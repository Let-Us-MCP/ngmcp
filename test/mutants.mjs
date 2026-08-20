#!/usr/bin/env node
/* Every test here ships with the mutation it must catch.
 *
 * A suite that passes proves nothing on its own: the defects this project has
 * already found all got past a green suite first. So each mutant is applied to
 * the source, the suite that claims to catch it is run, and the run is
 * required to fail. A mutant that survives means the test is decoration.
 *
 *     node test/mutants.mjs
 *     node test/mutants.mjs --only "backpressure"
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mutants = JSON.parse(readFileSync(path.join(ROOT, "test", "mutants.json"), "utf8"));
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex > -1 ? process.argv[onlyIndex + 1] : null;

const build = () => execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: ROOT, stdio: "pipe" });

const runSuite = (suite) => {
  try {
    execFileSync(process.execPath,
      ["--test", "--test-timeout=60000", suite], { cwd: ROOT, stdio: "pipe" });
    return "passed";
  } catch {
    return "failed";
  }
};

let survived = 0, killed = 0, broken = 0;
console.log(`${mutants.length} mutant(s)\n`);

for (const mutant of mutants) {
  if (only && !mutant.name.includes(only)) continue;
  const file = path.join(ROOT, mutant.file);
  const original = readFileSync(file, "utf8");
  if (!original.includes(mutant.find)) {
    console.log(`  BROKEN  ${mutant.name}`);
    console.log(`          anchor not found in ${mutant.file}; the mutant needs updating`);
    broken += 1;
    continue;
  }
  writeFileSync(file, original.replace(mutant.find, mutant.replace));
  let verdict;
  try {
    build();
    verdict = runSuite(mutant.suite);
  } catch {
    // A mutant that will not compile is still killed: the change cannot ship.
    verdict = "failed";
  } finally {
    writeFileSync(file, original);
  }
  if (verdict === "failed") {
    killed += 1;
    console.log(`  killed   ${mutant.name}`);
  } else {
    survived += 1;
    console.log(`  SURVIVED ${mutant.name}`);
    console.log(`           ${mutant.suite} passed with the defect in place`);
    console.log(`           ${mutant.why}`);
  }
}

build();
console.log(`\n${killed} killed, ${survived} survived, ${broken} with a stale anchor`);
process.exit(survived + broken ? 1 : 0);
