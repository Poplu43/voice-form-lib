/**
 * Sarvam AI Speech Service
 * Uses the official sarvamai npm library for STT and TTS streaming
 * Docs: https://docs.sarvam.ai/
 * NPM: https://www.npmjs.com/package/sarvamai
 */

export interface SarvamSpeechConfig {
  apiKey: string;
  language?: string; // BCP-47 format: "hi-IN", "en-IN", etc.
  model?: string; // "saaras:v3" for STT, "bulbul:v3" for TTS
  mode?: string; // "transcribe", "translate", etc.
  speaker?: string; // Voice name
  pace?: number; // 0.3 to 3.0
  pitch?: number; // 0.5 to 2.0
  loudness?: number; // 0.5 to 2.0
  sampleRate?: number; // 16000 or 8000
  debug?: boolean;
}

export interface SarvamSTTMessage {
  type: string;
  data?: {
    transcript?: string;
    request_id?: string;
    metrics?: {
      audio_duration?: number;
      processing_latency?: number;
    };
  };
}

export interface SarvamTTSMessage {
  type: string;
  data?: {
    content_type?: string;
    audio?: string; // base64 encoded audio chunk
    event_type?: string; // "final" for completion
  };
}

export type SarvamSTTCallback = (message: SarvamSTTMessage) => void;

/**
 * Sarvam Speech Service using the official npm library
 * Provides STT and TTS streaming via WebSocket under the hood
 */
export class SarvamSpeechService {
  private config: Required<SarvamSpeechConfig>;
  private client: any = null; // Will be initialized lazily
  private sttSocket: any = null;
  private sttCallback: SarvamSTTCallback | null = null;
  private sttActive: boolean = false;
  private debug: boolean = false;

  constructor(config: SarvamSpeechConfig) {
    this.debug = config.debug ?? false;
    this.config = {
      apiKey: config.apiKey,
      language: this.mapLanguageCodeToSarvam(config.language || "hi-IN"),
      model: config.model || "saaras:v3",
      mode: config.mode || "transcribe",
      speaker:
        config.speaker || this.getDefaultSpeaker(config.language || "hi-IN"),
      pace: config.pace ?? 1.0,
      pitch: config.pitch ?? 1.0,
      loudness: config.loudness ?? 1.0,
      sampleRate: config.sampleRate || 16000,
      debug: this.debug,
    };
  }

  /**
   * Initialize the Sarvam client (lazy initialization)
   */
  private async ensureClient(): Promise<void> {
    if (this.client) return;

    try {
      // Dynamically import the library to avoid bundling issues
      const { SarvamAIClient } = await import("sarvamai");

      this.client = new SarvamAIClient({
        apiSubscriptionKey: this.config.apiKey,
      });

      if (this.debug) {
        console.log("[SarvamSpeech] Client initialized");
      }
    } catch (error) {
      console.error("[SarvamSpeech] Failed to initialize client:", error);
      throw new Error(
        "Failed to initialize Sarvam client. Ensure 'sarvamai' package is installed.",
      );
    }
  }

  /**
   * Map language codes to Sarvam's expected format (BCP-47 with IN region)
   */
  private mapLanguageCodeToSarvam(code: string): string {
    const mapping: Record<string, string> = {
      "en-US": "en-IN",
      "hi-IN": "hi-IN",
      "bn-IN": "bn-IN",
      "ta-IN": "ta-IN",
      "te-IN": "te-IN",
      "ml-IN": "ml-IN",
      "mr-IN": "mr-IN",
      "gu-IN": "gu-IN",
      "kn-IN": "kn-IN",
      "pa-IN": "pa-IN",
      "od-IN": "od-IN",
      en: "en-IN",
      hi: "hi-IN",
      bn: "bn-IN",
      ta: "ta-IN",
      te: "te-IN",
      ml: "ml-IN",
      mr: "mr-IN",
      gu: "gu-IN",
      kn: "kn-IN",
      pa: "pa-IN",
    };
    return mapping[code] || "hi-IN";
  }

  /**
   * Get default speaker for a language
   */
  private getDefaultSpeaker(languageCode: string): string {
    const mapped = this.mapLanguageCodeToSarvam(languageCode);
    const speakers: Record<string, string> = {
      "hi-IN": "meera",
      "en-IN": "arvind",
      "bn-IN": "anushka",
      "ta-IN": "kanha",
      "te-IN": "priya",
      "ml-IN": "lakshmi",
      "mr-IN": "aarav",
      "gu-IN": "diya",
      "kn-IN": "ishaan",
      "pa-IN": "kabir",
    };
    return speakers[mapped] || "meera";
  }

