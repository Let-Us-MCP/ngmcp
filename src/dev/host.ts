/** A host to develop against.
 *
 * Without one there is nowhere to run a view: a host renders it, and the ones
 * that exist are products you cannot iterate inside. This is the smallest
 * thing that behaves like one. It connects to the app in process, serves a
 * page that mounts the view in a frame sandboxed the way the specification
 * requires, and proxies the view's tool calls back.
 *
 * It is a development tool and says so in the page. It grants every capability
 * and refuses nothing, which is exactly the condition under which an
 * application looks more portable than it is. Use the refusal controls to find
 * out otherwise before a real host does.
 */
import type { App } from "../app.js";
import { APP_MIME, PROTOCOL_VERSION, META } from "../protocol/version.js";

export interface DevHostOptions {
  port?: number;
  hostname?: string;
  /** Which host capabilities to advertise. Everything, by default. */
  capabilities?: Record<string, unknown>;
  /** Reloads the page when the view file changes. */
  watch?: string;
}

const CAPABILITIES = {
  serverTools: {}, serverResources: {}, downloadFile: {}, openLinks: {},
  message: { text: {} }, updateModelContext: { text: {}, structuredContent: {} },
  logging: {},
};

const PAGE = (viewUri: string, capabilities: string) => `<!doctype html>
<meta charset="utf-8"><title>ngmcp dev host</title>
<style>
  :root { color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif }
  body { margin: 0; display: grid; grid-template-rows: auto 1fr auto; height: 100vh }
  header, footer { padding: 8px 12px; border-bottom: 1px solid #8884;
    display: flex; gap: 10px; align-items: center; flex-wrap: wrap }
  footer { border: 0; border-top: 1px solid #8884; font: 11.5px/1.5 ui-monospace, monospace;
    max-height: 30vh; overflow: auto; display: block }
  #view { width: 100%; height: 100%; border: 0 }
  .warn { color: #a60; margin-left: auto }
  label { display: flex; gap: 4px; align-items: center }
  .row { padding: 1px 0 } .row.out { color: #888 }
</style>
<header>
  <strong>dev host</strong>
  <label><input type="checkbox" id="deny"> refuse the next call</label>
  <label><input type="checkbox" id="slow"> make calls slow</label>
  <button id="reload">Reload view</button>
  <button id="teardown">Ask to tear down</button>
  <span class="warn">grants everything; a real host will not</span>
</header>
<iframe id="view" sandbox="allow-scripts allow-same-origin"></iframe>
<footer id="log"></footer>
<script type="module">
  const caps = ${capabilities};
  const log = document.getElementById("log");
  const line = (dir, text) => {
    const el = document.createElement("div");
    el.className = "row " + (dir === "out" ? "out" : "");
    el.textContent = (dir === "out" ? "\\u2190 " : "\\u2192 ") + text;
    log.appendChild(el); log.scrollTop = log.scrollHeight;
  };

  async function mount() {
    const read = await rpc("resources/read", { uri: ${JSON.stringify(viewUri)} });
    document.getElementById("view").srcdoc = read.result.contents[0].text;
  }

  async function rpc(method, params) {
    const body = { jsonrpc: "2.0", id: Math.random().toString(36).slice(2),
      method, params: { ...params, _meta: {
        "${META.protocolVersion}": "${PROTOCOL_VERSION}",
        "${META.clientCapabilities}": caps,
        "${META.clientInfo}": { name: "ngmcp-dev-host", version: "0.0.1" },
      } } };
    const response = await fetch("/rpc", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return response.json();
  }

  /* Host methods, as opposed to tool calls. A dev host that ignores these
     leaves the view waiting out its timeout, which reads as the app being
     slow rather than as the host not having the method. Everything not
     implemented here is refused by name. */
  const hostMethods = {
    sendSizeChanged: (params) => ({ ok: true, height: params && params.height }),
    requestDisplayMode: (params) => {
      const mode = (params && params.mode) || "inline";
      const frame = document.getElementById("view").contentWindow;
      frame.postMessage({ __event: "displayMode", data: mode }, "*");
      return { mode };
    },
    openLink: (params) => ({ opened: params && params.url }),
    sendMessage: (params) => ({ sent: params && params.text }),
    updateModelContext: () => ({ updated: true }),
    sendLog: () => ({ logged: true }),
    requestTeardown: () => ({ ok: true }),
  };

  addEventListener("message", async (event) => {
    const data = event.data;
    const frame0 = document.getElementById("view").contentWindow;

    if (data && data.__host) {
      line("in", "host." + data.__host + " " + JSON.stringify(data.params ?? {}));
      if (document.getElementById("deny").checked) {
        document.getElementById("deny").checked = false;
        line("out", "refused by the dev host");
        frame0.postMessage({ __id: data.__id, error: "The host refused that." }, "*");
        return;
      }
      const method = hostMethods[data.__host];
      if (!method) {
        line("out", "no such host method: " + data.__host);
        frame0.postMessage({
          __id: data.__id,
          error: "This host does not implement " + data.__host + ".",
        }, "*");
        return;
      }
      const result = method(data.params);
      line("out", JSON.stringify(result));
      frame0.postMessage({ __id: data.__id, result }, "*");
      return;
    }

    if (!data || !data.__call) return;
    line("in", data.__call + " " + JSON.stringify(data.args ?? {}));
    const frame = document.getElementById("view").contentWindow;
    if (document.getElementById("slow").checked) {
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (document.getElementById("deny").checked) {
      document.getElementById("deny").checked = false;
      line("out", "refused by the dev host");
      frame.postMessage({ __id: data.__id, error: "The host refused that." }, "*");
      return;
    }
    const answer = await rpc("tools/call", { name: data.__call, arguments: data.args ?? {} });
    line("out", JSON.stringify(answer.result ?? answer.error).slice(0, 200));
    frame.postMessage(answer.error
      ? { __id: data.__id, error: answer.error.message }
      : { __id: data.__id, result: answer.result }, "*");
  });

  function tellTheView() {
    const frame = document.getElementById("view").contentWindow;
    if (!frame) return;
    frame.postMessage({ __event: "hostCapabilities", data: caps }, "*");
    frame.postMessage({ __event: "hostContext", data: {
      locale: navigator.language,
      theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      displayMode: "inline",
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    } }, "*");
  }
  document.getElementById("view").addEventListener("load", () => setTimeout(tellTheView, 0));

  document.getElementById("teardown").onclick = () => {
    const frame = document.getElementById("view").contentWindow;
    frame.postMessage({ __event: "teardown", __id: "teardown-1" }, "*");
    line("in", "asked the view to tear down");
  };

  document.getElementById("reload").onclick = () => mount();
  new EventSource("/changes").onmessage = () => location.reload();
  mount();
</script>`;

