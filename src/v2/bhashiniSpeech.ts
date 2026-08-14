import { io, type Socket } from "socket.io-client";
import {
  BrowserNoiseSuppressor,
  resolveNoiseSuppressionConfig,
  type AudioRecordingPair,
  type NoiseSuppressionConfig,
} from "./noiseSuppression";
import { SessionRecordingAccumulator } from "./recordingAccumulator";
import { formatTextForTts } from "./ttsText";
import type {
  BhashiniSpeechConfig,
  BhashiniSpeechProvider,
  SarvamSTTHandlers,
  V2SupportedLanguage,
} from "./types";

// Bhashini live ASR uses Socket.IO transport to Dhruva. The local capture
// module emits filtered raw Int16 PCM frames that are fed into `data` events,
// while a separate pipeline POST is used for TTS. The form-flow service does
// not poll a stop button, so we add lightweight client-side RMS-based silence
// detection to emit synthetic onSpeechStart / onSpeechEnd signals.

const DEFAULT_STT_SOCKET_URL = "wss://dhruva-api.bhashini.gov.in";
const DEFAULT_STT_SOCKET_PATH = "/socket.io";
const DEFAULT_TTS_SERVICE_ID = "Bhashini/IITM/TTS";
const DEFAULT_TTS_GENDER: "male" | "female" = "female";
const DEFAULT_TTS_SPEED = 1.0;
const DEFAULT_TTS_SAMPLING_RATE = 48000;
const DEFAULT_RESPONSE_FREQUENCY_SECS = 2;

const STT_SAMPLE_RATE = 16000;
const STT_CHUNK_BUFFER_BYTES = 4096; // ~128 ms of mono int16 audio
const STT_QUEUE_FLUSH_DELAY_MS = 10;

const DEFAULT_SILENCE_DEBOUNCE_MS = 1500;
const DEFAULT_RMS_THRESHOLD = 500;

// BCP-47 -> Bhashini 2-letter code. Bhashini uses ISO-639-1 codes (with `or`
// for Odia rather than ISO `od`).
const BHASHINI_LANGUAGE_MAP: Record<V2SupportedLanguage, string> = {
  "en-IN": "en",
  "hi-IN": "hi",
  "bn-IN": "bn",
  "ta-IN": "ta",
  "te-IN": "te",
  "kn-IN": "kn",
  "ml-IN": "ml",
  "mr-IN": "mr",
  "gu-IN": "gu",
  "pa-IN": "pa",
  "od-IN": "or",
};

