/** Turn a view entry point into one self-contained HTML file.
 *
 * A view is delivered as the body of a `ui://` resource and rendered in a
 * frame with an opaque origin and a restrictive content security policy.
 * Nothing can be fetched: no module specifier resolves, no stylesheet loads,
 * no CDN is reachable. So everything the view needs has to be inline by the
 * time the server hands it over.
 *
 * `esbuild` does the work and is a development dependency, imported lazily.
 * A server that only serves a view built earlier never loads it, which is how
 * the runtime stays free of dependencies.
 */

export interface BundleOptions {
  /** Path to the view's entry module. */
  entry: string;
  /** CSS inlined into a single `<style>`. */
  css?: string;
  /** Contents of `<title>`, for hosts that show one. */
  title?: string;
  /** Extra markup placed before the script. */
  body?: string;
  /** Readable output and a source map comment. Off by default. */
  debug?: boolean;
}

export interface BundleResult {
  html: string;
  /** Bytes of JavaScript, before the HTML wrapper. */
  scriptBytes: number;
  warnings: string[];
}

const escapeForScript = (source: string): string =>
  // A closing script tag inside the bundle would end the block early. This is
  // the only escaping that matters, because the bundle is inserted as text.
  source.replace(/<\/script/gi, "<\\/script");

export async function bundleView(options: BundleOptions): Promise<BundleResult> {
  let esbuild: typeof import("esbuild");
  try {
    esbuild = await import("esbuild");
  } catch {
    throw new Error(
      "bundleView needs esbuild. Install it as a development dependency: "
      + "npm install -D esbuild");
  }

  const built = await esbuild.build({
    entryPoints: [options.entry],
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    platform: "browser",
    minify: !options.debug,
    sourcemap: options.debug ? "inline" : false,
    legalComments: "none",
  });

  const script = built.outputFiles?.[0]?.text ?? "";
  const warnings = built.warnings.map((w) => w.text);

  const html = [
    "<!doctype html>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    options.title ? `<title>${options.title}</title>` : "",
    options.css ? `<style>${options.css}</style>` : "",
    options.body ?? '<div id="root"></div>',
    `<script type="module">${escapeForScript(script)}</script>`,
  ].filter(Boolean).join("\n");

  return { html, scriptBytes: script.length, warnings };
}
