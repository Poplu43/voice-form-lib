/**
 * voiceform.ts — live mic in, ONE speaker's text out. TypeScript port of
 * voiceform.py, rewritten to fit this library's environment (browser Web
 * Audio + onnxruntime-web + Sarvam, strict ESM).
 *
 * Built for voice form-filling: the user enrolls by saying a known phrase,
 * then everything they say is transcribed and everything anyone else says is
 * thrown away BEFORE it ever costs you money.
 *
 * The Python original was a headless CLI (`--setup / --enroll / --calibrate`).
 * There is no terminal or PortAudio microphone in a browser, so the CLI
 * subcommands become async methods on `VoiceForm`, and mic access goes through
 * getUserMedia + an AudioWorklet instead of `sounddevice`. Everything else —
 * the Silero VAD gate, the CAM++ speaker-embedding cosine check, the GTCRN
 * denoiser, the phrase-matching enrollment, the cost accounting — is a direct
 * port of the Python logic.
 *
 *   const vf = new VoiceForm({ sarvamApiKey, models });
 *   await vf.load();
 *   const profile = await vf.enroll({ onPrompt: ... });   // once per user
 *   await vf.calibrate(profile, { ... });                  // find the threshold
 *   const session = vf.listen(profile, { onResult: r => ... });
 *   // ... later
 *   const stats = await session.stop();
 *
 * HOW IT WORKS
 *
 *   mic ─► Silero VAD ─► utterance
 *                           │
 *                           ├─► CAM++ embedding ─► cosine vs enrolled voice
 *                           │                            │
 *                           │                    below threshold? DROP.
 *                           │                    (never sent, never billed)
 *                           │                            │
 *                           └────────────────────────────┴─► GTCRN denoise
 *                                                            ─► Sarvam ─► text
 *
 * The cosine check happens BEFORE transcription. That is the whole cost
 * strategy: you only pay Sarvam (₹30/hour of audio) for the enrolled
 * speaker's speech.
 *
 * NO LLM IS USED. The enrollment phrase defines who the speaker is, so there
 * is nothing for a language model to decide. Speaker ID is one dot product.
 *
 * WHAT IS DELIBERATELY NOT HERE (same rationale as the Python original)
 *   * distance estimation — enrollment makes it redundant, and on a single mic
 *                           it is unreliable anyway (53% ≈ chance in a dry room)
 *   * speaker diarization — you know who you want; you don't need to discover it
 *   * an LLM router       — the phrase is the definition
 */

// Reuse the exact onnxruntime-web the library already ships via @ricky0123/vad-web
// rather than adding a second ORT copy to the bundle. `ort` here is the same
// namespace noiseSuppression.ts imports.
import { ort } from "@ricky0123/vad-web/dist/real-time-vad";

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIGURATION — everything you might want to change is in this block
// ─────────────────────────────────────────────────────────────────────────────

export const SAMPLE_RATE = 16000;
export const FRAME = 512; // Silero v5/v6 requires exactly this at 16 kHz

/** The phrase the user says to enroll. Keep it 2-4 seconds, distinctive, and
 *  easy to say. Longer is better for voice quality; too long and people
 *  misread it. */
export const ENROLL_PHRASE = "mera hindi mai baat krna chahunga";
export const ENROLL_PHRASE_HINT = "I would like to speak in Hindi";
export const ENROLL_REPEATS = 2; // average N recordings -> a better voiceprint

/** Cosine similarity threshold: above this, it's the enrolled speaker. 0.50 is
 *  a safe start for CAM++ but IS MIC- AND ROOM-DEPENDENT. Run `calibrate()`
 *  and use the number it gives you. */
export const MATCH_THRESHOLD = 0.5;
export const REJECT_MARGIN = 0.06; // dead zone below the threshold -> "unsure"

// Voice activity detection
export const VAD_THRESHOLD = 0.5; // lower = more sensitive
export const MIN_SPEECH_MS = 380; // ignore short background/noise bursts
export const MIN_SILENCE_MS = 700; // prevent quick handover to nearby voices
export const SPEECH_PAD_MS = 200; // audio kept from just before speech starts
export const MAX_UTTERANCE_MS = 15000; // hard cut

// Enrollment reads out a full sentence, and people reading an unfamiliar phrase
// (especially in a script they don't use daily) often pause mid-sentence for
// longer than 500ms. A short MIN_SILENCE_MS during enrollment cuts the phrase
// off at that pause and only captures the first half. Give enrollment more room
// to breathe than live runtime use gets — but cap it so someone rambling past
// the phrase doesn't produce a 15s recording.
export const ENROLL_MIN_SILENCE_MS = 1200;
export const ENROLL_MAX_UTTERANCE_MS = 7000;

// Sarvam speech-to-text
export const SARVAM_WS_URL = "wss://api.sarvam.ai/speech-to-text-realtime/ws";
export const SARVAM_REST_URL = "https://api.sarvam.ai/speech-to-text";
export const SARVAM_WS_MODEL = "saaras:v3-realtime"; // the only model the WS accepts
export const SARVAM_REST_MODEL = "saarika:v2.5"; // /speech-to-text expects a saarika model (saaras is the translate endpoint)
export const SARVAM_WS_LANG = "auto"; // realtime uses "auto" (REST uses "unknown")
export const SARVAM_MODE = "codemix"; // English in Latin, Indic in native script
export const SARVAM_CHUNK_BYTES = 3200; // ~100 ms @ 16 kHz mono 16-bit

/** Default model URLs — identical to the Python `MODEL_URLS`. In the browser
 *  these are fetched as ArrayBuffers instead of downloaded to ./models. Swap
 *  them for self-hosted copies (e.g. the three .onnx files shipped alongside
 *  this port) in restricted-network / government deployments. */
export const MODEL_URLS = {
  sileroVad:
    "https://raw.githubusercontent.com/snakers4/silero-vad/v6.2.1/" +
    "src/silero_vad/data/silero_vad.onnx",
  gtcrn:
    "https://raw.githubusercontent.com/Xiaobin-Rong/gtcrn/main/" +
    "stream/onnx_models/gtcrn_simple.onnx",
  campplus:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/" +
    "speaker-recongition-models/" +
    "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
//  small numeric helpers  (no external DSP dependency — pure, unit-testable)
// ─────────────────────────────────────────────────────────────────────────────

/** In-place iterative radix-2 Cooley–Tukey FFT. `re`/`im` length must be a
 *  power of two. Replaces numpy.fft — the browser has no built-in FFT. */
function fftInPlace(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len >> 1; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + (len >> 1)] * curRe - im[i + k + (len >> 1)] * curIm;
        const bIm = re[i + k + (len >> 1)] * curIm + im[i + k + (len >> 1)] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + (len >> 1)] = aRe - bRe;
        im[i + k + (len >> 1)] = aIm - bIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
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

/** Real FFT of a length-`nfft` frame -> first nfft/2+1 complex bins. */
function rfft(frame: Float64Array, nfft: number): { re: Float64Array; im: Float64Array } {
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  re.set(frame.subarray(0, Math.min(frame.length, nfft)));
  fftInPlace(re, im, false);
  const half = nfft / 2 + 1;
  return { re: re.subarray(0, half) as Float64Array, im: im.subarray(0, half) as Float64Array };
}

