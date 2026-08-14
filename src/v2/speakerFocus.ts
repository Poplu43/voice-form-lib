/**
 * speakerFocus.ts — pulling ONE enrolled voice out of a noisy, crowded recording.
 *
 * WHAT PROBLEM THIS SOLVES
 *   Judging a whole utterance with a single embedding against a single fixed
 *   threshold falls apart in a room with other people in it:
 *
 *     - One embedding of "me for 2s, then a colleague for 1s, then me again"
 *       is an average of both voices and matches neither cleanly.
 *     - Background noise drags every embedding toward a generic centre, so a
 *       threshold tuned in a quiet room rejects the enrolled speaker outright
 *       in a loud one. The whole turn is then dropped and the user is told to
 *       "speak louder", which is both wrong and unactionable — they were
 *       speaking perfectly clearly.
 *
 *   So instead of one verdict per utterance, this scores SHORT OVERLAPPING
 *   WINDOWS, decides which of them are the enrolled speaker, and stitches those
 *   back together. Speech from other people in the gaps is left out rather than
 *   dragging the verdict down with it.
 *
 * WHY THE DECISION IS RELATIVE, NOT ABSOLUTE
 *   A fixed cosine threshold is a promise about absolute similarity, and that
 *   promise does not survive a change of microphone, room, or noise floor —
 *   which is exactly when it is most needed. Each window is instead compared
 *   against BOTH the enrolled voice and a cohort of background voices collected
 *   during the session: it is kept when it looks more like the enrolled speaker
 *   than like anything else in the room. That comparison degrades gracefully as
 *   conditions worsen, because both sides degrade together.
 *
 * WHAT THIS STILL CANNOT DO
 *   Two people talking over each other at the same instant. A single embedding
 *   of genuinely simultaneous speech matches neither voice; un-mixing needs
 *   source separation, which has no viable real-time browser model. What this
 *   does handle is the far more common case of a crowded room where the target
 *   speaker is dominant in some windows and others are dominant in others.
 */

import { cosineSimilarity } from "./voiceprint";

export interface SpeakerFocusConfig {
  /** Length of each scored window. Shorter reacts faster to a voice swap but
   *  gives noisier embeddings; ~800ms is about the floor for CAM++. */
  windowMs?: number;
  /** Step between windows. Half the window keeps boundaries from falling
   *  between two speakers. */
  hopMs?: number;
  /** How much more like the enrolled voice than like the background a window
   *  must look, once a cohort exists. */
  acceptMargin?: number;
  /** Absolute floor, used before a cohort exists (first turns of a session). */
  minAbsolute?: number;
  /**
   * The best window in an utterance must reach this for the enrolled speaker to
   * be considered present at all.
   *
   * Without it the relative rules below happily "focus" on the least-unlike
   * voice in a recording the enrolled speaker is entirely absent from — a
   * stranger becomes the target simply by being the strongest candidate. Presence
   * has to be decided on absolute evidence, and the clearest single window is
   * the most reliable evidence available; per-window selection is only about
   * WHICH parts, once presence is established.
   */
  presenceThreshold?: number;
  /** Keep windows within this much of the best window in the utterance. Anchors
   *  the decision to the clearest evidence actually present. */
  topBand?: number;
  /** Ignore a kept region shorter than this — usually a blip, not a word. */
  minKeepMs?: number;
  /** Join two kept regions separated by less than this, so a natural pause
   *  inside a sentence does not split it into fragments. */
  bridgeGapMs?: number;
  /** Cap on remembered background voices. */
  cohortSize?: number;
}

const DEFAULTS: Required<SpeakerFocusConfig> = {
  windowMs: 800,
  hopMs: 400,
  acceptMargin: 0.06,
  minAbsolute: 0.33,
  presenceThreshold: 0.5,
  topBand: 0.12,
  minKeepMs: 400,
  bridgeGapMs: 350,
  cohortSize: 24,
};

export interface FocusWindow {
  startSample: number;
  endSample: number;
  /** Similarity to the enrolled voice (best over centroid and each reading). */
  score: number;
  /** Best similarity to any remembered background voice. */
  background: number;
  kept: boolean;
}

export interface FocusResult {
  /** The enrolled speaker's audio, with other voices cut out. Empty if none. */
  audio: Float32Array;
  windows: FocusWindow[];
  keptSamples: number;
  totalSamples: number;
  /** Best window score seen — how strong the evidence was at its clearest. */
  bestScore: number;
  /** True when enough of the utterance was attributed to the enrolled voice. */
  found: boolean;
}

export type EmbedFn = (audio: Float32Array) => Promise<Float32Array | null>;

export class SpeakerFocus {
  private readonly cfg: Required<SpeakerFocusConfig>;
  private readonly references: Float32Array[];
  /** Background voices met during this session — the room's own cohort. */
  private cohort: Float32Array[] = [];

  constructor(
    /** Enrolled centroid plus, ideally, the individual enrollment readings.
     *  Scoring against the best of several readings is more forgiving of a
     *  rough or tired voice than scoring against their average alone. */
    references: Float32Array[],
    private readonly sampleRate: number,
    config: SpeakerFocusConfig = {},
  ) {
    this.references = references.filter((r) => r && r.length > 0);
    this.cfg = { ...DEFAULTS, ...config };
  }

  get cohortSize(): number {
    return this.cohort.length;
  }

  /** Similarity to the enrolled speaker: the best match across every reference. */
  scoreAgainstProfile(embedding: Float32Array): number {
    let best = -1;
    for (const ref of this.references) {
      const s = cosineSimilarity(embedding, ref);
      if (s > best) best = s;
    }
    return best;
  }

