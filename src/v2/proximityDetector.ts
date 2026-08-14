// Proximity / speaker-distance estimation on a single mono channel.
//
// This is a TypeScript port of the standalone Python prototype
// `speaker_distance_detector.py`. It is deliberately shaped to fit this
// library rather than to reproduce the prototype's main loop: the prototype
// owns the microphone (sounddevice), a VAD-by-RMS gate, WAV encoding, and the
// Sarvam upload — all of which already exist here (AudioWorklet capture in
// noiseSuppression.ts, @ricky0123/vad-web, encodeWavPcm16 in
// noiseSuppressionDsp.ts, and sarvamSpeech.ts). So the port keeps only the
// parts that were genuinely new: the distance math and the phrase-level
// segmentation/aggregation around it. Feed it the Float32Array blocks you are
// already capturing.
//
// ─────────────────────────────────────────────────────────────────────────
// IMPORTANT — read before relying on `estimateDistanceFromStream`.
//
// The prototype's estimator does NOT actually measure distance, and this port
// reproduces its math faithfully, so the same caveat applies. It takes the
// autocorrelation of the *speech signal* and calls energy after 50 ms
// "reverberant". But the autocorrelation of speech measures the signal's own
// periodicity (pitch, voicing, formants), not the room's impulse response.
// True direct-to-reverberant ratio needs the room impulse response, which is
// not recoverable from one channel without a trained model.
//
// Empirically (see the project's architecture note) this function returns a
// near-constant ~0.40–0.52 m for every true distance from 0.3 m to 4.0 m, in
// every room — so a fixed "Close/Far" threshold labels essentially everything
// the same. `metresToProximityLabel` is kept only for 1:1 parity with the
// prototype; do not surface metres in a product.
//
// The honest, cheap alternative is `envelopeModulationDepth` below, meant to
// be z-scored *within a session* (never against a global threshold) and used
// as an ordinal proximity rank with a confidence that goes to zero in dry
// rooms. That matches the design the architecture note recommends.
// ─────────────────────────────────────────────────────────────────────────

// --- Configuration (ported from the prototype's CONFIGURATION PROFILE) ---
export const PROXIMITY_SAMPLE_RATE = 16000; // Hz, matches the capture pipeline
export const PROXIMITY_HOP_DURATION_S = 0.25; // estimate every 250 ms
export const PROXIMITY_EARLY_REF_S = 0.05; // 50 ms early-reflection window
export const PROXIMITY_DISTANCE_WINDOW_S = 1.0; // rolling window fed to the estimator
export const PROXIMITY_ASR_MAX_BUFFER_S = 7.0; // cap on accumulated phrase audio

export const PROXIMITY_HOP_SAMPLES = Math.round(
  PROXIMITY_SAMPLE_RATE * PROXIMITY_HOP_DURATION_S,
);
export const PROXIMITY_EARLY_REF_SAMPLES = Math.round(
  PROXIMITY_SAMPLE_RATE * PROXIMITY_EARLY_REF_S,
);
export const PROXIMITY_DISTANCE_BUFFER_SIZE = Math.round(
  PROXIMITY_SAMPLE_RATE * PROXIMITY_DISTANCE_WINDOW_S,
);
export const PROXIMITY_ASR_MAX_BUFFER_SIZE = Math.round(
  PROXIMITY_SAMPLE_RATE * PROXIMITY_ASR_MAX_BUFFER_S,
);

/** RMS above which a hop is treated as speech (prototype: chunk_rms > 0.006). */
export const PROXIMITY_SPEECH_RMS_THRESHOLD = 0.006;
/** Consecutive silent hops that end a phrase (prototype: 3 → ~750 ms). */
export const PROXIMITY_SILENCE_HOPS_TO_END = 3;
/** Metres below which the prototype labelled a talker "close". */
export const PROXIMITY_CLOSE_THRESHOLD_M = 1.1;

/**
 * Non-negative-lag linear autocorrelation, i.e. r[k] = Σ_i x[i]·x[i+k] for
 * k = 0..N-1. This is exactly `np.correlate(x, x, mode="full")[center:]`.
 *
 * Computed via zero-padded FFT (O(N log N)) rather than the naive O(N²) double
 * loop, because the prototype's 1 s / 16 kHz window is 16000 samples and the
 * naive form is far too slow to run every 250 ms in a browser. The FFT result
 * is numerically identical to NumPy's direct method to floating-point epsilon.
 */
