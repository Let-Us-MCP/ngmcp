#!/usr/bin/env node
/* Examples are TypeScript, because their whole point is that the contract is
 * type-checked. Node cannot run them directly, so each is bundled to a single
 * runnable file the same way a user's own build would. */
import { build } from "esbuild";
import { readdirSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXAMPLES = path.join(ROOT, "examples");
if (!existsSync(EXAMPLES)) process.exit(0);

const { bundleView } = await import(path.join(ROOT, "dist", "build", "bundle.js"));

for (const name of readdirSync(EXAMPLES)) {
  const dir = path.join(EXAMPLES, name);
  const entry = path.join(dir, "server.ts");
  if (!existsSync(entry)) continue;
  mkdirSync(path.join(dir, "dist"), { recursive: true });

  // The view is built here rather than at server startup. A server that
  // bundles on boot pays for it on every start and needs its own source tree
  // on disk in production, which is not how anything ships.
  const viewEntry = path.join(dir, "view.ts");
  if (existsSync(viewEntry)) {
    const cssFile = path.join(dir, "view.css");
    const { html } = await bundleView({
      entry: viewEntry,
      title: name,
      css: existsSync(cssFile) ? readFileSync(cssFile, "utf8") : "",
    });
    writeFileSync(path.join(dir, "dist", "view.html"), html);
    console.log(`  built examples/${name}/dist/view.html`);
  }

  await build({
    entryPoints: [entry],
    outfile: path.join(EXAMPLES, name, "dist", "server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["esbuild"],
    logLevel: "warning",
  });
  console.log(`  built examples/${name}/dist/server.mjs`);
}