/** Inverse real FFT from nfft/2+1 complex bins back to a length-`nfft` frame. */
function irfft(re: Float64Array, im: Float64Array, nfft: number): Float64Array {
  const fullRe = new Float64Array(nfft);
  const fullIm = new Float64Array(nfft);
  const half = nfft / 2 + 1;
  for (let i = 0; i < half; i++) {
    fullRe[i] = re[i];
    fullIm[i] = im[i];
  }
  for (let i = 1; i < nfft - half + 1; i++) {
    fullRe[nfft - i] = re[i];
    fullIm[nfft - i] = -im[i];
  }
  fftInPlace(fullRe, fullIm, true);
  return fullRe;
}

function l2normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const inv = 1 / (Math.sqrt(s) + 1e-9);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function float32ToPcm16Bytes(x: Float32Array): Uint8Array {
  const out = new Uint8Array(x.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < x.length; i++) {
    const s = Math.max(-1, Math.min(1, x[i]));
    view.setInt16(i * 2, Math.round(s * 32767), true);
  }
  return out;
}

/** Mono 16-bit PCM WAV (44-byte header + LE body). Same layout as the
 *  library's encodeWavPcm16 — inlined here to keep this port standalone. */
function encodeWav(x: Float32Array, sampleRate: number): ArrayBuffer {
  const pcm = float32ToPcm16Bytes(x);
  const buffer = new ArrayBuffer(44 + pcm.length);
  const view = new DataView(buffer);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);
  new Uint8Array(buffer, 44).set(pcm);
  return buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ─────────────────────────────────────────────────────────────────────────────
//  VOICE ACTIVITY DETECTION  (Silero v6, MIT)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Silero v5/v6. Needs 576 samples per call at 16 kHz: 64 samples of carried
 * context + the 512-sample chunk. Direct port of the Python `VAD` class.
 */
export class VAD {
  static readonly CONTEXT = 64;

  private session: import("onnxruntime-common").InferenceSession;
  private state!: Float32Array;
  private ctx!: Float32Array;
  private readonly sr: bigint;

  private constructor(session: import("onnxruntime-common").InferenceSession) {
    this.session = session;
    const names = new Set(session.inputNames);
    if (names.has("h") || names.has("c")) {
      throw new Error("This is Silero v4. Load the v6 model instead.");
    }
    this.sr = BigInt(SAMPLE_RATE);
    this.reset();
  }

  static async create(model: ArrayBuffer): Promise<VAD> {
    const session = await ort.InferenceSession.create(model, {
      executionProviders: ["wasm"],
      intraOpNumThreads: 1,
    });
    return new VAD(session);
  }

  reset(): void {
    this.state = new Float32Array(2 * 1 * 128);
    this.ctx = new Float32Array(VAD.CONTEXT);
  }

  async process(frame: Float32Array): Promise<number> {
    const x = new Float32Array(VAD.CONTEXT + frame.length);
    x.set(this.ctx, 0);
    x.set(frame, VAD.CONTEXT);

    const feeds: Record<string, import("onnxruntime-common").Tensor> = {
      input: new ort.Tensor("float32", x, [1, x.length]),
      state: new ort.Tensor("float32", this.state, [2, 1, 128]),
      sr: new ort.Tensor("int64", BigInt64Array.from([this.sr]), []),
    };
    const out = await this.session.run(feeds);
    this.state = out.stateN.data as Float32Array;
    this.ctx = frame.slice(frame.length - VAD.CONTEXT);
    return (out.output.data as Float32Array)[0];
  }
}

/**
 * A finished chunk of speech, plus the wall-clock time it started at — i.e. the
 * moment the speaker actually said it, not the moment it finished processing.
 */
export class Utterance {
  constructor(
    public readonly audio: Float32Array,
    public readonly startWall: number, // epoch seconds
    /** Id of the speech run this utterance closes. Lets a caller correlate the
     *  finished utterance with the interim snapshots it already processed (see
     *  `InterimSpeech`). 0 for callers that don't use interim snapshots. */
    public readonly runId: number = 0,
    /**
     * Why this utterance ended.
     *   "endpoint"  — the speaker stopped; the turn is genuinely over.
     *   "maxLength" — the hard length cap cut it; THE SPEAKER IS STILL TALKING.
     * Treating the second as an end-of-turn truncates anyone who answers at
     * length, so callers must distinguish them.
     */
    public readonly reason: "endpoint" | "maxLength" = "endpoint",
  ) {}

  get durationS(): number {
    return this.audio.length / SAMPLE_RATE;
  }

  /** HH:MM:SS.mmm in local time, for display. */
  get timestamp(): string {
    const d = new Date(this.startWall * 1000);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return (
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
      `.${pad(d.getMilliseconds(), 3)}`
    );
  }
}

/**
 * A snapshot of speech that is still in progress, handed to `Segmenter`'s
 * `onInterim` callback roughly every `interimMs` of accumulated speech.
 *
 * Waiting for the endpoint (a full `minSilenceMs` of silence) before doing
 * *anything* with the audio is what makes a turn feel slow: the speaker gate,
 * the denoiser and the STT request all queue up behind the pause. These
 * snapshots let a caller start that work while the user is still talking, so
 * only the last chunk's latency is visible at the end of a turn.
 */
export interface InterimSpeech {
  /** Id of the speech run this snapshot belongs to — stable for the whole
   *  utterance, and matched by `Utterance.runId` when the run finishes. */
  runId: number;
  /** 1-based index of this snapshot inside the current run. */
  index: number;
  /** Everything captured in this run so far, including the pre-roll pad.
   *  A strict prefix of the eventual `Utterance.audio`, so sample offsets
   *  taken here stay valid against the finished utterance. */
  audio: Float32Array;
  /** Only the audio added since the previous snapshot of this run. */
  newAudio: Float32Array;
  /** Length of `audio` in milliseconds. */
  elapsedMs: number;
  /** Wall-clock (epoch seconds) the run started. */
  startWall: number;
}

/** Turns a stream of frames into complete utterances. Port of `Segmenter`. */
export class Segmenter {
  private minSil: number;
  private readonly minSp: number;
  private readonly pad: number;
  private readonly maxF: number;
  private readonly interimF: number;
  private readonly onInterim?: (interim: InterimSpeech) => void;
  private readonly onRunStart?: (runId: number) => void;
  private buf: Float32Array[] = [];
  private pre: Float32Array[] = [];
  private on = false;
  private sil = 0;
  private sp = 0;
  private startWall: number | null = null;
  private runId = 0;
  private interimAt = 0; // buf length at the last interim emission
  private interimIndex = 0;