  /**
   * Update language configuration
   */
  updateLanguage(language: string): void {
    const mapped = this.mapLanguageCodeToSarvam(language);
    this.config.language = mapped;
    this.config.speaker = this.getDefaultSpeaker(mapped);
    if (this.debug) {
      console.log(
        `[SarvamSpeech] Language updated to ${mapped}, speaker: ${this.config.speaker}`,
      );
    }
  }

  /**
   * Create STT streaming connection using the library
   */
  async createSTTClient(callback: SarvamSTTCallback): Promise<any> {
    await this.ensureClient();

    this.sttCallback = callback;

    try {
      if (this.debug) {
        console.log("[SarvamSpeech] Creating STT connection...");
      }

      // Connect to STT streaming endpoint
      const socket = await this.client.speechToTextStreaming.connect({
        model: this.config.model as any,
        mode: this.config.mode as any,
        language_code: this.config.language as any,
        sample_rate: this.config.sampleRate,
        input_audio_codec: "pcm_s16le" as any,
        high_vad_sensitivity: true,
        vad_signals: true,
        flush_signal: true,
        "Api-Subscription-Key": this.config.apiKey,
      });

      // Set up event handlers
      socket.on("message", (message: any) => {
        if (this.sttCallback) {
          this.sttCallback(message as SarvamSTTMessage);
        }
      });

      socket.on("error", (error: Error) => {
        console.error("[SarvamSpeech] STT socket error:", error);
      });

      socket.on("close", () => {
        if (this.debug) {
          console.log("[SarvamSpeech] STT socket closed");
        }
        this.sttActive = false;
      });

      socket.on("open", () => {
        if (this.debug) {
          console.log("[SarvamSpeech] STT socket opened");
        }
        this.sttActive = true;
      });

      // Connect the socket
      socket.connect();

      this.sttSocket = socket;

      if (this.debug) {
        console.log("[SarvamSpeech] STT connection established");
      }
      return socket;
    } catch (error) {
      console.error("[SarvamSpeech] Failed to create STT connection:", error);
      throw error;
    }
  }

  /**
   * Send audio data to STT connection
   */
  sendAudioToSTT(audioData: Int16Array): void {
    if (!this.sttSocket || !this.sttActive) {
      console.warn("[SarvamSpeech] STT not active");
      return;
    }

    try {
      // Convert to base64
      const base64Audio = this.int16ArrayToBase64(audioData);

      // Send using library's method
      this.sttSocket.transcribe({
        audio: base64Audio,
        encoding: "audio/pcm",
        sample_rate: this.config.sampleRate,
      });
    } catch (error) {
      console.error("[SarvamSpeech] Failed to send audio:", error);
    }
  }

  /**
   * Flush STT buffer (force immediate processing)
   */
  async flushSTT(): Promise<void> {
    if (this.sttSocket && this.sttSocket.flush) {
      this.sttSocket.flush();
    }
  }

  /**
   * Close STT connection
   */
  closeSTT(): void {
    if (this.sttSocket) {
      this.sttSocket.close();
      this.sttSocket = null;
    }
    this.sttActive = false;
    this.sttCallback = null;
    if (this.debug) {
      console.log("[SarvamSpeech] STT closed");
    }
  }

