import { SarvamAIClient } from "sarvamai";
import {
  BrowserNoiseSuppressor,
  resolveNoiseSuppressionConfig,
  type AudioRecordingPair,
  type NoiseSuppressionConfig,
} from "./noiseSuppression";
import { SessionRecordingAccumulator } from "./recordingAccumulator";
import { formatTextForTts } from "./ttsText";
import { appendWithOverlap } from "./transcriptChunks";
import type {
  SarvamSpeechConfig,
  SarvamSpeechProvider,
  SarvamSTTHandlers,
  V2SupportedLanguage,
} from "./types";

// Matches the production-validated config shown by the host application:
// `saarika:v2.5` for live STT plus WAV-framed PCM chunks. Bulbul v3 for TTS.
const DEFAULT_STT_MODEL = "saarika:v2.5";
const DEFAULT_TTS_MODEL = "bulbul:v3";
const DEFAULT_OUTPUT_CODEC = "mp3" as const;

// All values must come from sarvamai's TextToSpeechSpeaker union (lower-case
// string literals). `manan` is the documented bulbul:v3 default and is used
// for every language; hosts can override via SarvamSpeechConfig.speaker.
const DEFAULT_SPEAKER = "manan";

const DEFAULT_SPEAKERS: Record<V2SupportedLanguage, string> = {
  "en-IN": DEFAULT_SPEAKER,
  "hi-IN": DEFAULT_SPEAKER,
  "bn-IN": DEFAULT_SPEAKER,
  "ta-IN": DEFAULT_SPEAKER,
  "te-IN": DEFAULT_SPEAKER,
  "kn-IN": DEFAULT_SPEAKER,
  "ml-IN": DEFAULT_SPEAKER,
  "mr-IN": DEFAULT_SPEAKER,
  "gu-IN": DEFAULT_SPEAKER,
  "pa-IN": DEFAULT_SPEAKER,
  "od-IN": DEFAULT_SPEAKER,
};

function defaultSpeakerFor(language: V2SupportedLanguage): string {
  return DEFAULT_SPEAKERS[language] ?? DEFAULT_SPEAKER;
}

// Sarvam's live STT supports raw 16-bit PCM over the WebSocket. The local
// capture module emits filtered mono PCM frames and we send those directly,
// avoiding repeated WAV headers inside a streaming session.