export function autocorrelateNonNegativeLags(signal: Float32Array): Float64Array {
  const n = signal.length;
  if (n === 0) return new Float64Array(0);

  // Zero-pad to a power of two ≥ 2N so circular autocorrelation of the padded
  // sequence equals the linear autocorrelation of the original.
  let size = 1;
  while (size < 2 * n) size <<= 1;

  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < n; i++) re[i] = signal[i];

  fftInPlace(re, im, false);
  for (let i = 0; i < size; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i]; // power spectrum
    im[i] = 0;
  }
  fftInPlace(re, im, true); // inverse FFT → autocorrelation (real)

  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) out[k] = re[k];
  return out;
}

/**
 * FAITHFUL PORT of the prototype's `estimate_distance_from_stream`.
 *
 * Returns a distance in metres, clamped to [0.2, 8.0] and rounded to 2 dp,
 * exactly as the Python did. See the file header: this number does not track
 * true distance. Kept for parity and regression testing, not for product use.
 */
export function estimateDistanceFromStream(signal: Float32Array): number {
  if (signal.length < PROXIMITY_EARLY_REF_SAMPLES) return 1.0;

  const ac = autocorrelateNonNegativeLags(signal);

  let directEnergy = 0;
  const earlyEnd = Math.min(PROXIMITY_EARLY_REF_SAMPLES, ac.length);
  for (let k = 0; k < earlyEnd; k++) directEnergy += ac[k] * ac[k];

  let reverberantEnergy = 0;
  for (let k = PROXIMITY_EARLY_REF_SAMPLES; k < ac.length; k++) {
    reverberantEnergy += ac[k] * ac[k];
  }

  if (reverberantEnergy === 0) return 0.1;

  const drrDb = 10 * Math.log10(directEnergy / reverberantEnergy);
  const estimated = Math.pow(10, (-drrDb - 5) / 20);
  const clamped = Math.max(0.2, Math.min(estimated, 8.0));
  return Math.round(clamped * 100) / 100;
}

