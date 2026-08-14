import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
// Type-only import (not a re-export-from) so the name is actually usable
// below in this file, not just forwarded to external importers.
import type { AudioRecordingPair } from "./noiseSuppression";
import type {
  BedrockRouter,
  BedrockRoutingRequest,
  BedrockRoutingResponse,
  ConstraintSet,
  FieldAssignment,
  VoiceFormDebugApi,
  VoiceFormDebugOptions,
  VoiceFormFieldDescriptor,
  VoiceFormFieldType,
} from "../v1/types";

export type {
  BedrockRouter,
  BedrockRoutingRequest,
  BedrockRoutingResponse,
  ConstraintSet,
  FieldAssignment,
  VoiceFormDebugApi,
  VoiceFormDebugOptions,
  VoiceFormFieldDescriptor,
  VoiceFormFieldType,
};

export type V2SupportedLanguage =
  | "en-IN"
  | "hi-IN"
  | "bn-IN"
  | "ta-IN"
  | "te-IN"
  | "kn-IN"
  | "ml-IN"
  | "mr-IN"
  | "gu-IN"
  | "pa-IN"
  | "od-IN";

export type V2SpeechRecognitionUiState =
  | "idle"
  | "ignored"
  | "warming-up"
  | "listening"
  | "processing";

export interface SarvamSpeechConfig {
  apiKey: string;
  language: V2SupportedLanguage;
  speaker?: string;
  pace?: number;
  pitch?: number;
  loudness?: number;
  sttModel?: string;
  ttsModel?: string;
  outputAudioCodec?:
    | "mp3"
    | "wav"
    | "aac"
    | "opus"
    | "flac"
    | "linear16"
    | "mulaw"
    | "alaw";
  noiseSuppression?: boolean | VoiceNoiseSuppressionConfig;
  /** Samples per audio packet sent to the live-STT socket (16 kHz mono), i.e.
   *  the capture granularity. 1024 = 64ms. Smaller packets reach Sarvam sooner;
   *  much below 512 the per-message overhead starts to dominate. Default 1024. */
  sttChunkSizeSamples?: number;
  /** Ask Sarvam for an interim transcript every N ms while the user is still
   *  talking, instead of only when its server-side VAD decides the utterance is
   *  over. Turns one end-of-turn transcription into a stream of partial ones, so
   *  perceived latency stops scaling with how long the answer was.
   *
   *  Enabling this makes the provider report `usesClientVAD` (transcripts now
   *  arrive mid-speech, so the form service must hold finalization until the
   *  speaker actually pauses) and emit cumulative per-turn text. 0 = off.
   *  Default 0, which keeps the original end-of-utterance behaviour. */
  interimFlushMs?: number;
  /** Override the TTS endpoint. Useful for routing through a local proxy to avoid CORS. */
  ttsUrl?: string;
  /** Sarvam custom dictionary ID for TTS pronunciation overrides (e.g. "p_0e2d22b9"). */
  dictId?: string;
}

export interface SarvamSTTHandlers {
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onPartial?: (text: string) => void;
  onFinal: (text: string) => void;
  onError?: (error: Error) => void;
  shouldSendAudio?: () => boolean;
}

export interface SarvamSpeechProvider {
  setLanguage(language: V2SupportedLanguage): void;
  startListening(handlers: SarvamSTTHandlers): Promise<void>;
  stopListening(): Promise<void>;
  speak(
    text: string,
    opts?: { language?: V2SupportedLanguage; onAudioStart?: () => void },
  ): Promise<void>;
  stopSpeaking(): void;
  dispose(): void;
  /** True only for providers that use client-side VAD (e.g. Bhashini). When
   *  true the service applies Bhashini-specific transcript-accumulation and
   *  finalization-timer logic. Absent or false for server-VAD providers. */
  readonly usesClientVAD?: boolean;
  /** Raw-vs-processed audio recordings accumulated across the whole voice
   *  form session so far (not just the most recently answered field), if
   *  `noiseSuppression.recordAudio` was enabled. `null`/absent until at
   *  least one turn has completed. */
  getAudioRecordings?(): AudioRecordingPair | null;
  /** Clears any accumulated recordAudio data. Called once at the start of a
   *  new voice form session so recordings don't bleed across sessions. */
  resetAudioRecordingSession?(): void;
}

export interface SarvamProxyConfig {
  /** URL of the developer's proxy endpoint for TTS (HTTP POST). */
  ttsUrl: string;
  /** WebSocket URL of the developer's proxy endpoint for STT. */
  sttWsUrl: string;
  language: V2SupportedLanguage;
  /** Sent as `Authorization: Bearer <token>` to reject unauthorized callers. */
  authToken?: string;
  sttModel?: string;
  noiseSuppression?: boolean | VoiceNoiseSuppressionConfig;
}

