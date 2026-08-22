#!/usr/bin/env node
/** `ngmcp conform` — ask a server whether it does what the specification says.
 *
 * Prints the matrix with `src/text/`, which is the same renderer the library
 * offers a server for its own answers. A tool that recommends drawing in text
 * and then prints an unaligned wall of prose is not making its case.
 */
import { conform, type Report } from "./conform/index.js";
import { table, section } from "./text/index.js";

const USAGE = `ngmcp conform — check a server against the specification

  ngmcp conform -- <command> [args...]     spawn it and talk over stdio
  ngmcp conform --url <url>                post to it over HTTP

Options
  --only <id,id>     run only these checks
  --timeout <ms>     how long a single request may take, default 5000
  --json             the report as JSON, for a pipe
  --quiet            only what failed

Exit code is 1 if any check failed, 0 otherwise. A check that could not be
settled reports "unknown" and does not fail the run, because a harness that
guesses is worse than one that says it does not know.

Nothing destructive is ever called: only a tool annotated readOnlyHint that
takes no required arguments is invoked, and checks needing one report n/a
where no such tool exists.`;

interface Options {
  command?: { command: string; args: string[] };
  url?: string;
  only?: string[];
  timeoutMs?: number;
  json: boolean;
  quiet: boolean;
}

function parse(argv: string[]): Options | null {
  const options: Options = { json: false, quiet: false };
  const separator = argv.indexOf("--");
  const flags = separator >= 0 ? argv.slice(0, separator) : argv;
  const after = separator >= 0 ? argv.slice(separator + 1) : [];

  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    if (flag === "--url") { options.url = flags[++i]; continue; }
    if (flag === "--only") { options.only = (flags[++i] ?? "").split(","); continue; }
    if (flag === "--timeout") { options.timeoutMs = Number(flags[++i]); continue; }
    if (flag === "--json") { options.json = true; continue; }
    if (flag === "--quiet") { options.quiet = true; continue; }
    if (flag === "-h" || flag === "--help") return null;
    if (flag?.startsWith("-")) {
      process.stderr.write(`Unknown option ${flag}\n\n${USAGE}\n`);
      process.exit(2);
    }
  }
  if (after.length) {
    options.command = { command: after[0]!, args: after.slice(1) };
  }
  if (!options.command && !options.url) return null;
  return options;
}

const MARK: Record<string, string> = {
  pass: "pass", fail: "FAIL", "n/a": "n/a", unknown: "?",
};

function render(report: Report, quiet: boolean): string {
  const rows = report.findings
    .filter((f) => !quiet || f.verdict === "fail")
    .map((f) => ({ verdict: MARK[f.verdict] ?? f.verdict, id: f.id, note: f.note }));

  const heading = report.era === "unreachable"
    ? "Unreachable"
    : `${report.server || "unnamed server"}, ${report.era} negotiation`;

  const body = rows.length
    ? table({
        rows,
        columns: [
          { key: "verdict", label: "" },
          { key: "id", label: "Check" },
          { key: "note", label: "What was found" },
        ],
      })
    : "Nothing to report.";

  const tally = `${report.passed} passed, ${report.failed} failed, `
    + `${report.notApplicable} not applicable, ${report.unknown} unsettled`;

  const parts = [section(heading, body), "", tally];
  if (report.failed === 0 && report.unknown === 0 && report.era !== "unreachable") {
    parts.push("", "Every check that applies here passed.");
  }
  // Whatever the server said on stderr is usually where the reason is, so it
  // is printed rather than swallowed.
  if (report.stderr.trim()) {
    parts.push("", section("The server also said", report.stderr.trim().slice(0, 2000)));
  }
  return parts.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  if (verb !== "conform") {
    process.stderr.write(`${USAGE}\n`);
    process.exit(verb === "-h" || verb === "--help" || !verb ? 0 : 2);
  }

  const options = parse(argv.slice(1));
  if (!options) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const report = await conform({
    ...(options.command ? { command: options.command } : {}),
    ...(options.url ? { url: options.url } : {}),
    ...(options.only ? { only: options.only } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });

  process.stdout.write(options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${render(report, options.quiet)}\n`);

  // Only a failure fails the run. An unsettled check is reported and does not
  // decide anything, because a harness that guesses is worse than one that
  // admits it does not know.
  process.exit(report.failed > 0 ? 1 : 0);
}

void main();
