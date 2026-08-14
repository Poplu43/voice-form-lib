import { io, Socket } from "socket.io-client";
import { SupportedLanguage } from "./types";

export type BhashiniASRClient = Socket;

export interface BhashiniConfig {
  configEndpoint?: string; // Server-side proxy (RECOMMENDED)
  socketUrl?: string; // Direct URL (NOT recommended)
  apiKey?: string; // Direct API key (NOT recommended)
  language?: string; // e.g., "hi", "en", "ta"
  // TTS customization (all optional, library provides defaults)
  ttsGender?: "male" | "female"; // TTS voice gender
  ttsSpeed?: number; // TTS speech speed (default 1.0)
  debug?: boolean; // Enable debug logging

  // Internal fields (set by library, not user-configurable)
  audioFormat?: string;
  samplingRate?: number;
  serviceId?: string;
  ttsServiceId?: string;
  responseFrequencyInSecs?: number;
  ttsApiUrl?: string;
  ttsSamplingRate?: number;
}

export interface BhashiniCredentials {
  socketUrl: string;
  apiKey: string;
}

export interface BhashiniResponseCallback {
  (response: any, streamingStatus: any): void;
}

export class BhashiniSpeechService {
  private client: BhashiniASRClient | null = null;
  private isConnected: boolean = false;
  private config: BhashiniConfig;
  private debug: boolean;

  // Bhashini constants (not user-configurable)
  private static readonly SOCKET_URL = "wss://dhruva-api.bhashini.gov.in";
  private static readonly AUDIO_FORMAT = "wav";
  private static readonly SAMPLING_RATE = 16000;
  private static readonly RESPONSE_FREQUENCY_SECS = 2;
  private static readonly TTS_API_URL =
    "https://dhruva-api.bhashini.gov.in/services/inference/pipeline";
  private static readonly TTS_SERVICE_ID = "Bhashini/IITM/TTS";
  private static readonly TTS_SAMPLING_RATE = 48000;

  constructor(config: BhashiniConfig) {
    this.debug = config.debug ?? false;
    const mappedLanguage = this.mapLanguageCodeToBhashini(
      config.language || "hi",
    );

    // Select ASR service ID based on language
    const serviceId = this.getServiceIdForLanguage(mappedLanguage);

    this.config = {
      ...config,
      // Static Bhashini configuration
      socketUrl: config.socketUrl || BhashiniSpeechService.SOCKET_URL,
      audioFormat: BhashiniSpeechService.AUDIO_FORMAT,
      samplingRate: BhashiniSpeechService.SAMPLING_RATE,
      responseFrequencyInSecs: BhashiniSpeechService.RESPONSE_FREQUENCY_SECS,
      ttsApiUrl: BhashiniSpeechService.TTS_API_URL,
      ttsServiceId: BhashiniSpeechService.TTS_SERVICE_ID,
      ttsSamplingRate: BhashiniSpeechService.TTS_SAMPLING_RATE,
      // Language and service
      language: mappedLanguage,
      serviceId,
      // User-configurable TTS options
      ttsGender: config.ttsGender || "female",
      ttsSpeed: config.ttsSpeed || 1.0,
    };

    if (this.debug) {
      console.log(
        `[BhashiniSpeech] Initialized with language: ${mappedLanguage}, serviceId: ${serviceId}`,
      );
    }
  }

  /**
   * Map SupportedLanguage codes to Bhashini language codes
   */
  private mapLanguageCodeToBhashini(code: string): string {
    const mapping: Record<string, string> = {
      "en-US": "en",
      "hi-IN": "hi",
      en: "en",
      hi: "hi",
    };
    return mapping[code] || code;
  }

  /**
   * Get the appropriate ASR service ID based on language
   * English uses Whisper model, other languages use conformer multilingual
   */
  private getServiceIdForLanguage(language: string): string {
    if (language === "en") {
      return "ai4bharat/whisper-medium-en--gpu--t4";
    }
    return "bhashini/ai4bharat/conformer-multilingual-asr";
  }

