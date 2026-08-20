import test from "node:test";
import assert from "node:assert/strict";
import { toJsonSchema, validate, toolDescriptor, viewContents } from "../../dist/runtime/registry.js";
import { APP_MIME } from "../../dist/protocol/version.js";
import { CODE } from "../../dist/protocol/errors.js";

test("a tool with no parameters still publishes an object schema, never null", () => {
  const schema = toJsonSchema(undefined);
  assert.deepEqual(schema, { type: "object" });
  assert.notEqual(schema, null);
});

test("a raw JSON Schema is published exactly as the author wrote it", () => {
  const raw = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
  assert.deepEqual(toJsonSchema(raw), raw);
});

test("a Standard Schema that cannot describe itself still yields a valid object schema", () => {
  const standard = { "~standard": { version: 1, vendor: "test", validate: (v) => ({ value: v }) } };
  assert.deepEqual(toJsonSchema(standard), { type: "object" });
});

test("Standard Schema issues become -32602 with the paths intact", async () => {
  const failing = {
    "~standard": {
      version: 1, vendor: "test",
      validate: () => ({ issues: [{ message: "expected string", path: ["q"] }] }),
    },
  };
  await assert.rejects(() => validate(failing, {}), (error) => {
    assert.equal(error.code, CODE.invalidParams);
    assert.equal(error.data.issues[0].message, "expected string");
    assert.deepEqual(error.data.issues[0].path, ["q"]);
    return true;
  });
});

test("a raw JSON Schema still enforces top-level required keys", async () => {
  const raw = { type: "object", required: ["id"] };
  await assert.rejects(() => validate(raw, {}), (error) => {
    assert.deepEqual(error.data.missing, ["id"]);
    return true;
  });
  assert.deepEqual(await validate(raw, { id: "x" }), { id: "x" });
});

test("a tool that names a view carries it in _meta.ui", () => {
  const descriptor = toolDescriptor({
    name: "list", definition: { view: "ui://app/table", visibility: ["model", "app"] },
  });
  assert.equal(descriptor._meta.ui.resourceUri, "ui://app/table");
  assert.deepEqual(descriptor._meta.ui.visibility, ["model", "app"]);
});

test("a tool with no view carries no _meta at all", () => {
  const descriptor = toolDescriptor({ name: "plain", definition: {} });
  assert.equal(descriptor._meta, undefined);
  assert.deepEqual(descriptor.inputSchema, { type: "object" });
});

test("a view is served with the Apps mime type and a csp, both defaulted", () => {
  const contents = viewContents({ uri: "ui://app/table", html: "<p>x</p>" });
  assert.equal(contents.mimeType, APP_MIME);
  assert.equal(contents.text, "<p>x</p>");
  assert.deepEqual(contents._meta.ui.csp, {});
  assert.equal(contents._meta.ui.prefersBorder, true);
});