const STT_SAMPLE_RATE = 16000;
// 1024 samples = 64ms at 16 kHz. Previously 2048 (128ms): halving it halves the
// time audio sits in the capture buffer before it is on the wire, at the cost of
// twice as many (still small) socket messages.
const DEFAULT_STT_CHUNK_SAMPLES = 1024;

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export class SarvamSpeechService implements SarvamSpeechProvider {
  private readonly apiKey: string;
  private language: V2SupportedLanguage;
  private readonly speaker: string | undefined;
  private readonly pace: number | undefined;
  private readonly pitch: number | undefined;
  private readonly loudness: number | undefined;
  private readonly sttModel: string;
  private readonly ttsModel: string;
  private readonly ttsUrl: string;
  private readonly dictId: string | undefined;
  private readonly outputAudioCodec: NonNullable<
    SarvamSpeechConfig["outputAudioCodec"]
  >;

  private readonly sttChunkSizeSamples: number;
  private readonly interimFlushMs: number;

  /** True only when interim flushing is on: transcripts then arrive while the
   *  user is still speaking, and the form service must not start its
   *  finalization debounce until the speaker actually pauses. */
  readonly usesClientVAD: boolean;

  private client: SarvamAIClient | null = null;
  private sttSocket: any | null = null;
  private noiseSuppressor: BrowserNoiseSuppressor | null = null;
  private readonly recordingAccumulator = new SessionRecordingAccumulator();
  private audioElement: HTMLAudioElement | null = null;
  private currentBlobUrl: string | null = null;
  private speechGeneration = 0;
  private listeningGeneration = 0;
  private readonly noiseSuppression: NoiseSuppressionConfig | false;
  /** Interim-flush mode only: cumulative transcript for the current turn. */
  private turnText = "";
  private lastInterimFlushAt = 0;

  constructor(config: SarvamSpeechConfig) {
    if (!config.apiKey) {
      throw new Error(
        "[SarvamSpeechService] apiKey is required for direct mode",
      );
    }
    this.apiKey = config.apiKey;
    this.language = config.language;
    this.speaker = config.speaker;
    this.pace = config.pace;
    this.pitch = config.pitch;
    this.loudness = config.loudness;
    this.sttModel = config.sttModel ?? DEFAULT_STT_MODEL;
    this.ttsModel = config.ttsModel ?? DEFAULT_TTS_MODEL;
    this.ttsUrl = config.ttsUrl ?? "https://api.sarvam.ai/text-to-speech";
    this.dictId = config.dictId;
    this.outputAudioCodec = config.outputAudioCodec ?? DEFAULT_OUTPUT_CODEC;
    this.noiseSuppression = resolveNoiseSuppressionConfig(
      config.noiseSuppression,
    );
    this.sttChunkSizeSamples =
      config.sttChunkSizeSamples ?? DEFAULT_STT_CHUNK_SAMPLES;
    this.interimFlushMs = Math.max(0, config.interimFlushMs ?? 0);
    this.usesClientVAD = this.interimFlushMs > 0;
  }

  setLanguage(language: V2SupportedLanguage): void {
    if (this.language === language) {
      return;
    }
    this.language = language;
    if (this.sttSocket || this.noiseSuppressor) {
      void this.stopListening();
    }
  }

  async startListening(handlers: SarvamSTTHandlers): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      throw new Error(
        "[SarvamSpeechService] navigator.mediaDevices is unavailable. Microphone access requires HTTPS (or localhost) in a modern browser.",
      );
    }
    if (this.sttSocket || this.noiseSuppressor) {
      await this.stopListening();
    }
    const generation = ++this.listeningGeneration;

    const client = this.ensureClient();

    const socket: any = await client.speechToTextStreaming.connect({
      "language-code": this.language as any,
      model: this.sttModel as any,
      input_audio_codec: "pcm_s16le",
      sample_rate: "16000",
      high_vad_sensitivity: "true",
      vad_signals: "true", // Enable speech start/end events
      flush_signal: "true",
      "Api-Subscription-Key": this.apiKey,
    });
    this.sttSocket = socket;
    const isCurrentSession = () =>
      generation === this.listeningGeneration && this.sttSocket === socket;

    socket.on("message", (message: any) => {
      if (!isCurrentSession()) return;
      if (!message || typeof message !== "object") return;
      switch (message.type) {
        case "speech_start":
          this.beginTurn();
          handlers.onSpeechStart?.();
          break;
        case "speech_end":
          try {
            socket.flush?.();
          } catch {
            // ignore flush failures; socket may already be closing
          }
          handlers.onSpeechEnd?.();
          break;
        case "events": {
          // Production wire format: { type: "events", data: { signal_type: "START_SPEECH" | "END_SPEECH", occured_at: ... } }
          const signalType = message.data?.signal_type;
          if (signalType === "START_SPEECH") {
            this.beginTurn();
            handlers.onSpeechStart?.();
          } else if (signalType === "END_SPEECH") {
            try {
              socket.flush?.();
            } catch {
              // ignore flush failures; socket may already be closing
            }
            handlers.onSpeechEnd?.();
          }
          break;
        }
        case "data": {
          // Production wire format: { type: "data", data: { transcript, language_code, request_id, ... } }
          // Sarvam sends one "data" message per speech segment — after
          // END_SPEECH normally, or after each interim flush when
          // interimFlushMs is on.
          const transcript =
            typeof message.data?.transcript === "string"
              ? message.data.transcript
              : "";
          if (!transcript) return;
          this.emitTranscript(transcript, handlers);
          break;
        }
        case "transcript": {
          // Docs-stated shape, kept as a fallback: { type: "transcript", text }.
          const text = typeof message.text === "string" ? message.text : "";
          if (!text) return;
          this.emitTranscript(text, handlers);
          break;
        }
        default:
          // Ignore unknown frame types — keep forward-compatible.
          break;
      }
    });

    socket.on("error", (err: any) => {
      if (!isCurrentSession()) return;
      const error =
        err instanceof Error
          ? err
          : new Error(
              typeof err === "string" ? err : "Sarvam STT socket error",
            );
      handlers.onError?.(error);
    });

    try {
      if (typeof socket.waitForOpen === "function") {
        await socket.waitForOpen();
      }

      if (!isCurrentSession()) return;

      const noiseSuppressor = new BrowserNoiseSuppressor({
        ...(this.noiseSuppression || { enabled: false }),
        sampleRate: STT_SAMPLE_RATE,
        chunkSizeSamples: this.sttChunkSizeSamples,
        onChunk: (samples) => {
          if (!isCurrentSession()) return;
          if (handlers.shouldSendAudio && !handlers.shouldSendAudio()) return;
          if (samples.length === 0) return;
          try {
            const pcmBytes = new Uint8Array(
              samples.buffer,
              samples.byteOffset,
              samples.byteLength,
            );
            const base64Audio = uint8ArrayToBase64(pcmBytes);
            socket.transcribe({
              audio: base64Audio,
              encoding: "audio/wav",
              sample_rate: STT_SAMPLE_RATE,
            });
            this.maybeInterimFlush(socket);
          } catch (err) {
            if (isCurrentSession()) {
              handlers.onError?.(
                err instanceof Error ? err : new Error(String(err)),
              );
            }
          }
        },
        onError: (err) => {
          if (isCurrentSession()) handlers.onError?.(err);
        },
      });
      this.noiseSuppressor = noiseSuppressor;
      await noiseSuppressor.start();
      if (!isCurrentSession()) {
        await noiseSuppressor.stop().catch(() => undefined);
        return;
      }
    } catch (err) {
      if (isCurrentSession()) {
        await this.stopListening();
      }
      throw err;
    }
  }

  /** Starts a fresh cumulative transcript for the turn that just began. */
  private beginTurn(): void {
    this.turnText = "";
  }

  /**
   * Interim-flush mode emits several transcripts per turn, each covering only
   * the audio since the last flush, so they are folded into one cumulative
   * string — the form service reads a prefix-extension as "same answer, more
   * words" and anything else as a new segment. Without interim flushing there is
   * exactly one transcript per utterance and it is passed straight through, as
   * before.
   */
  private emitTranscript(text: string, handlers: SarvamSTTHandlers): void {
    if (!this.usesClientVAD) {
      handlers.onPartial?.(text);
      handlers.onFinal(text);
      return;
    }
    const next = appendWithOverlap(this.turnText, text);
    if (!next || next === this.turnText) return;
    this.turnText = next;
    handlers.onPartial?.(next);
    handlers.onFinal(next);
  }

  /** Asks Sarvam to transcribe what it is holding, without waiting for its
   *  server-side VAD to call the end of the utterance. */
  private maybeInterimFlush(socket: any): void {
    if (this.interimFlushMs <= 0) return;
    const now = Date.now();
    if (now - this.lastInterimFlushAt < this.interimFlushMs) return;
    this.lastInterimFlushAt = now;
    try {
      socket.flush?.();
    } catch {
      // ignore — socket may be closing
    }
  }

  async stopListening(): Promise<void> {
    this.listeningGeneration++;
    this.turnText = "";
    this.lastInterimFlushAt = 0;

    const noiseSuppressor = this.noiseSuppressor;
    const socket = this.sttSocket;

    this.noiseSuppressor = null;
    this.sttSocket = null;

    if (noiseSuppressor) {
      try {
        await noiseSuppressor.stop();
        this.recordingAccumulator.absorb(noiseSuppressor);
      } catch {
        // ignore — capture may already be ended
      }
    }
    if (socket) {
      try {
        socket.off?.("message");
        socket.off?.("error");
        socket.removeAllListeners?.();
      } catch {
        // ignore
      }
      try {
        socket.flush?.();
      } catch {
        // ignore
      }
      try {
        socket.close?.();
      } catch {
        // ignore
      }
    }
  }

  async speak(
    text: string,
    opts?: { language?: V2SupportedLanguage; onAudioStart?: () => void },
  ): Promise<void> {
    if (!text || !text.trim()) {
      return;
    }
    this.stopSpeaking();
    const generation = ++this.speechGeneration;
    const targetLanguage = opts?.language ?? this.language;
    const speaker = this.speaker ?? defaultSpeakerFor(targetLanguage);
    const isBulbulV3 = this.ttsModel.startsWith("bulbul:v3");
    const ttsText = formatTextForTts(text);

    // WORKAROUND: The Sarvam SDK's convertStream() returns null/undefined
    // even when the API succeeds. Make direct HTTP request instead.
    try {
      console.log("[SarvamSpeechService] Making direct TTS HTTP request");

      const body: any = {
        text: ttsText,
        target_language_code: targetLanguage,
        speaker: speaker,
        model: this.ttsModel,
        output_audio_codec: this.outputAudioCodec,
        ...(this.dictId ? { dict_id: this.dictId } : {}),
      };

      // Add optional parameters
      if (this.pace !== undefined) {
        body.pace = this.pace;
      }
      if (!isBulbulV3) {
        if (this.pitch !== undefined) {
          body.pitch = this.pitch;
        }
        if (this.loudness !== undefined) {
          body.loudness = this.loudness;
        }
      } else {
        body.pace = this.pace ?? 1.1; // bulbul:v3 uses pace=1.0 as default, so set explicitly if configured
        body.enable_preprocessing = true; // Enable Sarvam's bulbul:v3 preprocessing for better quality
        body.speech_sample_rate = 22050; // Match the sample rate used for STT to ensure consistent audio quality
        body.temperature = 0.6; // Add some variability to TTS output for more naturalness (0.0 = deterministic, 1.0 = very random)
      }

      console.log("[SarvamSpeechService] Request body:", JSON.stringify(body));

      const response = await fetch(this.ttsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "API-Subscription-Key": this.apiKey,
        },
        body: JSON.stringify(body),
      });

      console.log(
        "[SarvamSpeechService] HTTP response status:",
        response.status,
        response.statusText,
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[SarvamSpeechService] TTS API error:", errorText);
        throw new Error(
          `Sarvam TTS API failed: ${response.status} ${response.statusText}`,
        );
      }

      // Parse JSON response - Sarvam returns { audios: [...] } with base64 data
      const jsonResponse = await response.json();
      console.log(
        "[SarvamSpeechService] Response structure:",
        typeof jsonResponse,
        "keys:",
        Object.keys(jsonResponse || {}),
      );

      // Extract audio data from response
      let audioBase64: string | null = null;
      if (
        jsonResponse &&
        typeof jsonResponse === "object" &&
        "audios" in jsonResponse &&
        Array.isArray(jsonResponse.audios) &&
        jsonResponse.audios.length > 0
      ) {
        // Format: { audios: ["base64string"] }
        audioBase64 = jsonResponse.audios[0];
        console.log(
          "[SarvamSpeechService] Found audio in 'audios' array, length:",
          audioBase64?.length || 0,
        );
      } else if (
        jsonResponse &&
        typeof jsonResponse === "object" &&
        "audio" in jsonResponse &&
        typeof jsonResponse.audio === "string"
      ) {
        // Alternate format: { audio: "base64string" }
        audioBase64 = jsonResponse.audio;
        console.log(
          "[SarvamSpeechService] Found audio in 'audio' field, length:",
          audioBase64?.length || 0,
        );
      }

      if (!audioBase64 || typeof audioBase64 !== "string") {
        console.error(
          "[SarvamSpeechService] Could not find base64 audio in response:",
          jsonResponse,
        );
        throw new Error(
          "Sarvam TTS response does not contain audio data in expected format",
        );
      }

      // Decode base64 to ArrayBuffer
      console.log("[SarvamSpeechService] Decoding base64 audio...");
      const binaryString = atob(audioBase64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const arrayBuffer = bytes.buffer;

      console.log(
        "[SarvamSpeechService] Audio decoded, byteLength:",
        arrayBuffer.byteLength,
      );

      if (arrayBuffer.byteLength === 0) {
        throw new Error(
          "Sarvam TTS returned empty audio data (0 bytes). Check API response.",
        );
      }
      if (generation !== this.speechGeneration) {
        return;
      }

      const mime = this.codecToMime(this.outputAudioCodec);
      const blob = new Blob([arrayBuffer], { type: mime });
      const blobUrl = URL.createObjectURL(blob);
      if (generation !== this.speechGeneration) {
        URL.revokeObjectURL(blobUrl);
        return;
      }
      this.currentBlobUrl = blobUrl;

      const audio = new Audio(blobUrl);
      this.audioElement = audio;

      await this.playAudio(audio, blobUrl, generation, opts?.onAudioStart);
    } catch (err) {
      if (generation !== this.speechGeneration) {
        return;
      }
      this.stopSpeaking();
      console.error("[SarvamSpeechService] TTS error:", err);
      throw err instanceof Error
        ? err
        : new Error(`Sarvam TTS error: ${String(err)}`);
    }
  }

  private async playAudio(
    audio: HTMLAudioElement,
    blobUrl: string,
    generation: number,
    onAudioStart?: () => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      audio.onended = () => {
        this.cleanupAudioElement(audio, blobUrl);
        resolve();
      };
      audio.onerror = () => {
        this.cleanupAudioElement(audio, blobUrl);
        if (generation !== this.speechGeneration) {
          resolve();
          return;
        }
        reject(new Error("Sarvam TTS audio playback failed"));
      };
      audio
        .play()
        .then(() => {
          if (generation === this.speechGeneration) {
            onAudioStart?.();
          }
        })
        .catch((err) => {
          this.cleanupAudioElement(audio, blobUrl);
          if (generation !== this.speechGeneration) {
            resolve();
            return;
          }
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  stopSpeaking(): void {
    this.speechGeneration++;
    if (this.audioElement) {
      try {
        this.audioElement.pause();
        this.audioElement.src = "";
      } catch {
        // ignore
      }
      this.audioElement = null;
    }
    if (this.currentBlobUrl) {
      try {
        URL.revokeObjectURL(this.currentBlobUrl);
      } catch {
        // ignore
      }
      this.currentBlobUrl = null;
    }
  }

  dispose(): void {
    void this.stopListening();
    this.stopSpeaking();
    this.client = null;
  }

  getAudioRecordings(): AudioRecordingPair | null {
    return this.recordingAccumulator.getRecordings();
  }

  resetAudioRecordingSession(): void {
    this.recordingAccumulator.reset();
  }

  private ensureClient(): SarvamAIClient {
    if (!this.client) {
      this.client = new SarvamAIClient({
        apiSubscriptionKey: this.apiKey,
      });
    }
    return this.client;
  }

  private cleanupAudioElement(audio: HTMLAudioElement, blobUrl: string): void {
    if (this.audioElement === audio) {
      this.audioElement = null;
    }
    if (this.currentBlobUrl === blobUrl) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        // ignore
      }
      this.currentBlobUrl = null;
    }
  }

  private codecToMime(
    codec: NonNullable<SarvamSpeechConfig["outputAudioCodec"]>,
  ): string {
    switch (codec) {
      case "mp3":
        return "audio/mpeg";
      case "wav":
        return "audio/wav";
      case "aac":
        return "audio/aac";
      case "opus":
        return "audio/opus";
      case "flac":
        return "audio/flac";
      case "linear16":
      case "mulaw":
      case "alaw":
        return "audio/wav";
      default:
        return "audio/mpeg";
    }
  }
}
