import {
  BrowserNoiseSuppressor,
  resolveNoiseSuppressionConfig,
  type AudioRecordingPair,
  type NoiseSuppressionConfig,
} from "./noiseSuppression";
import { SessionRecordingAccumulator } from "./recordingAccumulator";
import { formatTextForTts } from "./ttsText";
import type {
  SarvamProxyConfig,
  SarvamSpeechProvider,
  SarvamSTTHandlers,
  V2SupportedLanguage,
} from "./types";

function toWs(url: string): string {
  return url.replace(/^https?/, (s) => (s === "https" ? "wss" : "ws"));
}

function toHttp(url: string): string {
  return url.replace(/^wss?/, (s) => (s === "wss" ? "https" : "http"));
}

/**
 * SarvamSpeechProvider implementation that routes all calls through a
 * developer-hosted proxy server. The Sarvam API key lives only on that
 * server — it is never sent to the browser.
 *
 * TTS uses chunked sentence streaming (same as SarvamSpeechService) so
 * low-bandwidth users hear audio quickly.
 */
export class SarvamHttpProxyProvider implements SarvamSpeechProvider {
  private language: V2SupportedLanguage;
  private readonly ttsUrl: string;
  private readonly sttWsUrl: string;
  private readonly sttModel: string;
  private readonly authToken: string;
  private readonly noiseSuppression: NoiseSuppressionConfig | false;

  // TTS state
  private audioElement: HTMLAudioElement | null = null;
  private currentBlobUrl: string | null = null;
  private speechGeneration = 0;

  // STT state
  private sttWs: WebSocket | null = null;
  private noiseSuppressor: BrowserNoiseSuppressor | null = null;
  private readonly recordingAccumulator = new SessionRecordingAccumulator();
  private listeningGeneration = 0;

  constructor(config: SarvamProxyConfig) {
    this.language = config.language;
    this.ttsUrl = toHttp(config.ttsUrl);
    this.sttWsUrl = toWs(config.sttWsUrl);
    this.sttModel = config.sttModel ?? "saarika:v2.5";
    this.authToken = config.authToken ?? "";
    this.noiseSuppression = resolveNoiseSuppressionConfig(
      config.noiseSuppression,
    );
  }

  // ── Language ────────────────────────────────────────────────────────────

  setLanguage(language: V2SupportedLanguage): void {
    if (this.language === language) return;
    this.language = language;
    if (this.sttWs || this.noiseSuppressor) void this.stopListening();
  }

  // ── TTS ─────────────────────────────────────────────────────────────────

  async speak(
    text: string,
    opts?: { language?: V2SupportedLanguage; onAudioStart?: () => void },
  ): Promise<void> {
    if (!text?.trim()) return;
    this.stopSpeaking();
    const generation = ++this.speechGeneration;
    const lang = opts?.language ?? this.language;
    const ttsText = formatTextForTts(text);

    try {
      const sentences = this.splitSentences(ttsText.trim());
      if (sentences.length === 1) {
        const buf = await this.fetchTTS(sentences[0], lang, generation);
        if (!buf || generation !== this.speechGeneration) return;
        await this.playBuffer(buf, generation, opts?.onAudioStart);
      } else {
        await this.streamTTS(sentences, lang, generation, opts?.onAudioStart);
      }
    } catch {
      if (generation !== this.speechGeneration) return;
      this.stopSpeaking();
    }
  }