  /**
   * Synthesize speech using TTS streaming
   * Returns base64-encoded audio (concatenated from all chunks)
   */
  async synthesizeSpeech(text: string): Promise<string> {
    await this.ensureClient();

    return new Promise(async (resolve, reject) => {
      try {
        if (this.debug) {
          console.log("[SarvamSpeech] Starting TTS synthesis...");
        }

        // Connect to TTS streaming endpoint
        const socket = await this.client.textToSpeechStreaming.connect({
          model: "bulbul:v3" as any,
        });

        const audioChunks: string[] = [];
        let completed = false;
        let closeTimeout: NodeJS.Timeout | null = null;

        // Set up message handler
        socket.on("message", (message: any) => {
          const ttsmsg = message as SarvamTTSMessage;

          if (ttsmsg.type === "audio" && ttsmsg.data?.audio) {
            audioChunks.push(ttsmsg.data.audio);
            if (this.debug) {
              console.log(
                `[SarvamSpeech] Audio chunk ${audioChunks.length} received`,
              );
            }
          } else if (
            ttsmsg.type === "event" &&
            ttsmsg.data?.event_type === "final"
          ) {
            if (this.debug) {
              console.log("[SarvamSpeech] TTS complete");
            }
            if (closeTimeout) clearTimeout(closeTimeout);
            completed = true;
            socket.close();
            const fullAudio = this.concatenateBase64Chunks(audioChunks);
            if (this.debug) {
              console.log(
                `[SarvamSpeech] Generated ${audioChunks.length} audio chunks`,
              );
            }
            resolve(fullAudio);
          }
        });

        socket.on("error", (error: Error) => {
          console.error("[SarvamSpeech] TTS socket error:", error);
          if (closeTimeout) clearTimeout(closeTimeout);
          if (!completed) {
            reject(error);
          }
        });

        socket.on("close", () => {
          if (closeTimeout) clearTimeout(closeTimeout);
          if (!completed && audioChunks.length > 0) {
            // Connection closed but we have audio
            const fullAudio = this.concatenateBase64Chunks(audioChunks);
            if (this.debug) {
              console.log(
                `[SarvamSpeech] TTS closed with ${audioChunks.length} chunks`,
              );
            }
            resolve(fullAudio);
          } else if (!completed) {
            reject(new Error("TTS connection closed without completing"));
          }
        });

        // Set up open handler - follows official API pattern
        socket.on("open", () => {
          if (this.debug) {
            console.log("[SarvamSpeech] TTS connection opened");
          }

          // Configure TTS parameters using official API format
          socket.configureConnection({
            type: "config" as any,
            data: {
              speaker: this.config.speaker,
              target_language_code: this.config.language,
              pace: this.config.pace,
              pitch: this.config.pitch,
              loudness: this.config.loudness,
              min_buffer_size: 50,
              max_chunk_length: 200,
            } as any,
          });

          if (this.debug) {
            console.log("[SarvamSpeech] TTS configured");
          }

          // Send text for synthesis
          socket.convert(text);

          // Safety timeout: close after 10 seconds if not completed
          closeTimeout = setTimeout(() => {
            if (!completed && audioChunks.length > 0) {
              if (this.debug) {
                console.log(
                  "[SarvamSpeech] TTS timeout - closing with existing audio",
                );
              }
              completed = true;
              socket.close();
              resolve(this.concatenateBase64Chunks(audioChunks));
            }
          }, 10000);
        });

        // Connect is handled automatically by the library
      } catch (error) {
        console.error("[SarvamSpeech] TTS synthesis failed:", error);
        reject(error);
      }
    });
  }

  /**
   * Properly concatenate base64-encoded audio chunks
   * Decodes each chunk to binary, concatenates binaries, then re-encodes
   */
  private concatenateBase64Chunks(chunks: string[]): string {
    if (chunks.length === 0) return "";
    if (chunks.length === 1) return chunks[0];

    try {
      // Calculate total size
      let totalSize = 0;
      const decodedChunks: Uint8Array[] = [];

      for (const chunk of chunks) {
        // Clean base64 string
        const cleaned = chunk.replace(/\s/g, "");
        const binary = atob(cleaned);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        decodedChunks.push(bytes);
        totalSize += bytes.length;
      }

      if (this.debug) {
        console.log(
          `[SarvamSpeech] Concatenating ${chunks.length} chunks, total size: ${totalSize} bytes`,
        );
      }

      // Concatenate all binary data
      const combined = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of decodedChunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      // Convert back to base64
      let binary = "";
      for (let i = 0; i < combined.length; i++) {
        binary += String.fromCharCode(combined[i]);
      }
      return btoa(binary);
    } catch (error) {
      console.error("[SarvamSpeech] Failed to concatenate chunks:", error);
      // Fallback: return first chunk
      return chunks[0];
    }
  }

  /**
   * Disconnect all connections
   */
  disconnect(): void {
    this.closeSTT();
    if (this.debug) {
      console.log("[SarvamSpeech] Disconnected");
    }
  }

  /**
   * Convert Int16Array to base64 string
   */
  private int16ArrayToBase64(int16Array: Int16Array): string {
    const uint8Array = new Uint8Array(int16Array.buffer);
    let binary = "";
    const len = uint8Array.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    return btoa(binary);
  }
}
