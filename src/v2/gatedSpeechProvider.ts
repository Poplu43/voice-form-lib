/**
 * gatedSpeechProvider.ts — a drop-in speech provider that puts the voiceform.ts
 * speaker gate in FRONT of transcription.
 *
 * Why this shape (and not editing SarvamSpeechService): the normal Sarvam path
 * streams audio chunks to a websocket continuously, so there is no per-utterance
 * boundary at which you can decide "is this our speaker?" BEFORE the audio is
 * sent (and billed). This provider instead does its own client-side VAD
 * (Silero), segments speech, embeds it with CAM++, compares to the enrolled
 * voiceprint, and puts ONLY the matching speaker's audio on the wire —
 * substituting silence for everyone else. Other voices are never transcribed,
 * never billed, and cannot appear in the transcript. TTS is delegated to a
 * normal SarvamSpeechService.
 *
 * Filtering the TEXT instead does not work, and it is worth knowing why: the
 * transcriber segments on its own VAD, so one segment can hold the user and the
 * person beside them, arriving as a single string containing both. Once two
 * voices are in one transcript, nothing downstream can separate them — the
 * mixing already happened. The filtering has to be on the audio.
 *
 * It implements SarvamSpeechProvider, so it plugs into V2VoiceFormService with
 * no library changes via:
 *     bhashiniProxy: { provider: gated, language }
 * (bhashiniProxy.provider is used verbatim — see voiceFormService.ts:4625.)
 *
 * WHAT THIS SOLVES / DOESN'T
 *   solves  : other people talking in turns, background chatter — their
 *             utterances embed to a different voice and are dropped.
 *   solves  : a crowded, noisy room where the enrolled speaker and others
 *             interleave inside ONE utterance. A single embedding of that is an
 *             average of everybody and matches nobody, so a rejected turn is
 *             re-examined window by window (see speakerFocus.ts) and only the
 *             enrolled speaker's parts are transcribed. Without this, a noisy
 *             room reads as silence and the user is told to speak louder while
 *             they are already speaking perfectly clearly.
 *   doesn't : two people talking at the exact same instant on one mic. A single
 *             embedding of mixed audio matches neither cleanly; un-mixing needs
 *             source separation, which has no viable real-time CPU model. The
 *             windowing above helps only because in real rooms one voice is
 *             usually dominant at any given moment.
 *
 * CAVEATS (must test on real hardware)
 *   - matchThreshold is mic/room/voice dependent. Run VoiceForm.calibrate()
 *     once and set the number it returns. 0.5 is only a starting point.
 *   - Very short utterances (2-3 words, <~1s) give less reliable embeddings.
 *
 * LATENCY MODEL (why this file works in slices, not utterances)
 *   The obvious implementation waits for the VAD endpoint, then embeds the whole
 *   utterance, then transcribes the whole utterance. Everything is serialised
 *   behind the pause, so the user sees nothing until ~1-2s after they stop
 *   talking — and the wait grows with how long they spoke.
 *
 *   Instead the Segmenter hands us `InterimSpeech` snapshots every
 *   `interimChunkMs` while the user is still talking, and we:
 *     1. run the speaker gate on the FIRST ~`gateMinSpeechMs` of speech, on a
 *        bounded window, so the accept/reject decision is done early and its
 *        cost does not scale with utterance length;
 *     2. on the realtime socket, let Sarvam stream cumulative partials as the
 *        person speaks (measured: first partial ~1.1s in, then ~1/second, and a
 *        cleaned-up `transcript.final` ~600ms after they stop) — or, on the REST
 *        fallback, transcribe in `restChunkMs` slices;
 *     3. at the endpoint, only the un-transcribed tail is left to send.
 *   Text is emitted cumulatively per turn: a realtime transcript restates and
 *   revises the whole turn (replace), a REST slice continues it (append). Either
 *   way the form service sees one growing answer rather than several.
 *
 *   The gate decides ONCE per turn by default. A rejection is not the last word
 *   — the endpoint re-checks the complete utterance, which is the steadiest
 *   embedding available, before anything is discarded.
 */

import type {
  SarvamSpeechConfig,
  SarvamSpeechProvider,
  SarvamSTTHandlers,
  V2SupportedLanguage,
} from "./types";
import { ort } from "@ricky0123/vad-web/dist/real-time-vad";
import { SarvamSpeechService } from "./sarvamSpeech";
import { resolveNoiseSuppressionAssetUrls } from "./noiseSuppressionAssets";
import { appendWithOverlap, isRevisionOf } from "./transcriptChunks";
import { dropInconsistentEmbeddings } from "./voiceprint";
import { SpeakerFocus, type SpeakerFocusConfig } from "./speakerFocus";
import {
  VAD,
  Embedder,
  Denoiser,
  Segmenter,
  Utterance,
  Sarvam,
  micFrameSource,
  phraseMatches,
  type FrameSource,
  type InterimSpeech,
  type VoiceProfile,
  ENROLL_MIN_SILENCE_MS,
  ENROLL_MAX_UTTERANCE_MS,
  ENROLL_PHRASE,
  ENROLL_PHRASE_HINT,
  SARVAM_MODE,
  SARVAM_WS_LANG,
  SARVAM_WS_MODEL,
  SARVAM_WS_URL,
  FRAME,
  SAMPLE_RATE,
} from "./voiceform";

export interface GatedSpeechConfig {
  /** ONNX models: ArrayBuffers or URLs. gtcrn optional (denoiser off if absent). */
  models: {
    sileroVad: ArrayBuffer | string;
    campplus: ArrayBuffer | string;
    gtcrn?: ArrayBuffer | string;
  };
  /** Enrolled voiceprint (e.g. voiceProfileFromCentroid(voice_profile.json)). */
  profile: VoiceProfile;
  matchThreshold?: number; // default 0.5 — TUNE with calibrate()
  rejectMargin?: number; // default 0.06

  /** Sarvam key used for REST STT (sent as Api-Subscription-Key). */
  sarvamApiKey: string;
  /** Same-origin STT proxy to avoid CORS, e.g. "/api/sarvam-stt". */
  sttProxyUrl?: string;
  /** Sarvam REST mode, e.g. "codemix". Omit for Sarvam's default. */
  sttMode?: string;

  /** TTS is delegated to a normal SarvamSpeechService built from this. */
  tts: SarvamSpeechConfig;

  language: V2SupportedLanguage;
  deviceId?: string;
  debug?: boolean;
  /** Override base URL for the onnxruntime-web .wasm runtime (offline / air-gapped
   *  deployments). Same layout as noiseSuppressionAssets. Defaults to the CDN. */
  assetBaseUrl?: string;

  // ── latency tuning (see "LATENCY MODEL" in the file header) ───────────────
  /**
   * Silence that closes an utterance. Default 500ms.
   *
   * Not lower: measured, Sarvam's own VAD calls end-of-speech about 500ms after
   * you stop, so a shorter endpoint here closes the turn before the server even
   * agrees speech ended — and, worse, splits one spoken sentence into several
   * runs at ordinary mid-sentence pauses. Each fragment then gets its own
   * speaker check and its own answer, which is how "I'm Hindu" arrives as "I".
   */
  endpointSilenceMs?: number;
  /** How often in-progress speech is inspected. This is the granularity of
   *  everything below. Default 450ms. */
  interimChunkMs?: number;
  /** Speech required before the speaker gate makes its first call. Below
   *  ~500ms CAM++ embeddings get noticeably noisier. Default 650ms. */
  gateMinSpeechMs?: number;
  /** Most-recent audio fed to CAM++ per check. Bounded so gate cost stays flat
   *  no matter how long the person talks. Default 1500ms. */
  gateWindowMs?: number;
  /**
   * Re-run the gate this often while speech continues, to catch a handover to a
   * different speaker mid-utterance. 0 = decide once per turn (default).
   *
   * Off by default because the failure modes are lopsided. CAM++ similarity for
   * ONE speaker swings widely across a sentence — a trailing-off clause or a
   * quiet syllable reads far lower than the same person's opening words — so a
   * mid-turn re-check mostly truncates real answers, and a truncated answer is
   * both wrong and invisible to the user. Mid-sentence speaker handover, the
   * thing it protects against, is rare by comparison. When enabled, a rejection
   * needs two consecutive confident readings, not one.
   */
  gateReverifyMs?: number;
  /**
   * Speech required before a below-threshold reading is allowed to REJECT a
   * turn. CAM++ embeddings under ~1s are noisy, so an early low cosine means
   * "not sure yet", not "different person" — before this much audio the gate
   * only ever accepts, and an undecided turn falls back to judging the complete
   * utterance at the endpoint. Default 1500ms.
   */
  gateHardRejectMs?: number;
  /**
   * Realtime path: ask Sarvam to flush an interim transcript this often while
   * the enrolled speaker keeps talking.
   *
   * Default 0 (off), because the realtime endpoint does not need it: measured
   * against api.sarvam.ai, it emits cumulative `transcript.partial` about once a
   * second on its own, and produces `transcript.final` off its own VAD once it
   * hears trailing silence — a manual flush changed nothing. Left configurable
   * for proxies/endpoints that do buffer until asked.
   */
  streamingFlushMs?: number;
  /** REST path: transcribe the running utterance in slices this long instead of
   *  waiting for the endpoint. 0 = whole-utterance (old behaviour, highest
   *  latency, fewest requests). Default 1300ms. */
  restChunkMs?: number;
  /**
   * Hard cap on a single utterance. Default 30000ms.
   *
   * Someone answering several form fields in one breath easily passes the
   * library's 15s default, and hitting the cap used to read as end-of-turn: the
   * answer was routed half-finished and the assistant moved on while they were
   * still talking. Reaching the cap now only closes the audio chunk, not the
   * turn.
   */
  maxUtteranceMs?: number;

