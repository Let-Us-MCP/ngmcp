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
  .stack { display: flex; flex-direction: column }
  .row { display: flex; flex-direction: row; flex-wrap: wrap }
  .gap-tight { gap: 4px } .gap-normal { gap: 10px } .gap-loose { gap: 20px }
  .spacer { flex: 1 }
  .columns { display: grid }
  .columns.collapsed { grid-template-columns: 1fr !important }
  .card { border: 1px solid #8884; border-radius: 8px; padding: 12px }
  .card-head { display: flex; align-items: center; justify-content: space-between }
  .tablist { display: flex; gap: 4px; border-bottom: 1px solid #8884 }
  .tab { padding: 6px 10px; border: 0; background: none; cursor: pointer; font: inherit }
  .tab.selected { font-weight: 700; box-shadow: inset 0 -2px currentColor }
  .tabpanel { padding: 10px 0 }
  .dialog { border: 1px solid #8884; border-radius: 10px; padding: 16px; min-width: 260px }
  .dialog::backdrop { background: #0006 }
  .proposal { border: 1px solid #fa08; padding: 10px; border-radius: 8px }
  .proposal-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 10px }
  .proposal-text { white-space: pre-wrap; margin: 0; font: 12px/1.4 ui-monospace, monospace }
  .approval { border: 1px solid #8884; border-radius: 8px; padding: 12px }
  .approval.risk-high { border-left: 4px solid #c00 }
  .approval-provenance { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px }
  .approval-provenance dt { color: #888 } .approval-provenance dd { margin: 0 }
  .task-bar { height: 6px; background: #8883; border-radius: 3px; overflow: hidden }
  .task-bar span { display: block; height: 100%; background: #0a84ff }
  .task { list-style: none; margin-bottom: 10px }
  .tasks { padding: 0; margin: 0 }
  .stream-lines { max-height: 160px; overflow-y: auto; font: 11.5px/1.5 ui-monospace, monospace }
  .stream-line { padding: 1px 4px } .stream-error { color: #c00 }
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