  constructor(
    private readonly vad: VAD,
    opts: {
      minSilenceMs?: number;
      maxMs?: number;
      /**
       * Speech required before a burst counts as an utterance at all. Below
       * this it is discarded as noise and NOTHING is emitted — which also means
       * no speaker check runs and no downstream code ever learns it happened.
       * The default (MIN_SPEECH_MS) is tuned to reject coughs and door clicks,
       * and it also rejects "No", "Yes" and "Haan", so callers that ask
       * one-word questions should lower it.
       */
      minSpeechMs?: number;
      /** Emit an `InterimSpeech` snapshot every N ms of speech. 0 = off. */
      interimMs?: number;
      onInterim?: (interim: InterimSpeech) => void;
      /** Fires as soon as a new speech run begins, before any audio is
       *  available — use it to reset per-turn state. */
      onRunStart?: (runId: number) => void;
    } = {},
  ) {
    const f = (FRAME / SAMPLE_RATE) * 1000;
    this.minSil = Math.max(1, Math.floor((opts.minSilenceMs ?? MIN_SILENCE_MS) / f));
    this.minSp = Math.max(1, Math.floor((opts.minSpeechMs ?? MIN_SPEECH_MS) / f));
    this.pad = Math.max(0, Math.floor(SPEECH_PAD_MS / f));
    this.maxF = Math.floor((opts.maxMs ?? MAX_UTTERANCE_MS) / f);
    this.interimF = opts.interimMs
      ? Math.max(1, Math.floor(opts.interimMs / f))
      : 0;
    this.onInterim = opts.onInterim;
    this.onRunStart = opts.onRunStart;
  }

  async push(frame: Float32Array): Promise<Utterance | null> {
    const p = await this.vad.process(frame);
    const now = Date.now() / 1000;
    if (p >= VAD_THRESHOLD) {
      if (!this.on) {
        this.on = true;
        this.sp = 0;
        this.buf = [...this.pre];
        // back-date the start to account for the pre-roll we just kept
        this.startWall = now - (this.pre.length * FRAME) / SAMPLE_RATE;
        this.runId += 1;
        this.interimAt = 0;
        this.interimIndex = 0;
        this.onRunStart?.(this.runId);
      }
      this.buf.push(frame);
      this.sp += 1;
      this.sil = 0;
      if (this.buf.length >= this.maxF) return this.emit("maxLength");
      this.maybeInterim();
      return null;
    }

    this.pre.push(frame);
    if (this.pre.length > this.pad) this.pre.shift();
    if (this.on) {
      this.buf.push(frame);
      this.sil += 1;
      if (this.sil >= this.minSil) {
        if (this.sp >= this.minSp) return this.emit();
        this.clear();
      }
    }
    return null;
  }

  /** Hands the caller the speech captured so far, without ending the run. */
  private maybeInterim(): void {
    if (!this.onInterim || this.interimF <= 0) return;
    if (this.buf.length - this.interimAt < this.interimF) return;

    const audio = concatFloat32(this.buf);
    // Every buffered frame is exactly FRAME samples long (FrameChunker
    // guarantees it), so the frame count converts straight to a sample offset.
    const newFrom = Math.min(this.interimAt * FRAME, audio.length);
    this.interimAt = this.buf.length;
    this.interimIndex += 1;
    this.onInterim({
      runId: this.runId,
      index: this.interimIndex,
      audio,
      newAudio: audio.subarray(newFrom),
      elapsedMs: (audio.length / SAMPLE_RATE) * 1000,
      startWall: this.startWall ?? Date.now() / 1000,
    });
  }

  /**
   * Raises or lowers the silence needed to end an utterance, mid-stream.
   *
   * Someone reciting several details in one breath pauses noticeably longer
   * between items than they do between words, so a caller that can tell it is in
   * such a flow can widen the endpoint while it lasts instead of chopping the
   * answer into fragments at every pause.
   */
  setMinSilenceMs(ms: number): void {
    const f = (FRAME / SAMPLE_RATE) * 1000;
    this.minSil = Math.max(1, Math.floor(ms / f));
  }

  private emit(reason: "endpoint" | "maxLength" = "endpoint"): Utterance {
    const a = concatFloat32(this.buf);
    const u = new Utterance(
      a,
      this.startWall ?? Date.now() / 1000,
      this.runId,
      reason,
    );
    this.clear();
    return u;
  }

  private clear(): void {
    this.on = false;
    this.buf = [];
    this.sil = 0;
    this.sp = 0;
    this.interimAt = 0;
    this.interimIndex = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SPEAKER EMBEDDING  (CAM++, Apache-2.0) — this is the whole speaker ID system
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 80-dim Kaldi-style log-mel filterbank. Port of the Python `fbank()` scipy
 * fallback path — there is no kaldi-native-fbank in the browser, so this IS the
 * feature extractor CAM++ uses. Frames the pre-emphasised signal into 400-sample
 * windows (25 ms) at a 160-sample hop (10 ms), zero-pads each to 512, applies a
 * Povey window, rfft -> power spectrum -> 80 triangular mel filters -> log, then
 * subtracts the per-bin mean over time (CMN, matching campplus's
 * feature_normalize_type = "global-mean").
 *
 * A constant multiplicative scale on the power spectrum only shifts the log by a
 * constant that is identical across every frame, and CMN removes exactly that —
 * so this port does not need to reproduce scipy's "spectrum" scaling factor to
 * match the Python features after normalisation.
 */
function fbank(xIn: Float32Array): Float32Array[] {
  const NPERSEG = 400;
  const NFFT = 512;
  const HOP = 160; // nperseg - noverlap (400 - 240)
  const NMELS = 80;

  // pre-emphasis: xp[0]=x[0]; xp[i]=x[i]-0.97*x[i-1]
  const xp = new Float32Array(xIn.length);
  if (xIn.length) xp[0] = xIn[0];
  for (let i = 1; i < xIn.length; i++) xp[i] = xIn[i] - 0.97 * xIn[i - 1];

  // Povey window (len 400): (0.5 - 0.5*cos(2*pi*n/399))^0.85
  const win = new Float64Array(NPERSEG);
  for (let n = 0; n < NPERSEG; n++) {
    win[n] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (NPERSEG - 1)), 0.85);
  }

  // triangular mel filterbank (80 x 257), built exactly like the Python code
  const mel = (fHz: number) => 1127.0 * Math.log(1 + fHz / 700.0);
  const imel = (z: number) => 700.0 * (Math.exp(z / 1127.0) - 1);
  const lo = mel(20.0);
  const hi = mel(7600.0);
  const pts = new Array(82);
  for (let i = 0; i < 82; i++) pts[i] = imel(lo + ((hi - lo) * i) / 81);
  const b = pts.map((p) => Math.floor((513 * p) / SAMPLE_RATE));
  const fb: Float64Array[] = [];
  for (let k = 1; k <= NMELS; k++) {
    const row = new Float64Array(257);
    const l = b[k - 1];
    const c = Math.max(b[k], b[k - 1] + 1);
    let r = Math.min(b[k + 1], 256);
    r = Math.max(r, c + 1);
    if (c < 257) {
      for (let j = l; j < c; j++) if (j >= 0 && j < 257) row[j] = (j - l) / Math.max(c - l, 1);
      for (let j = c; j < r; j++) if (j >= 0 && j < 257) row[j] = (r - j) / Math.max(r - c, 1);
    }
    fb.push(row);
  }

