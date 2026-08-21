import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "..", "examples", "titanic", "dist", "server.mjs");

/* The Titanic example over a real pipe, opened the way a shipping host opens
 * it: `initialize`, an older protocol version, and no `_meta` on anything.
 *
 * The numbers are checked against the dataset's own well-known values rather
 * than against whatever this code currently produces. 891 aboard, 342
 * survived, 38.38 per cent overall, 62.96 in first class, 74.20 for women.
 * Anybody can look those up, which is the point: a test that only agrees with
 * itself cannot notice the parser losing a row. */

function connect({ strict = false } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(strict ? { NGMCP_STRICT: "1" } : {}) },
  });
  const waiters = new Map();
  let buffer = "", id = 0;
  child.stderr.resume();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (waiters.has(message.id)) { waiters.get(message.id)(message); waiters.delete(message.id); }
    }
  });
  const rpc = (method, params = {}) => new Promise((resolve) => {
    const rid = ++id;
    waiters.set(rid, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: rid, method, params })}\n`);
  });
  const call = async (name, args = {}) => {
    const answer = await rpc("tools/call", { name, arguments: args });
    return answer;
  };
  return {
    rpc, call,
    text: async (name, args) => (await call(name, args)).result.content[0].text,
    data: async (name, args) => (await call(name, args)).result.structuredContent,
    async close() {
      try { child.stdin.end(); } catch { /* gone */ }
      child.kill("SIGKILL");
      for (const s of [child.stdin, child.stdout, child.stderr]) {
        try { s?.destroy(); } catch { /* gone */ }
      }
      child.unref();
    },
  };
}

test("a host that opens with initialize reaches it, and one that does not is told why", async () => {
  const shimmed = connect();
  try {
    const opened = await shimmed.rpc("initialize", {
      protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "claude-code", version: "2.1.238" },
    });
    assert.equal(opened.result.protocolVersion, "2025-06-18",
      "the shim answered in a version the client did not offer");
    assert.equal(opened.result.serverInfo.name, "titanic");
    const listed = await shimmed.rpc("tools/list");
    assert.deepEqual(listed.result.tools.map((t) => t.name).sort(),
      ["age_distribution", "passengers", "survival_by", "who_survived"]);
  } finally { await shimmed.close(); }

  const strict = connect({ strict: true });
  try {
    // No shim: the required `_meta` is missing and the server says exactly
    // which fields, rather than failing silently.
    const refused = await strict.rpc("tools/list");
    assert.equal(refused.error.code, -32602);
    assert.match(refused.error.message, /protocolVersion/);
  } finally { await strict.close(); }
});

test("891 passengers, 342 survived: the dataset arrives intact", async () => {
  /* Names in this file contain commas inside quotes, so a parser that splits
   * on commas loses columns rather than rows and the totals still look
   * plausible. These numbers are the check. */
  const c = connect();
  try {
    await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const out = await c.data("survival_by", { by: "class" });
    assert.equal(out.overall.total, 891);
    assert.equal(out.overall.survived, 342);
    assert.equal(out.overall.rate, 38.38);
    assert.deepEqual(out.bands.map((b) => b.band),
      ["First class", "Second class", "Third class"]);
    assert.deepEqual(out.bands.map((b) => b.total), [216, 184, 491]);
    assert.equal(out.bands[0].rate, 62.96);
  } finally { await c.close(); }
});

test("women and men are 74.2 and 18.9, which is the point of the dataset", async () => {
  const c = connect();
  try {
    await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const out = await c.data("survival_by", { by: "sex" });
    const [women, men] = out.bands;
    assert.equal(women.total, 314);
    assert.equal(men.total, 577);
    assert.equal(women.rate, 74.2);
    assert.equal(men.rate, 18.89);
  } finally { await c.close(); }
});

test("the chart in the answer carries the same numbers as the data", async () => {
  /* The two halves of the answer are for different readers and must not
   * disagree. A host with no frame gets only the text, and if the text says
   * something the data does not, nobody downstream can tell. */
  const c = connect();
  try {
    await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const answer = await c.call("survival_by", { by: "class" });
    const chart = answer.result.content[0].text;
    const data = answer.result.structuredContent;
    for (const band of [...data.bands, data.overall]) {
      assert.ok(chart.includes(band.band), `${band.band} is missing from the chart`);
      assert.ok(chart.includes(band.rate.toFixed(1)),
        `${band.band} says ${band.rate} in the data and not in the chart`);
    }
  } finally { await c.close(); }
});

test("a rate is drawn against 100, so 63 per cent is not a full bar", async () => {
  const c = connect();
  try {
    await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const chart = await c.text("survival_by", { by: "class" });
    const widths = chart.split("\n")
      .filter((l) => /%$/.test(l))
      .map((l) => (l.match(/[█▏▎▍▌▋▊▉]/g) ?? []).length);
    assert.equal(widths.length, 4);
    assert.ok(Math.max(...widths) < 30,
      `the longest bar is ${Math.max(...widths)} of 34, so a rate is being scaled to itself`);
    // And the overall line is the same length in both charts, which is only
    // true if they share a scale.
    const bySex = await c.text("survival_by", { by: "sex" });
    const overall = (text) => text.split("\n").find((l) => l.startsWith("Everyone aboard"));
    assert.equal(
      (overall(chart).match(/[█▏▎▍▌▋▊▉]/g) ?? []).length,
      (overall(bySex).match(/[█▏▎▍▌▋▊▉]/g) ?? []).length);
  } finally { await c.close(); }
});

test("an unrecorded age is not counted as zero", async () => {
  /* 177 passengers have no age. Treating a missing value as zero pulls the
   * median down and invents 177 newborns. */
  const c = connect();
  try {
    await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const out = await c.data("age_distribution", {});
    assert.equal(out.counted, 714);
    assert.equal(out.unknown, 177);
    assert.equal(out.counted + out.unknown, 891);
    assert.equal(out.median, 28);
    assert.ok(!out.ages.includes(0), "an unrecorded age became a zero");
    assert.match(out.chart, /Median age 28/);
  } finally { await c.close(); }
});

test("the passenger table is markdown, and says what it left out", async () => {
  const c = connect();
  try {
    await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const out = await c.data("passengers", { klass: 1, sex: "female", limit: 5 });
    assert.equal(out.matched, 94);
    assert.equal(out.shown, 5);
    assert.match(out.table, /^\| Name/m);
    assert.match(out.table, /and 89 more/);
    // The most expensive ticket in the dataset, which is a name worth being
    // able to check by eye.
    assert.match(out.table, /Ward, Miss\. Anna/);
    assert.match(out.table, /£512\.33/);
    // A comma inside a quoted name survived the parser.
    assert.ok(out.passengers.every((p) => p.name.includes(",")),
      "a name lost its comma, so the CSV was split naively");
  } finally { await c.close(); }
});

test("the diagram is a fenced mermaid block whose numbers add up", async () => {
  const c = connect();
  try {
    await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const out = await c.data("who_survived", {});
    assert.equal(out.counts.survived + out.counts.lost, out.counts.aboard);
    assert.match(out.diagram, /```mermaid\nflowchart LR/);
    assert.match(out.diagram, /\n```$/);
    assert.match(out.diagram, /lived\[\("Survived: 342"\)\]/);
    assert.match(out.diagram, /women -->\|"233 of 314"\| lived/);
  } finally { await c.close(); }
});
