import { describe, expect, it } from "vitest";
import {
  ProximityStreamDetector,
  PROXIMITY_EARLY_REF_SAMPLES,
  PROXIMITY_HOP_SAMPLES,
  autocorrelateNonNegativeLags,
  blockRms,
  envelopeModulationDepth,
  estimateDistanceFromStream,
  metresToProximityLabel,
} from "../src/v2/proximityDetector";

function noise(length: number, amp = 0.1, seed = 1): Float32Array {
  // Deterministic LCG so tests are reproducible without a PRNG dependency.
  let s = seed >>> 0;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    s = (1103515245 * s + 12345) & 0x7fffffff;
    out[i] = ((s / 0x7fffffff) * 2 - 1) * amp;
  }
  return out;
}

/** A synthetic "reverberant" signal: white noise with an exponential decay. */
function decayingNoise(length: number, tau: number, seed = 2): Float32Array {
  const base = noise(length, 0.2, seed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = base[i] * Math.exp(-i / tau);
  return out;
}

describe("autocorrelateNonNegativeLags", () => {
  it("returns full signal energy at lag 0", () => {
    const x = new Float32Array([1, 2, 3]);
    const ac = autocorrelateNonNegativeLags(x);
    expect(ac[0]).toBeCloseTo(1 + 4 + 9, 6);
  });

  it("matches the direct-form autocorrelation", () => {
    const x = noise(64, 1, 5);
    const ac = autocorrelateNonNegativeLags(x);
    for (let k = 0; k < x.length; k++) {
      let direct = 0;
      for (let i = 0; i + k < x.length; i++) direct += x[i] * x[i + k];
      expect(ac[k]).toBeCloseTo(direct, 4);
    }
  });

  it("returns an empty result for an empty signal", () => {
    expect(autocorrelateNonNegativeLags(new Float32Array(0)).length).toBe(0);
  });
});

describe("estimateDistanceFromStream (faithful port)", () => {
  it("returns 1.0 for signals shorter than the early-reflection window", () => {
    expect(estimateDistanceFromStream(new Float32Array(PROXIMITY_EARLY_REF_SAMPLES - 1))).toBe(1.0);
  });

  it("clamps output into [0.2, 8.0]", () => {
    const d = estimateDistanceFromStream(decayingNoise(16000, 4000));
    expect(d).toBeGreaterThanOrEqual(0.2);
    expect(d).toBeLessThanOrEqual(8.0);
  });

  it("rounds to two decimal places", () => {
    const d = estimateDistanceFromStream(decayingNoise(16000, 3000));
    // Two-dp values survive a round-trip through Math.round(x*100)/100.
    expect(d).toBeCloseTo(Math.round(d * 100) / 100, 10);
  });

  // Regression test documenting the KNOWN limitation (see module header):
  // the estimate barely moves across genuinely different decay profiles,
  // because it reads the signal's own periodicity, not the room. If a future
  // change makes this actually track distance, this test SHOULD fail and be
  // rewritten — that would be the good kind of failure.
  it("is nearly invariant to the reverberation profile it claims to measure", () => {
    const dry = estimateDistanceFromStream(decayingNoise(16000, 800, 7));
    const wet = estimateDistanceFromStream(decayingNoise(16000, 12000, 7));
    expect(Math.abs(dry - wet)).toBeLessThan(0.5);
  });
});

describe("blockRms", () => {
  it("is 0 for silence", () => {
    expect(blockRms(new Float32Array(128))).toBe(0);
  });

  it("is 1 for a full-scale square wave", () => {
    expect(blockRms(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1, 6);
  });
});

describe("metresToProximityLabel (parity only)", () => {
  it("labels below the threshold as close", () => {
    expect(metresToProximityLabel(0.5)).toBe("Speaker_01 (Close)");
  });
  it("labels at/above the threshold as far", () => {
    expect(metresToProximityLabel(2.0)).toBe("Speaker_02 (Far)");
  });
});

describe("envelopeModulationDepth (honest ordinal cue)", () => {
  it("is 0 for a signal too short to frame", () => {
    expect(envelopeModulationDepth(new Float32Array(10))).toBe(0);
  });

  it("is larger for a modulated (syllabic) envelope than for steady noise", () => {
    const sr = 16000;
    const steady = noise(sr, 0.1, 9);
    // Impose a slow 4 Hz amplitude modulation with deep valleys.
    const modulated = new Float32Array(sr);
    const base = noise(sr, 0.1, 9);
    for (let i = 0; i < sr; i++) {
      const gate = 0.5 * (1 + Math.sin((2 * Math.PI * 4 * i) / sr));
      modulated[i] = base[i] * (0.02 + gate);
    }
    expect(envelopeModulationDepth(modulated, sr)).toBeGreaterThan(
      envelopeModulationDepth(steady, sr),
    );
  });
});

describe("ProximityStreamDetector", () => {
  const speech = () => noise(PROXIMITY_HOP_SAMPLES, 0.1, 42); // rms ~0.058 > 0.006
  const silence = () => new Float32Array(PROXIMITY_HOP_SAMPLES);

  it("emits nothing until a phrase ends on silence", () => {
    const det = new ProximityStreamDetector();
    expect(det.pushHop(speech())).toBeNull();
    expect(det.pushHop(speech())).toBeNull();
    expect(det.pushHop(silence())).toBeNull(); // 1st silent hop
    expect(det.pushHop(silence())).toBeNull(); // 2nd
    const phrase = det.pushHop(silence()); // 3rd → ends phrase
    expect(phrase).not.toBeNull();
    expect(phrase!.hopCount).toBe(2);
    expect(phrase!.audio.length).toBe(2 * PROXIMITY_HOP_SAMPLES);
  });

  it("invokes the onPhrase callback with a completed phrase", () => {
    const phrases: number[] = [];
    const det = new ProximityStreamDetector((p) => phrases.push(p.hopCount));
    det.pushHop(speech());
    det.pushHop(silence());
    det.pushHop(silence());
    det.pushHop(silence());
    expect(phrases).toEqual([1]);
  });

  it("flush() force-closes an in-progress phrase", () => {
    const det = new ProximityStreamDetector();
    det.pushHop(speech());
    det.pushHop(speech());
    const flushed = det.flush();
    expect(flushed).not.toBeNull();
    expect(flushed!.hopCount).toBe(2);
    expect(det.flush()).toBeNull(); // nothing left to flush
  });

  it("populates a parity label and an honest modulation depth", () => {
    const det = new ProximityStreamDetector();
    det.pushHop(speech());
    const phrase = det.flush()!;
    expect(phrase.legacyLabel).toMatch(/Speaker_0[12]/);
    expect(typeof phrase.modulationDepth).toBe("number");
  });
});
