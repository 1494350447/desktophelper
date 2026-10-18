export type EchoGateInput = {
  micLevel: number;
  systemLevel: number;
  systemActiveAt: number;
  now: number;
};

export type EchoGateOptions = {
  systemFloor?: number;
  micFloor?: number;
  dominanceRatio?: number;
  holdMs?: number;
};

/**
 * Microphone echo gate for desktop loopback capture.
 *
 * The microphone keeps hearing whatever the speakers play. While system audio
 * is carrying speech, microphone energy that is not clearly louder than the
 * loopback is treated as speaker leakage. A short hold keeps the reverb tail
 * from reopening the microphone between syllables.
 */
export function shouldMuteMicrophone(input: EchoGateInput, options: EchoGateOptions = {}): boolean {
  const systemFloor = options.systemFloor ?? 0.008;
  const micFloor = options.micFloor ?? 0.012;
  const dominanceRatio = options.dominanceRatio ?? 1.8;
  const holdMs = options.holdMs ?? 380;
  if (!Number.isFinite(input.micLevel) || !Number.isFinite(input.systemLevel)) return false;
  if (!Number.isFinite(input.now) || !Number.isFinite(input.systemActiveAt)) return false;
  if (input.now - input.systemActiveAt > holdMs) return false;
  if (input.systemLevel < systemFloor) return false;
  return input.micLevel < Math.max(micFloor, input.systemLevel * dominanceRatio);
}
