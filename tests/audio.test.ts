import test from "node:test";
import assert from "node:assert/strict";
import {
  SpeechSegmenter,
  downmixToMono,
  float32ToInt16,
  pcm16ToWav,
  resampleLinear,
} from "../src/shared/audio.ts";

const RATE = 16000;

function tone(ms: number, amplitude = 0.2): Int16Array {
  const samples = Math.round((RATE * ms) / 1000);
  const pcm = new Int16Array(samples);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.sin((2 * Math.PI * 220 * index) / RATE) * amplitude;
    pcm[index] = Math.round(value * 32767);
  }
  return pcm;
}

function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((RATE * ms) / 1000));
}

function join(parts: Int16Array[]): Int16Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

test("float32ToInt16 clips and preserves polarity", () => {
  const pcm = float32ToInt16(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]));
  assert.equal(pcm[0], 0);
  assert.ok(pcm[1] > 16000 && pcm[1] < 16400);
  assert.ok(pcm[2] < -16000 && pcm[2] > -16400);
  assert.equal(pcm[3], 32767);
  assert.equal(pcm[4], -32768);
  assert.equal(pcm[5], 32767);
  assert.equal(pcm[6], -32768);
});

test("downmixToMono averages channels", () => {
  const mono = downmixToMono([new Float32Array([1, 0]), new Float32Array([0, 1])]);
  assert.deepEqual(Array.from(mono), [0.5, 0.5]);
});

test("resampleLinear changes length for 48k to 16k", () => {
  const input = new Float32Array(4800).fill(0.25);
  const output = resampleLinear(input, 48000, 16000);
  assert.equal(output.length, 1600);
  assert.ok(output.every((value) => Math.abs(value - 0.25) < 1e-6));
});

test("pcm16ToWav writes a mono 16-bit PCM header", () => {
  const pcm = tone(100);
  const wav = pcm16ToWav(pcm, RATE);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const ascii = (offset: number, length: number): string =>
    String.fromCharCode(...wav.subarray(offset, offset + length));
  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(ascii(12, 4), "fmt ");
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), RATE);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), pcm.length * 2);
  assert.equal(wav.byteLength, 44 + pcm.length * 2);
});

test("segmenter ignores silence", () => {
  const segmenter = new SpeechSegmenter({ sampleRate: RATE });
  assert.equal(segmenter.push(silence(1000)).length, 0);
  assert.equal(segmenter.flush().length, 0);
});

test("segmenter emits one utterance after speech followed by silence", () => {
  const segmenter = new SpeechSegmenter({
    sampleRate: RATE,
    startThreshold: 0.01,
    endThreshold: 0.008,
    minSpeechMs: 200,
    endSilenceMs: 600,
  });
  const first = segmenter.push(join([silence(300), tone(700), silence(800)]));
  assert.equal(first.length, 1);
  assert.ok(first[0].startMs <= 300);
  assert.ok(first[0].endMs >= 950);
  assert.ok(first[0].pcm.length > 16000 * 0.6);
});

test("segmenter keeps speech split across arbitrary chunk boundaries", () => {
  const segmenter = new SpeechSegmenter({ sampleRate: RATE, minSpeechMs: 200, endSilenceMs: 500 });
  const samples = join([tone(600), silence(700)]);
  const utterances: ReturnType<SpeechSegmenter["push"]> = [];
  for (let offset = 0; offset < samples.length; offset += 1600) {
    utterances.push(...segmenter.push(samples.subarray(offset, offset + 1600)));
  }
  assert.equal(utterances.length, 1);
  assert.ok(utterances[0].endMs >= 550);
});

test("flush emits a trailing utterance when recording stops", () => {
  const segmenter = new SpeechSegmenter({ sampleRate: RATE, minSpeechMs: 200 });
  assert.equal(segmenter.push(tone(500)).length, 0);
  const utterances = segmenter.flush();
  assert.equal(utterances.length, 1);
  assert.ok(utterances[0].pcm.length >= 16000 * 0.45);
});

test("segmenter splits very long speech at the configured limit", () => {
  const segmenter = new SpeechSegmenter({
    sampleRate: RATE,
    minSpeechMs: 200,
    endSilenceMs: 500,
    maxUtteranceMs: 800,
  });
  const utterances = segmenter.push(tone(2200));
  assert.equal(utterances.length, 2);
  assert.ok(utterances.every((entry) => entry.endMs - entry.startMs >= 750));
});

test("segmenter ignores a single short click", () => {
  const segmenter = new SpeechSegmenter({ sampleRate: RATE, minSpeechMs: 220, endSilenceMs: 500 });
  const utterances = segmenter.push(join([tone(40), silence(900)]));
  assert.equal(utterances.length, 0);
});
