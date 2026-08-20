import type { Dispatcher } from "../runtime/dispatch.js";
import type { Incoming, Notification, Response } from "../protocol/jsonrpc.js";
import { CODE } from "../protocol/errors.js";
import type { Backpressure } from "../runtime/notifications.js";
import type { Readable, Writable } from "node:stream";

export interface StdioOptions {
  stdin?: Readable;
  stdout?: Writable;
  /** Exit the process once the client's pipe closes. Default true.
   *
   * A server whose client has gone is a server nobody can reach. Staying
   * alive leaves an orphan holding a pipe, which is how test suites and shells
   * end up hanging on a process that will never be spoken to again. */
  exitOnClose?: boolean;
  exit?: (code: number) => void;
}

/** One JSON object per line, both ways.
 *
 * Requests are dispatched as they arrive rather than awaited in turn, so a
 * slow tool does not hold up the ones behind it. Ordering of responses is not
 * preserved and does not need to be: the id is the correlation, and a
 * transport that serialises on it would be inventing a constraint the
 * protocol does not have.
 */
export class StdioTransport {
  #buffer = "";
  #pending = 0;
  #started = false;

  constructor(
    private readonly dispatcher: Dispatcher,
    private readonly options: StdioOptions = {},
  ) {}

  /** Bytes the transport is still holding, for the backpressure policy. */
  get pending(): number { return this.#pending; }

  backpressure(highWaterMark = 1 << 20): Backpressure {
    return { highWaterMark, pending: () => this.#pending };
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    const stdin: Readable = this.options.stdin ?? (process.stdin as unknown as Readable);
    const stdout: Writable = this.options.stdout ?? (process.stdout as unknown as Writable);

    this.dispatcher.sink = (note: Notification) => this.#write(stdout, note);
    stdout.on("error", () => { /* the host went away mid-write */ });

    stdin.on("data", (chunk: Buffer | string) => {
      this.#buffer += chunk.toString();
      let index: number;
      while ((index = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, index).trim();
        this.#buffer = this.#buffer.slice(index + 1);
        if (line) this.#accept(stdout, line);
      }
    });

    // A client that goes away has cancelled everything it asked for, and the
    // specification says to treat it exactly that way.
    const gone = () => {
      this.dispatcher.inFlight.cancelAll("closed");
      if (this.options.exitOnClose !== false) {
        const exit = this.options.exit ?? ((code: number) => process.exit(code));
        // One turn, so an abort handler that is mid-resolve can finish.
        setTimeout(() => exit(0), 0).unref?.();
      }
    };
    stdin.on("end", gone);
    stdin.on("close", gone);
  }

  #accept(stdout: Writable, line: string): void {
    let message: Incoming;
    try {
      message = JSON.parse(line) as Incoming;
    } catch (error) {
      this.#write(stdout, {
        jsonrpc: "2.0", id: null,
        error: { code: CODE.parse, message: (error as Error).message },
      } as unknown as Notification);
      return;
    }
    // Dispatched, not awaited: this is where concurrency actually happens.
    void this.dispatcher.handle(message).then(
      (response) => { if (response) this.#write(stdout, response as unknown as Notification); },
      (error) => {
        const id = (message as { id?: string | number }).id ?? null;
        this.#write(stdout, {
          jsonrpc: "2.0", id,
          error: { code: CODE.internal, message: (error as Error).message },
        } as unknown as Notification);
      },
    );
  }

  #write(stdout: Writable, message: Notification | Response): void {
    const line = `${JSON.stringify(message)}\n`;
    this.#pending += Buffer.byteLength(line);
    try {
      stdout.write(line, () => { this.#pending -= Buffer.byteLength(line); });
    } catch {
      this.#pending -= Buffer.byteLength(line);
    }
  }
}
