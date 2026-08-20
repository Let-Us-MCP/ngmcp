/** Asking the client something, and waiting for the answer.
 *
 * Elicitation and sampling both invert the direction: the server sends a
 * request and the client answers it. That needs two things a one-way sink does
 * not have — an id to correlate on, and a transport with a way back.
 *
 * This is the one place where something is remembered between two messages,
 * so it is worth being exact about what it is not. It is **not** connection
 * state. Nothing here survives the request that opened it: a pending ask
 * belongs to the tool call that made it, dies when that call is cancelled or
 * times out, and is gone by the time the response goes out. It is the same
 * category as the in-flight lifetimes, which exist so a cancellation can find
 * its request. A session would be something the *next* request could read, and
 * there is nothing here the next request can see.
 *
 * The other half is honesty about transports. A client reachable only by a
 * single HTTP response has no way back: the request arrives, the answer goes
 * out, and there is no channel left to carry a question. That is `unavailable`
 * rather than a hang, because a tool that waits forever for an answer nobody
 * can send is the worst of the three outcomes.
 */
import type { Id, Notification, Request } from "../protocol/jsonrpc.js";

/** What a transport must give us to carry a question to the client. */
export interface Channel {
  /** Write a request the client is expected to answer. */
  send(message: Request): void;
}

export interface Answer {
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

interface Waiter {
  resolve: (answer: Answer) => void;
  method: string;
}

/** Requests this server has sent that are still waiting to be answered. */
export class Outbound {
  #channel: Channel | null = null;
  readonly #waiting = new Map<Id, Waiter>();
  #counter = 0;

  /** Set by a transport that has a way back. Left alone, every ask is
   *  `unavailable`, which is the truthful answer for a transport that does
   *  not carry one. */
  set channel(channel: Channel | null) { this.#channel = channel; }

  get available(): boolean { return this.#channel !== null; }

  /** True when this id is an answer we are waiting for rather than a request. */
  answers(id: Id): boolean { return this.#waiting.has(id); }

  /** Route a client's answer back to whoever asked. */
  deliver(id: Id, answer: Answer): boolean {
    const waiter = this.#waiting.get(id);
    if (!waiter) return false;
    this.#waiting.delete(id);
    waiter.resolve(answer);
    return true;
  }

  /** Ask, and wait. Never rejects: the caller gets an answer describing what
   *  happened, including the case where nothing could be asked at all. */
  ask(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Answer> {
    const channel = this.#channel;
    if (!channel) {
      return Promise.resolve({
        error: {
          code: -32601,
          message: `This transport has no way back, so ${method} cannot be asked.`,
        },
      });
    }
    // Prefixed so a server-minted id can never collide with a client's, which
    // is the only thing on the wire that distinguishes the two directions.
    const id: Id = `srv-${++this.#counter}`;
    return new Promise<Answer>((resolve) => {
      const settle = (answer: Answer) => {
        this.#waiting.delete(id);
        signal.removeEventListener("abort", onAbort);
        resolve(answer);
      };
      const onAbort = () => settle({
        error: { code: -32800, message: `The request was ${reasonOf(signal)}.` },
      });
      // A question asked on behalf of a request that has already been
      // cancelled is a question nobody is waiting for the answer to.
      if (signal.aborted) {
        resolve({ error: { code: -32800, message: `The request was ${reasonOf(signal)}.` } });
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiting.set(id, { resolve: settle, method });
      channel.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Abandon everything still waiting, when the client goes away. */
  closeAll(reason: string): void {
    for (const [id, waiter] of [...this.#waiting]) {
      this.#waiting.delete(id);
      waiter.resolve({
        error: { code: -32800, message: `The client ${reason} before answering ${waiter.method}.` },
      });
    }
  }
}

const reasonOf = (signal: AbortSignal): string => {
  const reason = (signal as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : "cancelled";
};

/** A message that is an answer rather than a request or a notification. */
export const isAnswer = (
  message: unknown,
): message is { id: Id; result?: Record<string, unknown>; error?: Answer["error"] } =>
  typeof message === "object" && message !== null
  && "id" in message && (message as { id?: unknown }).id !== null
  && !("method" in message)
  && ("result" in message || "error" in message);

export type { Notification };