  // framing: boundary=None, padded=True -> integer number of hops
  const nFrames = xp.length >= NPERSEG ? 1 + Math.floor((xp.length - NPERSEG) / HOP) : 0;
  const feats: Float32Array[] = [];
  const frame = new Float64Array(NFFT);
  for (let t = 0; t < nFrames; t++) {
    const start = t * HOP;
    frame.fill(0);
    for (let n = 0; n < NPERSEG; n++) frame[n] = xp[start + n] * win[n];
    const { re, im } = rfft(frame, NFFT);
    // power spectrum (|Z|^2), then mel-project and log
    const pw = new Float64Array(257);
    for (let k = 0; k < 257; k++) pw[k] = re[k] * re[k] + im[k] * im[k];
    const m = new Float32Array(NMELS);
    for (let j = 0; j < NMELS; j++) {
      const row = fb[j];
      let acc = 0;
      for (let k = 0; k < 257; k++) acc += pw[k] * row[k];
      m[j] = Math.log(Math.max(acc, 1e-10));
    }
    feats.push(m);
  }

  // CMN: subtract the mean over time per mel-bin
  if (feats.length) {
    const mean = new Float64Array(NMELS);
    for (const fr of feats) for (let j = 0; j < NMELS; j++) mean[j] += fr[j];
    for (let j = 0; j < NMELS; j++) mean[j] /= feats.length;
    for (const fr of feats) for (let j = 0; j < NMELS; j++) fr[j] -= mean[j];
  }
  return feats;
}

/** CAM++ speaker embedder. Port of the Python `Embedder` class. */
export class Embedder {
  private session: import("onnxruntime-common").InferenceSession;
  private readonly inputName: string;
  /** WeSpeaker builds want int16-scaled samples; 3D-Speaker builds want [-1,1].
   *  The shipped campplus.onnx sets normalize_samples=1 -> scale 1.0. */
  private readonly scale: number;

  private constructor(
    session: import("onnxruntime-common").InferenceSession,
    scale: number,
  ) {
    this.session = session;
    this.inputName = session.inputNames[0];
    this.scale = scale;
  }

  static async create(model: ArrayBuffer, scale = 1.0): Promise<Embedder> {
    const session = await ort.InferenceSession.create(model, {
      executionProviders: ["wasm"],
      intraOpNumThreads: 1,
    });
    return new Embedder(session, scale);
  }

  async embed(audio: Float32Array): Promise<Float32Array | null> {
    const scaled =
      this.scale === 1.0
        ? audio
        : Float32Array.from(audio, (v) => v * this.scale);
    const feats = fbank(scaled);
    if (feats.length < 10) return null;

    const T = feats.length;
    const flat = new Float32Array(T * 80);
    for (let t = 0; t < T; t++) flat.set(feats[t], t * 80);

    const out = await this.session.run({
      [this.inputName]: new ort.Tensor("float32", flat, [1, T, 80]),
    });
    const e = out.embedding.data as Float32Array;
    return l2normalize(e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  DENOISER  (GTCRN, MIT) — improves ASR accuracy, optional
// ─────────────────────────────────────────────────────────────────────────────

/** Streaming GTCRN denoiser. Direct port of the Python `Denoiser` class. */
export class Denoiser {
  private static readonly SHAPES: Record<string, number[]> = {
    conv_cache: [2, 1, 16, 16, 33],
    tra_cache: [2, 3, 1, 1, 16],
    inter_cache: [2, 1, 33, 16],
  };

  private session: import("onnxruntime-common").InferenceSession;
  private readonly win: Float64Array;
  private cache!: Record<string, import("onnxruntime-common").Tensor>;

  private constructor(session: import("onnxruntime-common").InferenceSession) {
    this.session = session;
    this.win = new Float64Array(512);
    for (let n = 0; n < 512; n++) {
      this.win[n] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * n) / 512));
    }
    this.reset();
  }

  static async create(model: ArrayBuffer): Promise<Denoiser> {
    const session = await ort.InferenceSession.create(model, {
      executionProviders: ["wasm"],
      intraOpNumThreads: 1,
    });
    return new Denoiser(session);
  }

  reset(): void {
    this.cache = {};
    for (const [k, s] of Object.entries(Denoiser.SHAPES)) {
      const len = s.reduce((a, b) => a * b, 1);
      this.cache[k] = new ort.Tensor("float32", new Float32Array(len), s);
    }
  }