  /**
   * Fetch credentials from server proxy or use direct config
   */
  private async fetchCredentials(): Promise<BhashiniCredentials> {
    if (this.config.configEndpoint) {
      // Fetch from server proxy (recommended)
      const response = await fetch(this.config.configEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          language: this.config.language,
          serviceId: this.config.serviceId,
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch Bhashini credentials: ${response.statusText}`,
        );
      }

      const data = await response.json();
      return {
        socketUrl: data.socketUrl,
        apiKey: data.apiKey,
      };
    } else if (this.config.socketUrl && this.config.apiKey) {
      // Use direct credentials (not recommended for production)
      return {
        socketUrl: this.config.socketUrl,
        apiKey: this.config.apiKey,
      };
    } else {
      throw new Error(
        "Either configEndpoint or both socketUrl and apiKey must be provided",
      );
    }
  }

  /**
   * Create and connect Bhashini client
   */
  async createClient(
    responseCallback: BhashiniResponseCallback,
    autoStart: boolean = true,
  ): Promise<BhashiniASRClient> {
    // Fetch credentials from server proxy
    const credentials = await this.fetchCredentials();

    // Create socket connection
    const socket = io(credentials.socketUrl, {
      transports: ["websocket", "polling"],
      auth: { authorization: credentials.apiKey },
      path: "/socket.io",
      secure: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5,
    }) as BhashiniASRClient;

    socket.connect();

    // Setup event handlers
    socket.on("connect", () => {
      if (this.debug) {
        console.log("[Bhashini] Connected to ASR service");
      }
      this.isConnected = true;
      if (autoStart) {
        socket.emit("start", this.getDefaultTaskSequence());
      }
    });

    socket.on("disconnect", (reason: string) => {
      if (this.debug) {
        console.log(`[Bhashini] Disconnected: ${reason}`);
      }
      this.isConnected = false;
    });

    socket.on("error", (error: any) => {
      if (this.debug) {
        console.error("[Bhashini] Socket error:", error);
      }
    });

    socket.on("connect_error", (error: any) => {
      if (this.debug) {
        console.error("[Bhashini] Connection error:", error);
      }
    });

    socket.on("response", (data: any, streamingStatus: any) => {
      responseCallback(data, streamingStatus);
    });

    this.client = socket;
    return this.client;
  }

  /**
   * Send audio data to Bhashini
   */
  sendAudioData(client: BhashiniASRClient, audioData: Int16Array): void {
    if (!this.isConnected) {
      if (this.debug) {
        console.warn("[Bhashini] Not connected, cannot send audio data");
      }
      return;
    }

    client.emit(
      "data",
      { audio: [{ audioContent: audioData }] },
      { responseTaskSequenceDepth: 1 },
      false, // dataComplete
      false, // stop
    );
  }

  /**
   * CRITICAL: Restart session to prevent text accumulation
   * This is required after each command to avoid Bhashini accumulating all text
   */
  restartSession(client: BhashiniASRClient): void {
    if (!this.isConnected) {
      if (this.debug) {
        console.warn("[Bhashini] Not connected, cannot restart session");
      }
      return;
    }

    if (this.debug) {
      console.log("[Bhashini] Restarting session to prevent text accumulation");
    }

    // Official Bhashini protocol for session restart
    client.emit("data", null, null, true, false); // End data, don't stop
    client.emit("data", null, null, true, true); // End data AND stop

    // Wait a bit before starting new session
    setTimeout(() => {
      if (this.isConnected) {
        client.emit("start", this.getDefaultTaskSequence());
      }
    }, 100);
  }

  /**
   * Disconnect with proper cleanup
   */
  disconnect(): void {
    if (this.client && this.isConnected) {
      if (this.debug) {
        console.log("[Bhashini] Disconnecting...");
      }

      // Properly end the session
      this.client.emit("data", null, null, true, false);
      this.client.emit("data", null, null, true, true);

      // Disconnect socket
      this.client.disconnect();
      this.client = null;
      this.isConnected = false;
    }
  }

  /**
   * Get default task sequence for ASR
   */
  getDefaultTaskSequence(): any[] {
    return [
      {
        taskType: "asr",
        config: {
          serviceId: this.config.serviceId,
          language: { sourceLanguage: this.config.language },
          samplingRate: this.config.samplingRate,
          encoding: null,
          audioFormat: this.config.audioFormat,
        },
      },
      {
        responseFrequencyInSecs: this.config.responseFrequencyInSecs,
        responseTaskSequenceDepth: 1,
      },
    ];
  }

  /**
   * Update language configuration
   */
  updateLanguage(language: string): void {
    const mappedLanguage = this.mapLanguageCodeToBhashini(language);
    this.config.language = mappedLanguage;
    this.config.serviceId = this.getServiceIdForLanguage(mappedLanguage);
    if (this.debug) {
      console.log(
        `[BhashiniSpeech] Language updated to: ${mappedLanguage}, serviceId: ${this.config.serviceId}`,
      );
    }
  }

  /**
   * Check if connected
   */
  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Synthesize speech using Bhashini TTS API
   * Returns base64-encoded audio content
   */
  async synthesizeSpeech(text: string): Promise<string> {
    if (!this.config.ttsApiUrl) {
      throw new Error("Bhashini TTS API URL not configured");
    }

    if (!this.config.apiKey) {
      throw new Error("Bhashini API key not configured");
    }

    const requestBody = {
      pipelineTasks: [
        {
          taskType: "tts",
          config: {
            language: {
              sourceLanguage: this.config.language,
            },
            serviceId: this.config.ttsServiceId,
            gender: this.config.ttsGender,
            speed: this.config.ttsSpeed,
            samplingRate: this.config.ttsSamplingRate,
          },
        },
      ],
      inputData: {
        input: [
          {
            source: text,
          },
        ],
        audio: [
          {
            audioContent: null,
          },
        ],
      },
    };

    if (this.debug) {
      console.log("[Bhashini TTS] Synthesizing speech:", text);
    }

    const response = await fetch(this.config.ttsApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.config.apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(
        `Bhashini TTS API request failed: ${response.statusText}`,
      );
    }

    const data = await response.json();

    // Extract audio content from response
    if (
      data?.pipelineResponse &&
      Array.isArray(data.pipelineResponse) &&
      data.pipelineResponse.length > 0 &&
      data.pipelineResponse[0]?.audio &&
      Array.isArray(data.pipelineResponse[0].audio) &&
      data.pipelineResponse[0].audio.length > 0 &&
      data.pipelineResponse[0].audio[0]?.audioContent
    ) {
      const audioContent = data.pipelineResponse[0].audio[0].audioContent;
      if (this.debug) {
        console.log("[Bhashini TTS] Speech synthesis successful");
      }
      return audioContent;
    }

    throw new Error("Bhashini TTS API returned invalid response format");
  }
}