  stopSpeaking(): void {
    this.speechGeneration++;
    if (this.audioElement) {
      try { this.audioElement.pause(); } catch { /* ignore */ }
      this.audioElement = null;
    }
    if (this.currentBlobUrl) {
      try { URL.revokeObjectURL(this.currentBlobUrl); } catch { /* ignore */ }
      this.currentBlobUrl = null;
    }
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) h["Authorization"] = `Bearer ${this.authToken}`;
    return h;
  }

  private async fetchTTS(
    text: string,
    language: V2SupportedLanguage,
    generation: number,
  ): Promise<ArrayBuffer | null> {
    if (generation !== this.speechGeneration) return null;

    const res = await fetch(this.ttsUrl, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        text,
        target_language_code: language,
        model: "bulbul:v3",
        speaker: "manan",
        output_audio_codec: "mp3",
        pace: 1.1,
        enable_preprocessing: true,
        speech_sample_rate: 22050,
        temperature: 0.6,
      }),
    });

    if (generation !== this.speechGeneration) return null;
    if (!res.ok) throw new Error(`Sarvam TTS proxy: ${res.status}`);

    const json = await res.json();
    if (generation !== this.speechGeneration) return null;

    const base64: string = json?.audios?.[0] ?? json?.audio ?? "";
    if (!base64) throw new Error("No audio in Sarvam TTS proxy response");

    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return generation !== this.speechGeneration ? null : bytes.buffer;
  }

  // Pipeline: fetch sentence N+1 while sentence N plays. Max 2 concurrent
  // requests — efficient for low-bandwidth connections.
  private async streamTTS(
    sentences: string[],
    language: V2SupportedLanguage,
    generation: number,
    onAudioStart?: () => void,
  ): Promise<void> {
    let nextIdx = 0;
    const fetches = new Map<number, Promise<ArrayBuffer | null>>();

    const kick = (i: number) => {
      if (i < sentences.length && !fetches.has(i)) {
        fetches.set(i, this.fetchTTS(sentences[i], language, generation));
        nextIdx = i + 1;
      }
    };

    kick(0); kick(1);

    for (let i = 0; i < sentences.length; i++) {
      if (generation !== this.speechGeneration) return;
      kick(nextIdx);
      const buf = await (fetches.get(i) ?? Promise.resolve(null));
      fetches.delete(i);
      if (!buf || generation !== this.speechGeneration) return;
      await this.playBuffer(buf, generation, i === 0 ? onAudioStart : undefined);
    }
  }

  private async playBuffer(
    buffer: ArrayBuffer,
    generation: number,
    onAudioStart?: () => void,
  ): Promise<void> {
    const blob = new Blob([buffer], { type: "audio/mp3" });
    const url = URL.createObjectURL(blob);
    this.currentBlobUrl = url;

    if (generation !== this.speechGeneration) {
      URL.revokeObjectURL(url);
      this.currentBlobUrl = null;
      return;
    }

    const audio = new Audio(url);
    this.audioElement = audio;

    await new Promise<void>((resolve, reject) => {
      audio.onended = () => {
        if (this.audioElement === audio) this.audioElement = null;
        if (this.currentBlobUrl === url) {
          URL.revokeObjectURL(url);
          this.currentBlobUrl = null;
        }
        resolve();
      };
      audio.onerror = () => reject(new Error("Audio playback error"));
      audio.play().then(() => onAudioStart?.()).catch(reject);
    });
  }

  private splitSentences(text: string): string[] {
    const ABBREV = new Set([
      "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "vs", "etc", "no", "st",
    ]);
    const words = text.replace(/\s+/g, " ").split(" ");
    const result: string[] = [];
    let cur: string[] = [];

    for (const w of words) {
      cur.push(w);
      if (cur.length < 3) continue;
      const last = w.slice(-1);
      const isEnd =
        last === "!" || last === "?" || last === "।" || last === ";" ||
        (last === "." && !ABBREV.has(w.replace(/\.+$/, "").toLowerCase()));
      if (isEnd) { result.push(cur.join(" ")); cur = []; }
    }

    if (cur.length) {
      if (cur.length <= 2 && result.length) {
        result[result.length - 1] += " " + cur.join(" ");
      } else {
        result.push(cur.join(" "));
      }
    }
    return result.length ? result : [text];
  }

  // ── STT ─────────────────────────────────────────────────────────────────

  async startListening(handlers: SarvamSTTHandlers): Promise<void> {
    if (this.sttWs || this.noiseSuppressor) await this.stopListening();
    const generation = ++this.listeningGeneration;
    const isActive = () =>
      generation === this.listeningGeneration && !!this.sttWs;

    // The proxy adds the real Sarvam API key server-side.
    const params = new URLSearchParams({
      "language-code": this.language,
      model: this.sttModel,
      input_audio_codec: "pcm_s16le",
      sample_rate: "16000",
      high_vad_sensitivity: "true",
      vad_signals: "true",
      flush_signal: "true",
    });

    const ws = new WebSocket(`${this.sttWsUrl}?${params}`);
    this.sttWs = ws;

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () =>
        reject(new Error("Sarvam STT proxy WebSocket failed to open"));
    });

    if (generation !== this.listeningGeneration) { ws.close(); return; }

    ws.onmessage = (event) => {
      if (!isActive()) return;
      try {
        const msg = JSON.parse(
          typeof event.data === "string" ? event.data : "{}",
        );
        switch (msg?.type) {
          case "speech_start":
            handlers.onSpeechStart?.();
            break;
          case "speech_end":
            try { ws.send(JSON.stringify({ type: "flush" })); } catch { /* ignore */ }
            handlers.onSpeechEnd?.();
            break;
          case "events": {
            const sig = msg.data?.signal_type;
            if (sig === "START_SPEECH") {
              handlers.onSpeechStart?.();
            } else if (sig === "END_SPEECH") {
              try { ws.send(JSON.stringify({ type: "flush" })); } catch { /* ignore */ }
              handlers.onSpeechEnd?.();
            }
            break;
          }
          case "data": {
            const t: string = msg.data?.transcript ?? "";
            if (t) { handlers.onPartial?.(t); handlers.onFinal(t); }
            break;
          }
          case "transcript": {
            const t: string = msg.text ?? "";
            if (t) { handlers.onPartial?.(t); handlers.onFinal(t); }
            break;
          }
        }
      } catch { /* ignore malformed frames */ }
    };

    ws.onerror = () => {
      if (isActive())
        handlers.onError?.(new Error("Sarvam STT proxy WebSocket error"));
    };

    ws.onclose = () => {
      if (generation === this.listeningGeneration && this.sttWs === ws)
        this.sttWs = null;
    };

    // Mic capture — audio goes to the proxy, not directly to Sarvam.
    const sup = new BrowserNoiseSuppressor({
      ...(this.noiseSuppression || { enabled: false }),
      sampleRate: 16000,
      chunkSizeSamples: 2048,
      onChunk: (pcm: Int16Array) => {
        if (!isActive() || ws.readyState !== WebSocket.OPEN) return;
        if (handlers.shouldSendAudio && !handlers.shouldSendAudio()) return;

        // Sarvam's WebSocket protocol: JSON with base64-encoded PCM.
        const u8 = new Uint8Array(pcm.buffer);
        let bin = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < u8.length; i += CHUNK) {
          bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
        }
        ws.send(
          JSON.stringify({
            audio: btoa(bin),
            encoding: "audio/wav",
            sample_rate: "16000",
            language_code: this.language,
            model: this.sttModel,
          }),
        );
      },
    });
    this.noiseSuppressor = sup;
    await sup.start();
  }

  async stopListening(): Promise<void> {
    this.listeningGeneration++;
    if (this.noiseSuppressor) {
      try {
        await this.noiseSuppressor.stop();
        this.recordingAccumulator.absorb(this.noiseSuppressor);
      } catch { /* ignore */ }
      this.noiseSuppressor = null;
    }
    if (this.sttWs) {
      try { this.sttWs.close(); } catch { /* ignore */ }
      this.sttWs = null;
    }
  }

  dispose(): void {
    this.stopSpeaking();
    void this.stopListening();
  }

  getAudioRecordings(): AudioRecordingPair | null {
    return this.recordingAccumulator.getRecordings();
  }

  resetAudioRecordingSession(): void {
    this.recordingAccumulator.reset();
  }
}