  async run(xIn: Float32Array): Promise<Float32Array> {
    if (xIn.length < 512) return xIn;
    this.reset();
    const nf = 1 + Math.floor((xIn.length - 512) / 256);
    const out = new Float64Array((nf - 1) * 256 + 512);
    const nrm = new Float64Array(out.length);
    const w2 = new Float64Array(512);
    for (let n = 0; n < 512; n++) w2[n] = this.win[n] * this.win[n];

    const frame = new Float64Array(512);
    for (let f = 0; f < nf; f++) {
      const i = f * 256;
      for (let n = 0; n < 512; n++) frame[n] = xIn[i + n] * this.win[n];
      const { re, im } = rfft(frame, 512);
      // mix[1,257,1,2] interleaved as (real, imag) per bin
      const mix = new Float32Array(257 * 2);
      for (let k = 0; k < 257; k++) {
        mix[k * 2] = re[k];
        mix[k * 2 + 1] = im[k];
      }
      const res = await this.session.run({
        mix: new ort.Tensor("float32", mix, [1, 257, 1, 2]),
        ...this.cache,
      });
      this.cache = {
        conv_cache: res.conv_cache_out,
        tra_cache: res.tra_cache_out,
        inter_cache: res.inter_cache_out,
      };
      const enh = res.enh.data as Float32Array; // [1,257,1,2]
      const eRe = new Float64Array(257);
      const eIm = new Float64Array(257);
      for (let k = 0; k < 257; k++) {
        eRe[k] = enh[k * 2];
        eIm[k] = enh[k * 2 + 1];
      }
      const y = irfft(eRe, eIm, 512);
      for (let n = 0; n < 512; n++) {
        out[i + n] += y[n] * this.win[n];
        nrm[i + n] += w2[n];
      }
    }

    const y = new Float32Array(xIn.length);
    const m = Math.min(out.length, xIn.length);
    for (let n = 0; n < m; n++) y[n] = out[n] / Math.max(nrm[n], 1e-8);
    // tail: if output shorter than input, keep the original samples
    for (let n = m; n < xIn.length; n++) y[n] = xIn[n];
    return y;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PHRASE MATCHING — enrollment compares what was read against the phrase
// ─────────────────────────────────────────────────────────────────────────────

const DEVANAGARI_RE = /[\u0900-\u097F]/;

function normText(s: string): string {
  // keep word chars, whitespace, and the Devanagari block; collapse the rest
  const cleaned = (s || "")
    .toLowerCase()
    .replace(/[^\w\s\u0900-\u097F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

// Rough Devanagari -> Roman transliteration, used only as a fallback for
// matching an enrollment phrase — NOT linguistically precise (schwa deletion,
// conjuncts, gemination are approximated), but good enough for fuzzy compare.
const DEVA_VOWELS: Record<string, string> = {
  "अ": "a", "आ": "aa", "इ": "i", "ई": "ii", "उ": "u", "ऊ": "uu",
  "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au",
};
const DEVA_MATRAS: Record<string, string> = {
  "ा": "aa", "ि": "i", "ी": "ii", "ु": "u", "ू": "uu", "ृ": "ri",
  "े": "e", "ै": "ai", "ो": "o", "ौ": "au",
};
const DEVA_CONSONANTS: Record<string, string> = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng",
  "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "ny",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
  "य": "y", "र": "r", "ल": "l", "व": "v",
  "श": "sh", "ष": "sh", "स": "s", "ह": "h",
};
const DEVA_VIRAMA = "्";
const DEVA_ANUSVARA = "ं";
const DEVA_CHANDRABINDU = "ँ";
const DEVA_VISARGA = "ः";
const DEVA_NUKTA = "़";
const DEVA_DANDA = "।";

function devaToRoman(s: string): string {
  const out: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c in DEVA_CONSONANTS) {
      out.push(DEVA_CONSONANTS[c]);
      const nxt = i + 1 < n ? s[i + 1] : "";
      if (nxt === DEVA_VIRAMA) {
        i += 2;
        continue;
      }
      if (nxt in DEVA_MATRAS) {
        out.push(DEVA_MATRAS[nxt]);
        i += 2;
        continue;
      }
      if (![DEVA_ANUSVARA, DEVA_CHANDRABINDU, DEVA_VISARGA, DEVA_NUKTA].includes(nxt)) {
        out.push("a");
      }
      i += 1;
      continue;
    }
    if (c in DEVA_VOWELS) {
      out.push(DEVA_VOWELS[c]);
      i += 1;
      continue;
    }
    if (c === DEVA_ANUSVARA || c === DEVA_CHANDRABINDU) {
      out.push("n");
      i += 1;
      continue;
    }
    if (c === DEVA_VISARGA) {
      out.push("h");
      i += 1;
      continue;
    }
    if (c === DEVA_NUKTA) {
      i += 1;
      continue;
    }
    if (c === DEVA_DANDA) {
      out.push(" ");
      i += 1;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join("");
}

/**
 * Ratcliff/Obershelp similarity ratio — the algorithm Python's
 * difflib.SequenceMatcher.ratio() uses. Recursively finds the longest matching
 * block, then recurses on the segments to the left and right of it, summing the
 * matched lengths. ratio = 2*M / (len(a)+len(b)).
 */
function sequenceRatio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1;

  function longestMatch(
    alo: number, ahi: number, blo: number, bhi: number,
  ): [number, number, number] {
    let bestI = alo;
    let bestJ = blo;
    let bestSize = 0;
    // j2len[j] = length of the longest match ending at a[i], b[j]
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (let j = blo; j < bhi; j++) {
        if (a[i] !== b[j]) continue;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestSize) {
          bestI = i - k + 1;
          bestJ = j - k + 1;
          bestSize = k;
        }
      }
      j2len = newj2len;
    }
    return [bestI, bestJ, bestSize];
  }

  let matches = 0;
  const stack: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (stack.length) {
    const [alo, ahi, blo, bhi] = stack.pop()!;
    const [i, j, k] = longestMatch(alo, ahi, blo, bhi);
    if (k > 0) {
      matches += k;
      if (alo < i && blo < j) stack.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) stack.push([i + k, ahi, j + k, bhi]);
    }
  }
  return (2 * matches) / total;
}

export function phraseMatches(
  said: string,
  expected: string,
  threshold = 0.55,
): { score: number; ok: boolean } {
  // If Sarvam returned Devanagari but the phrase is Latin, transliterate before
  // comparing — otherwise every reading scores near 0 regardless of accuracy.
  if (DEVANAGARI_RE.test(said || "") && !DEVANAGARI_RE.test(expected || "")) {
    said = devaToRoman(said);
  }
  const a = normText(said);
  const b = normText(expected);
  if (!a) return { score: 0, ok: false };
  const r = sequenceRatio(a, b);
  // also accept if most of the expected words are present (ASR drops words)
  const ew = new Set(b.split(" ").filter(Boolean));
  const aw = new Set(a.split(" ").filter(Boolean));
  let inter = 0;
  for (const w of ew) if (aw.has(w)) inter += 1;
  const cover = inter / Math.max(ew.size, 1);
  const score = Math.max(r, cover);
  return { score, ok: score >= threshold };
}

// ─────────────────────────────────────────────────────────────────────────────
//  SARVAM SPEECH-TO-TEXT — REST by default, realtime WS opt-in (--stream)
// ─────────────────────────────────────────────────────────────────────────────

export interface SarvamResult {
  text: string;
  language: string | null;
}

/**
 * Port of the Python `Sarvam` class. REST is the default: one fetch with a
 * bounded timeout, which behaves reliably. The realtime websocket is opt-in
 * (`useStream: true`) and still falls back to REST after one bounded attempt.
 *
 * `restUrl` may point at your own proxy to avoid browser CORS on
 * api.sarvam.ai — the request shape is unchanged.
 */