  /**
   * Once someone has been speaking for `flowAfterMs`, the endpoint widens to
   * `flowEndpointSilenceMs`. Defaults: 3500ms and 900ms.
   *
   * A short answer wants a short endpoint, so the form feels quick. But someone
   * reciting "community OBC, income two lakh, district Sonipat…" pauses between
   * items far longer than between words, and a short endpoint chops that into
   * fragments — each routed separately, most of them against the wrong field.
   * The two cases want opposite settings, so the endpoint adapts once the shape
   * of the answer is apparent.
   */
  flowAfterMs?: number;
  flowEndpointSilenceMs?: number;

  /**
   * Shortest burst of speech that counts as an utterance. Default 200ms.
   *
   * The library default (380ms) is tuned to reject coughs and clicks, and it
   * also rejects "No", "Yes" and "Haan" — a form full of yes/no questions then
   * never forms an utterance for them, so the speaker gate never runs, and the
   * transcript Sarvam DID produce gets discarded for failing a check that never
   * happened. Short answers are the ones a voice form most needs to hear.
   */
  minSpeechMs?: number;

  /**
   * What to do with speech the gate could not confidently judge — too short to
   * embed reliably, or too noisy.
   *
   * `false` (default) drops it: in a room with other people in it, the
   * ambiguous middle is mostly THEM, and a voiceprint gate whose answer to "I am
   * not sure" is "transcribe it anyway" does not do the job it exists for. The
   * cost is real and worth stating: a genuine one-word answer that lands in the
   * ambiguous band is lost, and the user is asked again.
   *
   * `true` transcribes it instead, which suits a single-user desk where a lost
   * answer is the more annoying failure. Short utterances are still judged
   * against the room (see judgeCompleteUtterance) in both modes, so this governs
   * only what happens when even that comparison is inconclusive.
   */
  recallFirst?: boolean;

  /**
   * Crowd handling. When the whole-utterance speaker check fails — which is what
   * a noisy room does to it — the utterance is re-examined in short windows and
   * only the parts that look like the enrolled speaker are transcribed, instead
   * of the turn being dropped and the user told to speak up.
   *
   * `false` disables it (one verdict per utterance, as before). Pass an object to
   * tune the windowing. Enabled by default.
   */
  crowdFocus?: boolean | SpeakerFocusConfig;

  /**
   * Realtime path: how long to wait after our own endpoint for Sarvam's final
   * transcript before declaring the turn over. Measured, the server's
   * `transcript.final` lands ~600ms after speech stops — about 300ms after our
   * (shorter) endpoint — and a final that arrives ends the wait immediately, so
   * this only costs anything when one never comes. Default 800ms.
   */
  finalGraceMs?: number;
}

/** Per-turn state. One of these exists from the moment the VAD detects speech
 *  until the utterance has been fully transcribed. */
interface SpeechRun {
  id: number;
  /** "pending" until the gate has enough speech to judge the speaker. */
  decision: "pending" | "accept" | "reject";
  /** Set when a rejection was clearly someone else (cosine below the reject
   *  margin) rather than a marginal reading. A confident rejection is the only
   *  one that stops feeding the socket mid-turn. */
  confidentReject: boolean;
  /** Consecutive confident-low readings while already accepted. A single one is
   *  not enough to abandon a turn (see gateReverifyMs). */
  lowStreak: number;
  /** Whether the service has been told this turn is under way. Must happen
   *  before any text is released, or the service — believing nobody is speaking
   *  — starts its finalization debounce and ends the answer mid-sentence. */
  speechStartFired: boolean;
  gateBusy: boolean;
  lastGateAt: number;
  /** Samples of this run already handed to STT (REST path). */
  restCursor: number;
  restBusy: boolean;
  lastFlushAt: number;
  /** Cumulative text emitted for this run so far. */
  text: string;
  /** Samples already counted towards the audio-seconds bill (WS path). */
  accountedSamples: number;
}

const DEFAULTS = {
  endpointSilenceMs: 500,
  interimChunkMs: 450,
  gateMinSpeechMs: 650,
  gateWindowMs: 1500,
  gateReverifyMs: 0,
  gateHardRejectMs: 1500,
  minSpeechMs: 200,
  maxUtteranceMs: 30000,
  flowAfterMs: 3500,
  flowEndpointSilenceMs: 900,
  streamingFlushMs: 0,
  restChunkMs: 1300,
  finalGraceMs: 800,
} as const;

/** Minimum gap between gate checks, so an undecided turn re-tests on fresh
 *  audio rather than on every snapshot. */
const GATE_RETRY_MS = 350;

/** Extra wait after a rescue flush, when the server's own final never arrived. */
const RESCUE_FLUSH_GRACE_MS = 500;

/** Sent in place of anyone else's audio, so the transcriber's timeline stays
 *  continuous (and its endpointing keeps working) while hearing only the user. */
const SILENT_FRAME = new Float32Array(FRAME);

/** Under this, an utterance is too short for a trustworthy CAM++ embedding, so
 *  a low score says nothing. "No" and "Yes" live here. */
const UNJUDGEABLE_MS = 750;

/** How long a confident rejection keeps suppressing server transcripts — long
 *  enough to cover the other speaker's sentence, short enough not to swallow the
 *  user's reply to them. */
const REJECTION_SHADOW_MS = 2500;

/** Shortest slice worth a Sarvam request — below this it is almost always a
 *  breath or a clipped consonant, and the round-trip returns "". */
const MIN_SLICE_MS = 280;
/** Shortest tail worth sending at the endpoint. Smaller than MIN_SLICE_MS
 *  because a dropped tail loses the end of a real word. */
const MIN_TAIL_MS = 180;

async function loadBuf(m: ArrayBuffer | string): Promise<ArrayBuffer> {
  if (typeof m !== "string") return m;
  const res = await fetch(m);
  if (!res.ok) throw new Error(`model fetch failed (${m}): HTTP ${res.status}`);
  return res.arrayBuffer();
}

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function msToSamples(ms: number): number {
  return Math.round((ms / 1000) * SAMPLE_RATE);
}

/** The last `ms` of `x` (or all of it, if shorter). Keeps the speaker gate's
 *  cost independent of how long the person has been talking. */
function tailWindow(x: Float32Array, ms: number): Float32Array {
  const want = msToSamples(ms);
  return x.length <= want ? x : x.subarray(x.length - want);
}

function rmsOf(x: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i] * x[i];
  const n = Math.max(1, to - from);
  return Math.sqrt(sum / n);
}

/**
 * Picks a slice boundary inside [earliest, end) that lands on the quietest 20ms
 * window — i.e. between words rather than mid-syllable. Cutting a slice through
 * the middle of a word costs accuracy on BOTH sides of the seam, which is the
 * main risk of chunked transcription.
 */
function findQuietCut(x: Float32Array, earliest: number, end: number): number {
  const win = msToSamples(20);
  const from = Math.max(0, Math.min(earliest, end - win));
  if (end - from <= win) return end;
  let bestAt = end;
  let bestRms = Infinity;
  for (let start = from; start + win <= end; start += win) {
    const r = rmsOf(x, start, start + win);
    if (r < bestRms) {
      bestRms = r;
      bestAt = start + win;
    }
  }
  return bestAt;
}

/**
 * Drops the trailing silence the segmenter appends while it waits out
 * `endpointSilenceMs`, so the endpoint tail isn't mostly-empty audio (which
 * both costs money and makes Sarvam more likely to return "").
 */
