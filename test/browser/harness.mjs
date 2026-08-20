import { spawn } from "node:child_process";
import { chromium, webkit } from "playwright";

export const ENGINES = { chromium, webkit };
const V = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": V,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "ngmcp-browser-test", version: "1.0.0" },
};

/** A host, in the sense the protocol means: it talks to the server, renders the
 *  view it delivers, and proxies the view's tool calls back. The frame gets no
 *  `allow-same-origin`, so it has an opaque origin and this page cannot read
 *  into it, which is the property that makes the sandbox worth having. */
const HOST_PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<iframe id="view" sandbox="allow-scripts" style="width:100%;height:600px;border:0"></iframe>
<script>
  window.__calls = [];
  addEventListener("message", async (event) => {
    const data = event.data;
    if (!data || !data.__call) return;
    window.__calls.push({ name: data.__call, args: data.args });
    const frame = document.getElementById("view").contentWindow;
    try {
      const result = await window.__callServer(data.__call, data.args ?? {});
      frame.postMessage({ __id: data.__id, result }, "*");
    } catch (error) {
      frame.postMessage({ __id: data.__id, error: String(error.message) }, "*");
    }
  });
  window.__mount = (html) => {
    document.getElementById("view").srcdoc = html;
  };
</script></body>`;

function server(serverPath) {
  const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
  const waiters = new Map();
  const stderr = [];
  let buffer = "";
  let id = 0;
  child.stderr.on("data", (b) => stderr.push(b.toString()));
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = waiters.get(message.id);
      if (waiter) { waiters.delete(message.id); waiter(message); }
    }
  });
  const request = (method, params = {}) => new Promise((resolve) => {
    const requestId = ++id;
    waiters.set(requestId, resolve);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: requestId, method, params: { ...params, _meta: META },
    })}\n`);
  });
  return {
    request,
    stderr: () => stderr.join(""),
    async close() {
      try { child.stdin.end(); } catch { /* gone */ }
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

/** Start the server, render its view in an opaque-origin frame, wire the two
 *  together, and hand back the frame to assert on. */
export async function openApp(engineName, serverPath, { viewUri } = {}) {
  const engine = ENGINES[engineName];
  const mcp = server(serverPath);
  const browser = await engine.launch();
  const page = await browser.newPage();

  await page.exposeFunction("__callServer", async (name, args) => {
    const answer = await mcp.request("tools/call", { name, arguments: args });
    if (answer.error) throw new Error(answer.error.message);
    return answer.result;
  });
  await page.setContent(HOST_PAGE);

  const listed = await mcp.request("tools/list");
  const uri = viewUri
    ?? listed.result.tools.find((t) => t._meta?.ui?.resourceUri)?._meta.ui.resourceUri;
  const read = await mcp.request("resources/read", { uri });
  const content = read.result.contents[0];
  if (content.mimeType !== "text/html;profile=mcp-app") {
    throw new Error(`view came back as ${content.mimeType}`);
  }
  await page.evaluate((html) => window.__mount(html), content.text);

  const frame = page.frameLocator("#view");
  await frame.locator("html[data-ready='1']").waitFor({ timeout: 10000 });

  return {
    page, frame, mcp, browser, engine: engineName,
    calls: () => page.evaluate(() => window.__calls),
    async close() { await browser.close(); await mcp.close(); },
  };
}
