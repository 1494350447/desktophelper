import test from "node:test";
import assert from "node:assert/strict";
import { shouldMuteMicrophone } from "../src/shared/echo.ts";

test("microphone is muted while system speech dominates", () => {
  assert.equal(
    shouldMuteMicrophone({ micLevel: 0.02, systemLevel: 0.05, systemActiveAt: 1000, now: 1200 }),
    true,
  );
  assert.equal(
    shouldMuteMicrophone({ micLevel: 0.06, systemLevel: 0.05, systemActiveAt: 1000, now: 1200 }),
    true,
  );
});

test("clearly louder near-field speech keeps the microphone open", () => {
  assert.equal(
    shouldMuteMicrophone({ micLevel: 0.14, systemLevel: 0.05, systemActiveAt: 1000, now: 1200 }),
    false,
  );
});

test("microphone reopens after the system speech hold expires", () => {
  assert.equal(
    shouldMuteMicrophone({ micLevel: 0.02, systemLevel: 0.05, systemActiveAt: 1000, now: 1500 }),
    false,
  );
});

test("quiet system audio does not mute the microphone", () => {
  assert.equal(
    shouldMuteMicrophone({ micLevel: 0.01, systemLevel: 0.003, systemActiveAt: 1000, now: 1100 }),
    false,
  );
});

test("invalid levels never block the microphone", () => {
  assert.equal(
    shouldMuteMicrophone({ micLevel: Number.NaN, systemLevel: 0.05, systemActiveAt: 1000, now: 1100 }),
    false,
  );
});
