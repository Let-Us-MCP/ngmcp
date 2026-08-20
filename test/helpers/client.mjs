import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.join(HERE, "..", "fixtures", "demo-server.mjs");
export const VERSION = "2026-07-28";
export const M = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  logLevel: "io.modelcontextprotocol/logLevel",
  serverInfo: "io.modelcontextprotocol/serverInfo",
};

/** A bare stdio client. Deliberately not built on any SDK: these tests have to
 *  send malformed and out-of-version messages that an SDK refuses to build. */
export function connect(serverPath = SERVER) {
  const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
  // Nothing reads stderr otherwise, and a child that fills the pipe buffer
  // blocks forever holding the suite open.
  const stderr = [];
  child.stderr.on("data", (b) => stderr.push(b.toString()));
  child.on("error", () => {});
  const waiters = new Map();
  const notifications = [];
  const listeners = [];
  let buffer = "";
  let id = 0;

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && message.id !== null && waiters.has(message.id)) {
        waiters.get(message.id)(message);
        waiters.delete(message.id);
      } else {
        notifications.push(message);
        for (const fn of listeners) fn(message);
      }
    }
  });

  const meta = (over = {}) => ({
    [M.protocolVersion]: VERSION,
    [M.clientCapabilities]: {},
    [M.clientInfo]: { name: "ngmcp-test", version: "1.0.0" },
    ...over,
  });

  const send = (method, params = {}, metaOver = {}, rawMeta) => {
    const requestId = ++id;
    const _meta = rawMeta !== undefined ? rawMeta : meta(metaOver);
    const message = {
      jsonrpc: "2.0", id: requestId, method,
      params: { ...params, ...(_meta === null ? {} : { _meta }) },
    };
    const promise = new Promise((resolve) => waiters.set(requestId, resolve));
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return { id: requestId, promise };
  };

  return {
    child,
    notifications,
    onNotification: (fn) => listeners.push(fn),
    request: (method, params, metaOver, rawMeta) => send(method, params, metaOver, rawMeta).promise,
    requestWithId: (method, params, metaOver) => send(method, params, metaOver),
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    raw(line) { child.stdin.write(`${line}\n`); },
    stderr: () => stderr.join(""),
    async close() {
      try { child.stdin.end(); } catch { /* already gone */ }
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGKILL");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 500))]);
      }
      // Open pipes keep the runner's event loop alive even after the child is
      // gone, which is what turns eleven passing tests into one hung suite.
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        try { stream?.destroy(); } catch { /* already destroyed */ }
      }
      child.unref();
    },
  };
}

export const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
