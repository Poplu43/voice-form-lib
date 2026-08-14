import { RnnoiseWorkletNode,loadRnnoise,} from "@sapphi-red/web-noise-suppressor";
import { FrameProcessor, Message, defaultModelFetcher } from "@ricky0123/vad-web";
import { ort } from "@ricky0123/vad-web/dist/real-time-vad";
import { SileroV5 } from "@ricky0123/vad-web/dist/models/v5";
import type { FrameProcessorEvent } from "@ricky0123/vad-web/dist/frame-processor";
import type { VoiceNoiseSuppressionConfig } from "./types";
import { resolveNoiseSuppressionAssetUrls } from "./noiseSuppressionAssets";
import {
  CAPTURE_PROCESSOR_NAME,
  createCaptureWorkletBlobUrl,
} from "./captureWorkletSource";
import {
  Decimator,
  computeRmsAndPeak,
  computeVadTargetGain,
  encodeWavPcm16,
  float32ToInt16,
  stepGain,
} from "./noiseSuppressionDsp";

export interface NoiseSuppressionConfig {
  enabled?: boolean;
  sampleRate?: number;
  chunkSizeSamples?: number;
  highPassHz?: number;
  lowPassHz?: number;
  noiseFloorLearningRate?: number;
  speechThresholdMultiplier?: number;
  minSpeechRms?: number;
  noiseGateAttenuation?: number;
  dropNonSpeech?: boolean;
  attack?: number;
  release?: number;
  mode?: "legacy-rms" | "rnnoise-vad";
  useBrowserNoiseSuppression?: boolean;
  assetBaseUrl?: string;
  vad?: {
    positiveSpeechThreshold?: number;
    negativeSpeechThreshold?: number;
  };
  /** When true, records two parallel WAV clips for A/B quality comparison:
   *  `raw` (mic capture before this pipeline's filtering/denoising/gating)
   *  and `processed` (the actual audio sent onward to STT). Retrieve via
   *  `getRecordings()` after `stop()`, or `onRecordingsReady`. */
  recordAudio?: boolean;
}

export interface NoiseSuppressedCaptureOptions extends NoiseSuppressionConfig {
  onChunk: (samples: Int16Array) => void;
  onError?: (error: Error) => void;
  /** Fires once, after `stop()`, when `recordAudio` produced a recording. */
  onRecordingsReady?: (recordings: AudioRecordingPair) => void;
}

export interface AudioRecordingPair {
  /** Mic capture before this library's filtering/denoising/VAD gating (still
   *  subject to whatever the browser itself applies via getUserMedia
   *  constraints — echoCancellation, and useBrowserNoiseSuppression if that
   *  was requested). This is the fair "before" baseline for A/B comparison. */
  raw: Blob;
  /** The actual audio this pipeline produced and sent onward to STT. */
  processed: Blob;
}

/**
 * Shared config resolver for all three v2 speech providers (Sarvam direct,
 * Bhashini, Sarvam proxy) — previously copy-pasted in each provider.
 */
export function resolveNoiseSuppressionConfig(
  config: boolean | VoiceNoiseSuppressionConfig | undefined,
): NoiseSuppressionConfig | false {
  if (config === false) return false;
  if (config === true || config === undefined) return { enabled: true };
  return { enabled: config.enabled ?? true, ...config };
}

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_CHUNK_SIZE = 1024;
const DEFAULT_HIGH_PASS_HZ = 85;
const DEFAULT_LOW_PASS_HZ = 7400;
const DEFAULT_NOISE_FLOOR_LEARNING_RATE = 0.01;
const DEFAULT_SPEECH_THRESHOLD_MULTIPLIER = 2.4;
const DEFAULT_MIN_SPEECH_RMS = 0.006;
const DEFAULT_NOISE_GATE_ATTENUATION = 0.55;
const DEFAULT_DROP_NON_SPEECH = true;
const DEFAULT_ATTACK = 0.18;
const DEFAULT_RELEASE = 0.04;
const DEFAULT_MODE: NonNullable<NoiseSuppressionConfig["mode"]> =
  "rnnoise-vad";
