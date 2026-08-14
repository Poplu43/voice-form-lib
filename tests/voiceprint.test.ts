import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  dropInconsistentEmbeddings,
} from "../src/v2/voiceprint";

/** A unit-norm embedding pointing `angle` radians away from the reference. */
function embeddingAt(angle: number, dim = 16): Float32Array {
  const v = new Float32Array(dim);
  v[0] = Math.cos(angle);
  v[1] = Math.sin(angle);
  return v;
}

describe("cosineSimilarity", () => {
  it("is 1 for identical unit vectors and 0 for orthogonal ones", () => {
    expect(cosineSimilarity(embeddingAt(0), embeddingAt(0))).toBeCloseTo(1, 5);
    expect(
      cosineSimilarity(embeddingAt(0), embeddingAt(Math.PI / 2)),
    ).toBeCloseTo(0, 5);
  });
});

describe("dropInconsistentEmbeddings", () => {
  it("drops the one reading that does not belong", () => {
    // Three readings of one voice, plus a fourth from somewhere else entirely.
    const mine = [embeddingAt(0), embeddingAt(0.05), embeddingAt(-0.04)];
    const stranger = embeddingAt(1.3);
    const { kept, dropped } = dropInconsistentEmbeddings([...mine, stranger]);

    expect(dropped).toBe(1);
    expect(kept).toHaveLength(3);
    expect(kept).not.toContain(stranger);
  });

  it("keeps every reading when they all agree", () => {
    const readings = [embeddingAt(0), embeddingAt(0.03), embeddingAt(0.06)];
    const { kept, dropped } = dropInconsistentEmbeddings(readings);
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(3);
  });

  it("keeps both when there are only two — no majority to appeal to", () => {
    // With two readings there is no way to tell which one is the outlier, and
    // guessing wrong would enroll the wrong voice.
    const readings = [embeddingAt(0), embeddingAt(1.2)];
    const { kept, dropped } = dropInconsistentEmbeddings(readings);
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(2);
  });

  it("never returns an empty set", () => {
    // Mutually inconsistent readings: a noisy profile still beats no profile.
    const readings = [
      embeddingAt(0),
      embeddingAt(2.1),
      embeddingAt(4.2),
    ];
    const { kept } = dropInconsistentEmbeddings(readings);
    expect(kept.length).toBeGreaterThan(0);
  });

  it("reports the per-reading agreement scores used for the decision", () => {
    const { agreement } = dropInconsistentEmbeddings([
      embeddingAt(0),
      embeddingAt(0.05),
      embeddingAt(1.3),
    ]);
    expect(agreement).toHaveLength(3);
    // The outlier agrees with the others least.
    expect(agreement[2]).toBeLessThan(agreement[0]);
    expect(agreement[2]).toBeLessThan(agreement[1]);
  });

  it("respects a custom tolerance", () => {
    const readings = [embeddingAt(0), embeddingAt(0.05), embeddingAt(0.5)];
    expect(dropInconsistentEmbeddings(readings, 0.5).dropped).toBe(0);
    expect(dropInconsistentEmbeddings(readings, 0.02).dropped).toBe(1);
  });
});