// Bhashini implements exactly the same provider shape as Sarvam — both expose
// startListening / stopListening / speak / stopSpeaking / setLanguage / dispose
// so the form-flow service does not care which one is wired in. The alias
// below documents the intent without forking a parallel interface.
export type BhashiniSpeechProvider = SarvamSpeechProvider;

export interface BhashiniSpeechConfig {
  apiKey: string;
  language: V2SupportedLanguage;

  // STT (Dhruva Socket.IO) — defaults match the public Bhashini endpoint.
  sttSocketUrl?: string; // default: "wss://dhruva-api.bhashini.gov.in"
  sttSocketPath?: string; // default: "/socket.io"
  asrServiceId?: string; // override the per-language ASR service routing
  responseFrequencyInSecs?: number; // default: 2 (Bhashini final-segment cadence)

  // TTS pipeline — the host application must supply its own Bhashini pipeline
  // endpoint URL. There is no public default since each tenant has its own.
  ttsPipelineUrl: string;
  ttsServiceId?: string; // default: "Bhashini/IITM/TTS"
  ttsGender?: "male" | "female"; // default: "female"
  ttsSpeed?: number; // default: 1.0
  ttsSamplingRate?: number; // default: 48000

  // Tunables for client-side end-of-utterance detection (Bhashini provides no
  // server-side VAD signals, so the form-flow needs them computed locally).
  silenceDebounceMs?: number; // default: 1500
  rmsSilenceThreshold?: number; // default: 500 (out of 32767, ~1.5% amplitude)
  noiseSuppression?: boolean | VoiceNoiseSuppressionConfig;
}

export interface VoiceNoiseSuppressionConfig {
  enabled?: boolean;
  // Legacy RMS-gate tunables — only consulted when mode is "legacy-rms".
  highPassHz?: number;
  lowPassHz?: number;
  noiseFloorLearningRate?: number;
  speechThresholdMultiplier?: number;
  minSpeechRms?: number;
  noiseGateAttenuation?: number;
  dropNonSpeech?: boolean;
  attack?: number;
  release?: number;

  /** "rnnoise-vad" (default) runs RNNoise spectral denoising + Silero neural
   *  VAD gating over an AudioWorklet pipeline. "legacy-rms" keeps the old
   *  amplitude-threshold gate (automatic fallback if AudioWorklet/WASM/the
   *  CDN assets are unavailable). */
  mode?: "legacy-rms" | "rnnoise-vad";
  /** Whether to also request the browser's own native noise suppression on
   *  the captured MediaStreamTrack. Only applies in "rnnoise-vad" mode —
   *  "legacy-rms" always requests `false` to preserve prior behavior.
   *  Default: true. */
  useBrowserNoiseSuppression?: boolean;
  /** Override base URL for self-hosting the RNNoise/Silero VAD binary
   *  assets (WASM/ONNX/worklet files) instead of loading them from the
   *  default jsdelivr CDN — useful for offline/restricted-network
   *  deployments. Expected to contain the same file layout as the default
   *  CDN paths (see noiseSuppressionAssets.ts). */
  assetBaseUrl?: string;
  vad?: {
    /** Silero VAD speech-probability threshold above which the gate opens.
     *  Default: 0.5. */
    positiveSpeechThreshold?: number;
    /** Reserved for future use (frame-processor internal speech-segment
     *  tracking); the gate itself only uses positiveSpeechThreshold today.
     *  Default: 0.35. */
    negativeSpeechThreshold?: number;
  };
  /** When true, records two parallel WAV clips for A/B quality comparison —
   *  `raw` (mic capture before this pipeline's own filtering/denoising/VAD
   *  gating) and `processed` (what's actually sent to STT). Retrieve via
   *  the speech provider's/controller's `getAudioRecordings()` after the
   *  session stops. Default: false. */
  recordAudio?: boolean;
}

// Re-exported here (rather than defined here) because it's the shape
// BrowserNoiseSuppressor itself produces — see noiseSuppression.ts (imported
// at the top of this file). Type-only, so it doesn't introduce a runtime
// import cycle with noiseSuppression.ts's own
// `import type { VoiceNoiseSuppressionConfig }`.
export type { AudioRecordingPair };

export interface BhashiniProxyConfig {
  provider: BhashiniSpeechProvider;
  language: V2SupportedLanguage;
}

export interface BedrockProxyConfig {
  routerUrl: string;
  translatorUrl?: string;
  fetchInit?: RequestInit;
}

export interface BedrockDirectConfig {
  modelId: string;
  client: BedrockRuntimeClient;
}

export type V2BedrockConfig =
  | { direct: BedrockDirectConfig; proxy?: undefined }
  | { proxy: BedrockProxyConfig; direct?: undefined };

export interface TranslatedOptionMapping {
  value: string;
  originalLabel: string;
  translatedLabel: string;
  language: V2SupportedLanguage;
}