const DEFAULT_USE_BROWSER_NS = true;
const DEFAULT_POSITIVE_SPEECH_THRESHOLD = 0.5;
const DEFAULT_NEGATIVE_SPEECH_THRESHOLD = 0.35;

// RNNoise operates natively at 48kHz, 480-sample (10ms) frames; Silero VAD
// (v5) operates on 512-sample (32ms) frames at 16kHz.
const VAD_FRAME_SAMPLES = 512;
const VAD_REDEMPTION_MS = 240;
const DECIMATION_LOWPASS_HZ = 7000;

type AudioContextCtor = typeof AudioContext;

export class BrowserNoiseSuppressor {
  private readonly opts: Required<
    Pick<
      NoiseSuppressedCaptureOptions,
      | "enabled"
      | "sampleRate"
      | "chunkSizeSamples"
      | "highPassHz"
      | "lowPassHz"
      | "noiseFloorLearningRate"
      | "speechThresholdMultiplier"
      | "minSpeechRms"
      | "noiseGateAttenuation"
      | "dropNonSpeech"
      | "attack"
      | "release"
      | "mode"
      | "useBrowserNoiseSuppression"
      | "recordAudio"
    >
  > &
    Pick<
      NoiseSuppressedCaptureOptions,
      "onChunk" | "onError" | "onRecordingsReady" | "assetBaseUrl" | "vad"
    >;

  private activeMode: "legacy-rms" | "rnnoise-vad" | null = null;
  private closed = false;

  // Shared across both modes.
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private silentOutput: GainNode | null = null;
  private highPass: BiquadFilterNode | null = null;
  private lowPass: BiquadFilterNode | null = null;
  private notch50: BiquadFilterNode | null = null;
  private notch60: BiquadFilterNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private pendingSamples: number[] = [];

  // legacy-rms only
  private processor: ScriptProcessorNode | null = null;
  private noiseFloor = 0.01;
  private currentGain = 1;
  private resampleRemainder = 0;

  // rnnoise-vad only
  private rnnoiseNode: RnnoiseWorkletNode | null = null;
  private vadGateNode: GainNode | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private decimator: Decimator | null = null;
  private frameProcessor: FrameProcessor | null = null;
  private sileroModel: { release: () => Promise<void> } | null = null;
  private vadFrameBuffer: number[] = [];

  // Shared capture-worklet module registration
  private captureModuleLoaded = false;

  // recordAudio only
  private recordingTapNode: AudioWorkletNode | null = null;
  private recordingTapSilentGain: GainNode | null = null;
  private rawRecordingSamples: number[] = [];
  private processedRecordingSamples: number[] = [];
  private recordingNativeSampleRate = 0;
  private lastRecordings: AudioRecordingPair | null = null;

  constructor(options: NoiseSuppressedCaptureOptions) {
    this.opts = {
      enabled: options.enabled ?? true,
      sampleRate: options.sampleRate ?? DEFAULT_SAMPLE_RATE,
      chunkSizeSamples: options.chunkSizeSamples ?? DEFAULT_CHUNK_SIZE,
      highPassHz: options.highPassHz ?? DEFAULT_HIGH_PASS_HZ,
      lowPassHz: options.lowPassHz ?? DEFAULT_LOW_PASS_HZ,
      noiseFloorLearningRate:
        options.noiseFloorLearningRate ?? DEFAULT_NOISE_FLOOR_LEARNING_RATE,
      speechThresholdMultiplier:
        options.speechThresholdMultiplier ?? DEFAULT_SPEECH_THRESHOLD_MULTIPLIER,
      minSpeechRms: options.minSpeechRms ?? DEFAULT_MIN_SPEECH_RMS,
      noiseGateAttenuation:
        options.noiseGateAttenuation ?? DEFAULT_NOISE_GATE_ATTENUATION,
      dropNonSpeech: options.dropNonSpeech ?? DEFAULT_DROP_NON_SPEECH,
      attack: options.attack ?? DEFAULT_ATTACK,
      release: options.release ?? DEFAULT_RELEASE,
      mode: options.mode ?? DEFAULT_MODE,
      useBrowserNoiseSuppression:
        options.useBrowserNoiseSuppression ?? DEFAULT_USE_BROWSER_NS,
      recordAudio: options.recordAudio ?? false,
      assetBaseUrl: options.assetBaseUrl,
      vad: options.vad,
      onChunk: options.onChunk,
      onError: options.onError,
      onRecordingsReady: options.onRecordingsReady,
    };
  }

