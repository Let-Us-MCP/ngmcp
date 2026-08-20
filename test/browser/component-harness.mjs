import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { bundleView } from "../../dist/build/bundle.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
/* Stories are written into the repository rather than a temp directory so
 * that a relative import of the view package resolves the way it would in a
 * real project. */
const STORIES = path.join(ROOT, ".stories");
mkdirSync(STORIES, { recursive: true });

export const ENGINES = { chromium, webkit };
/** What a story imports to reach the components. */
export const VIEW = "../src/view/index.js";

const cache = new Map();

/** One real bundle, so the frame gets what a published view would get.
 *  Hand-concatenating the compiled files worked while there were three in a
 *  straight line, and stops the moment components import each other. */
export async function bundleStory(source) {
  const cached = cache.get(source);
  if (cached) return cached;
  const name = `story-${createHash("sha1").update(source).digest("hex").slice(0, 12)}.ts`;
  const entry = path.join(STORIES, name);
  writeFileSync(entry, source);
  try {
    const { html } = await bundleView({ entry, debug: true });
    const open = html.indexOf('<script type="module">') + '<script type="module">'.length;
    const script = html.slice(open, html.lastIndexOf("</script>"));
    cache.set(source, script);
    return script;
  } finally {
    try { unlinkSync(entry); } catch { /* already gone */ }
  }
}

export const BASE_CSS = `
  :root { color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif }
  body { margin: 0; padding: 12px }
  .data-table { border-collapse: collapse; width: 100% }
  .data-table th, .data-table td { text-align: left; padding: 6px 8px;
    border-bottom: 1px solid #8884 }
  .data-table td.num, .data-table th.num { text-align: right }
  .data-table tr[aria-selected="true"] { background: #0a84ff22 }
  .data-table button.sort { all: unset; cursor: pointer; font: inherit; font-weight: 600 }
  .data-table th button.sort:focus-visible { outline: 2px solid currentColor }
  .filter { width: 100%; padding: 6px; margin-bottom: 8px }
  .status { color: #888; margin: 8px 0 0 }
  .pager { display: flex; gap: 8px; align-items: center; margin-top: 8px }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap }
  .metric { display: block; padding: 10px; border: 1px solid #8884; border-radius: 8px }
  .metric-value { font-size: 22px; font-weight: 600 }
  .metric-delta.good { color: #0a0 } .metric-delta.bad { color: #c00 }
  .toast { padding: 8px; border: 1px solid #8884; margin-bottom: 6px }
  .banner { padding: 8px; border: 1px solid #8884 }
  .field { display: block; margin-bottom: 10px }
  .field label { display: block; font-weight: 600 }
  .field-error { color: #c00 } .field-help { color: #888 }
  [data-prefilled="true"] { outline: 2px dashed #fa0 }
  .button-error { color: #c00; margin-left: 8px }
`;

/** Mount one component in a sandboxed frame with an opaque origin, the way a
 *  host renders a view, and hand back a locator for it. */
export async function mount(engineName, source, { css = "" } = {}) {
  const script = await bundleStory(
    `${source}\ndocument.documentElement.dataset.ready = "1";`);
  const browser = await ENGINES[engineName].launch();
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><body style="margin:0">
    <iframe id="f" sandbox="allow-scripts" style="width:100%;height:700px;border:0"></iframe>
    <script>window.__mount = (h) => { document.getElementById("f").srcdoc = h; };<\/script>
  </body>`);
  const html = `<!doctype html><meta charset="utf-8"><style>${BASE_CSS}${css}</style>
    <div id="root"></div>
    <script type="module">${script.replace(/<\/script/gi, "<\\/script")}<\/script>`;
  await page.evaluate((h) => window.__mount(h), html);
  const frame = page.frameLocator("#f");
  await frame.locator("html[data-ready='1']").waitFor({ timeout: 10000 });
  return { page, frame, engine: engineName, async close() { await browser.close(); } };
}