export async function devHost(
  app: App,
  options: DevHostOptions = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const { createServer } = await import("node:http");
  const { watch } = await import("node:fs");
  const handler = app.fetch({ healthPath: "" });
  const listeners = new Set<{ write(chunk: string): void }>();

  const viewUri = app.viewUris[0] ?? "";
  if (!viewUri) throw new Error("This app registers no view to develop against.");

  const server = createServer(async (incoming, outgoing) => {
    const url = incoming.url ?? "/";

    if (url === "/changes") {
      outgoing.writeHead(200, {
        "content-type": "text/event-stream", "cache-control": "no-cache",
      });
      listeners.add(outgoing);
      incoming.on("close", () => listeners.delete(outgoing));
      return;
    }

    if (url === "/rpc" && incoming.method === "POST") {
      const chunks: Buffer[] = [];
      incoming.on("data", (c: Buffer) => chunks.push(c));
      incoming.on("end", async () => {
        const response = await handler(new Request("http://dev/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Buffer.concat(chunks).toString(),
        }));
        outgoing.writeHead(response.status, { "content-type": "application/json" });
        outgoing.end(await response.text());
      });
      return;
    }

    outgoing.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    outgoing.end(PAGE(viewUri, JSON.stringify(options.capabilities ?? CAPABILITIES)));
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(options.port ?? 0, options.hostname ?? "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  if (options.watch) {
    watch(options.watch, { recursive: true }, () => {
      for (const listener of listeners) listener.write("data: changed\n\n");
    });
  }

  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const DEV_MIME = APP_MIME;