  getRecordings(): AudioRecordingPair | null {
    return this.lastRecordings;
  }

  getRawSampleArrays(): {
    raw: Float32Array;
    processed: Float32Array;
    rawSampleRate: number;
    processedSampleRate: number;
  } | null {
    if (!this.opts.recordAudio) return null;
    if (
      this.rawRecordingSamples.length === 0 &&
      this.processedRecordingSamples.length === 0
    ) {
      return null;
    }
    return {
      raw: Float32Array.from(this.rawRecordingSamples),
      processed: Float32Array.from(this.processedRecordingSamples),
      rawSampleRate: this.recordingNativeSampleRate || this.opts.sampleRate,
      processedSampleRate: this.opts.sampleRate,
    };
  }

  async start(): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      throw new Error(
        "[BrowserNoiseSuppressor] navigator.mediaDevices is unavailable.",
      );
    }

    if (this.opts.mode === "rnnoise-vad") {
      try {
        await this.startRnnoiseVad();
        return;
      } catch (err) {
        this.opts.onError?.(
          new Error(
            `[BrowserNoiseSuppressor] rnnoise-vad pipeline failed to initialize, falling back to legacy-rms: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
        await this.teardown();
      }
    }

    await this.startLegacyRms();
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.finalizeRecordings();
    await this.teardown();
  }

  // ── legacy-rms mode ──────────────────────────────────────────────────────

  private async startLegacyRms(): Promise<void> {
    this.activeMode = "legacy-rms";
    this.resetRecordingBuffers();
    const AudioContextClass = this.resolveAudioContext();
    const audioContext = new AudioContextClass({
      sampleRate: this.opts.sampleRate,
    });
    this.audioContext = audioContext;

    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: true,
      },
    });
    this.mediaStream = mediaStream;

    const source = audioContext.createMediaStreamSource(mediaStream);
    const { input: filterInput, output: filterOutput } =
      this.buildFilterChain(audioContext);

    await this.setupRawRecordingTap(audioContext, source);

    const processor = audioContext.createScriptProcessor(2048, 1, 1);
    const silentOutput = audioContext.createGain();
    silentOutput.gain.value = 0;

    processor.onaudioprocess = (event) => {
      if (this.closed) return;
      try {
        const input = event.inputBuffer.getChannelData(0);
        const processed = this.opts.enabled
          ? this.processFrame(input)
          : Array.from(input);
        this.emitResampled(processed, audioContext.sampleRate);
      } catch (err) {
        this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    source.connect(filterInput);
    filterOutput
      .connect(processor)
      .connect(silentOutput)
      .connect(audioContext.destination);

    this.source = source;
    this.processor = processor;
    this.silentOutput = silentOutput;

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
  }

  private processFrame(input: Float32Array): number[] {
    const { rms, peak } = computeRmsAndPeak(input);
    const threshold = Math.max(
      this.opts.minSpeechRms,
      this.noiseFloor * this.opts.speechThresholdMultiplier,
    );
    const isSpeech = rms > threshold || peak > threshold * 2.4;

    if (!isSpeech) {
      this.noiseFloor =
        this.noiseFloor * (1 - this.opts.noiseFloorLearningRate) +
        rms * this.opts.noiseFloorLearningRate;
    }

    const targetGain = isSpeech ? 1 : this.opts.noiseGateAttenuation;
    const output: number[] = [];

    for (let i = 0; i < input.length; i++) {
      this.currentGain = stepGain(
        this.currentGain,
        targetGain,
        this.opts.attack,
        this.opts.release,
      );
      output.push(
        !isSpeech && this.opts.dropNonSpeech ? 0 : input[i] * this.currentGain,
      );
    }

    return output;
  }

  private emitResampled(samples: number[], inputSampleRate: number): void {
    if (inputSampleRate === this.opts.sampleRate) {
      this.appendSamples(samples);
      return;
    }

    const ratio = inputSampleRate / this.opts.sampleRate;
    const resampled: number[] = [];
    let index = this.resampleRemainder;
    while (index < samples.length) {
      const base = Math.floor(index);
      const next = Math.min(base + 1, samples.length - 1);
      const frac = index - base;
      resampled.push(samples[base] * (1 - frac) + samples[next] * frac);
      index += ratio;
    }
    this.resampleRemainder = index - samples.length;
    this.appendSamples(resampled);
  }

  // ── rnnoise-vad mode ─────────────────────────────────────────────────────

  private async startRnnoiseVad(): Promise<void> {
    if (
      typeof AudioWorkletNode === "undefined" ||
      typeof WebAssembly === "undefined"
    ) {
      throw new Error(
        "AudioWorklet/WebAssembly is unavailable in this environment",
      );
    }

    const AudioContextClass = this.resolveAudioContext();
    const audioContext = new AudioContextClass();
    this.audioContext = audioContext;
    this.resetRecordingBuffers();

    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: this.opts.useBrowserNoiseSuppression,
      },
    });
    this.mediaStream = mediaStream;

    const source = audioContext.createMediaStreamSource(mediaStream);
    const { input: filterInput, output: filterOutput } =
      this.buildFilterChain(audioContext);

    await this.setupRawRecordingTap(audioContext, source);

    const assets = resolveNoiseSuppressionAssetUrls(this.opts.assetBaseUrl);

    await audioContext.audioWorklet.addModule(assets.rnnoiseWorkletUrl);
    const wasmBinary = await loadRnnoise({
      url: assets.rnnoiseWasmUrl,
      simdUrl: assets.rnnoiseWasmSimdUrl,
    });
    const rnnoiseNode = new RnnoiseWorkletNode(audioContext, {
      maxChannels: 1,
      wasmBinary,
    });
    this.rnnoiseNode = rnnoiseNode;

    const vadGateNode = audioContext.createGain();
    vadGateNode.gain.value = 1;
    this.vadGateNode = vadGateNode;

    await this.ensureCaptureWorkletModule(audioContext);
    const captureNode = new AudioWorkletNode(
      audioContext,
      CAPTURE_PROCESSOR_NAME,
    );
    this.captureNode = captureNode;

    const silentOutput = audioContext.createGain();
    silentOutput.gain.value = 0;
    this.silentOutput = silentOutput;

    source.connect(filterInput);
    filterOutput.connect(rnnoiseNode);
    rnnoiseNode.connect(vadGateNode);
    vadGateNode.connect(captureNode);
    captureNode.connect(silentOutput);
    silentOutput.connect(audioContext.destination);

    ort.env.wasm.wasmPaths = assets.onnxWasmBasePath;
    ort.env.wasm.numThreads = 1;
    const model = await SileroV5.new(ort, () =>
      defaultModelFetcher(assets.sileroModelUrl),
    );
    this.sileroModel = model;
    this.frameProcessor = new FrameProcessor(
      model.process,
      model.reset_state,
      {
        positiveSpeechThreshold:
          this.opts.vad?.positiveSpeechThreshold ??
          DEFAULT_POSITIVE_SPEECH_THRESHOLD,
        negativeSpeechThreshold:
          this.opts.vad?.negativeSpeechThreshold ??
          DEFAULT_NEGATIVE_SPEECH_THRESHOLD,
        redemptionMs: VAD_REDEMPTION_MS,
        preSpeechPadMs: 0,
        minSpeechMs: 0,
        submitUserSpeechOnPause: false,
      },
      (VAD_FRAME_SAMPLES / 16000) * 1000,
    );
    this.frameProcessor.resume();

    this.decimator = new Decimator(
      Math.round(audioContext.sampleRate / this.opts.sampleRate) || 1,
      audioContext.sampleRate,
      DECIMATION_LOWPASS_HZ,
    );
    this.vadFrameBuffer = [];
    this.currentGain = 1;

    captureNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (this.closed || !this.decimator) return;
      try {
        const decimated = this.decimator.processBlock(event.data);
        this.appendSamples(Array.from(decimated));
        if (this.opts.enabled) this.feedVad(decimated);
      } catch (err) {
        this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    this.activeMode = "rnnoise-vad";
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
  }

  private feedVad(samples: Float32Array): void {
    if (!this.frameProcessor) return;
    for (let i = 0; i < samples.length; i++) {
      this.vadFrameBuffer.push(samples[i]);
    }
    while (this.vadFrameBuffer.length >= VAD_FRAME_SAMPLES) {
      const frame = Float32Array.from(
        this.vadFrameBuffer.splice(0, VAD_FRAME_SAMPLES),
      );
      void this.frameProcessor.process(frame, (ev) => this.handleVadEvent(ev));
    }
  }

  private handleVadEvent(event: FrameProcessorEvent): void {
    if (event.msg !== Message.FrameProcessed) return;
    if (!this.vadGateNode || !this.audioContext) return;
    const targetGain = computeVadTargetGain(
      event.probs.isSpeech,
      this.opts.vad?.positiveSpeechThreshold ??
        DEFAULT_POSITIVE_SPEECH_THRESHOLD,
      this.opts.noiseGateAttenuation,
    );
    const timeConstant =
      targetGain > this.vadGateNode.gain.value
        ? this.opts.attack
        : this.opts.release;
    this.vadGateNode.gain.setTargetAtTime(
      targetGain,
      this.audioContext.currentTime,
      timeConstant,
    );
  }

  // ── shared helpers ───────────────────────────────────────────────────────

  private buildFilterChain(audioContext: AudioContext): {
    input: BiquadFilterNode;
    output: DynamicsCompressorNode;
  } {
    const highPass = audioContext.createBiquadFilter();
    highPass.type = "highpass";
    highPass.frequency.value = this.opts.highPassHz;
    highPass.Q.value = 0.72;

    const notch50 = audioContext.createBiquadFilter();
    notch50.type = "notch";
    notch50.frequency.value = 50;
    notch50.Q.value = 18;

    const notch60 = audioContext.createBiquadFilter();
    notch60.type = "notch";
    notch60.frequency.value = 60;
    notch60.Q.value = 18;

    const lowPass = audioContext.createBiquadFilter();
    lowPass.type = "lowpass";
    lowPass.frequency.value = this.opts.lowPassHz;
    lowPass.Q.value = 0.72;

    const compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 18;
    compressor.ratio.value = 1.6;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.12;

    highPass.connect(notch50).connect(notch60).connect(lowPass).connect(compressor);

    this.highPass = highPass;
    this.notch50 = notch50;
    this.notch60 = notch60;
    this.lowPass = lowPass;
    this.compressor = compressor;

    return { input: highPass, output: compressor };
  }

  // ── recordAudio ──────────────────────────────────────────────────────────

  private resetRecordingBuffers(): void {
    this.rawRecordingSamples = [];
    this.processedRecordingSamples = [];
    this.recordingNativeSampleRate = 0;
  }

  private async ensureCaptureWorkletModule(
    audioContext: AudioContext,
  ): Promise<void> {
    if (this.captureModuleLoaded) return;
    const blobUrl = createCaptureWorkletBlobUrl();
    try {
      await audioContext.audioWorklet.addModule(blobUrl);
      this.captureModuleLoaded = true;
    } finally {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        // ignore
      }
    }
  }

  private async setupRawRecordingTap(
    audioContext: AudioContext,
    source: AudioNode,
  ): Promise<void> {
    if (!this.opts.recordAudio) return;
    this.recordingNativeSampleRate = audioContext.sampleRate;
    if (typeof AudioWorkletNode === "undefined" || !audioContext.audioWorklet) {
      this.opts.onError?.(
        new Error(
          "[BrowserNoiseSuppressor] recordAudio requested but AudioWorklet is unavailable; only the processed recording will be captured.",
        ),
      );
      return;
    }
    try {
      await this.ensureCaptureWorkletModule(audioContext);
      const tapNode = new AudioWorkletNode(audioContext, CAPTURE_PROCESSOR_NAME);
      tapNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!this.opts.recordAudio) return;
        this.rawRecordingSamples.push(...event.data);
      };
      source.connect(tapNode);
      const tapSilentGain = audioContext.createGain();
      tapSilentGain.gain.value = 0;
      tapNode.connect(tapSilentGain);
      tapSilentGain.connect(audioContext.destination);
      this.recordingTapNode = tapNode;
      this.recordingTapSilentGain = tapSilentGain;
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private finalizeRecordings(): void {
    if (!this.opts.recordAudio) return;
    if (
      this.rawRecordingSamples.length === 0 &&
      this.processedRecordingSamples.length === 0
    ) {
      return;
    }
    const rawRate = this.recordingNativeSampleRate || this.opts.sampleRate;
    const raw = new Blob(
      [encodeWavPcm16(float32ToInt16(this.rawRecordingSamples), rawRate)],
      { type: "audio/wav" },
    );
    const processed = new Blob(
      [
        encodeWavPcm16(
          float32ToInt16(this.processedRecordingSamples),
          this.opts.sampleRate,
        ),
      ],
      { type: "audio/wav" },
    );
    this.lastRecordings = { raw, processed };
    this.opts.onRecordingsReady?.(this.lastRecordings);
  }

  private appendSamples(samples: number[]): void {
    if (this.opts.recordAudio) {
      this.processedRecordingSamples.push(...samples);
    }
    this.pendingSamples.push(...samples);
    while (this.pendingSamples.length >= this.opts.chunkSizeSamples) {
      const chunk = this.pendingSamples.splice(0, this.opts.chunkSizeSamples);
      this.opts.onChunk(float32ToInt16(chunk));
    }
  }

  private async teardown(): Promise<void> {
    if (this.processor) {
      this.processor.onaudioprocess = null;
    }
    if (this.captureNode) {
      this.captureNode.port.onmessage = null;
    }
    if (this.recordingTapNode) {
      this.recordingTapNode.port.onmessage = null;
    }
    if (this.rnnoiseNode) {
      try {
        this.rnnoiseNode.destroy();
      } catch {
        // ignore
      }
    }
    if (this.sileroModel) {
      try {
        await this.sileroModel.release();
      } catch {
        // ignore
      }
    }

    for (const node of [
      this.source,
      this.highPass,
      this.notch50,
      this.notch60,
      this.lowPass,
      this.compressor,
      this.processor,
      this.rnnoiseNode,
      this.vadGateNode,
      this.captureNode,
      this.recordingTapNode,
      this.recordingTapSilentGain,
      this.silentOutput,
    ]) {
      try {
        node?.disconnect();
      } catch {
        // ignore
      }
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      this.mediaStream = null;
    }

    if (this.audioContext) {
      await this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }

    this.pendingSamples = [];
    this.vadFrameBuffer = [];
    this.source = null;
    this.processor = null;
    this.silentOutput = null;
    this.highPass = null;
    this.notch50 = null;
    this.notch60 = null;
    this.lowPass = null;
    this.compressor = null;
    this.rnnoiseNode = null;
    this.vadGateNode = null;
    this.captureNode = null;
    this.recordingTapNode = null;
    this.recordingTapSilentGain = null;
    this.decimator = null;
    this.frameProcessor = null;
    this.sileroModel = null;
    this.activeMode = null;
    this.captureModuleLoaded = false;
  }

  private resolveAudioContext(): AudioContextCtor {
    const win = window as typeof window & {
      webkitAudioContext?: AudioContextCtor;
    };
    const AudioContextClass = window.AudioContext ?? win.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("[BrowserNoiseSuppressor] Web Audio is unavailable.");
    }
    return AudioContextClass;
  }
}