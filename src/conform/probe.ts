/** A bare client, for asking a server things it would rather not be asked.
 *
 * Deliberately not built on any SDK, for the same reason the tests are not: a
 * conformance run has to send messages an SDK refuses to construct — a request
 * with no `_meta`, a version the server does not speak, a body that is not
 * JSON. An SDK that fixes those on the way out would be testing itself.
 *
 * It speaks to a subprocess over stdio or to a URL over HTTP, and it records
 * every message in both directions so a check can assert about traffic that
 * arrived rather than only about the answer it asked for.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface Sent {
  at: number;
  raw: string;
}

export interface Received {
  at: number;
  message: Record<string, unknown>;
}

export interface Probe {
  /** Send a request and wait for the answer with the matching id. */
  request(message: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown> | null>;
  /** Send anything at all, including things that are not JSON. */
  raw(text: string): void;
  /** Everything that arrived which was not an answer to a request. */
  notifications(): Received[];
  /** Everything that arrived, answers included. */
  received(): Received[];
  /** Anything the server wrote to stderr, which is often where the reason is. */
  stderr(): string;
  close(): Promise<void>;
}

const isAnswerTo = (message: Record<string, unknown>, id: unknown): boolean =>
  message["id"] === id && ("result" in message || "error" in message);

/** Spawn a server and talk to it over its own pipes. */
export function stdioProbe(command: string, args: readonly string[]): Probe {
  const child: ChildProcess = spawn(command, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiters = new Map<unknown, (m: Record<string, unknown>) => void>();
  const all: Received[] = [];
  const notes: Received[] = [];
  const errors: string[] = [];
  let buffer = "";

  child.on("error", (cause) => errors.push(String(cause)));
  child.stderr?.on("data", (b: Buffer) => errors.push(b.toString()));
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A server writing non-JSON to stdout is itself a finding, kept rather
        // than thrown away.
        errors.push(`non-JSON on stdout: ${line.slice(0, 200)}`);
        continue;
      }
      const entry = { at: Date.now(), message };
      all.push(entry);
      let claimed = false;
      for (const [id, resolve] of waiters) {
        if (isAnswerTo(message, id)) {
          waiters.delete(id);
          resolve(message);
          claimed = true;
          break;
        }
      }
      if (!claimed) notes.push(entry);
    }
  });

  return {
    request(message, timeoutMs = 5000) {
      return new Promise((resolve) => {
        const id = message["id"];
        const timer = setTimeout(() => {
          waiters.delete(id);
          // Null rather than a rejection: "did not answer" is a result a
          // check wants to report, not an exception it has to catch.
          resolve(null);
        }, timeoutMs);
        waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      });
    },
    raw(text) { child.stdin?.write(text); },
    notifications: () => [...notes],
    received: () => [...all],
    stderr: () => errors.join(""),
    async close() {
      try { child.stdin?.end(); } catch { /* gone */ }
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill("SIGKILL");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 500))]);
      }
      for (const s of [child.stdin, child.stdout, child.stderr]) {
        try { s?.destroy(); } catch { /* gone */ }
      }
      child.unref();
    },
  };
}

/** Talk to a server over HTTP. One request, one response, nothing between. */
export function httpProbe(url: string): Probe {
  const all: Received[] = [];
  const errors: string[] = [];

  return {
    async request(message, timeoutMs = 5000) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message),
          signal: controller.signal,
        });
        // A 202 is the correct answer to a notification and carries no body.
        if (response.status === 202) return null;
        const text = await response.text();
        if (!text) return null;
        const parsed = JSON.parse(text) as Record<string, unknown>;
        // The status is part of what a check may want to assert about, so it
        // travels with the message rather than being discarded here.
        const entry = { at: Date.now(), message: { ...parsed, __status: response.status } };
        all.push(entry);
        return entry.message;
      } catch (cause) {
        errors.push(String(cause));
        return null;
      } finally { clearTimeout(timer); }
    },
    raw(text) {
      void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: text,
      }).then(async (r) => {
        const body = await r.text().catch(() => "");
        if (body) {
          try {
            all.push({ at: Date.now(), message: {
              ...JSON.parse(body) as Record<string, unknown>, __status: r.status } });
          } catch { errors.push(`non-JSON body: ${body.slice(0, 200)}`); }
        }
      }).catch((cause) => errors.push(String(cause)));
    },
    // HTTP without a stream carries no unsolicited traffic at all, which is a
    // fact about the transport rather than about the server.
    notifications: () => [],
    received: () => [...all],
    stderr: () => errors.join(""),
    async close() { /* nothing is held open */ },
  };
}