function trimTrailingSilence(x: Float32Array): Float32Array {
  if (x.length === 0) return x;
  const win = msToSamples(20);
  let peak = 0;
  for (let start = 0; start + win <= x.length; start += win) {
    peak = Math.max(peak, rmsOf(x, start, start + win));
  }
  const floor = Math.max(0.004, peak * 0.1);
  let lastVoiced = -1;
  for (let start = 0; start + win <= x.length; start += win) {
    if (rmsOf(x, start, start + win) > floor) lastVoiced = start + win;
  }
  if (lastVoiced < 0) return x.subarray(0, 0);
  // Keep a little air after the last voiced window so plosives aren't clipped.
  return x.subarray(0, Math.min(x.length, lastVoiced + msToSamples(80)));
}


export class GatedSpeechProvider implements SarvamSpeechProvider {
  // Our own Silero VAD decides the turn boundaries and we now emit transcripts
  // MID-utterance, so this is a client-VAD provider as far as the form service
  // is concerned. That matters for one specific reason: with usesClientVAD the
  // service only arms its finalization debounce while the user is NOT speaking.
  // Left false, the first mid-speech slice would arm a 300ms timer and the
  // answer would be finalized while the person was still mid-sentence.
  readonly usesClientVAD = true;

  private readonly cfg: GatedSpeechConfig;
  private readonly centroid: Float32Array;
  /** Centroid plus every individual enrollment reading. Scoring against the best
   *  of them is more forgiving of a rough, tired or shouted-over voice than the
   *  average alone, which is smoother than any real utterance. */
  private readonly references: Float32Array[];
  private readonly threshold: number;
  private readonly margin: number;
  private readonly strictAcceptThreshold: number;
  private readonly stt: Sarvam;
  private readonly tts: SarvamSpeechService;
  private readonly focus: SpeakerFocus | null;

  private readonly endpointSilenceMs: number;
  private readonly interimChunkMs: number;
  private readonly gateMinSpeechMs: number;
  private readonly gateWindowMs: number;
  private readonly gateReverifyMs: number;
  private readonly gateHardRejectMs: number;
  private readonly minSpeechMs: number;
  private readonly maxUtteranceMs: number;
  private readonly flowAfterMs: number;
  private readonly flowEndpointSilenceMs: number;
  private readonly recallFirst: boolean;
  /** The live segmenter, so the endpoint can be widened mid-answer. */
  private segmenter: Segmenter | null = null;
  private readonly streamingFlushMs: number;
  private readonly restChunkMs: number;
  private readonly finalGraceMs: number;

  private vad: VAD | null = null;
  private embedder: Embedder | null = null;
  private denoiser: Denoiser | null = null;
  private loaded = false;

  private source: FrameSource | null = null;
  private running = false;
  private queue: Utterance[] = [];
  private ws: WebSocket | null = null;
  private useRestFallback = false;
  private lastSpeakerDecisionAt = 0;
  private lastSpeakerAccepted = false;
  /** When we last confidently identified somebody OTHER than the enrolled
   *  speaker. Suppresses server transcripts for a moment afterwards. */
  private lastConfidentRejectAt = 0;
  private readonly speakerDecisionWindowMs = 2800;
  private streamedAudioSeconds = 0;

  /** The run currently being spoken, if any. */
  private run: SpeechRun | null = null;
  /** Audio captured while the gate is still deciding. Sent if the turn is
   *  accepted, discarded if it turns out to be somebody else. */
  private heldFrames: Float32Array[] = [];
  /** Runs whose utterance has been emitted but not yet fully transcribed. */
  private readonly endedRuns = new Map<number, SpeechRun>();
  /** Run that owns the transcript text right now. Outlives `run` because the
   *  realtime socket keeps delivering text after the endpoint. */
  private textRun: SpeechRun | null = null;
  private turnEndTimer: ReturnType<typeof setTimeout> | null = null;
  private turnEndPending = false;

  constructor(cfg: GatedSpeechConfig) {
    this.cfg = cfg;
    this.centroid = Float32Array.from(cfg.profile.centroid);
    // The centroid is an average, and an average is smoother than any single
    // real utterance — matching against the individual readings too gives the
    // gate something to recognise when the live voice is rough or strained.
    this.references = [
      this.centroid,
      ...(cfg.profile.embeddings ?? []).map((e) => Float32Array.from(e)),
    ];
    this.threshold = cfg.matchThreshold ?? 0.5;
    this.margin = cfg.rejectMargin ?? 0.06;
    this.strictAcceptThreshold =
      this.threshold + Math.max(0.02, this.margin * 0.5);
    this.stt = new Sarvam(cfg.sarvamApiKey, { restUrl: cfg.sttProxyUrl });
    this.tts = new SarvamSpeechService(cfg.tts);
    this.focus =
      cfg.crowdFocus === false
        ? null
        : new SpeakerFocus(this.references, SAMPLE_RATE, {
            // Derive the speaker-strictness from the caller's own threshold
            // rather than carrying a second, unrelated set of numbers. Presence
            // is judged a little below it, because a single 800ms window in a
            // noisy room reads lower than a clean whole utterance.
            presenceThreshold: Math.max(0.3, this.threshold - 0.05),
            minAbsolute: Math.max(0.2, this.threshold - 0.15),
            ...(typeof cfg.crowdFocus === "object" ? cfg.crowdFocus : {}),
          });

    this.endpointSilenceMs =
      cfg.endpointSilenceMs ?? DEFAULTS.endpointSilenceMs;
    this.interimChunkMs = cfg.interimChunkMs ?? DEFAULTS.interimChunkMs;
    this.gateMinSpeechMs = cfg.gateMinSpeechMs ?? DEFAULTS.gateMinSpeechMs;
    this.gateWindowMs = cfg.gateWindowMs ?? DEFAULTS.gateWindowMs;
    this.gateReverifyMs = cfg.gateReverifyMs ?? DEFAULTS.gateReverifyMs;
    this.gateHardRejectMs = cfg.gateHardRejectMs ?? DEFAULTS.gateHardRejectMs;
    this.minSpeechMs = cfg.minSpeechMs ?? DEFAULTS.minSpeechMs;
    this.maxUtteranceMs = cfg.maxUtteranceMs ?? DEFAULTS.maxUtteranceMs;
    this.flowAfterMs = cfg.flowAfterMs ?? DEFAULTS.flowAfterMs;
    this.flowEndpointSilenceMs =
      cfg.flowEndpointSilenceMs ?? DEFAULTS.flowEndpointSilenceMs;
    this.recallFirst = cfg.recallFirst ?? false;
    this.streamingFlushMs = cfg.streamingFlushMs ?? DEFAULTS.streamingFlushMs;
    this.restChunkMs = cfg.restChunkMs ?? DEFAULTS.restChunkMs;
    this.finalGraceMs = cfg.finalGraceMs ?? DEFAULTS.finalGraceMs;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    // voiceform.ts creates onnxruntime-web sessions with the "wasm" backend but
    // never configures where the .wasm runtime lives. The only place that gets
    // set is noiseSuppression.ts, which this provider bypasses (it replaces the
    // STT pipeline). Without this, VAD/CAM++/GTCRN session creation 404s on the
    // ORT wasm and startListening rejects — the gate would capture nothing.
    // Reuse the library's own asset resolver so it matches the pinned version
    // (and honours assetBaseUrl overrides for offline deployments).
    const assets = resolveNoiseSuppressionAssetUrls(this.cfg.assetBaseUrl);
    ort.env.wasm.wasmPaths = assets.onnxWasmBasePath;
    ort.env.wasm.numThreads = 1; // avoid COOP/COEP header requirement
    const [vadBuf, camBuf] = await Promise.all([
      loadBuf(this.cfg.models.sileroVad),
      loadBuf(this.cfg.models.campplus),
    ]);
    this.vad = await VAD.create(vadBuf);
    this.embedder = await Embedder.create(camBuf);
    if (this.cfg.models.gtcrn) {
      this.denoiser = await Denoiser.create(await loadBuf(this.cfg.models.gtcrn));
    }
    this.loaded = true;
  }

  setLanguage(language: V2SupportedLanguage): void {
    this.cfg.language = language;
    this.tts.setLanguage(language);
  }

