import { describe, expect, it } from "vitest";
import { SpeakerFocus, spliceRanges } from "../src/v2/speakerFocus";

const SAMPLE_RATE = 16000;

/** A unit embedding `angle` radians from the reference direction. */
function voice(angle: number): Float32Array {
  const v = new Float32Array(8);
  v[0] = Math.cos(angle);
  v[1] = Math.sin(angle);
  return v;
}

const ME = voice(0);
const COLLEAGUE = voice(1.1);
const STRANGER = voice(1.4);

/**
 * Builds audio where each 800ms window belongs to a given speaker, plus an
 * embed() that reports that speaker. Lets the windowing logic be tested without
 * onnxruntime or a real microphone.
 */
function speechOf(speakers: Float32Array[], windowMs = 800) {
  const perWindow = Math.round((windowMs / 1000) * SAMPLE_RATE);
  const audio = new Float32Array(perWindow * speakers.length);
  // Encode the speaker index into the samples so embed() can recover it.
  speakers.forEach((_, i) => {
    audio.fill(i + 1, i * perWindow, (i + 1) * perWindow);
  });
  const embed = async (chunk: Float32Array): Promise<Float32Array> => {
    // Whoever occupies most of this chunk wins — mirrors "one voice dominates".
    const counts = new Map<number, number>();
    for (let i = 0; i < chunk.length; i++) {
      counts.set(chunk[i], (counts.get(chunk[i]) ?? 0) + 1);
    }
    let bestIdx = 1;
    let bestCount = -1;
    for (const [val, n] of counts) {
      if (n > bestCount) {
        bestCount = n;
        bestIdx = val;
      }
    }
    return speakers[Math.max(0, Math.round(bestIdx) - 1)] ?? speakers[0];
  };
  return { audio, embed, perWindow };
}

describe("SpeakerFocus", () => {
  it("keeps the enrolled speaker's windows and drops the other voice", async () => {
    const { audio, embed, perWindow } = speechOf([ME, ME, COLLEAGUE, ME]);
    const focus = new SpeakerFocus([ME], SAMPLE_RATE);

    const result = await focus.focus(audio, embed);

    expect(result.found).toBe(true);
    // The colleague's window is excluded, so less audio comes back than went in.
    expect(result.keptSamples).toBeLessThan(audio.length);
    expect(result.keptSamples).toBeGreaterThanOrEqual(perWindow * 2);
    const colleagueWindows = result.windows.filter(
      (w) => w.score < 0.5 && w.kept,
    );
    expect(colleagueWindows).toHaveLength(0);
  });

  it("recovers the answer when the whole-utterance average would fail", async () => {
    // This is the crowded-room case: averaged over the utterance the embedding
    // sits between two voices and matches neither, but window by window the
    // enrolled speaker is clearly present in three of five.
    const { audio, embed } = speechOf([ME, COLLEAGUE, ME, STRANGER, ME]);
    const focus = new SpeakerFocus([ME], SAMPLE_RATE);

    const result = await focus.focus(audio, embed);

    expect(result.found).toBe(true);
    expect(result.audio.length).toBeGreaterThan(0);
    expect(result.bestScore).toBeGreaterThan(0.9);
  });

  it("returns nothing when the enrolled speaker never appears", async () => {
    const { audio, embed } = speechOf([COLLEAGUE, STRANGER, COLLEAGUE]);
    const focus = new SpeakerFocus([ME], SAMPLE_RATE);

    const result = await focus.focus(audio, embed);

    expect(result.found).toBe(false);
    expect(result.audio.length).toBe(0);
  });

  it("does not promote the nearest stranger to target when nobody matches", async () => {
    // Guards the relative selection: anchoring to "the best window present"
    // would make whoever is least unlike the enrolled speaker into the target,
    // in a recording that speaker is absent from entirely.
    const nearMiss = voice(0.95); // ~0.58 similarity — closest, but not us
    const { audio, embed } = speechOf([nearMiss, COLLEAGUE, nearMiss]);
    const focus = new SpeakerFocus([ME], SAMPLE_RATE, {
      presenceThreshold: 0.7,
    });

    const result = await focus.focus(audio, embed);

    expect(result.found).toBe(false);
    expect(result.audio.length).toBe(0);
  });

  it("scores against the best enrollment reading, not just their average", async () => {
    // A rough or strained voice can sit closer to one reading than to the mean.
    const rough = voice(0.35);
    const focus = new SpeakerFocus([voice(0), rough], SAMPLE_RATE);
    expect(focus.scoreAgainstProfile(rough)).toBeCloseTo(1, 5);
  });

  it("learns the room's other voices and uses them as competition", async () => {
    const focus = new SpeakerFocus([ME], SAMPLE_RATE);
    expect(focus.cohortSize).toBe(0);

    focus.noteBackground(COLLEAGUE);
    expect(focus.cohortSize).toBe(1);
    expect(focus.scoreAgainstBackground(COLLEAGUE)).toBeCloseTo(1, 5);

    // The enrolled speaker must never end up in the cohort competing with
    // themselves — that would suppress their own audio.
    focus.noteBackground(ME);
    expect(focus.cohortSize).toBe(1);
  });

  it("bridges a short gap so one sentence is not split into fragments", async () => {
    const { audio, embed } = speechOf([ME, ME, ME]);
    const focus = new SpeakerFocus([ME], SAMPLE_RATE);
    const result = await focus.focus(audio, embed);
    // All three windows are the same speaker and contiguous, so the whole
    // utterance comes back as one piece.
    expect(result.keptSamples).toBe(audio.length);
  });

  it("handles audio shorter than a single window", async () => {
    const short = new Float32Array(Math.round(0.3 * SAMPLE_RATE)).fill(1);
    const focus = new SpeakerFocus([ME], SAMPLE_RATE, { minKeepMs: 100 });
    const result = await focus.focus(short, async () => ME);
    expect(result.windows).toHaveLength(1);
    expect(result.found).toBe(true);
  });

  it("reports nothing found for empty audio", async () => {
    const focus = new SpeakerFocus([ME], SAMPLE_RATE);
    const result = await focus.focus(new Float32Array(0), async () => ME);
    expect(result.found).toBe(false);
    expect(result.windows).toHaveLength(0);
  });
});

describe("spliceRanges", () => {
  it("concatenates the kept ranges only", () => {
    const audio = Float32Array.from({ length: 1000 }, (_, i) => i);
    const out = spliceRanges(audio, [
      [0, 100],
      [500, 600],
    ]);
    expect(out.length).toBe(200);
  });

  it("fades each seam so the cut does not click", () => {
    // A hard cut leaves a step transient, which ASR transcribes as a consonant.
    const audio = new Float32Array(1000).fill(1);
    const out = spliceRanges(audio, [[0, 500]], 10);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(0);
    expect(out[250]).toBe(1); // untouched in the middle
  });
});