export interface TranslatedFieldPrompt {
  fieldId: string;
  originalLabel: string;
  translatedLabel: string;
  language: V2SupportedLanguage;
}

export interface V2UiHooks {
  onPrompt?: (payload: { text: string; fieldId?: string }) => void;
  onSpeechSynthesis?: (payload: { text: string }) => void;
  onTranscript?: (payload: { text: string; isFinal?: boolean }) => void;
  onSpeechRecognitionStateChange?: (payload: {
    state: V2SpeechRecognitionUiState;
    acceptsSpeech: boolean;
    fieldId?: string;
    message: string;
  }) => void;
  onAssignment?: (payload: {
    fieldId: string;
    value: string | string[];
  }) => void;
  onStatus?: (payload: { message: string }) => void;
  onError?: (payload: { error: Error }) => void;
  onFieldsExtracted?: (payload: { fields: VoiceFormFieldDescriptor[] }) => void;
  onStepChange?: (payload: {
    stepId: string;
    label: string;
    index: number;
    fieldIds: string[];
  }) => void;
  onQuit?: (payload: {
    confirmed: boolean;
    reason?: "completed" | "user-stop" | "no-response";
  }) => void;
  onResetRequested?: () => Promise<void> | void;
  onTranslation?: (payload: {
    prompt?: TranslatedFieldPrompt;
    options?: TranslatedOptionMapping[];
  }) => void;
}

// ── Observability ─────────────────────────────────────────────────────────────

export interface LLMCallEvent {
  /** Which library operation triggered this LLM call. */
  type: "routing" | "translate-prompt" | "translate-options";
  modelId: string;
  /** Opaque ID that groups all calls within one voice-form session. */
  sessionId: string;
  /** Form field being processed (routing calls only). */
  fieldId?: string;
  language?: V2SupportedLanguage;
  /** Full input sent to the model. */
  input: unknown;
  /** Parsed model output. */
  output: unknown;
  usage?: { inputTokens: number; outputTokens: number };
  durationMs: number;
  error?: Error;
}

export interface ObservabilityHooks {
  /** Fires once when the voice form session starts (fields extracted). */
  onSessionStart?: (
    sessionId: string,
    fields: VoiceFormFieldDescriptor[],
  ) => void;
  /** Fires once when the session ends (completed, user-stop, no-response). */
  onSessionEnd?: (sessionId: string, reason?: string) => void;
  /** Fires after every LLM call (routing + translation). */
  onLLMCall?: (event: LLMCallEvent) => void | Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────

export interface V2VoiceFormInitOptions {
  formSelector: string;
  language: V2SupportedLanguage;
  defaultLanguage?: V2SupportedLanguage;
  autoStart?: boolean;
  transcriptGuard?:
    | boolean
    | {
        enabled?: boolean;
        intervalMs?: number;
      };
  /**
   * Fill fields WHILE the user is still speaking, instead of waiting for them to
   * finish the whole answer.
   *
   * Someone who answers three questions in one breath otherwise watches the form
   * sit empty for the entire sentence and then fill all at once. With this on,
   * each detail lands as the next one is being spoken.
   *
   * Only assignments are applied mid-answer — never skips, never special
   * commands ("go back", "reset"), which need the complete sentence to be
   * judged. Everything applied this way is re-routed against the full transcript
   * when the turn ends, so a value inferred from half a clause ("two…") is
   * corrected once the rest arrives ("…lakh"). `false` restores end-of-turn-only
   * routing.
   */
  incrementalRouting?:
    | boolean
    | {
        enabled?: boolean;
        /** Minimum gap between mid-answer routing calls. Default 700ms. */
        minIntervalMs?: number;
        /** New words required since the last call. Default 2. */
        minNewWords?: number;
        /** Confidence an assignment needs to be applied early. Default 0.8 —
         *  higher than at turn end, because the evidence is incomplete. */
        minConfidence?: number;
      };
  sarvamSpeech?: SarvamSpeechConfig;
  sarvamProxy?: SarvamProxyConfig;
  bhashiniSpeech?: BhashiniSpeechConfig;
  bhashiniProxy?: BhashiniProxyConfig;
  bedrock: V2BedrockConfig;
  uiHooks?: V2UiHooks;
  debug?: VoiceFormDebugOptions;
  observability?: ObservabilityHooks;
}

export interface V2VoiceFormController {
  start(): Promise<void>;
  stop(): Promise<void>;
  setLanguage(language: V2SupportedLanguage): Promise<void>;
  getExtractedFields(): VoiceFormFieldDescriptor[];
  announceAndStop(message: string): Promise<void>;
  /** Raw-vs-processed audio recordings from the most recent listening
   *  session, if `noiseSuppression.recordAudio` was enabled on the active
   *  speech provider config. `null` until a session has completed. */
  getAudioRecordings(): AudioRecordingPair | null;
}

export class TranslationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TranslationError";
  }
}