export class Sarvam {
  audioS = 0;
  calls = 0;
  private ws: WebSocket | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly opts: {
      useStream?: boolean;
      wsTimeoutMs?: number;
      restUrl?: string;
      wsUrl?: string;
    } = {},
  ) {}

  private wsFullUrl(): string {
    const base = this.opts.wsUrl ?? SARVAM_WS_URL;
    return (
      `${base}?model=${SARVAM_WS_MODEL}&language_code=${SARVAM_WS_LANG}` +
      `&mode=${SARVAM_MODE}&encoding=linear16` +
      `&sample_rate=${SAMPLE_RATE}&endpointing=vad`
    );
  }

  async transcribe(
    audio: Float32Array,
    opts: { mode?: string; timeoutMs?: number; languageCode?: string } = {},
  ): Promise<SarvamResult | null> {
    this.calls += 1;
    this.audioS += audio.length / SAMPLE_RATE;
    if (!this.opts.useStream) return this.rest(audio, opts.mode, opts.languageCode);
    try {
      return await this.wsOnce(audio, opts.timeoutMs ?? this.opts.wsTimeoutMs ?? 10000);
    } catch (err) {
      this.close();
      // eslint-disable-next-line no-console
      console.warn(`websocket failed (${String(err)}); using REST for this utterance`);
      return this.rest(audio, opts.mode, opts.languageCode);
    }
  }

  private async wsOnce(audio: Float32Array, timeoutMs: number): Promise<SarvamResult> {
    const pcm = float32ToPcm16Bytes(audio);
    const ws = await this.connect();
    ws.send(JSON.stringify({ event: "speech_start" }));
    for (let i = 0; i < pcm.length; i += SARVAM_CHUNK_BYTES) {
      const slice = pcm.subarray(i, i + SARVAM_CHUNK_BYTES);
      ws.send(JSON.stringify({ event: "audio_input", audio: bytesToBase64(slice) }));
    }
    ws.send(JSON.stringify({ event: "speech_end" }));
    ws.send(JSON.stringify({ event: "flush" }));

    return await new Promise<SarvamResult>((resolve, reject) => {
      const parts: string[] = [];
      let lang: string | null = null;
      const timer = setTimeout(() => {
        cleanup();
        resolve({ text: parts.filter(Boolean).join(" ").trim(), language: lang });
      }, timeoutMs);
      const onMsg = (ev: MessageEvent) => {
        let m: any;
        try {
          m = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        } catch {
          return;
        }
        const event = m.event || m.type;
        const d = m.data ?? m;
        if (event === "transcript.final") {
          parts.push(((d.text as string) || "").trim());
          lang = d.language || lang;
          cleanup();
          resolve({ text: parts.filter(Boolean).join(" ").trim(), language: lang });
        } else if (event === "error") {
          cleanup();
          reject(new Error(`${d.code}: ${d.message}`));
        } else if ((event === "session.end" || event === "vad.speech_end") && parts.length) {
          cleanup();
          resolve({ text: parts.filter(Boolean).join(" ").trim(), language: lang });
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg);
      };
      ws.addEventListener("message", onMsg);
    });
  }

  private connect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    // Browsers can't set arbitrary WS headers, so the key rides in the
    // subprotocol — the same mechanism the official SDK uses. Passing it as a
    // `?api-subscription-key=` query param instead LOOKS like it works (the
    // handshake completes) and is then rejected with
    // "invalid_subscription_key" in the first message, on a socket that stays
    // open and silent forever.
    const ws = new WebSocket(this.wsFullUrl(), [
      `api-subscription-key.${this.apiKey}`,
    ]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("open timeout")), 8000);
      ws.onopen = () => {
        clearTimeout(to);
        resolve(ws);
      };
      ws.onerror = () => {
        clearTimeout(to);
        reject(new Error("socket error"));
      };
    });
  }

  private async rest(
    audio: Float32Array,
    mode?: string,
    languageCode?: string,
  ): Promise<SarvamResult | null> {
    const wav = new Blob([encodeWav(audio, SAMPLE_RATE)], { type: "audio/wav" });
    const form = new FormData();
    form.append("model", SARVAM_REST_MODEL);
    // "unknown" makes Sarvam auto-detect per request. That is fine for a whole
    // utterance, but when the caller sends short slices each one is detected
    // independently, and a second of Indian-accented English comes back as
    // Gujarati or Punjabi. Pin the language when the caller knows it.
    form.append("language_code", languageCode || "unknown");
    if (mode) form.append("mode", mode);
    form.append("file", wav, "a.wav");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(this.opts.restUrl ?? SARVAM_REST_URL, {
        method: "POST",
        headers: { "Api-Subscription-Key": this.apiKey },
        body: form,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        // eslint-disable-next-line no-console
        console.error(`[Sarvam STT] HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
        throw new Error(`HTTP ${res.status}`);
      }
      const d: any = await res.json();
      const text = ((d.transcript as string) || "").trim();
      if (!text) {
        // eslint-disable-next-line no-console
        console.warn(
          `[Sarvam STT] 200 OK but empty transcript. Response keys: ${Object.keys(d).join(", ")}`,
        );
      }
      return {
        text,
        language: d.language_code ?? null,
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`REST failed: ${String(err)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.send(JSON.stringify({ event: "end" }));
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  costInr(): number {
    return (this.audioS / 3600) * 30;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  AUDIO INPUT — browser mic (getUserMedia + AudioWorklet), or a WAV buffer
// ─────────────────────────────────────────────────────────────────────────────

// The Python original read FRAME-sized blocks from PortAudio (mic_frames) or a
// wave file (wav_frames). In the browser the equivalents are getUserMedia +
// an AudioWorklet, and decodeAudioData. Both yield a stream of 512-sample
// (FRAME) Float32 frames at 16 kHz.

const CAPTURE_WORKLET_SOURCE = `
class VffFrameProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      const ch = input[0];
      const copy = new Float32Array(ch.length);
      copy.set(ch);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor("vff-frame-processor", VffFrameProcessor);
`;

/** One-pole-free integer-factor decimator with a simple biquad anti-alias, so
 *  native-rate mic audio (usually 48 kHz) becomes clean 16 kHz. Mirrors the
 *  library's Decimator. */
class Decimator {
  private b0: number; private b1: number; private b2: number;
  private a1: number; private a2: number;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  private counter = 0;
  constructor(private readonly factor: number, sampleRate: number, cutoffHz = 7000) {
    const w = (2 * Math.PI * cutoffHz) / sampleRate;
    const alpha = Math.sin(w) / (2 * 0.707);
    const cosw = Math.cos(w);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cosw) / 2) / a0;
    this.b1 = (1 - cosw) / a0;
    this.b2 = ((1 - cosw) / 2) / a0;
    this.a1 = (-2 * cosw) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  processBlock(input: Float32Array): Float32Array {
    const out: number[] = [];
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      const y =
        this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 -
        this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
      if (this.counter === 0) out.push(y);
      this.counter = (this.counter + 1) % this.factor;
    }
    return Float32Array.from(out);
  }
}

/** Rebuffers an arbitrary stream of Float32 blocks into fixed FRAME-sized
 *  frames delivered via callback. */
class FrameChunker {
  private pending: number[] = [];
  constructor(private readonly onFrame: (f: Float32Array) => void) {}
  push(block: Float32Array): void {
    for (let i = 0; i < block.length; i++) this.pending.push(block[i]);
    while (this.pending.length >= FRAME) {
      this.onFrame(Float32Array.from(this.pending.splice(0, FRAME)));
    }
  }
}

/** A running microphone frame source. Call `stop()` to release the mic. */
export interface FrameSource {
  stop(): Promise<void>;
}

/** Opens the mic and drives `onFrame` with 16 kHz / FRAME-sample frames. */
export async function micFrameSource(
  onFrame: (frame: Float32Array) => void,
  deviceId?: string,
): Promise<FrameSource> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    throw new Error("navigator.mediaDevices unavailable (needs HTTPS or localhost).");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      autoGainControl: true,
      noiseSuppression: true,
      deviceId: deviceId ? { exact: deviceId } : undefined,
    },
  });
  const AC: typeof AudioContext =
    window.AudioContext ?? (window as any).webkitAudioContext;
  const ctx = new AC();
  const src = ctx.createMediaStreamSource(stream);

  const blobUrl = URL.createObjectURL(
    new Blob([CAPTURE_WORKLET_SOURCE], { type: "application/javascript" }),
  );
  try {
    await ctx.audioWorklet.addModule(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  const node = new AudioWorkletNode(ctx, "vff-frame-processor");
  const factor = Math.max(1, Math.round(ctx.sampleRate / SAMPLE_RATE));
  const decimator = new Decimator(factor, ctx.sampleRate);
  const chunker = new FrameChunker(onFrame);

  node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    const down = factor > 1 ? decimator.processBlock(ev.data) : ev.data;
    chunker.push(down);
  };
  const sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(node).connect(sink).connect(ctx.destination);
  if (ctx.state === "suspended") await ctx.resume();

  return {
    async stop() {
      node.port.onmessage = null;
      try { src.disconnect(); node.disconnect(); sink.disconnect(); } catch { /* ignore */ }
      for (const t of stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
      await ctx.close().catch(() => undefined);
    },
  };
}

/** Decodes a WAV/audio ArrayBuffer to 16 kHz mono FRAME frames — the browser
 *  analogue of wav_frames(), for testing without a mic. */
export async function wavFrames(buffer: ArrayBuffer): Promise<Float32Array[]> {
  const AC: typeof AudioContext =
    window.AudioContext ?? (window as any).webkitAudioContext;
  const tmp = new AC();
  const decoded = await tmp.decodeAudioData(buffer.slice(0));
  await tmp.close().catch(() => undefined);

  // downmix to mono
  const chs = decoded.numberOfChannels;
  const mono = new Float32Array(decoded.length);
  for (let c = 0; c < chs; c++) {
    const d = decoded.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / chs;
  }
  // resample to 16 kHz via OfflineAudioContext if needed
  let x = mono;
  if (decoded.sampleRate !== SAMPLE_RATE) {
    const off = new OfflineAudioContext(1, Math.ceil((mono.length * SAMPLE_RATE) / decoded.sampleRate), SAMPLE_RATE);
    const buf = off.createBuffer(1, mono.length, decoded.sampleRate);
    buf.copyToChannel(mono, 0);
    const node = off.createBufferSource();
    node.buffer = buf;
    node.connect(off.destination);
    node.start();
    const rendered = await off.startRendering();
    x = rendered.getChannelData(0).slice();
  }
  const frames: Float32Array[] = [];
  for (let i = 0; i + FRAME <= x.length; i += FRAME) frames.push(x.subarray(i, i + FRAME).slice());
  return frames;
}

// ─────────────────────────────────────────────────────────────────────────────
//  VOICEPRINT PROFILE — browser-friendly JSON (browsers can't read .npz)
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceProfile {
  centroid: number[]; // unit-norm, length 192
  embeddings?: number[][];
  phrase?: string;
  created?: string;
}

/** Build a profile from a bare centroid array (e.g. converted from the Python
 *  voice_profile.npz -> voice_profile.json). Re-normalises defensively. */
export function voiceProfileFromCentroid(centroid: number[], phrase?: string): VoiceProfile {
  const v = l2normalize(Float32Array.from(centroid));
  return { centroid: Array.from(v), phrase, created: new Date().toISOString() };
}

function centroidVec(p: VoiceProfile): Float32Array {
  return Float32Array.from(p.centroid);
}

// ─────────────────────────────────────────────────────────────────────────────
//  ORCHESTRATOR — the CLI's --enroll / --calibrate / run loop as one class
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceFormModels {
  /** ArrayBuffers or URLs for the three ONNX models. URLs are fetched. */
  sileroVad: ArrayBuffer | string;
  campplus: ArrayBuffer | string;
  gtcrn?: ArrayBuffer | string; // optional; omit to disable the denoiser
}

export interface VoiceFormOptions {
  sarvamApiKey: string;
  models: VoiceFormModels;
  useStream?: boolean; // opt into Sarvam realtime WS (default: REST)
  sarvamRestUrl?: string; // proxy override to sidestep CORS
  sarvamWsUrl?: string;
  matchThreshold?: number;
  rejectMargin?: number;
  deviceId?: string; // mic device
}

export interface TranscriptResult {
  text: string;
  language: string | null;
  similarity: number;
  unsure: boolean;
  durationS: number;
  latencyMs: number;
  timestamp: string;
  timestampEpoch: number;
}

export interface ListenSession {
  stop(): Promise<{ total: number; kept: number; audioS: number; keptS: number; costInr: number }>;
}

async function loadModel(m: ArrayBuffer | string): Promise<ArrayBuffer> {
  if (typeof m !== "string") return m;
  const res = await fetch(m);
  if (!res.ok) throw new Error(`failed to fetch model ${m}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

export class VoiceForm {
  private vad!: VAD;
  private embedder!: Embedder;
  private denoiser: Denoiser | null = null;
  private sarvam: Sarvam;
  private readonly matchThreshold: number;
  private readonly rejectMargin: number;

  constructor(private readonly opts: VoiceFormOptions) {
    if (!opts.sarvamApiKey) throw new Error("sarvamApiKey is required");
    this.matchThreshold = opts.matchThreshold ?? MATCH_THRESHOLD;
    this.rejectMargin = opts.rejectMargin ?? REJECT_MARGIN;
    this.sarvam = new Sarvam(opts.sarvamApiKey, {
      useStream: opts.useStream,
      restUrl: opts.sarvamRestUrl,
      wsUrl: opts.sarvamWsUrl,
    });
  }

  /** Loads the three ONNX models. Call once before enroll/calibrate/listen. */
  async load(): Promise<void> {
    const [vadBuf, camBuf] = await Promise.all([
      loadModel(this.opts.models.sileroVad),
      loadModel(this.opts.models.campplus),
    ]);
    this.vad = await VAD.create(vadBuf);
    this.embedder = await Embedder.create(camBuf);
    if (this.opts.models.gtcrn) {
      this.denoiser = await Denoiser.create(await loadModel(this.opts.models.gtcrn));
    }
  }

  /**
   * Enrollment — the user says a known phrase `repeats` times; we average the
   * embeddings into a voiceprint. Port of the Python `enroll()`.
   */
  async enroll(opts: {
    phrase?: string;
    repeats?: number;
    strict?: boolean;
    deviceId?: string;
    onPrompt?: (payload: {
      recording: number;
      of: number;
      attempt: number;
      phrase: string;
      hint?: string;
    }) => void;
    onHeard?: (payload: { text: string; score: number; ok: boolean; durationS: number }) => void;
    onError?: (message: string) => void;
  } = {}): Promise<VoiceProfile | null> {
    const phrase = opts.phrase ?? ENROLL_PHRASE;
    const repeats = opts.repeats ?? ENROLL_REPEATS;
    const strict = opts.strict ?? true;
    const maxAttempts = repeats + 6;

    const seg = new Segmenter(this.vad, {
      minSilenceMs: ENROLL_MIN_SILENCE_MS,
      maxMs: ENROLL_MAX_UTTERANCE_MS,
    });
    const embeddings: Float32Array[] = [];
    let got = 0;
    let attempts = 0;

    opts.onPrompt?.({ recording: 1, of: repeats, attempt: 1, phrase, hint: ENROLL_PHRASE_HINT });

    const queue: Utterance[] = [];
    const source = await micFrameSource(async (frame) => {
      const u = await seg.push(frame);
      if (u) queue.push(u);
    }, opts.deviceId ?? this.opts.deviceId);

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const utt = queue.shift();
        if (!utt) {
          await sleep(20);
          continue;
        }
        attempts += 1;
        const dur = utt.durationS;
        if (dur < 0.8) {
          opts.onError?.(`too short (${dur.toFixed(1)}s), try again`);
          continue;
        }
        const e = await this.embedder.embed(utt.audio);
        if (!e) {
          opts.onError?.("couldn't read that, try again");
          continue;
        }
        const clean = this.denoiser ? await this.denoiser.run(utt.audio) : utt.audio;
        // mode="translit" asks Sarvam to romanize the speech itself, so we
        // compare Latin against Latin instead of Devanagari against Latin.
        const r = await this.sarvam.transcribe(clean, { mode: "translit" });
        const said = r?.text ?? "";
        const { score, ok } = phraseMatches(said, phrase);
        opts.onHeard?.({ text: said, score, ok, durationS: dur });

        if (strict && !ok) {
          opts.onError?.("that didn't match the phrase — please read it again");
          if (attempts >= maxAttempts) {
            opts.onError?.("Too many attempts. Try strict:false, or an easier phrase.");
            return null;
          }
          opts.onPrompt?.({ recording: got + 1, of: repeats, attempt: attempts + 1, phrase, hint: ENROLL_PHRASE_HINT });
          continue;
        }

        embeddings.push(e);
        got += 1;
        if (got >= repeats) break;
        opts.onPrompt?.({ recording: got + 1, of: repeats, attempt: attempts + 1, phrase, hint: ENROLL_PHRASE_HINT });
      }
    } finally {
      await source.stop();
    }

    if (!embeddings.length) return null;

    // consistency check between repeats — catches a bad mic or a second person
    if (embeddings.length > 1) {
      let worst = Infinity;
      for (let i = 1; i < embeddings.length; i++) {
        worst = Math.min(worst, cosine(embeddings[0], embeddings[i]));
      }
      if (worst < 0.55) {
        opts.onError?.(`repeat consistency LOW (${worst.toFixed(2)}) — matching may be unreliable`);
      }
    }

    // mean of unit-norm embeddings, re-normalised
    const dim = embeddings[0].length;
    const mean = new Float32Array(dim);
    for (const e of embeddings) for (let i = 0; i < dim; i++) mean[i] += e[i];
    for (let i = 0; i < dim; i++) mean[i] /= embeddings.length;
    const centroid = l2normalize(mean);

    return {
      centroid: Array.from(centroid),
      embeddings: embeddings.map((e) => Array.from(e)),
      phrase,
      created: new Date().toISOString(),
    };
  }

  /**
   * Calibration — collect cosine scores for the enrolled person and a different
   * person, then suggest a threshold. Port of the Python `calibrate()`. The
   * caller drives the two collection phases via `phase()` transitions.
   */
  async calibrate(
    profile: VoiceProfile,
    opts: {
      perPhase?: number;
      deviceId?: string;
      onPhase: (phase: "enrolled" | "different") => void;
      onSample?: (payload: { phase: "enrolled" | "different"; index: number; cosine: number }) => void;
      /** Resolve/await this to advance from the enrolled phase to the different
       *  phase (e.g. wait for a button press). */
      waitForNextPhase: () => Promise<void>;
    },
  ): Promise<{
    same: number[];
    other: number[];
    gap: number;
    threshold: number | null;
    verdict: "clean" | "narrow" | "none" | "insufficient";
  }> {
    const centroid = centroidVec(profile);
    const n = opts.perPhase ?? 5;
    const seg = new Segmenter(this.vad);

    const collect = async (phase: "enrolled" | "different"): Promise<number[]> => {
      const scores: number[] = [];
      opts.onPhase(phase);
      const queue: Utterance[] = [];
      const source = await micFrameSource(async (frame) => {
        const u = await seg.push(frame);
        if (u) queue.push(u);
      }, opts.deviceId ?? this.opts.deviceId);
      const advance = phase === "enrolled" ? opts.waitForNextPhase() : Promise.resolve();
      let done = false;
      advance.then(() => { done = true; });
      try {
        while (scores.length < n && !done) {
          const u = queue.shift();
          if (!u || u.durationS < 0.8) { await sleep(20); continue; }
          const e = await this.embedder.embed(u.audio);
          if (!e) continue;
          const s = cosine(e, centroid);
          scores.push(s);
          opts.onSample?.({ phase, index: scores.length, cosine: s });
        }
      } finally {
        await source.stop();
      }
      return scores;
    };

    const same = await collect("enrolled");
    const other = await collect("different");

    if (same.length < 2 || other.length < 2) {
      return { same, other, gap: NaN, threshold: null, verdict: "insufficient" };
    }
    const lo = Math.min(...same);
    const hi = Math.max(...other);
    const gap = lo - hi;
    if (gap > 0.1) return { same, other, gap, threshold: (lo + hi) / 2, verdict: "clean" };
    if (gap > 0) return { same, other, gap, threshold: (lo + hi) / 2, verdict: "narrow" };
    return { same, other, gap, threshold: null, verdict: "none" };
  }

  /**
   * The live loop: mic -> VAD -> speaker gate -> (denoise) -> Sarvam. Only the
   * enrolled speaker's speech is ever sent. Port of the Python `run()`.
   * Returns a session handle; call `stop()` to end and get the cost summary.
   */
  listen(
    profile: VoiceProfile,
    handlers: {
      onResult: (r: TranscriptResult) => void;
      onRejected?: (payload: { timestamp: string; similarity: number }) => void;
      onError?: (message: string) => void;
    },
  ): ListenSession {
    const centroid = centroidVec(profile);
    const seg = new Segmenter(this.vad);
    let total = 0;
    let kept = 0;
    let audioS = 0;
    let keptS = 0;

    const queue: Utterance[] = [];
    let running = true;
    let sourcePromise: Promise<FrameSource>;

    const pump = async () => {
      while (running) {
        const utt = queue.shift();
        if (!utt) { await sleep(20); continue; }
        total += 1;
        const dur = utt.durationS;
        const t0 = performance.now();

        // ── speaker check happens BEFORE transcription. This is the cost gate.
        const e = await this.embedder.embed(utt.audio);
        const sim = e ? cosine(e, centroid) : -1;

        if (sim < this.matchThreshold - this.rejectMargin) {
          handlers.onRejected?.({ timestamp: utt.timestamp, similarity: sim });
          continue;
        }
        const unsure = sim < this.matchThreshold;

        const clean = this.denoiser ? await this.denoiser.run(utt.audio) : utt.audio;
        const r = await this.sarvam.transcribe(clean);
        if (!r || !r.text) continue;

        kept += 1;
        keptS += dur;
        handlers.onResult({
          text: r.text,
          language: r.language,
          similarity: Math.round(sim * 1000) / 1000,
          unsure,
          durationS: Math.round(dur * 100) / 100,
          latencyMs: Math.round(performance.now() - t0),
          timestamp: utt.timestamp,
          timestampEpoch: Math.round(utt.startWall * 1000) / 1000,
        });
      }
    };

    sourcePromise = micFrameSource(async (frame) => {
      audioS += FRAME / SAMPLE_RATE;
      const u = await seg.push(frame);
      if (u) queue.push(u);
    }, this.opts.deviceId).catch((err) => {
      handlers.onError?.(String(err));
      throw err;
    });
    void pump();

    return {
      stop: async () => {
        running = false;
        try {
          (await sourcePromise).stop();
        } catch {
          // ignore
        }
        this.sarvam.close();
        return {
          total,
          kept,
          audioS,
          keptS,
          costInr: this.sarvam.costInr(),
        };
      },
    };
  }

  /** Cumulative audio-seconds billed and ₹ cost so far (mirrors the CLI tally). */
  cost(): { audioS: number; costInr: number; calls: number } {
    return { audioS: this.sarvam.audioS, costInr: this.sarvam.costInr(), calls: this.sarvam.calls };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}