/** RMS of a block — the prototype's speech gate is `rms > 0.006`. */
export function blockRms(block: Float32Array): number {
  if (block.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
  return Math.sqrt(sum / block.length);
}

/** Prototype's Close/Far split. Kept only for parity — see file header. */
export function metresToProximityLabel(distanceM: number): string {
  return distanceM < PROXIMITY_CLOSE_THRESHOLD_M
    ? "Speaker_01 (Close)"
    : "Speaker_02 (Far)";
}

/**
 * HONEST proximity feature: envelope modulation depth. Reverberation fills the
 * inter-syllable valleys of the speech envelope, so a talker further from the
 * mic has a *shallower* log-envelope range. Defined as p95 − p15 of the
 * log-envelope over the block (the architecture note's strongest single cue).
 *
 * This is scale-relative: use it ordinally, z-scored within a session, not
 * against a fixed threshold. Larger value ⇒ nearer.
 */
export function envelopeModulationDepth(
  signal: Float32Array,
  sampleRate = PROXIMITY_SAMPLE_RATE,
): number {
  if (signal.length === 0) return 0;

  // ~20 ms frames, half-overlap → a coarse amplitude envelope.
  const frame = Math.max(1, Math.round(0.02 * sampleRate));
  const hop = Math.max(1, Math.floor(frame / 2));
  const env: number[] = [];
  for (let start = 0; start + frame <= signal.length; start += hop) {
    let sum = 0;
    for (let i = start; i < start + frame; i++) sum += signal[i] * signal[i];
    const rms = Math.sqrt(sum / frame);
    if (rms > 0) env.push(Math.log(rms));
  }
  if (env.length < 4) return 0;

  env.sort((a, b) => a - b);
  const pct = (p: number) => env[Math.min(env.length - 1, Math.floor(p * env.length))];
  return pct(0.95) - pct(0.15);
}

// A completed phrase: what the prototype printed per utterance, minus the
// transcript (which the library's Sarvam path produces separately).
export interface ProximityPhrase {
  /** Concatenated speech samples for the phrase (≤ PROXIMITY_ASR_MAX_BUFFER_SIZE). */
  audio: Float32Array;
  /** Median of the faithful per-hop distance estimates over the phrase (metres). */
  medianDistanceM: number;
  /** Honest ordinal cue: envelope-modulation depth over the whole phrase. */
  modulationDepth: number;
  /** Prototype-parity label. Do not surface — see file header. */
  legacyLabel: string;
  /** Hop count that made up the phrase. */
  hopCount: number;
}

/**
 * Streaming, stateful phrase segmenter — the reusable core of the prototype's
 * `main()` loop, without the mic or the network. Push fixed-size hop blocks
 * (PROXIMITY_HOP_SAMPLES samples of mono 16 kHz PCM) as your capture produces
 * them; get a ProximityPhrase back each time a phrase ends on silence.
 *
 * Mirrors noiseSuppressionDsp's stateful-class style (cf. Decimator): pure,
 * WebAudio-type-free, and directly unit-testable.
 */
export class ProximityStreamDetector {
  private distanceBuffer = new Float64Array(PROXIMITY_DISTANCE_BUFFER_SIZE);
  private accumulator: number[] = [];
  private perHopDistances: number[] = [];
  private isSpeaking = false;
  private silenceHops = 0;

  private readonly onPhrase?: (phrase: ProximityPhrase) => void;

  constructor(onPhrase?: (phrase: ProximityPhrase) => void) {
    this.onPhrase = onPhrase;
  }

  /**
   * Feed one hop of audio. Returns a ProximityPhrase iff this hop ended a
   * phrase; otherwise null. (Also invokes the onPhrase callback if provided.)
   */
  pushHop(block: Float32Array): ProximityPhrase | null {
    // Roll the 1 s distance window and append the new hop at the end.
    const shift = Math.min(block.length, this.distanceBuffer.length);
    this.distanceBuffer.copyWithin(0, shift);
    this.distanceBuffer.set(
      block.subarray(Math.max(0, block.length - shift)),
      this.distanceBuffer.length - shift,
    );

    // The estimator wants a Float32Array view of the rolling window.
    const window = Float32Array.from(this.distanceBuffer);
    const instantDistance = estimateDistanceFromStream(window);
    const rms = blockRms(block);

    if (rms > PROXIMITY_SPEECH_RMS_THRESHOLD) {
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.accumulator = [];
        this.perHopDistances = [];
      }
      for (let i = 0; i < block.length; i++) this.accumulator.push(block[i]);
      this.perHopDistances.push(instantDistance);
      this.silenceHops = 0;

      if (this.accumulator.length > PROXIMITY_ASR_MAX_BUFFER_SIZE) {
        this.accumulator = this.accumulator.slice(-PROXIMITY_ASR_MAX_BUFFER_SIZE);
      }
      return null;
    }

    // Silence.
    if (!this.isSpeaking) return null;
    this.silenceHops += 1;
    if (this.silenceHops < PROXIMITY_SILENCE_HOPS_TO_END) return null;

    return this.endPhrase(instantDistance);
  }

  /** Force-close any in-progress phrase (e.g. on stop()). */
  flush(): ProximityPhrase | null {
    if (!this.isSpeaking || this.accumulator.length === 0) return null;
    const fallback = this.perHopDistances.length
      ? this.perHopDistances[this.perHopDistances.length - 1]
      : 1.0;
    return this.endPhrase(fallback);
  }

  private endPhrase(fallbackDistance: number): ProximityPhrase {
    const audio = Float32Array.from(this.accumulator);
    const medianDistanceM =
      this.perHopDistances.length > 0
        ? median(this.perHopDistances)
        : fallbackDistance;

    const phrase: ProximityPhrase = {
      audio,
      medianDistanceM,
      modulationDepth: envelopeModulationDepth(audio),
      legacyLabel: metresToProximityLabel(medianDistanceM),
      hopCount: this.perHopDistances.length,
    };

    this.isSpeaking = false;
    this.silenceHops = 0;
    this.accumulator = [];
    this.perHopDistances = [];

    this.onPhrase?.(phrase);
    return phrase;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * In-place iterative radix-2 Cooley–Tukey FFT (and inverse when `inverse`
 * is true). `re`/`im` must have power-of-two length. Dependency-free so the
 * module stays unit-testable under plain Vitest, matching the rest of the DSP
 * layer.
 */
function fftInPlace(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  if (n <= 1) return;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < len / 2; k++) {
        const aR = re[i + k];
        const aI = im[i + k];
        const bR = re[i + k + len / 2] * curR - im[i + k + len / 2] * curI;
        const bI = re[i + k + len / 2] * curI + im[i + k + len / 2] * curR;
        re[i + k] = aR + bR;
        im[i + k] = aI + bI;
        re[i + k + len / 2] = aR - bR;
        im[i + k + len / 2] = aI - bI;
        const nextR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nextR;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}
