import test from "node:test";
import assert from "node:assert/strict";
import { parseMeta, hasCapability, requireCapabilities } from "../../dist/protocol/meta.js";
import { PROTOCOL_VERSION, META } from "../../dist/protocol/version.js";
import { CODE } from "../../dist/protocol/errors.js";

const meta = (over = {}) => ({
  _meta: {
    [META.protocolVersion]: PROTOCOL_VERSION,
    [META.clientCapabilities]: {},
    ...over,
  },
});

test("accepts a request carrying both required fields", () => {
  const parsed = parseMeta("tools/list", meta());
  assert.equal(parsed.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(parsed.clientCapabilities, {});
});

test("rejects a missing protocolVersion with -32602", () => {
  const bad = { _meta: { [META.clientCapabilities]: {} } };
  assert.throws(() => parseMeta("tools/list", bad), (error) => {
    assert.equal(error.code, CODE.invalidParams);
    assert.deepEqual(error.data.missing, [META.protocolVersion]);
    return true;
  });
});

test("rejects missing clientCapabilities with -32602", () => {
  const bad = { _meta: { [META.protocolVersion]: PROTOCOL_VERSION } };
  assert.throws(() => parseMeta("tools/list", bad), (error) => {
    assert.deepEqual(error.data.missing, [META.clientCapabilities]);
    return true;
  });
});

test("rejects a request with no _meta at all, naming both fields", () => {
  assert.throws(() => parseMeta("tools/list", {}), (error) => {
    assert.equal(error.code, CODE.invalidParams);
    assert.equal(error.data.missing.length, 2);
    return true;
  });
});

test("rejects a version it does not implement with -32022 and the supported list", () => {
  const old = meta({ [META.protocolVersion]: "2025-11-25" });
  assert.throws(() => parseMeta("tools/call", old), (error) => {
    assert.equal(error.code, CODE.unsupportedProtocolVersion);
    assert.deepEqual(error.data.supported, [PROTOCOL_VERSION]);
    assert.equal(error.data.requested, "2025-11-25");
    return true;
  });
});

test("server/discover answers a version it does not implement, because it is the probe", () => {
  const old = meta({ [META.protocolVersion]: "2025-11-25" });
  const parsed = parseMeta("server/discover", old);
  assert.equal(parsed.protocolVersion, "2025-11-25");
});

test("server/discover still requires the fields to be present", () => {
  assert.throws(() => parseMeta("server/discover", {}), (error) => {
    assert.equal(error.code, CODE.invalidParams);
    return true;
  });
});

test("carries progressToken, logLevel and clientInfo through", () => {
  const parsed = parseMeta("tools/call", meta({
    [META.progressToken]: "p1",
    [META.logLevel]: "info",
    [META.clientInfo]: { name: "claude-code", version: "2.1.237" },
  }));
  assert.equal(parsed.progressToken, "p1");
  assert.equal(parsed.logLevel, "info");
  assert.equal(parsed.clientInfo.name, "claude-code");
});

test("hasCapability walks a dotted path", () => {
  const caps = { elicitation: { form: {} }, roots: { listChanged: true } };
  assert.equal(hasCapability(caps, "elicitation.form"), true);
  assert.equal(hasCapability(caps, "elicitation.url"), false);
  assert.equal(hasCapability(caps, "roots.listChanged"), true);
  assert.equal(hasCapability(caps, "sampling"), false);
});

test("hasCapability treats an explicit false as absent", () => {
  assert.equal(hasCapability({ roots: { listChanged: false } }, "roots.listChanged"), false);
});

test("requireCapabilities raises -32021 naming every missing capability", () => {
  assert.throws(() => requireCapabilities({}, ["elicitation.form", "sampling"]), (error) => {
    assert.equal(error.code, CODE.missingRequiredClientCapability);
    assert.deepEqual(error.data.requiredCapabilities, ["elicitation.form", "sampling"]);
    return true;
  });
});