  /** Similarity to the closest remembered background voice (-1 if none yet). */
  scoreAgainstBackground(embedding: Float32Array): number {
    let best = -1;
    for (const other of this.cohort) {
      const s = cosineSimilarity(embedding, other);
      if (s > best) best = s;
    }
    return best;
  }

  /** Remembers a voice that is not the enrolled speaker. */
  noteBackground(embedding: Float32Array): void {
    // Never let something that looks like the enrolled speaker into the cohort:
    // it would then compete with them and suppress their own audio.
    if (this.scoreAgainstProfile(embedding) >= 0.5) return;
    this.cohort.push(embedding);
    if (this.cohort.length > this.cfg.cohortSize) this.cohort.shift();
  }

  /**
   * Scores the utterance window by window and returns only the parts that look
   * like the enrolled speaker.
   */
  async focus(audio: Float32Array, embed: EmbedFn): Promise<FocusResult> {
    const win = Math.round((this.cfg.windowMs / 1000) * this.sampleRate);
    const hop = Math.round((this.cfg.hopMs / 1000) * this.sampleRate);
    const windows: FocusWindow[] = [];

    if (audio.length === 0 || this.references.length === 0) {
      return {
        audio: audio.subarray(0, 0),
        windows,
        keptSamples: 0,
        totalSamples: audio.length,
        bestScore: -1,
        found: false,
      };
    }

    for (let start = 0; start < audio.length; start += hop) {
      const end = Math.min(start + win, audio.length);
      // A final sliver shorter than half a window has no reliable embedding of
      // its own; the previous window already overlaps it.
      if (end - start < win / 2 && windows.length > 0) break;
      const e = await embed(audio.subarray(start, end));
      if (!e) continue;
      windows.push({
        startSample: start,
        endSample: end,
        score: this.scoreAgainstProfile(e),
        background: this.scoreAgainstBackground(e),
        kept: false,
      });
      // Feed the cohort as we go: a clearly-not-us window helps judge the rest
      // of this very utterance.
      if (this.isClearlyOther(windows[windows.length - 1])) {
        this.noteBackground(e);
      }
      if (end >= audio.length) break;
    }

    if (windows.length === 0) {
      return {
        audio: audio.subarray(0, 0),
        windows,
        keptSamples: 0,
        totalSamples: audio.length,
        bestScore: -1,
        found: false,
      };
    }

    const bestScore = Math.max(...windows.map((w) => w.score));

    // Presence first: if not one window looks like the enrolled speaker, they
    // are not in this recording, and picking their "closest" window would just
    // promote a stranger to target on the strength of being nearest.
    if (bestScore < this.cfg.presenceThreshold) {
      return {
        audio: audio.subarray(0, 0),
        windows,
        keptSamples: 0,
        totalSamples: audio.length,
        bestScore,
        found: false,
      };
    }

    for (const w of windows) {
      w.kept = this.keepWindow(w, bestScore);
    }

    const ranges = this.mergeKeptRanges(windows, audio.length);
    const keptSamples = ranges.reduce((n, [s, e]) => n + (e - s), 0);
    const minKeep = Math.round((this.cfg.minKeepMs / 1000) * this.sampleRate);

    return {
      audio: keptSamples >= minKeep ? spliceRanges(audio, ranges) : audio.subarray(0, 0),
      windows,
      keptSamples,
      totalSamples: audio.length,
      bestScore,
      found: keptSamples >= minKeep,
    };
  }

  private isClearlyOther(w: FocusWindow): boolean {
    return w.score < this.cfg.minAbsolute - 0.05;
  }

  private keepWindow(w: FocusWindow, bestScore: number): boolean {
    // Anchor to the clearest evidence in this utterance: windows well below the
    // best one are a different voice, however the absolute numbers came out.
    if (w.score < bestScore - this.cfg.topBand) return false;
    // With a cohort, prefer the relative judgement — it survives a change of
    // room or noise floor, where an absolute threshold does not.
    if (w.background > -1) return w.score >= w.background + this.cfg.acceptMargin;
    return w.score >= this.cfg.minAbsolute;
  }

  /** Kept windows -> contiguous sample ranges, bridging short gaps. */
  private mergeKeptRanges(
    windows: FocusWindow[],
    totalSamples: number,
  ): Array<[number, number]> {
    const bridge = Math.round((this.cfg.bridgeGapMs / 1000) * this.sampleRate);
    const ranges: Array<[number, number]> = [];
    for (const w of windows) {
      if (!w.kept) continue;
      const last = ranges[ranges.length - 1];
      if (last && w.startSample - last[1] <= bridge) {
        last[1] = Math.max(last[1], w.endSample);
      } else {
        ranges.push([w.startSample, Math.min(w.endSample, totalSamples)]);
      }
    }
    return ranges;
  }
}

/**
 * Concatenates the given ranges, with a short cross-fade at each seam. Cutting
 * audio at an arbitrary sample leaves a click, and a click is a transient that
 * ASR happily transcribes as a consonant.
 */
export function spliceRanges(
  audio: Float32Array,
  ranges: Array<[number, number]>,
  fadeSamples = 48,
): Float32Array {
  const total = ranges.reduce((n, [s, e]) => n + (e - s), 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const [s, e] of ranges) {
    const piece = audio.subarray(s, e);
    out.set(piece, at);
    const fade = Math.min(fadeSamples, Math.floor(piece.length / 2));
    for (let i = 0; i < fade; i++) {
      const g = i / fade;
      out[at + i] *= g;
      out[at + piece.length - 1 - i] *= g;
    }
    at += piece.length;
  }
  return out;
}