  async startListening(handlers: SarvamSTTHandlers): Promise<void> {
    await this.ensureLoaded();
    if (!this.vad || !this.embedder) throw new Error("gate models not loaded");
    if (this.source) await this.stopListening();

    const seg = new Segmenter(this.vad, {
      minSilenceMs: this.endpointSilenceMs,
      minSpeechMs: this.minSpeechMs,
      maxMs: this.maxUtteranceMs,
      interimMs: this.interimChunkMs,
      onRunStart: (runId) => {
        // Speech resumed while we were waiting to declare the turn over — so it
        // was a pause, not an ending. Keep the turn open; firing onSpeechEnd now
        // would finalize an answer the user is still in the middle of giving.
        this.turnEndPending = false;
        this.clearTurnEndTimer();
        // Back to the snappy endpoint until this answer proves to be a flow.
        seg.setMinSilenceMs(this.endpointSilenceMs);
        // Drop the previous turn's text pointer immediately. Realtime partials
        // for the new turn can arrive before its speaker check finishes, and
        // prefixing those with the last answer would replay it into this one.
        this.textRun = null;
        this.run = {
          id: runId,
          decision: "pending",
          confidentReject: false,
          lowStreak: 0,
          speechStartFired: false,
          gateBusy: false,
          lastGateAt: 0,
          restCursor: 0,
          restBusy: false,
          lastFlushAt: 0,
          text: "",
          accountedSamples: 0,
        };
      },
      // Fire-and-forget: the gate and the slice requests are async, and blocking
      // the frame callback on them would stall VAD and drop microphone audio.
      // Re-entrancy is handled by the gateBusy / restBusy flags on the run.
      onInterim: (interim) => {
        void this.onInterimSpeech(interim, handlers);
      },
    });
    this.segmenter = seg;
    this.queue = [];
    this.run = null;
    this.textRun = null;
    this.endedRuns.clear();
    this.clearTurnEndTimer();
    this.running = true;
    this.useRestFallback = false;
    this.lastSpeakerDecisionAt = 0;
    this.lastSpeakerAccepted = false;

    try {
      await this.openRealtimeStt(handlers);
    } catch (err) {
      // Not surfaced through onError: sliced REST is a working transcription
      // path, so this is a downgrade, not a session failure, and reporting it as
      // an error just replaces the prompt with a scary message.
      this.degradeToRest(err instanceof Error ? err.message : String(err));
    }

    // Pump: closes out each utterance once the endpoint fires. By this point
    // most of the audio has usually already been transcribed by the interim
    // path, so this only has the tail left to do.
    const pump = async () => {
      while (this.running) {
        const utt = this.queue.shift();
        if (!utt) {
          await new Promise((r) => setTimeout(r, 20));
          continue;
        }
        try {
          await this.finishRun(utt, handlers);
        } catch (err) {
          handlers.onError?.(
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      }
    };

    let framesSeen = 0;
    let framePump: Promise<void> = Promise.resolve();
    this.source = await micFrameSource((frame) => {
      // Serialise frame handling. The capture worklet does not await this
      // callback, and VAD.process() mutates the Silero model's recurrent state
      // in place — overlapping calls interleave those writes, and a corrupted
      // VAD state looks exactly like "the microphone can't hear you". Only the
      // cheap per-frame work is in this chain; the gate and the STT requests run
      // off the interim callbacks, so this never becomes the bottleneck.
      framePump = framePump
        .then(() => this.handleFrame(frame, seg, handlers, ++framesSeen))
        .catch((err) => {
          handlers.onError?.(
            err instanceof Error ? err : new Error(String(err)),
          );
        });
    }, this.cfg.deviceId);
    if (this.cfg.debug) {
      // eslint-disable-next-line no-console
      console.log("[GatedSpeechProvider] listening started");
    }

    void pump();
  }

  /** One captured 32ms frame: stream it (realtime path) and feed the VAD. */
  private async handleFrame(
    frame: Float32Array,
    seg: Segmenter,
    handlers: SarvamSTTHandlers,
    frameNumber: number,
  ): Promise<void> {
    if (!this.running) return;
    if (this.cfg.debug && frameNumber === 1) {
      // eslint-disable-next-line no-console
      console.log("[GatedSpeechProvider] mic open — receiving audio frames");
    }
    // ONLY the enrolled speaker's audio is ever put on the wire.
    //
    // Streaming everything and filtering the text afterwards cannot work: Sarvam
    // segments on its own VAD, so one of its segments can contain the user AND
    // whoever spoke next to them, and the transcript comes back as a single
    // string with both people's words in it. No amount of gating downstream can
    // separate them again — the mixing already happened, at the transcriber.
    //
    // So the stream is substituted, not filtered:
    //   accepted run -> the real audio, preceded by whatever was buffered while
    //                   the gate was still deciding, so the opening words survive
    //   undecided    -> buffered locally, silence on the wire
    //   anyone else  -> silence on the wire, buffer discarded
    // Silence rather than nothing keeps the server's clock continuous, so its
    // endpointing still fires normally at the end of the user's turn.
    if (!this.useRestFallback && this.ws?.readyState === WebSocket.OPEN) {
      if (!handlers.shouldSendAudio || handlers.shouldSendAudio()) {
        const run = this.run;
        if (run?.decision === "accept") {
          if (this.heldFrames.length) {
            for (const held of this.heldFrames) this.sendFrame(held);
            this.heldFrames = [];
          }
          this.sendFrame(frame);
        } else {
          if (run && run.decision === "pending") {
            this.heldFrames.push(frame);
            // Bound the hold: past this the gate has had its say, and unbounded
            // buffering would only delay audio nobody is going to want.
            const maxHeld = Math.ceil(
              (this.gateHardRejectMs + 500) / ((FRAME / SAMPLE_RATE) * 1000),
            );
            if (this.heldFrames.length > maxHeld) this.heldFrames.shift();
          } else {
            this.heldFrames = [];
          }
          this.sendFrame(SILENT_FRAME);
        }
      }
    }

    const u = await seg.push(frame);
    if (!u) return;
    // Hand the finished run over to the pump before the next run starts
    // overwriting `this.run`.
    if (this.run && this.run.id === u.runId) {
      this.endedRuns.set(u.runId, this.run);
      this.run = null;
    }
    this.queue.push(u);
  }

  /**
   * Runs on every `InterimSpeech` snapshot — i.e. every `interimChunkMs` while
   * the user is still talking. This is where the latency win lives: the speaker
   * decision and most of the transcription happen here rather than after the
   * endpoint.
   */
  private async onInterimSpeech(
    interim: InterimSpeech,
    handlers: SarvamSTTHandlers,
  ): Promise<void> {
    const run = this.run;
    if (!this.running || !run || run.id !== interim.runId) return; // stale
    if (run.decision === "reject") return;

    // Respect the service's half-duplex gate: while it is busy processing the
    // previous answer it does not want audio. Skip this snapshot but leave the
    // decision alone — someone who starts answering a beat early should still be
    // picked up once the window opens, which is what the endpoint path (and the
    // original whole-utterance code) does.
    if (handlers.shouldSendAudio && !handlers.shouldSendAudio()) {
      if (this.cfg.debug) {
        // eslint-disable-next-line no-console
        console.log(
          `[GatedSpeechProvider] run ${run.id} snapshot held — not in listening window`,
        );
      }
      return;
    }

    if (!(await this.runSpeakerGate(run, interim, handlers))) return;

    // Our speaker is talking right now, so keep the WS-final gate window fresh
    // (see shouldUseServerText) even on a long answer.
    this.lastSpeakerDecisionAt = Date.now();

    // Long answer in progress: widen the endpoint so the pauses between listed
    // details don't each end the turn.
    if (interim.elapsedMs >= this.flowAfterMs && this.segmenter) {
      this.segmenter.setMinSilenceMs(this.flowEndpointSilenceMs);
    }

    if (this.useRestFallback) {
      await this.maybeTranscribeSlice(run, interim.audio, handlers);
      return;
    }

    // Realtime path: nudge Sarvam to emit a transcript for what it is holding,
    // rather than waiting for its own endpointing at the end of the sentence.
    const now = Date.now();
    if (
      this.streamingFlushMs > 0 &&
      this.ws?.readyState === WebSocket.OPEN &&
      now - run.lastFlushAt >= this.streamingFlushMs
    ) {
      run.lastFlushAt = now;
      this.accountStreamedAudio(run, interim.audio.length);
      try {
        this.ws.send(JSON.stringify({ event: "flush" }));
      } catch {
        // ignore — socket may be closing
      }
    }
  }

  /**
   * Decides (and periodically re-decides) whether the current run is our
   * enrolled speaker. Returns true when the run is accepted.
   *
   * The embedding runs on a bounded tail window, so a 30-second answer costs the
   * same per check as a 2-second one — the old whole-utterance embed grew with
   * utterance length and was itself a chunk of the perceived lag.
   */
  private async runSpeakerGate(
    run: SpeechRun,
    interim: InterimSpeech,
    handlers: SarvamSTTHandlers,
  ): Promise<boolean> {
    const now = Date.now();
    const undecided =
      run.decision === "pending" &&
      interim.elapsedMs >= this.gateMinSpeechMs &&
      now - run.lastGateAt >= GATE_RETRY_MS;
    const reverify =
      run.decision === "accept" &&
      this.gateReverifyMs > 0 &&
      now - run.lastGateAt >= this.gateReverifyMs;

    if (run.gateBusy || (!undecided && !reverify)) {
      return run.decision === "accept";
    }

    run.gateBusy = true;
    try {
      const window = tailWindow(interim.audio, this.gateWindowMs);
      const e = await this.embedder!.embed(window);
      const sim = e ? this.similarity(e) : -1;
      run.lastGateAt = Date.now();

      if (this.cfg.debug) {
        // eslint-disable-next-line no-console
        console.log(
          `[GatedSpeechProvider] run ${run.id} gate @${(interim.elapsedMs / 1000).toFixed(2)}s · cosine ${sim.toFixed(3)} · threshold ${this.threshold}`,
        );
      }

      if (sim >= this.strictAcceptThreshold) {
        const firstAccept = run.decision !== "accept";
        run.decision = "accept";
        run.lowStreak = 0;
        this.lastSpeakerAccepted = true;
        this.lastSpeakerDecisionAt = run.lastGateAt;
        if (firstAccept) {
          this.textRun = run;
          this.announceTurnStart(run, handlers);
        }
        return true;
      }

      // Below threshold. On a short window that is far more likely to be a noisy
      // embedding than a different person, so stay undecided and re-test on more
      // audio; if the turn ends while still undecided, finishRun() judges the
      // complete utterance exactly as the pre-slicing code did.
      run.lowStreak += 1;
      const confidentlyLow = sim < this.threshold - this.margin;
      // Abandoning a turn already in progress is the expensive mistake — it
      // truncates a real answer mid-sentence — so it takes two consecutive
      // confident readings, not one dip.
      const abandonAccepted =
        run.decision === "accept" && confidentlyLow && run.lowStreak >= 2;
      const canReject =
        abandonAccepted ||
        (run.decision !== "accept" &&
          interim.elapsedMs >= this.gateHardRejectMs);
      if (!canReject) {
        if (this.cfg.debug) {
          const why =
            run.decision === "accept"
              ? "keeping the accepted turn"
              : "waiting for more audio";
          // eslint-disable-next-line no-console
          console.log(
            `[GatedSpeechProvider] run ${run.id} undecided (${sim.toFixed(2)} < ${this.strictAcceptThreshold.toFixed(2)}) at ${(interim.elapsedMs / 1000).toFixed(2)}s — ${why}`,
          );
        }
        return run.decision === "accept";
      }

      run.decision = "reject";
      // Below the reject margin is "definitely someone else"; between the margin
      // and the threshold is the dead zone the profile was always meant to have.
      // Either way the endpoint takes one more look at the WHOLE utterance,
      // which is the most reliable embedding available and the same judgement
      // the pre-slicing code made — the flag only decides whether we keep
      // feeding the socket in the meantime.
      run.confidentReject = confidentlyLow;
      if (confidentlyLow) {
        this.noteConfidentRejection();
      } else {
        this.lastSpeakerAccepted = false;
      }
      if (this.cfg.debug) {
        // eslint-disable-next-line no-console
        console.log(
          `[GatedSpeechProvider] run ${run.id} drop speaker (${sim.toFixed(2)}) below strict threshold ${this.strictAcceptThreshold.toFixed(2)}${run.confidentReject ? "" : " — will re-check the full utterance at the endpoint"}`,
        );
      }
      return false;
    } catch (err) {
      handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
      return false;
    } finally {
      run.gateBusy = false;
    }
  }

  /** REST path: send the next `restChunkMs` of accepted speech, if that much has
   *  accumulated and the previous slice has come back. */
  private async maybeTranscribeSlice(
    run: SpeechRun,
    audio: Float32Array,
    handlers: SarvamSTTHandlers,
  ): Promise<void> {
    if (this.restChunkMs <= 0 || run.restBusy) return;
    const chunk = msToSamples(this.restChunkMs);
    if (audio.length - run.restCursor < chunk) return;

    // Look for the seam around one chunk in, so the cut lands in a gap between
    // words instead of mid-syllable. The search window is BOUNDED to roughly one
    // chunk: searching all pending audio would let a big backlog (e.g. a turn
    // whose gate decision flipped late) collapse into one enormous slice, which
    // is exactly the whole-utterance latency this path exists to avoid.
    const cut = findQuietCut(
      audio,
      run.restCursor + Math.floor(chunk * 0.6),
      Math.min(audio.length, run.restCursor + Math.floor(chunk * 1.4)),
    );
    if (cut - run.restCursor < msToSamples(MIN_SLICE_MS)) return;

    const slice = audio.slice(run.restCursor, cut);
    run.restCursor = cut;
    run.restBusy = true;
    try {
      await this.transcribeSlice(slice, run, handlers);
    } finally {
      run.restBusy = false;
    }
  }

  private async transcribeSlice(
    slice: Float32Array,
    run: SpeechRun,
    handlers: SarvamSTTHandlers,
    opts: { denoise?: boolean } = {},
  ): Promise<void> {
    try {
      const denoise = opts.denoise ?? true;
      const clean =
        denoise && this.denoiser ? await this.denoiser.run(slice) : slice;
      // Pin the language: slices are short, and per-slice auto-detection sends
      // back a different Indic script for each one. (/speech-to-text takes no
      // mode param.)
      const r = await this.stt.transcribe(clean, {
        languageCode: this.cfg.language,
      });
      const text = (r?.text ?? "").trim();
      if (this.cfg.debug) {
        // eslint-disable-next-line no-console
        console.log(
          `[GatedSpeechProvider] run ${run.id} slice ${(slice.length / SAMPLE_RATE).toFixed(2)}s -> "${text}"`,
        );
      }
      if (text) this.emitRunText(run, text, handlers);
    } catch (err) {
      handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Emits the turn's transcript CUMULATIVELY (everything heard in this run so
   * far), not just the newest slice. Each emission is therefore a strict prefix
   * extension of the last, which is what the form service's transcript
   * accumulator treats as "same answer, more words" instead of a new segment.
   */
  private emitRunText(
    run: SpeechRun,
    segment: string,
    handlers: SarvamSTTHandlers,
  ): void {
    const incoming = segment.trim();
    if (!incoming) return;
    // A realtime transcript restates the whole turn and may revise earlier words
    // (the socket's final turned "income is too" into "income is 2 lakh"); a
    // REST slice is the next disjoint piece. Replace in the first case, append
    // in the second.
    const next = isRevisionOf(run.text, incoming)
      ? incoming
      : appendWithOverlap(run.text, incoming);
    if (!next || next === run.text) return;
    run.text = next;
    handlers.onPartial?.(next);
    handlers.onFinal(next);
  }

  /** Closes out a finished utterance: transcribe whatever the interim path did
   *  not already cover, then tell the service the turn is over. */
  private async finishRun(
    utt: Utterance,
    handlers: SarvamSTTHandlers,
  ): Promise<void> {
    const run = this.endedRuns.get(utt.runId) ?? null;
    if (run) this.endedRuns.delete(utt.runId);

    // The length cap closed the audio chunk, but the person is mid-sentence.
    // Transcribe what we have and leave the turn open — the next chunk continues
    // it. Only a real endpoint ends a turn.
    const stillTalking = utt.reason === "maxLength";

    if (run?.decision === "accept") {
      if (this.useRestFallback) {
        const tail = trimTrailingSilence(utt.audio.subarray(run.restCursor));
        if (tail.length >= msToSamples(MIN_TAIL_MS)) {
          await this.transcribeSlice(tail, run, handlers);
        }
        if (!stillTalking) handlers.onSpeechEnd?.();
      } else {
        this.accountStreamedAudio(run, utt.audio.length);
        // Deliberately NOT flushing here. We keep streaming (silence included),
        // and the server endpoints on its own ~500ms after speech stops and
        // sends a cleaner final than a flush returns — flushing at our endpoint
        // preempted it and truncated the segment mid-word. scheduleTurnEnd()
        // flushes only if that final never shows up.
        if (!stillTalking) this.scheduleTurnEnd(handlers);
      }
      return;
    }

    // Either the utterance ended before the gate had gateMinSpeechMs to judge it
    // (a one-word answer like "haan"), or it was rejected on a marginal reading.
    // Both get the original whole-utterance judgement: a longer window gives a
    // much steadier embedding, and this is the safety net that stops a noisy
    // early reading from silently swallowing a real answer.
    if (utt.durationS < 0.3) return;
    if (handlers.shouldSendAudio && !handlers.shouldSendAudio()) return;

    const e = await this.embedder!.embed(utt.audio);
    const sim = e ? this.similarity(e) : -1;
    const verdict = this.judgeCompleteUtterance(sim, e, utt.durationS);
    if (this.cfg.debug) {
      // eslint-disable-next-line no-console
      console.log(
        `[GatedSpeechProvider] endpoint re-check ${utt.durationS.toFixed(2)}s · cosine ${sim.toFixed(3)} · threshold ${this.threshold} · ${verdict}`,
      );
    }

    if (verdict === "reject") {
      this.noteConfidentRejection();
      // Remember the voice. Every rejected utterance makes the room's cohort a
      // better yardstick, so later decisions rest on "closer to the user or
      // closer to these people?" rather than on a fixed threshold — which is
      // what makes the gate tighten over a session instead of drifting.
      if (e && this.focus) this.focus.noteBackground(e);
      return; // never sent, never billed
    }

    if (verdict === "unsure") {
      // One embedding of "me, then someone else, then me" is an average of both
      // and matches neither — the normal shape of an answer given in a crowded
      // room, not evidence that the enrolled speaker was silent. Look window by
      // window before giving up on the turn.
      if (await this.rescueFromCrowd(utt, handlers)) return;
      if (!this.recallFirst) return;
      if (this.cfg.debug) {
        // eslint-disable-next-line no-console
        console.log(
          `[GatedSpeechProvider] keeping unjudgeable ${utt.durationS.toFixed(2)}s utterance — a lost answer costs more than a wrong one`,
        );
      }
    }

    this.lastSpeakerAccepted = true;
    this.lastSpeakerDecisionAt = Date.now();

    const shortRun: SpeechRun = run ?? {
      id: utt.runId,
      decision: "accept",
      confidentReject: false,
      lowStreak: 0,
      speechStartFired: false,
      gateBusy: false,
      lastGateAt: Date.now(),
      restCursor: 0,
      restBusy: false,
      lastFlushAt: 0,
      text: "",
      accountedSamples: 0,
    };
    shortRun.decision = "accept";
    this.textRun = shortRun;
    handlers.onSpeechStart?.();

    // If the gate had been confident enough to stop feeding the socket, what the
    // server holds for this turn is truncated — flushing it would answer with
    // half a sentence. We still have the complete audio locally, so send that
    // over REST instead.
    const socketHeardOnlyPartOfIt = run?.confidentReject === true;
    if (this.useRestFallback || socketHeardOnlyPartOfIt) {
      await this.transcribeSlice(
        trimTrailingSilence(utt.audio),
        shortRun,
        handlers,
      );
      if (!stillTalking) handlers.onSpeechEnd?.();
      return;
    }
    this.accountStreamedAudio(shortRun, utt.audio.length);
    this.flushRealtime();
    if (!stillTalking) this.scheduleTurnEnd(handlers);
  }

  private accountStreamedAudio(run: SpeechRun, samples: number): void {
    const unaccounted = samples - run.accountedSamples;
    if (unaccounted <= 0) return;
    run.accountedSamples = samples;
    this.streamedAudioSeconds += unaccounted / SAMPLE_RATE;
  }

  private flushRealtime(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ event: "flush" }));
    } catch {
      // ignore — socket may be closing
    }
  }

  /**
   * Realtime path only. The closing flush's transcript arrives asynchronously,
   * so we hold onSpeechEnd for a short grace period — the service starts its own
   * finalization debounce off that signal, and firing it too early would finalize
   * the answer without the last few words. Resolved immediately by the first
   * transcript that lands (see openRealtimeStt).
   */
  private scheduleTurnEnd(handlers: SarvamSTTHandlers): void {
    this.clearTurnEndTimer();
    this.turnEndPending = true;
    this.turnEndTimer = setTimeout(() => {
      this.turnEndTimer = null;
      if (!this.turnEndPending) return;
      // The server's own endpointing normally delivers the final well inside
      // this window. It hasn't, so ask for whatever it is holding and allow one
      // shorter grace for the reply before closing the turn without it.
      this.flushRealtime();
      this.turnEndTimer = setTimeout(() => {
        this.turnEndTimer = null;
        if (!this.turnEndPending) return;
        this.turnEndPending = false;
        handlers.onSpeechEnd?.();
      }, RESCUE_FLUSH_GRACE_MS);
    }, this.finalGraceMs);
  }

  private resolveTurnEnd(handlers: SarvamSTTHandlers): void {
    if (!this.turnEndPending) return;
    this.turnEndPending = false;
    this.clearTurnEndTimer();
    handlers.onSpeechEnd?.();
  }

  private clearTurnEndTimer(): void {
    if (this.turnEndTimer) {
      clearTimeout(this.turnEndTimer);
      this.turnEndTimer = null;
    }
  }

  async stopListening(): Promise<void> {
    this.running = false;
    this.clearTurnEndTimer();
    this.turnEndPending = false;
    this.segmenter = null;
    this.run = null;
    this.heldFrames = [];
    this.textRun = null;
    this.endedRuns.clear();
    const src = this.source;
    this.source = null;
    this.queue = [];
    const ws = this.ws;
    this.ws = null;
    if (src) {
      try {
        await src.stop();
      } catch {
        // ignore
      }
    }
    if (ws) {
      // Only send the closing handshake on a socket that can still take it —
      // send() on a CLOSING/CLOSED socket is a no-op that Chrome logs as an
      // error, which buried the real errors in the console.
      if (ws.readyState === WebSocket.OPEN) {
        for (const event of ["speech_end", "flush", "end"]) {
          try {
            ws.send(JSON.stringify({ event }));
          } catch {
            // ignore
          }
        }
      }
      try {
        ws.onclose = null;
        ws.close();
      } catch {
        // ignore
      }
    }
  }

  speak(
    text: string,
    opts?: { language?: V2SupportedLanguage; onAudioStart?: () => void },
  ): Promise<void> {
    return this.tts.speak(text, opts);
  }

  stopSpeaking(): void {
    this.tts.stopSpeaking();
  }

  dispose(): void {
    void this.stopListening();
    this.tts.dispose();
    this.stt.close();
  }

  /** Cumulative audio-seconds sent to Sarvam and ₹ cost so far. */
  cost(): { audioS: number; costInr: number } {
    const audioS = this.useRestFallback ? this.stt.audioS : this.streamedAudioSeconds;
    return { audioS, costInr: (audioS / 3600) * 30 };
  }

  private sendFrame(frame: Float32Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(
        JSON.stringify({
          event: "audio_input",
          audio: bytesToBase64(float32ToPcm16Bytes(frame)),
        }),
      );
    } catch {
      // ignore frame send failures
    }
  }

  /**
   * Tells the service a turn is under way — exactly once per run.
   *
   * Ordering matters more than it looks: the service starts its finalization
   * debounce on any text that arrives while it believes nobody is speaking, so a
   * transcript released before this call ends the answer at its first word.
   */
  private announceTurnStart(
    run: SpeechRun,
    handlers: SarvamSTTHandlers,
  ): void {
    if (run.speechStartFired) return;
    run.speechStartFired = true;
    handlers.onSpeechStart?.();
  }

  /** Similarity to the enrolled speaker: best match across the centroid and
   *  every individual enrollment reading. */
  private similarity(embedding: Float32Array): number {
    if (this.focus) return this.focus.scoreAgainstProfile(embedding);
    let best = -1;
    for (const ref of this.references) {
      best = Math.max(best, cosine(embedding, ref));
    }
    return best;
  }

  /**
   * Last resort for a turn the whole-utterance check rejected — which, in a room
   * with other people in it, is mostly the enrolled speaker being averaged
   * together with everyone else rather than the enrolled speaker being absent.
   *
   * Re-examines the utterance in short windows, keeps the ones that look like
   * the enrolled voice, and transcribes just those. Returns true when it
   * salvaged something. Uses REST deliberately: the audio is already here, and
   * what the socket heard is the unfiltered mixture.
   */
  private async rescueFromCrowd(
    utt: Utterance,
    handlers: SarvamSTTHandlers,
  ): Promise<boolean> {
    if (!this.focus || !this.embedder) return false;

    // Denoise ONCE, up front, and use the result for both the window embeddings
    // and the transcription. Speaker embeddings are what the noise damaged in
    // the first place, so cleaning the audio before measuring it is the single
    // biggest lever available here — and doing it once avoids denoising the same
    // samples again on the way to STT.
    const cleaned = this.denoiser
      ? await this.denoiser.run(utt.audio)
      : utt.audio;

    const result = await this.focus.focus(cleaned, (window) =>
      this.embedder!.embed(window),
    );

    if (this.cfg.debug) {
      const kept = result.windows.filter((w) => w.kept).length;
      // eslint-disable-next-line no-console
      console.log(
        `[GatedSpeechProvider] crowd focus: kept ${kept}/${result.windows.length} windows ` +
          `(${(result.keptSamples / SAMPLE_RATE).toFixed(2)}s of ${(result.totalSamples / SAMPLE_RATE).toFixed(2)}s) · ` +
          `best ${result.bestScore.toFixed(3)} · room cohort ${this.focus.cohortSize} · ` +
          `scores ${result.windows.map((w) => w.score.toFixed(2)).join(" ")}`,
      );
    }

    if (!result.found || result.audio.length < msToSamples(MIN_TAIL_MS)) {
      return false;
    }

    this.lastSpeakerAccepted = true;
    this.lastSpeakerDecisionAt = Date.now();

    const rescuedRun: SpeechRun = {
      id: utt.runId,
      decision: "accept",
      confidentReject: false,
      lowStreak: 0,
      speechStartFired: false,
      gateBusy: false,
      lastGateAt: Date.now(),
      restCursor: 0,
      restBusy: false,
      lastFlushAt: 0,
      text: "",
      accountedSamples: 0,
    };
    this.textRun = rescuedRun;
    handlers.onSpeechStart?.();
    await this.transcribeSlice(result.audio, rescuedRun, handlers, {
      denoise: false, // already cleaned above
    });
    handlers.onSpeechEnd?.();
    return true;
  }

  /**
   * Whether a transcript arriving from the realtime socket should be used.
   *
   * The socket transcribes everything it hears, including speech our own VAD
   * never turned into an utterance — a one-word "No" is over before the
   * segmenter's minimum, and previously that meant no gate decision existed and
   * the transcript was discarded for failing a check that never ran. So the
   * question is not "did the gate approve?" but "did the gate REJECT?": text is
   * used unless someone else was confidently speaking just now.
   */
  private shouldUseServerText(): boolean {
    if (
      this.lastSpeakerAccepted &&
      Date.now() - this.lastSpeakerDecisionAt <= this.speakerDecisionWindowMs
    ) {
      return true;
    }
    // Somebody else was just confidently identified — this text is probably the
    // tail of their sentence.
    if (Date.now() - this.lastConfidentRejectAt <= REJECTION_SHADOW_MS) {
      return false;
    }
    // No live approval. The socket hears the whole room, including speech our
    // VAD never segmented, so unvouched text here is as likely to be a passer-by
    // as the user. Strict mode declines it; recall-first mode takes it, which is
    // what rescues one-word answers the segmenter never formed an utterance for.
    return this.recallFirst;
  }

  /** Records a confident "that was someone else", which suppresses server text
   *  for a short while afterwards. */
  private noteConfidentRejection(): void {
    this.lastConfidentRejectAt = Date.now();
    this.lastSpeakerAccepted = false;
  }

  /**
   * Endpoint verdict for a complete utterance the fast gate did not accept.
   *
   * `sim` alone is not enough to decide with: it means different things for a
   * 0.4s answer than for a 4s one, and different things in a quiet room than in
   * a loud one. Hence the comparisons against duration and against the room's
   * own voices.
   */
  private judgeCompleteUtterance(
    sim: number,
    embedding: Float32Array | null,
    durationS: number,
  ): "accept" | "reject" | "unsure" {
    if (sim >= this.strictAcceptThreshold) return "accept";

    const background =
      embedding && this.focus ? this.focus.scoreAgainstBackground(embedding) : -1;

    // Known voice in the room, and this looks more like them than like the
    // enrolled speaker. That is the one case worth rejecting outright.
    if (background > -1 && sim < background) return "reject";

    // Too short for a trustworthy embedding — "No", "Yes", "Haan". A low score
    // here is weak evidence, so decide it RELATIVELY where possible: clearly
    // closer to the enrolled speaker than to any voice the room has produced is
    // good enough for a one-word answer, and clearly not is a rejection. Only
    // when there is nothing to compare against does it fall through as unsure.
    if (durationS * 1000 < UNJUDGEABLE_MS) {
      if (background > -1) {
        return sim >= background + this.margin ? "accept" : "reject";
      }
      return sim >= this.threshold - this.margin ? "accept" : "unsure";
    }

    // Long enough to judge, clearly below the profile, and no competing voice on
    // record to appeal to.
    if (background === -1 && sim < this.threshold - this.margin) return "reject";

    return "unsure";
  }

  /**
   * Abandons the realtime socket and finishes the session on sliced REST
   * transcription instead. Safe to call at any point, including mid-utterance:
   * the REST path reads the same per-run audio cursor, so whatever the socket
   * never transcribed is simply sent as the next slice.
   *
   * This is not just belt-and-braces. The realtime endpoint is reached directly
   * (browsers cannot set the auth header a proxy would), so a key that works for
   * REST through a same-origin proxy can still be refused here — and it is
   * refused in a message AFTER the handshake, where the connect path cannot see
   * it.
   */
  private degradeToRest(why: string): void {
    if (this.useRestFallback) return;
    this.useRestFallback = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[GatedSpeechProvider] realtime STT unusable (${why}) — falling back to sliced REST transcription`,
    );
    const dead = this.ws;
    this.ws = null;
    this.clearTurnEndTimer();
    this.turnEndPending = false;
    if (dead) {
      try {
        dead.onclose = null;
        dead.onerror = null;
        dead.close();
      } catch {
        // ignore
      }
    }
  }

  private resolveRealtimeWsUrl(): string {
    const proxy = this.cfg.sttProxyUrl?.trim();
    if (proxy && /^wss?:\/\//i.test(proxy)) {
      return proxy;
    }
    return SARVAM_WS_URL;
  }

  private async openRealtimeStt(handlers: SarvamSTTHandlers): Promise<void> {
    const base = this.resolveRealtimeWsUrl();
    const params = new URLSearchParams({
      model: SARVAM_WS_MODEL,
      language_code: SARVAM_WS_LANG,
      mode: SARVAM_MODE,
      encoding: "linear16",
      sample_rate: String(SAMPLE_RATE),
      endpointing: "vad",
    });
    const full = `${base}?${params.toString()}`;
    // The key goes in the WebSocket subprotocol, not the query string. Browsers
    // cannot set request headers on a WebSocket, and this is the mechanism the
    // official SDK uses for exactly that reason. With `?api-subscription-key=`
    // the handshake still succeeds and the server then replies
    // "invalid_subscription_key" — a socket that is open, accepts audio, and
    // returns nothing, which is indistinguishable from a silent microphone.
    const ws = new WebSocket(full, [
      `api-subscription-key.${this.cfg.sarvamApiKey}`,
    ]);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("realtime STT websocket open timeout"));
      }, 8000);
      ws.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("realtime STT websocket error"));
      };
    });

    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "{}");
      } catch {
        return;
      }
      const eventType = String(msg?.event ?? msg?.type ?? "");
      const payload = msg?.data ?? msg;

      // Sarvam's own VAD signals are deliberately NOT forwarded. Our Silero
      // segmenter owns the turn boundaries (it is the thing the speaker gate is
      // keyed to), and forwarding both would give the service two conflicting
      // opinions about whether the user is still speaking — which is what
      // decides when it finalizes the answer.

      // A protocol error means this socket will never produce a transcript —
      // Sarvam reports things like an unaccepted subscription key AFTER the
      // handshake succeeds, so the open() call above cannot catch it. Swallowing
      // it left the provider streaming into a dead socket, which is
      // indistinguishable from a silent user.
      if (eventType === "error" || payload?.error) {
        const detail =
          payload?.message ??
          payload?.error ??
          JSON.stringify(msg).slice(0, 200);
        this.degradeToRest(`error event: ${String(detail)}`);
        return;
      }

      const finalText =
        (eventType === "transcript.final"
          ? payload?.text
          : msg?.is_final || payload?.is_final
            ? payload?.text ?? payload?.transcript ?? msg?.text
            : "") ?? "";
      const partialText =
        (eventType === "transcript.partial"
          ? payload?.text
          : eventType === "data" || eventType === "transcript"
            ? payload?.text ?? payload?.transcript ?? msg?.text
            : "") ?? "";

      const normalizedPartial =
        typeof partialText === "string" ? partialText.trim() : "";
      const normalizedFinal = typeof finalText === "string" ? finalText.trim() : "";

      // Partials are released only for a turn the gate has ACCEPTED.
      //
      // Emitting them while the gate was still undecided did make the form fill
      // sooner, but "undecided" is exactly the state a stranger's voice occupies
      // for its first second — so the room's other voices reached the form. A
      // voiceprint gate that leaks the audio it has not yet vouched for is not a
      // gate. Latency is bought elsewhere (see the streaming pipeline), not by
      // guessing ahead of the speaker check.
      if (normalizedPartial && this.textRun && this.shouldUseServerText()) {
        const base = this.textRun.text;
        handlers.onPartial?.(
          base ? `${base} ${normalizedPartial}`.trim() : normalizedPartial,
        );
      }
      if (normalizedFinal) {
        if (this.shouldUseServerText()) {
          const run = this.textRun;
          if (run) {
            this.emitRunText(run, normalizedFinal, handlers);
          } else {
            handlers.onFinal(normalizedFinal);
          }
          // The transcript we were holding the turn open for has landed.
          this.resolveTurnEnd(handlers);
        } else if (this.cfg.debug) {
          // eslint-disable-next-line no-console
          console.log(
            `[GatedSpeechProvider] dropped final transcript due to speaker gate: "${normalizedFinal}"`,
          );
        }
      }
    };

    ws.onerror = () => {
      this.degradeToRest("websocket runtime error");
    };

    // A socket that closes under us is just as dead as one that errors; without
    // this the session would keep "listening" into nothing.
    ws.onclose = () => {
      if (this.ws === ws && this.running) {
        this.degradeToRest("websocket closed");
      }
    };

    try {
      ws.send(JSON.stringify({ event: "speech_start" }));
    } catch {
      // ignore
    }
  }

  /**
   * Re-enroll the target voice ON THE CURRENT MIC.
   *
   * The user is asked to READ A KNOWN SENTENCE, and each recording is
   * transcribed and checked against it before its embedding is allowed into the
   * voiceprint. Knowing what was supposed to be said is what makes enrolling in
   * a shared room safe: a colleague talking over you, a passer-by, or the room's
   * TV all fail the phrase check and are discarded, where "just speak naturally
   * for ten seconds" would average their voice into your profile and quietly
   * ruin every later comparison. It also rules out enrolling on a cough, a
   * throat-clear, or half a sentence.
   *
   * Pass `phrase: null` (or omit `sarvamApiKey`) for the older text-independent
   * behaviour — no STT call, no endpoint dependency, but no protection either.
   *
   * Use this when the shipped voice_profile.json (enrolled on a different mic)
   * gives low cosine against the live voice. Persist the result (e.g.
   * localStorage) and feed it back as `profile`, then a normal threshold
   * (~0.45) will cleanly separate the user from others again.
   */
  static async enrollFromMic(
    cfg: Pick<
      GatedSpeechConfig,
      "models" | "assetBaseUrl" | "deviceId" | "debug"
    > & {
      /** Enables phrase verification. Without it, enrollment is text-independent. */
      sarvamApiKey?: string;
      /** Same-origin STT proxy, e.g. "/api/sarvam-stt". */
      sttProxyUrl?: string;
      language?: V2SupportedLanguage;
    },
    opts: {
      /** Verified readings to average (default 3). */
      count?: number;
      /** Ignore blips shorter than this (default 1.2s). */
      minDurationS?: number;
      /** Give up after this (default 45000ms — phrase checks need more room). */
      timeoutMs?: number;
      /** The sentence to read. `null` disables verification. */
      phrase?: string | null;
      /** How closely the transcript must match (default 0.55, as VoiceForm.enroll). */
      phraseThreshold?: number;
      onProgress?: (captured: number, of: number) => void;
      /** Fires whenever another reading is wanted — show `phrase` to the user. */
      onPrompt?: (payload: {
        phrase: string;
        hint?: string;
        captured: number;
        of: number;
      }) => void;
      /** Fires for every utterance heard, matched or not. */
      onHeard?: (payload: {
        text: string;
        score: number;
        ok: boolean;
        durationS: number;
      }) => void;
    } = {},
  ): Promise<VoiceProfile> {
    const count = opts.count ?? 3;
    const minDur = opts.minDurationS ?? 1.2;
    const timeoutMs = opts.timeoutMs ?? 45000;
    const phraseThreshold = opts.phraseThreshold ?? 0.55;
    const phrase =
      opts.phrase === null
        ? null
        : (opts.phrase ?? ENROLL_PHRASE);
    const verify = Boolean(phrase && cfg.sarvamApiKey);
    const stt = verify
      ? new Sarvam(cfg.sarvamApiKey!, { restUrl: cfg.sttProxyUrl })
      : null;

    const assets = resolveNoiseSuppressionAssetUrls(cfg.assetBaseUrl);
    ort.env.wasm.wasmPaths = assets.onnxWasmBasePath;
    ort.env.wasm.numThreads = 1;

    const vad = await VAD.create(await loadBuf(cfg.models.sileroVad));
    const embedder = await Embedder.create(await loadBuf(cfg.models.campplus));
    // Someone reading an unfamiliar sentence pauses mid-way far more than they
    // do mid-answer, so enrollment gets a longer endpoint than the live gate.
    const seg = new Segmenter(vad, {
      minSilenceMs: ENROLL_MIN_SILENCE_MS,
      maxMs: ENROLL_MAX_UTTERANCE_MS,
    });

    const embeddings: Float32Array[] = [];
    const queue: Utterance[] = [];
    const source = await micFrameSource(async (frame) => {
      const u = await seg.push(frame);
      if (u) queue.push(u);
    }, cfg.deviceId);

    if (phrase) {
      opts.onPrompt?.({
        phrase,
        hint: phrase === ENROLL_PHRASE ? ENROLL_PHRASE_HINT : undefined,
        captured: 0,
        of: count,
      });
    }

    const started = Date.now();
    try {
      while (embeddings.length < count && Date.now() - started < timeoutMs) {
        const u = queue.shift();
        if (!u) {
          await new Promise((r) => setTimeout(r, 20));
          continue;
        }
        if (u.durationS < minDur) continue;

        if (verify) {
          // mode "translit" asks Sarvam to romanise, so a Latin phrase can be
          // compared against Indic speech without a script mismatch.
          const r = await stt!.transcribe(u.audio, {
            mode: "translit",
            ...(cfg.language ? { languageCode: cfg.language } : {}),
          });
          const said = r?.text ?? "";
          const { score, ok } = phraseMatches(said, phrase!, phraseThreshold);
          opts.onHeard?.({ text: said, score, ok, durationS: u.durationS });
          if (cfg.debug) {
            // eslint-disable-next-line no-console
            console.log(
              `[GatedSpeechProvider] enroll heard "${said}" · match ${score.toFixed(2)} · ${ok ? "accepted" : "rejected (not the phrase)"}`,
            );
          }
          if (!ok) {
            // Not our reader — a bystander, the room, or a misread. Discard it
            // rather than averaging it into the voiceprint.
            opts.onPrompt?.({
              phrase: phrase!,
              hint: phrase === ENROLL_PHRASE ? ENROLL_PHRASE_HINT : undefined,
              captured: embeddings.length,
              of: count,
            });
            continue;
          }
        }

        const e = await embedder.embed(u.audio);
        if (!e) continue;
        embeddings.push(e);
        opts.onProgress?.(embeddings.length, count);
        if (cfg.debug) {
          // eslint-disable-next-line no-console
          console.log(`[GatedSpeechProvider] enroll captured ${embeddings.length}/${count}`);
        }
        if (embeddings.length < count && phrase) {
          opts.onPrompt?.({
            phrase,
            hint: phrase === ENROLL_PHRASE ? ENROLL_PHRASE_HINT : undefined,
            captured: embeddings.length,
            of: count,
          });
        }
      }
    } finally {
      await source.stop();
    }

    if (embeddings.length === 0) {
      throw new Error(
        verify
          ? "enrollFromMic: nothing matched the phrase — read the sentence shown, in a quiet moment, and retry"
          : "enrollFromMic: no speech captured — speak for ~2s and retry",
      );
    }

    // Even among readings that passed the phrase check, one may have been
    // captured over a door slam or with the speaker turned away; averaging it in
    // drags the centroid off the real voice.
    const { kept, agreement, dropped } = dropInconsistentEmbeddings(embeddings);
    if (cfg.debug && dropped > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[GatedSpeechProvider] enroll dropped ${dropped} inconsistent reading(s) (agreement ${agreement.map((a) => a.toFixed(2)).join(", ")})`,
      );
    }

    // Mean of unit-norm embeddings, re-normalised.
    const dim = kept[0].length;
    const mean = new Float32Array(dim);
    for (const e of kept) for (let i = 0; i < dim; i++) mean[i] += e[i];
    for (let i = 0; i < dim; i++) mean[i] /= kept.length;
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += mean[i] * mean[i];
    norm = Math.sqrt(norm) + 1e-9;
    const centroid = Array.from(mean, (v) => v / norm);

    return {
      centroid,
      embeddings: kept.map((e) => Array.from(e)),
      phrase: phrase ?? "(mic-enrolled)",
      created: new Date().toISOString(),
    };
  }
}


// Keep the imported FRAME referenced so tree-shakers and linters don't flag it;
// it documents the frame contract the gate relies on. (SAMPLE_RATE is used
// directly by the slice/window helpers above.)
void FRAME;