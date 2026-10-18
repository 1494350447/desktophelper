import test from "node:test";
import assert from "node:assert/strict";
import { S, SchemaError } from "../src/shared/schema.ts";
import { AppError } from "../src/shared/result.ts";
import { defaultSettings } from "../src/shared/models.ts";
import { payloadSchemas, settingsSchema, validatePayload } from "../src/shared/protocol.ts";

test("string validator enforces min and max", () => {
  const schema = S.string({ min: 2, max: 4 });
  assert.equal(schema.parse("abc"), "abc");
  assert.throws(() => schema.parse("a"), SchemaError);
  assert.throws(() => schema.parse("abcde"), SchemaError);
});

test("object validator rejects unknown keys", () => {
  const schema = S.object({ name: S.string() });
  assert.deepEqual(schema.parse({ name: "ok" }), { name: "ok" });
  assert.throws(() => schema.parse({ name: "ok", extra: 1 }), SchemaError);
});

test("optional fields accept missing values", () => {
  const schema = S.object({ a: S.string(), b: S.number().optional() });
  assert.deepEqual(schema.parse({ a: "x" }), { a: "x", b: undefined });
});

test("validate wraps schema errors into AppError", () => {
  const schema = S.object({ n: S.number({ min: 1 }) });
  try {
    S.validate(schema, { n: 0 });
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "VALIDATION");
  }
});

test("default settings satisfy the settings schema", () => {
  const parsed = S.validate(settingsSchema, defaultSettings());
  assert.equal(parsed.llm.provider, "mock");
  assert.equal(parsed.trigger.maxAnswers, 5);
  assert.equal(parsed.privacy.excludeFromCapture, true);
});

test("settings schema rejects invalid overlay opacity", () => {
  const settings = defaultSettings();
  settings.overlay.opacity = 1.5;
  assert.throws(() => S.validate(settingsSchema, settings), AppError);
});

test("settings schema rejects non-boolean capture protection", () => {
  const settings = defaultSettings() as unknown as { privacy: { excludeFromCapture: unknown } };
  settings.privacy.excludeFromCapture = "yes";
  assert.throws(() => S.validate(settingsSchema, settings), AppError);
});

test("there is no account or auth channel in the rewrite", () => {
  const channels = Object.keys(payloadSchemas);
  assert.equal(channels.some((channel) => channel.startsWith("auth.")), false);
  assert.equal(channels.some((channel) => channel.includes("login")), false);
  assert.equal(channels.some((channel) => channel.includes("account")), false);
});

test("empty payload is accepted for app.snapshot", () => {
  assert.deepEqual(validatePayload("app.snapshot", undefined), {});
  assert.deepEqual(validatePayload("app.snapshot", {}), {});
});
