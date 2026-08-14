import { describe, expect, it } from "vitest";
import {
  BiquadLowpass,
  Decimator,
  computeRmsAndPeak,
  computeVadTargetGain,
  encodeWavPcm16,
  float32ToInt16,
  stepGain,
} from "../src/v2/noiseSuppressionDsp";

function sineWave(freqHz: number, sampleRate: number, length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

describe("computeRmsAndPeak", () => {
  it("returns 0 rms/peak for silence", () => {
    const { rms, peak } = computeRmsAndPeak(new Float32Array(256));
    expect(rms).toBe(0);
    expect(peak).toBe(0);
  });

  it("computes rms and peak for a full-scale square wave", () => {
    const input = new Float32Array([1, -1, 1, -1]);
    const { rms, peak } = computeRmsAndPeak(input);
    expect(rms).toBeCloseTo(1, 5);
    expect(peak).toBeCloseTo(1, 5);
  });

  it("a quieter signal has proportionally lower rms", () => {
    const loud = computeRmsAndPeak(new Float32Array([0.5, -0.5, 0.5, -0.5]));
    const quiet = computeRmsAndPeak(new Float32Array([0.1, -0.1, 0.1, -0.1]));
    expect(quiet.rms).toBeLessThan(loud.rms);
  });
});

describe("stepGain", () => {
  it("moves toward target using the attack rate when ramping up", () => {
    const next = stepGain(0, 1, 0.2, 0.05);
    expect(next).toBeCloseTo(0.2, 5);
  });

  it("moves toward target using the release rate when ramping down", () => {
    const next = stepGain(1, 0, 0.2, 0.05);
    expect(next).toBeCloseTo(0.95, 5);
  });

  it("converges to the target over repeated steps", () => {
    let gain = 0;
    for (let i = 0; i < 200; i++) {
      gain = stepGain(gain, 1, 0.2, 0.05);
    }
    expect(gain).toBeCloseTo(1, 5);
  });
});

describe("float32ToInt16", () => {
  it("maps the full-scale range correctly", () => {
    const pcm = float32ToInt16([1, -1, 0]);
    expect(pcm[0]).toBe(32767);
    expect(pcm[1]).toBe(-32768);
    expect(pcm[2]).toBe(0);
  });

  it("clips values outside [-1, 1]", () => {
    const pcm = float32ToInt16([2, -2]);
    expect(pcm[0]).toBe(32767);
    expect(pcm[1]).toBe(-32768);
  });
});

describe("BiquadLowpass", () => {
  it("passes a low frequency tone through with little attenuation", () => {
    const sampleRate = 48000;
    const filter = new BiquadLowpass(sampleRate, 7000);
    const input = sineWave(200, sampleRate, 4096);
    let peakOut = 0;
    // Skip the filter's settling transient before measuring steady-state peak.
    for (let i = 0; i < input.length; i++) {
      const y = filter.process(input[i]);
      if (i > 1024) peakOut = Math.max(peakOut, Math.abs(y));
    }
    expect(peakOut).toBeGreaterThan(0.8);
  });

  it("attenuates a frequency well above cutoff", () => {
    const sampleRate = 48000;
    const filter = new BiquadLowpass(sampleRate, 7000);
    const input = sineWave(18000, sampleRate, 4096);
    let peakOut = 0;
    for (let i = 0; i < input.length; i++) {
      const y = filter.process(input[i]);
      if (i > 1024) peakOut = Math.max(peakOut, Math.abs(y));
    }
    expect(peakOut).toBeLessThan(0.3);
  });
});

describe("Decimator", () => {
  it("throws for a non-integer or non-positive factor", () => {
    expect(() => new Decimator(0, 48000, 7000)).toThrow();
    expect(() => new Decimator(2.5, 48000, 7000)).toThrow();
  });

  it("reduces sample count by the decimation factor", () => {
    const decimator = new Decimator(3, 48000, 7000);
    const input = sineWave(200, 48000, 3000);
    const out = decimator.processBlock(input);
    expect(out.length).toBe(1000);
  });

  it("maintains phase/counter state across multiple processBlock calls", () => {
    const streamed = new Decimator(3, 48000, 7000);
    const whole = new Decimator(3, 48000, 7000);
    const input = sineWave(200, 48000, 3000);

    const first = streamed.processBlock(input.slice(0, 1500));
    const second = streamed.processBlock(input.slice(1500));
    const streamedTotal = first.length + second.length;

    const wholeOut = whole.processBlock(input);
    expect(streamedTotal).toBe(wholeOut.length);
  });

  it("aliasing test: a tone above the new Nyquist is attenuated by decimation", () => {
    const sampleRate = 48000;
    const targetRate = 16000; // Nyquist = 8000Hz
    const decimator = new Decimator(3, sampleRate, 7000);
    // 19kHz would alias into the 16kHz-sampled band without the anti-alias
    // filter; with it, energy reaching the decimated output should be small.
    const input = sineWave(19000, sampleRate, 9000);
    const out = decimator.processBlock(input);
    const { peak } = computeRmsAndPeak(out.slice(200)); // skip settling transient
    expect(peak).toBeLessThan(0.3);
    expect(out.length).toBeCloseTo(input.length / 3, -1);
    void targetRate;
  });
});

describe("encodeWavPcm16", () => {
  function readAscii(view: DataView, offset: number, length: number): string {
    let out = "";
    for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
    return out;
  }

  it("writes a valid RIFF/WAVE/fmt/data header", () => {
    const samples = new Int16Array([1000, -1000, 0, 32767, -32768]);
    const buffer = encodeWavPcm16(samples, 16000);
    const view = new DataView(buffer);

    expect(readAscii(view, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
    expect(readAscii(view, 8, 4)).toBe("WAVE");
    expect(readAscii(view, 12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(readAscii(view, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
  });

  it("round-trips PCM sample values through the data section", () => {
    const samples = new Int16Array([1000, -1000, 0, 32767, -32768]);
    const buffer = encodeWavPcm16(samples, 16000);
    const view = new DataView(buffer);
    for (let i = 0; i < samples.length; i++) {
      expect(view.getInt16(44 + i * 2, true)).toBe(samples[i]);
    }
  });

  it("produces a buffer of exactly 44 + 2*N bytes for N samples", () => {
    const buffer = encodeWavPcm16(new Int16Array(500), 48000);
    expect(buffer.byteLength).toBe(44 + 1000);
  });

  it("handles zero samples", () => {
    const buffer = encodeWavPcm16(new Int16Array(0), 16000);
    expect(buffer.byteLength).toBe(44);
    const view = new DataView(buffer);
    expect(view.getUint32(40, true)).toBe(0);
  });
});

describe("computeVadTargetGain", () => {
  it("opens the gate when probability meets the threshold", () => {
    expect(computeVadTargetGain(0.6, 0.5, 0.55)).toBe(1);
    expect(computeVadTargetGain(0.5, 0.5, 0.55)).toBe(1);
  });

  it("attenuates when probability is below the threshold", () => {
    expect(computeVadTargetGain(0.2, 0.5, 0.55)).toBe(0.55);
  });
});
