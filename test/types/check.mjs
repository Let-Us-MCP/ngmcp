#!/usr/bin/env node
/* The contract is the reason this package exists, so something has to fail
 * when it stops holding.
 *
 * Runtime tests cannot do it: a shape mismatch between a tool and its view is
 * a type error and nothing else. So each case is compiled on its own. Files
 * marked `@expect: compiles` must produce no error; files marked
 * `@expect-error: <text>` must produce one containing that text. A file that
 * was supposed to fail and compiled cleanly is the interesting failure: it
 * means the types stopped connecting and nobody would have noticed.
 *
 *   node test/types/check.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const CASES = path.join(HERE, "cases");

const files = readdirSync(CASES)
  .filter((f) => f.endsWith(".ts") && f !== "contract.ts").sort();

/* Flags rather than a project file: tsc refuses to mix `-p` with a file list,
 * and each case has to be compiled on its own so one failure does not mask
 * another. */
const FLAGS = [
  "--noEmit", "--strict", "--skipLibCheck", "--verbatimModuleSyntax",
  "--target", "ES2023", "--module", "nodenext", "--moduleResolution", "nodenext",
  "--lib", "ES2023,DOM", "--noUncheckedIndexedAccess",
];

const compile = (file) => {
  try {
    execFileSync("npx", ["tsc", ...FLAGS, file], { cwd: ROOT, stdio: "pipe" });
    return "";
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
};

let failures = 0;
console.log(`${files.length} type case(s)\n`);

for (const file of files) {
  const full = path.join(CASES, file);
  const source = readFileSync(full, "utf8");
  const wantsError = /^\/\/ @expect-error:\s*(.+)$/m.exec(source);
  const output = compile(full);

  if (wantsError) {
    const needle = wantsError[1].trim();
    if (!output) {
      failures += 1;
      console.log(`  FAILED   ${file}`);
      console.log(`           compiled cleanly; it was meant to fail with ${JSON.stringify(needle)}`);
      console.log("           the contract has stopped being enforced");
    } else if (!output.includes(needle)) {
      failures += 1;
      console.log(`  FAILED   ${file}`);
      console.log(`           failed, but not with ${JSON.stringify(needle)}`);
      console.log(`           ${output.split("\n").filter(Boolean)[0]}`);
    } else {
      console.log(`  rejected ${file}`);
    }
  } else {
    if (output) {
      failures += 1;
      console.log(`  FAILED   ${file}`);
      console.log(`           should compile, but did not:`);
      for (const line of output.split("\n").filter(Boolean).slice(0, 3)) {
        console.log(`           ${line}`);
      }
    } else {
      console.log(`  compiles ${file}`);
    }
  }
}

console.log(`\n${files.length - failures} correct, ${failures} wrong`);
process.exit(failures ? 1 : 0);