function defaultAsrServiceFor(bhashiniLang: string): string {
  return bhashiniLang === "en"
    ? "ai4bharat/whisper-medium-en--gpu--t4"
    : "bhashini/ai4bharat/conformer-multilingual-asr";
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export class BhashiniSpeechService implements BhashiniSpeechProvider {
  readonly usesClientVAD = true as const;
  private readonly apiKey: string;
  private language: V2SupportedLanguage;
  private readonly sttSocketUrl: string;
  private readonly sttSocketPath: string;
  private readonly asrServiceIdOverride: string | undefined;
  private readonly responseFrequencyInSecs: number;
  private readonly ttsPipelineUrl: string;
  private readonly ttsServiceId: string;
  private readonly ttsGender: "male" | "female";
  private readonly ttsSpeed: number;
  private readonly ttsSamplingRate: number;
  private readonly silenceDebounceMs: number;
  private readonly rmsSilenceThreshold: number;
  private readonly noiseSuppression: NoiseSuppressionConfig | false;

  // STT runtime state.
  private socket: Socket | null = null;
  private socketReady = false;
  private noiseSuppressor: BrowserNoiseSuppressor | null = null;
  private readonly recordingAccumulator = new SessionRecordingAccumulator();
  private audioQueue: Int16Array[] = [];
  private processingQueue = false;
  private listenHandlers: SarvamSTTHandlers | null = null;
  private listeningGeneration = 0;

  // Client-side VAD bookkeeping.
  private isSpeaking = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  // Bhashini emits "final" segments only after it detects end-of-stream.
  // Short utterances often finish entirely within interim frames, so we
  // remember the latest interim and promote it to a synthetic `onFinal` at
  // close-time if no real final ever arrived.
  private lastInterimText = "";
  private deliveredTranscriptText = "";

  // TTS playback.
  private audioElement: HTMLAudioElement | null = null;
  private currentBlobUrl: string | null = null;
  private speechGeneration = 0;

  constructor(config: BhashiniSpeechConfig) {
    if (!config.apiKey) {
      throw new Error("[BhashiniSpeechService] apiKey is required");
    }
    if (!config.ttsPipelineUrl) {
      throw new Error(
        "[BhashiniSpeechService] ttsPipelineUrl is required — supply the Bhashini pipeline endpoint that your tenant exposes for TTS",
      );
    }
    this.apiKey = config.apiKey;
    this.language = config.language;
    this.sttSocketUrl = config.sttSocketUrl ?? DEFAULT_STT_SOCKET_URL;
    this.sttSocketPath = config.sttSocketPath ?? DEFAULT_STT_SOCKET_PATH;
    this.asrServiceIdOverride = config.asrServiceId;
    this.responseFrequencyInSecs =
      config.responseFrequencyInSecs ?? DEFAULT_RESPONSE_FREQUENCY_SECS;
    this.ttsPipelineUrl = config.ttsPipelineUrl;
    this.ttsServiceId = config.ttsServiceId ?? DEFAULT_TTS_SERVICE_ID;
    this.ttsGender = config.ttsGender ?? DEFAULT_TTS_GENDER;
    this.ttsSpeed = config.ttsSpeed ?? DEFAULT_TTS_SPEED;
    this.ttsSamplingRate =
      config.ttsSamplingRate ?? DEFAULT_TTS_SAMPLING_RATE;
    this.silenceDebounceMs =
      config.silenceDebounceMs ?? DEFAULT_SILENCE_DEBOUNCE_MS;
    this.rmsSilenceThreshold =
      config.rmsSilenceThreshold ?? DEFAULT_RMS_THRESHOLD;
    this.noiseSuppression = resolveNoiseSuppressionConfig(
      config.noiseSuppression,
    );
  }

  setLanguage(language: V2SupportedLanguage): void {
    if (this.language === language) return;
    this.language = language;
    if (this.socket || this.noiseSuppressor) {
      void this.stopListening();
    }
  }

  async startListening(handlers: SarvamSTTHandlers): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      throw new Error(
        "[BhashiniSpeechService] navigator.mediaDevices is unavailable. Microphone access requires HTTPS (or localhost) in a modern browser.",
      );
    }
    if (this.socket || this.noiseSuppressor) {
      await this.stopListening();
    }
    const generation = ++this.listeningGeneration;
    const isCurrentSession = () =>
      generation === this.listeningGeneration &&
      this.listenHandlers === handlers;

    this.listenHandlers = handlers;
    this.audioQueue = [];
    this.socketReady = false;
    this.processingQueue = false;
    this.isSpeaking = false;
    this.lastInterimText = "";
    this.deliveredTranscriptText = "";
    this.cancelSilenceTimer();

    const noiseSuppressor = new BrowserNoiseSuppressor({
      ...(this.noiseSuppression || { enabled: false }),
      sampleRate: STT_SAMPLE_RATE,
      chunkSizeSamples: STT_CHUNK_BUFFER_BYTES / 2,
      onChunk: (samples) => {
        if (!isCurrentSession()) return;
        if (handlers.shouldSendAudio && !handlers.shouldSendAudio()) return;
        if (samples.length === 0) return;
        this.audioQueue.push(samples);
        this.updateVoiceActivity(samples);
        if (this.socketReady && !this.processingQueue) {
          void this.processAudioQueue();
        }
      },
      onError: (err) => {
        if (isCurrentSession()) {
          this.listenHandlers?.onError?.(err);
        }
      },
    });
    this.noiseSuppressor = noiseSuppressor;

    // Open the socket. Bhashini's Dhruva endpoint expects the `start` event
    // with a task sequence describing the ASR pipeline.
    const bhashiniLang = BHASHINI_LANGUAGE_MAP[this.language] ?? "en";
    const asrServiceId =
      this.asrServiceIdOverride ?? defaultAsrServiceFor(bhashiniLang);
    const taskSequence: unknown[] = [
      {
        taskType: "asr",
        config: {
          serviceId: asrServiceId,
          language: { sourceLanguage: bhashiniLang },
          samplingRate: STT_SAMPLE_RATE,
          encoding: null,
          audioFormat: "wav",
          preProcessors: ["denoiser"],
          postProcessors: ["itn", "punctuation"],
        },
      },
      {
        responseFrequencyInSecs: this.responseFrequencyInSecs,
        responseTaskSequenceDepth: 1,
      },
    ];

    const socket = io(this.sttSocketUrl, {
      transports: ["websocket", "polling"],
      auth: { authorization: this.apiKey },
      path: this.sttSocketPath,
      secure: true,
      reconnection: false,
    });
    this.socket = socket;

    socket.on("connect", () => {
      if (!isCurrentSession() || this.socket !== socket) return;
      socket.emit("start", taskSequence);
      this.socketReady = true;
      void this.processAudioQueue();
    });

    socket.on("response", (response: any, streamingStatus: any) => {
      if (!isCurrentSession() || this.socket !== socket) return;
      try {
        if (!response || typeof response !== "object") return;
        const pipelineResponse = response.pipelineResponse ?? [];
        if (!Array.isArray(pipelineResponse) || pipelineResponse.length === 0) {
          return;
        }
        const outputList = pipelineResponse[0]?.output ?? [];
        if (!Array.isArray(outputList) || outputList.length === 0) return;

        if (streamingStatus?.isIntermediateResult) {
          const interim =
            typeof outputList[0]?.source === "string"
              ? outputList[0].source.trim()
              : "";
          if (interim) {
            const cleanedInterim =
              this.removeRollingTranscriptDuplication(interim);
            this.lastInterimText = interim;
            // Send the FULL current transcript so voiceFormService can replace
            // its live display. This handles both word extensions (new words
            // appended) and word revisions (Bhashini refined an earlier word)
            // without incremental-extraction errors. Skip if text unchanged.
            if (cleanedInterim && cleanedInterim !== this.deliveredTranscriptText) {
              this.deliveredTranscriptText = cleanedInterim;
              this.listenHandlers?.onPartial?.(cleanedInterim);
            }
          }
          return;
        }

        // Final segment — Bhashini collates multiple chunks; we join them
        // with ". " to match the reference implementation. A real final
        // supersedes the latest interim, so clear it to avoid double-emit.
        const finalText = this.removeRollingTranscriptDuplication(
          outputList
            .filter((chunk: any) => typeof chunk.source === "string" && chunk.source.trim())
            .map((chunk: any) => chunk.source.trim())
            .join(". "),
        );
        if (finalText) {
          this.lastInterimText = "";
          if (finalText !== this.deliveredTranscriptText) {
            this.deliveredTranscriptText = finalText;
            this.listenHandlers?.onFinal(finalText);
          }
        }
      } catch (err) {
        this.listenHandlers?.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    });

    socket.on("abort", (message: any) => {
      if (!isCurrentSession() || this.socket !== socket) return;
      this.listenHandlers?.onError?.(
        new Error(
          `Bhashini socket aborted: ${typeof message === "string" ? message : JSON.stringify(message)}`,
        ),
      );
    });

    socket.on("connect_error", (err: any) => {
      if (!isCurrentSession() || this.socket !== socket) return;
      this.listenHandlers?.onError?.(
        err instanceof Error
          ? err
          : new Error(typeof err === "string" ? err : "Bhashini connect error"),
      );
    });

    socket.on("disconnect", () => {
      if (!isCurrentSession() || this.socket !== socket) return;
      this.socketReady = false;
    });

    try {
      await noiseSuppressor.start();
      if (!isCurrentSession() || this.socket !== socket) {
        await noiseSuppressor.stop().catch(() => undefined);
        return;
      }
      socket.connect();
    } catch (err) {
      if (isCurrentSession()) {
        await this.stopListening();
      }
      throw err;
    }
  }

  async stopListening(): Promise<void> {
    this.listeningGeneration++;
    this.cancelSilenceTimer();
    this.socketReady = false;
    this.isSpeaking = false;

    const noiseSuppressor = this.noiseSuppressor;
    const socket = this.socket;
    const handlers = this.listenHandlers;
    const lastInterimText = this.lastInterimText;
    const deliveredTranscriptText = this.deliveredTranscriptText;

    this.noiseSuppressor = null;
    this.socket = null;
    this.listenHandlers = null;
    this.lastInterimText = "";
    this.deliveredTranscriptText = "";

    if (noiseSuppressor) {
      try {
        await noiseSuppressor.stop();
        this.recordingAccumulator.absorb(noiseSuppressor);
      } catch {
        // ignore — capture may already be ended
      }
    }
    this.audioQueue = [];

    // Signal end-of-stream so Bhashini can flush any pending final. Matches
    // the reference impl's two-null-frame protocol close.
    if (socket) {
      try {
        socket.emit("data", null, null, false, false);
        socket.emit("data", null, null, false, false);
      } catch {
        // ignore
      }
      // Brief grace period for a final-segment response to land before we
      // close the socket. Without this, short utterances always end with
      // only interim transcripts and the form-flow sees an empty result.
      await new Promise<void>((resolve) => setTimeout(resolve, 800));
    }

    // If Bhashini did not emit a true final since the last interim, promote
    // the latest interim to a synthetic onFinal so the spoken text actually
    // reaches the form-flow.
    if (lastInterimText && handlers) {
      try {
        const finalText =
          this.removeRollingTranscriptDuplication(lastInterimText);
        // Promote the last interim to a synthetic final only if the socket
        // never delivered a true final (deliveredTranscriptText would already
        // equal finalText in that case).
        if (finalText && finalText !== deliveredTranscriptText) {
          handlers.onFinal(finalText);
        }
      } catch {
        // ignore
      }
    }

    if (socket) {
      try {
        socket.removeAllListeners?.();
        socket.close();
      } catch {
        // ignore
      }
    }
  }

  async speak(
    text: string,
    opts?: { language?: V2SupportedLanguage; onAudioStart?: () => void },
  ): Promise<void> {
    if (!text || !text.trim()) return;
    this.stopSpeaking();
    const generation = ++this.speechGeneration;
    const targetLanguage = opts?.language ?? this.language;
    const bhashiniLang = BHASHINI_LANGUAGE_MAP[targetLanguage] ?? "en";
    const ttsText = formatTextForTts(text);

    const body = {
      pipelineTasks: [
        {
          taskType: "tts",
          config: {
            language: { sourceLanguage: bhashiniLang },
            serviceId: this.ttsServiceId,
            gender: this.ttsGender,
            speed: this.ttsSpeed,
            samplingRate: this.ttsSamplingRate,
          },
        },
      ],
      inputData: {
        input: [{ source: ttsText }],
        audio: [{ audioContent: null }],
      },
    };

    const response = await fetch(this.ttsPipelineUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      if (generation !== this.speechGeneration) {
        return;
      }
      throw new Error(
        `[BhashiniSpeechService] TTS pipeline failed: ${response.status} ${response.statusText}`,
      );
    }
    const data = (await response.json()) as {
      pipelineResponse?: Array<{
        audio?: Array<{ audioContent?: string }>;
      }>;
    };
    const audioContent =
      data?.pipelineResponse?.[0]?.audio?.[0]?.audioContent;
    if (typeof audioContent !== "string" || !audioContent) {
      if (generation !== this.speechGeneration) {
        return;
      }
      throw new Error(
        "[BhashiniSpeechService] TTS response missing audioContent",
      );
    }
    if (generation !== this.speechGeneration) {
      return;
    }

    const bytes = base64ToBytes(audioContent);
    // Cast through ArrayBuffer for stricter lib.dom Blob typings (newer TS
    // narrows Uint8Array's buffer to ArrayBufferLike which BlobPart rejects).
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "audio/wav" });
    const blobUrl = URL.createObjectURL(blob);
    if (generation !== this.speechGeneration) {
      URL.revokeObjectURL(blobUrl);
      return;
    }
    this.currentBlobUrl = blobUrl;

    const audio = new Audio(blobUrl);
    this.audioElement = audio;

    await new Promise<void>((resolve, reject) => {
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
        reject(new Error("Bhashini TTS audio playback failed"));
      };
      audio
        .play()
        .then(() => {
          if (generation === this.speechGeneration) {
            opts?.onAudioStart?.();
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
  }

  getAudioRecordings(): AudioRecordingPair | null {
    return this.recordingAccumulator.getRecordings();
  }

  resetAudioRecordingSession(): void {
    this.recordingAccumulator.reset();
  }

  private async processAudioQueue(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;
    try {
      while (
        this.socketReady &&
        this.audioQueue.length > 0 &&
        this.socket
      ) {
        const chunk = this.audioQueue.shift();
        if (!chunk) continue;
        this.socket.emit(
          "data",
          { audio: [{ audioContent: chunk }] },
          { responseTaskSequenceDepth: 1 },
          false,
          false,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, STT_QUEUE_FLUSH_DELAY_MS),
        );
      }
    } finally {
      this.processingQueue = false;
    }
  }

  // Compute the RMS of an int16 PCM frame; emit synthetic VAD signals to
  // the listen handlers so voiceFormService can react to natural end-of-
  // utterance silence (Bhashini does not send speech_start / speech_end).
  private updateVoiceActivity(samples: Int16Array): void {
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      sumSquares += s * s;
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, samples.length));

    if (rms > this.rmsSilenceThreshold) {
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.listenHandlers?.onSpeechStart?.();
      }
      this.cancelSilenceTimer();
      return;
    }

    if (!this.isSpeaking || this.silenceTimer) return;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      this.isSpeaking = false;
      this.listenHandlers?.onSpeechEnd?.();
    }, this.silenceDebounceMs);
  }

  private cancelSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private cleanupAudioElement(
    audio: HTMLAudioElement,
    blobUrl: string,
  ): void {
    if (this.audioElement === audio) this.audioElement = null;
    if (this.currentBlobUrl === blobUrl) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        // ignore
      }
      this.currentBlobUrl = null;
    }
  }

  private joinTranscriptText(left: string, right: string): string {
    return [left, right]
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private normalizeTranscriptForComparison(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private getIncrementalTranscript(previous: string, incoming: string): string {
    const cleanedIncoming = incoming.replace(/\s+/g, " ").trim();
    if (!cleanedIncoming) return "";

    const normalizedPrevious =
      this.normalizeTranscriptForComparison(previous);
    const normalizedIncoming =
      this.normalizeTranscriptForComparison(cleanedIncoming);
    if (!normalizedPrevious) return cleanedIncoming;

    // Exact match or incoming is fully contained in delivered — nothing new.
    if (normalizedIncoming === normalizedPrevious) return "";
    if (normalizedPrevious.includes(normalizedIncoming)) return "";

    // Common case: incoming extends delivered (cumulative / appended words).
    if (normalizedIncoming.startsWith(`${normalizedPrevious} `)) {
      return cleanedIncoming
        .slice(previous.length)
        .replace(/^[\s.,;:!?-]+/, "")
        .trim();
    }

    // Tail of previous matches head of incoming (rolling window slid forward).
    const previousWords = previous.trim().split(/\s+/);
    const incomingWords = cleanedIncoming.split(/\s+/);
    const maxOverlap = Math.min(previousWords.length, incomingWords.length);
    for (let size = maxOverlap; size > 0; size--) {
      const previousTail = this.normalizeTranscriptForComparison(
        previousWords.slice(-size).join(" "),
      );
      const incomingHead = this.normalizeTranscriptForComparison(
        incomingWords.slice(0, size).join(" "),
      );
      if (previousTail && previousTail === incomingHead) {
        return incomingWords.slice(size).join(" ").trim();
      }
    }

    // Bhashini's rolling window can restart from the MIDDLE of already-delivered
    // text (e.g. delivered = "A B C D E", incoming = "C D E A B C D E").
    // The checks above miss this because the head of incoming ("C") is not the
    // word immediately after the tail of previous ("E").
    //
    // Strategy: find where in previous the head of incoming aligns, check if
    // that alignment consumes all of previous (meaning incoming's continuation
    // is genuinely new), then verify the continuation is not itself already
    // in previous before returning it.
    //
    // Per-word normalization: strip all non-alphanumeric from each word
    // individually (1 original word → 1 normalized token, possibly empty for
    // punctuation-only tokens like ".").
    const normWord = (w: string) =>
      w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

    // Build filtered (non-empty normalized) views with original-index tracking.
    const prevFilt: string[] = [];
    for (const w of previousWords) {
      const n = normWord(w);
      if (n) prevFilt.push(n);
    }

    const incNorms: string[] = [];
    const incOrigIdx: number[] = []; // incOrigIdx[i] = incomingWords index for incNorms[i]
    for (let i = 0; i < incomingWords.length; i++) {
      const n = normWord(incomingWords[i]);
      if (n) {
        incNorms.push(n);
        incOrigIdx.push(i);
      }
    }

    const minMatch = Math.min(4, incNorms.length);
    if (minMatch >= 2 && prevFilt.length >= minMatch) {
      for (
        let ps = 0;
        ps <= prevFilt.length - minMatch;
        ps++
      ) {
        let ml = 0;
        while (
          ml < incNorms.length &&
          ps + ml < prevFilt.length &&
          incNorms[ml] === prevFilt[ps + ml]
        ) {
          ml++;
        }
        if (ml < minMatch) continue;

        if (ps + ml >= prevFilt.length) {
          // The match ran to the end of previous. Everything in incoming
          // after the matched words is potentially new content.
          const firstNewOrigIdx =
            ml < incOrigIdx.length ? incOrigIdx[ml] : incomingWords.length;
          const newPart = incomingWords.slice(firstNewOrigIdx).join(" ").trim();
          if (!newPart) return "";
          // Verify the "new" portion is not also already in delivered.
          const normNew = this.normalizeTranscriptForComparison(newPart);
          if (normalizedPrevious.includes(normNew)) return "";
          return newPart;
        }
      }
    }

    return cleanedIncoming;
  }

  private removeRollingTranscriptDuplication(text: string): string {
    const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (words.length < 4) return text.trim();

    for (let size = Math.floor(words.length / 2); size >= 2; size--) {
      const first = this.normalizeTranscriptForComparison(
        words.slice(0, size).join(" "),
      );
      const second = this.normalizeTranscriptForComparison(
        words.slice(size, size * 2).join(" "),
      );
      if (first && first === second) {
        return [...words.slice(0, size), ...words.slice(size * 2)]
          .join(" ")
          .trim();
      }
    }

    return text.trim();
  }
}
