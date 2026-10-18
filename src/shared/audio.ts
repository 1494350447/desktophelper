export type SpeechUtterance = {
  pcm: Int16Array;
  startMs: number;
  endMs: number;
};

export type SpeechSegmenterOptions = {
  sampleRate?: number;
  frameMs?: number;
  startThreshold?: number;
  endThreshold?: number;
  minSpeechMs?: number;
  endSilenceMs?: number;
  maxUtteranceMs?: number;
  preRollMs?: number;
  tailMs?: number;
};

type AudioFrame = {
  pcm: Int16Array;
  startSample: number;
};

function concatInt16(parts: Int16Array[]): Int16Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function float32ToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Number.isFinite(input[index]) ? input[index] : 0;
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    output[index] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return output;
}

export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const length = Math.min(...channels.map((channel) => channel.length));
  const mono = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[index];
    mono[index] = sum / channels.length;
  }
  return mono;
}

export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (input.length === 0 || fromRate === toRate) return input;
  const length = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const output = new Float32Array(length);
  const ratio = fromRate / toRate;
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    output[index] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
}

export function pcm16ToWav(pcm: Int16Array, sampleRate = 16000): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let index = 0; index < pcm.length; index += 1) {
    view.setInt16(offset, pcm[index], true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function frameEnergy(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  let sumSquares = 0;
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = pcm[index] / 32768;
    sum += sample;
    sumSquares += sample * sample;
  }
  const mean = sum / pcm.length;
  const variance = sumSquares / pcm.length - mean * mean;
  return Math.sqrt(Math.max(0, variance));
}

export class SpeechSegmenter {
  private readonly sampleRate: number;
  private readonly frameSamples: number;
  private readonly frameMs: number;
  private readonly startThreshold: number;
  private readonly endThreshold: number;
  private readonly minSpeechMs: number;
  private readonly endSilenceMs: number;
  private readonly maxUtteranceMs: number;
  private readonly preRollFrames: number;
  private readonly tailFrames: number;

  private pending: Int16Array = new Int16Array(0);
  private nextFrameStart = 0;
  private preRoll: AudioFrame[] = [];
  private frames: AudioFrame[] = [];
  private inSpeech = false;
  private speechMs = 0;
  private utteranceMs = 0;
  private silentFrames = 0;
  private utteranceStartSample = 0;

  constructor(options: SpeechSegmenterOptions = {}) {
    this.sampleRate = Math.max(8000, Math.round(options.sampleRate ?? 16000));
    const requestedFrameMs = Math.max(10, options.frameMs ?? 20);
    this.frameSamples = Math.max(1, Math.round((this.sampleRate * requestedFrameMs) / 1000));
    this.frameMs = (this.frameSamples / this.sampleRate) * 1000;
    this.startThreshold = Math.max(0.001, options.startThreshold ?? 0.012);
    this.endThreshold = Math.max(0.0005, options.endThreshold ?? 0.008);
    this.minSpeechMs = Math.max(60, options.minSpeechMs ?? 220);
    this.endSilenceMs = Math.max(this.frameMs, options.endSilenceMs ?? 650);
    this.maxUtteranceMs = Math.max(this.minSpeechMs, options.maxUtteranceMs ?? 12000);
    this.preRollFrames = Math.max(0, Math.round((options.preRollMs ?? 240) / this.frameMs));
    this.tailFrames = Math.max(0, Math.round((options.tailMs ?? 180) / this.frameMs));
  }

  push(input: Int16Array): SpeechUtterance[] {
    if (input.length === 0) return [];
    const combined = this.pending.length === 0 ? input : concatInt16([this.pending, input]);
    const utterances: SpeechUtterance[] = [];
    let offset = 0;
    while (combined.length - offset >= this.frameSamples) {
      const frame = combined.subarray(offset, offset + this.frameSamples);
      const emitted = this.processFrame(frame, this.nextFrameStart);
      if (emitted) utterances.push(emitted);
      offset += this.frameSamples;
      this.nextFrameStart += this.frameSamples;
    }
    this.pending = combined.slice(offset);
    return utterances;
  }

  flush(): SpeechUtterance[] {
    const utterances: SpeechUtterance[] = [];
    if (this.pending.length > 0) {
      const emitted = this.processFrame(this.pending, this.nextFrameStart);
      if (emitted) utterances.push(emitted);
      this.nextFrameStart += this.pending.length;
      this.pending = new Int16Array(0);
    }
    if (this.inSpeech && this.speechMs >= this.minSpeechMs) {
      const utterance = this.emit(false);
      if (utterance) utterances.push(utterance);
    }
    this.reset();
    return utterances;
  }

  reset(keepPreRoll: AudioFrame[] = []): void {
    this.pending = new Int16Array(0);
    this.preRoll = keepPreRoll;
    this.frames = [];
    this.inSpeech = false;
    this.speechMs = 0;
    this.utteranceMs = 0;
    this.silentFrames = 0;
    this.utteranceStartSample = 0;
  }

  private processFrame(frame: Int16Array, startSample: number): SpeechUtterance | null {
    const energy = frameEnergy(frame);
    if (!this.inSpeech) {
      if (energy < this.startThreshold) {
        this.preRoll.push({ pcm: frame.slice(), startSample });
        if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
        return null;
      }
      this.inSpeech = true;
      this.utteranceStartSample = this.preRoll[0]?.startSample ?? startSample;
      this.frames = this.preRoll.map((entry) => ({ pcm: entry.pcm, startSample: entry.startSample }));
      this.preRoll = [];
      this.frames.push({ pcm: frame.slice(), startSample });
      this.speechMs = this.frameMs;
      this.utteranceMs = this.frameMs;
      this.silentFrames = 0;
      return null;
    }

    this.frames.push({ pcm: frame.slice(), startSample });
    this.utteranceMs += this.frameMs;
    if (energy >= this.endThreshold) {
      this.speechMs += this.frameMs;
      this.silentFrames = 0;
    } else {
      this.silentFrames += 1;
    }

    if (this.silentFrames * this.frameMs >= this.endSilenceMs && this.speechMs >= this.minSpeechMs) {
      return this.emit(true);
    }
    if (this.utteranceMs >= this.maxUtteranceMs) return this.emit(false);
    return null;
  }

  private emit(trimTrailingSilence: boolean): SpeechUtterance | null {
    let selected = this.frames;
    let carryOver: AudioFrame[] = [];
    if (trimTrailingSilence) {
      const drop = Math.max(0, this.silentFrames - this.tailFrames);
      if (drop > 0) selected = selected.slice(0, Math.max(1, selected.length - drop));
      const keep = Math.min(this.silentFrames, this.preRollFrames);
      if (keep > 0) carryOver = this.frames.slice(this.frames.length - keep);
    }
    if (selected.length === 0) {
      this.reset();
      return null;
    }
    const first = selected[0];
    const last = selected[selected.length - 1];
    const utterance: SpeechUtterance = {
      pcm: concatInt16(selected.map((entry) => entry.pcm)),
      startMs: (Math.min(this.utteranceStartSample, first.startSample) / this.sampleRate) * 1000,
      endMs: ((last.startSample + last.pcm.length) / this.sampleRate) * 1000,
    };
    this.reset(carryOver);
    return utterance;
  }
}
