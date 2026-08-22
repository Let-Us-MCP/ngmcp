import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { conform } from "../../dist/index.js";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const CLI = path.join(ROOT, "dist", "cli.js");
const GOOD = path.join(ROOT, "test", "fixtures", "demo-server.mjs");
const BROKEN = path.join(ROOT, "test", "fixtures", "nonconforming-server.mjs");
const TITANIC = path.join(ROOT, "examples", "titanic", "dist", "server.mjs");

const against = (server, env = {}) => conform({
  command: { command: process.execPath, args: [server] },
  timeoutMs: 4000,
  ...(Object.keys(env).length ? {} : {}),
});

const verdicts = (report) =>
  Object.fromEntries(report.findings.map((f) => [f.id, f.verdict]));

/* A conformance harness that only ever passes proves it can say yes and
 * nothing else. Half of this file is a server that is wrong on purpose. */

test("a conforming server passes, and the harness says which negotiation it speaks", async () => {
  const report = await against(GOOD);
  assert.equal(report.era, "modern");
  assert.equal(report.failed, 0, JSON.stringify(report.findings.filter((f) => f.verdict === "fail")));
  assert.ok(report.passed >= 8, `only ${report.passed} checks ran`);
});

test("a server that is wrong on purpose fails on every count it is wrong about", async () => {
  const report = await against(BROKEN);
  const found = verdicts(report);
  const shouldFail = [
    "version.refusal-is-32022",
    "meta.required-fields",
    "tools.input-schema",
    "tools.names-unique",
    "resource.missing-is-not-32002",
    "method.unknown-is-32601",
    "notification.gets-no-answer",
    "progress.needs-a-token",
    "notify.nothing-after-the-response",
    "ui.view-resolves",
  ];
  for (const id of shouldFail) {
    assert.equal(found[id], "fail", `${id} did not catch a deliberate violation`);
  }
  assert.equal(report.failed, shouldFail.length);

  // And what could not be settled stays unsettled. This server swallows a
  // malformed body instead of answering -32700, which is indistinguishable
  // from a transport that carries the answer on the same call — so the honest
  // verdict is "unknown", and quietly promoting it to a pass would report a
  // requirement as met that was never demonstrated.
  assert.equal(found["json.malformed-is-32700"], "unknown");
  assert.equal(report.unknown, 1);
});

test("answering initialize with anything is not the same as speaking it", async () => {
  /* The broken server answers every method with an empty result, `initialize`
   * included. Read as a handshake, that would class it as bridged and excuse
   * it from the checks a modern server has to pass — which is how a server
   * that is wrong about everything comes out looking better than one that is
   * wrong about one thing. */
  const report = await against(BROKEN);
  assert.equal(report.era, "modern");
  assert.equal(verdicts(report)["meta.required-fields"], "fail");
});

test("a shimmed server is reported as bridged, not blamed for the shim", async () => {
  /* A server behind the `initialize` shim answers both negotiations. The
   * `_meta` requirements stop being observable from outside, because the shim
   * fills them in before the server sees the request. Failing it for that
   * would be failing it for the shim's entire purpose. */
  const report = await against(TITANIC);
  assert.equal(report.era, "bridged");
  assert.equal(verdicts(report)["meta.required-fields"], "n/a");
  assert.equal(verdicts(report)["initialize.answers"], "pass");
  assert.equal(report.failed, 0);
});

test("nothing destructive is ever called", async () => {
  /* A conformance run that restarts somebody's deployment to check the shape
   * of a progress notification has done more harm than the defect it went
   * looking for. */
  // A server whose tools say what they would do: one destructive, one
  // read-only but requiring an argument. Each writes to stderr if called, and
  // the harness collects stderr, so the proof is what is absent from it.
  const report = await conform({
    command: { command: process.execPath, args: ["-e", `
      const { App } = await import(${JSON.stringify(path.join(ROOT, "dist", "index.js"))});
      const app = new App({ name: "dangerous", version: "1.0.0" });
      app.tool("wipe_everything", { description: "Destroys things.",
        annotations: { destructiveHint: true } },
        async () => { process.stderr.write("CALLED wipe_everything\\n"); return {}; });
      app.tool("needs_an_argument", { description: "Read only, needs an id.",
        annotations: { readOnlyHint: true },
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
        async () => { process.stderr.write("CALLED needs_an_argument\\n"); return {}; });
      app.serve();
    `] },
    timeoutMs: 4000,
  });
  assert.doesNotMatch(report.stderr, /CALLED wipe_everything/,
    "the harness called a destructive tool");
  assert.doesNotMatch(report.stderr, /CALLED needs_an_argument/,
    "the harness invented arguments for a tool that required them");
  // And it says so rather than passing quietly.
  assert.equal(verdicts(report)["progress.needs-a-token"], "n/a");
  assert.match(
    report.findings.find((f) => f.id === "progress.needs-a-token").note,
    /nothing destructive is called/);
});

test("a server that answers nothing is reported as unreachable, not as passing", async () => {
  const report = await conform({
    command: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 3000)"] },
    timeoutMs: 400,
  });
  assert.equal(report.era, "unreachable");
  assert.equal(report.failed, 1);
  assert.equal(report.passed, 0, "an unreachable server passed a check");
});

test("the cli prints a matrix and exits 1 only when something failed", async () => {
  const ok = await run(process.execPath, [CLI, "conform", "--", process.execPath, GOOD]);
  assert.match(ok.stdout, /modern negotiation/);
  assert.match(ok.stdout, /Every check that applies here passed/);

  await assert.rejects(
    () => run(process.execPath, [CLI, "conform", "--", process.execPath, BROKEN]),
    (error) => {
      assert.equal(error.code, 1, "a failing run did not exit 1");
      assert.match(error.stdout, /FAIL {2}tools\.names-unique/);
      return true;
    });
});

test("--json gives the same report a pipe can read", async () => {
  const { stdout } = await run(process.execPath,
    [CLI, "conform", "--json", "--", process.execPath, GOOD]);
  const report = JSON.parse(stdout);
  assert.equal(report.era, "modern");
  assert.ok(Array.isArray(report.findings));
  assert.equal(report.findings.length, report.passed + report.failed
    + report.notApplicable + report.unknown, "the tally does not add up");
});

test("--only runs just the checks named", async () => {
  const report = await conform({
    command: { command: process.execPath, args: [GOOD] },
    only: ["tools.names-unique"],
    timeoutMs: 4000,
  });
  assert.deepEqual(report.findings.map((f) => f.id), ["tools.names-unique"]);
});
