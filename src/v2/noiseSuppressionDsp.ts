// Pure, dependency-free DSP helpers used by the noise-suppression pipeline.
// Kept free of AudioContext/WebAudio types so they're directly unit-testable
// under plain Vitest/jsdom without any Web Audio stubbing.

export interface RmsPeak {
  rms: number;
  peak: number;
}

export function computeRmsAndPeak(input: Float32Array): RmsPeak {
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < input.length; i++) {
    const sample = input[i];
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, input.length));
  return { rms, peak };
}

/** One-step exponential smoothing toward `targetGain`, using `attack` when
 * ramping up and `release` when ramping down — matches the envelope shape
 * used throughout this pipeline's gating. */
export function stepGain(
  currentGain: number,
  targetGain: number,
  attack: number,
  release: number,
): number {
  const smoothing = targetGain > currentGain ? attack : release;
  return currentGain + (targetGain - currentGain) * smoothing;
}

export function float32ToInt16(samples: ArrayLike<number>): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clipped = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = clipped < 0 ? clipped * 32768 : clipped * 32767;
  }
  return pcm;
}

/**
 * Second-order (RBJ cookbook) Butterworth-Q lowpass biquad, Direct Form I.
 * Used as the anti-alias filter ahead of integer-factor decimation.
 */
export class BiquadLowpass {
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(sampleRate: number, cutoffHz: number, q = 0.707) {
    const omega = (2 * Math.PI * cutoffHz) / sampleRate;
    const alpha = Math.sin(omega) / (2 * q);
    const cosw = Math.cos(omega);
    const b0 = (1 - cosw) / 2;
    const b1 = 1 - cosw;
    const b2 = (1 - cosw) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * cosw;
    const a2 = 1 - alpha;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  process(x: number): number {
    const y =
      this.b0 * x +
      this.b1 * this.x1 +
      this.b2 * this.x2 -
      this.a1 * this.y1 -
      this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * Anti-aliased integer-factor downsampler (e.g. 48kHz -> 16kHz at factor 3).
 * Stateful across `processBlock` calls so it can run on a streamed sequence
 * of audio-callback-sized blocks.
 */
export class Decimator {
  private readonly filter: BiquadLowpass;
  private readonly factor: number;
  private counter = 0;

  constructor(factor: number, sampleRate: number, cutoffHz: number) {
    if (factor < 1 || !Number.isInteger(factor)) {
      throw new Error(
        `[Decimator] factor must be a positive integer, got ${factor}`,
      );
    }
    this.factor = factor;
    this.filter = new BiquadLowpass(sampleRate, cutoffHz);
  }

  processBlock(input: Float32Array): Float32Array {
    const out: number[] = [];
    for (let i = 0; i < input.length; i++) {
      const filtered = this.filter.process(input[i]);
      if (this.counter === 0) out.push(filtered);
      this.counter = (this.counter + 1) % this.factor;
    }
    return Float32Array.from(out);
  }
}

/** Simple probability-threshold gain target for the VAD-driven noise gate. */
export function computeVadTargetGain(
  isSpeechProbability: number,
  positiveSpeechThreshold: number,
  noiseGateAttenuation: number,
): number {
  return isSpeechProbability >= positiveSpeechThreshold
    ? 1
    : noiseGateAttenuation;
}

/**
 * Encodes mono 16-bit PCM as a WAV file (44-byte RIFF/fmt/data header +
 * little-endian PCM body). Returns a plain ArrayBuffer — no Blob dependency —
 * so it's directly testable by re-reading the header back out.
 */
export function encodeWavPcm16(
  samples: Int16Array,
  sampleRate: number,
): ArrayBuffer {
  const bitsPerSample = 16;
  const numChannels = 1;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeAscii(offset: number, text: string): void {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size (PCM)
  view.setUint16(20, 1, true); // audio format: 1 = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += bytesPerSample) {
    view.setInt16(offset, samples[i], true);
  }

  return buffer;
}
