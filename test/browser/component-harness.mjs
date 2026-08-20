import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "..", "dist", "view");
export const ENGINES = { chromium, webkit };

/* The view runtime, flattened into one script.
 *
 * The frame has an opaque origin and no server behind it, so module specifiers
 * cannot resolve. These three files form a straight line, so stripping the
 * import and export keywords and concatenating them in order is enough, and
 * keeps the harness free of a bundler. */
const ORDER = ["reactive.js", "dom.js", "panes/data-table.js"];
const strip = (source) => source
  .replace(/^\s*import[^;]*;$/gm, "")
  .replace(/^export\s+/gm, "")
  .replace(/\/\/# sourceMappingURL=.*$/gm, "");

export function runtime() {
  return ORDER.map((f) => strip(readFileSync(path.join(DIST, f), "utf8"))).join("\n");
}

export const BASE_CSS = `
  :root { color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif }
  body { margin: 0; padding: 12px }
  .data-table { border-collapse: collapse; width: 100% }
  .data-table th, .data-table td { text-align: left; padding: 6px 8px;
    border-bottom: 1px solid #8884 }
  .data-table td.num, .data-table th.num { text-align: right }
  .data-table tr[aria-selected="true"] { background: #0a84ff22 }
  .data-table button.sort { all: unset; cursor: pointer; font: inherit;
    font-weight: 600 }
  .data-table th button.sort:focus-visible { outline: 2px solid currentColor }
  .filter { width: 100%; padding: 6px; margin-bottom: 8px }
  .status { color: #888; margin: 8px 0 0 }
  .pager { display: flex; gap: 8px; align-items: center; margin-top: 8px }
`;

/** Mount one component in a sandboxed frame with an opaque origin, the same
 *  way a host renders a view, and hand back a locator for it. */
export async function mount(engineName, script, { css = "" } = {}) {
  const browser = await ENGINES[engineName].launch();
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><body style="margin:0">
    <iframe id="f" sandbox="allow-scripts" style="width:100%;height:700px;border:0"></iframe>
    <script>window.__mount = (html) => { document.getElementById("f").srcdoc = html; };<\/script>
  </body>`);

  const html = `<!doctype html><meta charset="utf-8"><style>${BASE_CSS}${css}</style>
    <div id="root"></div>
    <script type="module">
      ${runtime()}
      ${script}
      document.documentElement.dataset.ready = "1";
    <\/script>`;

  await page.evaluate((h) => window.__mount(h), html);
  const frame = page.frameLocator("#f");
  await frame.locator("html[data-ready='1']").waitFor({ timeout: 10000 });
  return {
    page, frame, engine: engineName,
    async close() { await browser.close(); },
  };
}
