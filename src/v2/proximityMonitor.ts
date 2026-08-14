// Live glue between the microphone and ProximityStreamDetector.
//
// The detector (proximityDetector.ts) is pure and knows nothing about audio
// hardware — it just eats fixed-size 16 kHz hop blocks. This module supplies
// them from a real mic, reusing the library's own first-party capture worklet
// (captureWorkletSource.ts) rather than the deprecated ScriptProcessorNode.
//
// Chain: getUserMedia → AudioWorklet frames (native rate, e.g. 48 kHz)
//        → StreamingLinearResampler → 16 kHz → HopAccumulator (250 ms hops)
//        → ProximityStreamDetector.pushHop → phrase events.
//
// NOTE on capture constraints: proximity lives in the *raw* reverberant tail
// of the signal, so this requests the mic with echo cancellation, browser
// noise suppression, and auto-gain all OFF. Those DSP stages each flatten the
// exact cue we measure — auto-gain in particular destroys envelope-modulation
// depth. This is the "fork the raw signal" point from the architecture note.

import {
  CAPTURE_PROCESSOR_NAME,
  createCaptureWorkletBlobUrl,
} from "./captureWorkletSource";
import {
  ProximityStreamDetector,
  PROXIMITY_HOP_SAMPLES,
  PROXIMITY_SAMPLE_RATE,
  PROXIMITY_SPEECH_RMS_THRESHOLD,
  blockRms,
  type ProximityPhrase,
} from "./proximityDetector";

/**
 * Stateful linear resampler for a streamed sequence of blocks. Correct across
 * block boundaries (keeps a fractional read cursor and a rolling buffer), so
 * it can be fed audio-callback-sized chunks. Pure and dependency-free for unit
 * testing. When srcRate === dstRate it is an effective passthrough.
 */
export class StreamingLinearResampler {
  private buf: number[] = [];
  private readPos = 0; // fractional index into `buf`
  private readonly step: number;

  constructor(srcRate: number, dstRate: number) {
    if (srcRate <= 0 || dstRate <= 0) {
      throw new Error("[StreamingLinearResampler] rates must be positive");
    }
    this.step = srcRate / dstRate;
  }

  process(block: Float32Array): Float32Array {
    for (let i = 0; i < block.length; i++) this.buf.push(block[i]);

    const out: number[] = [];
    // Need buf[floor(readPos)] and its successor to interpolate.
    while (Math.floor(this.readPos) + 1 < this.buf.length) {
      const i0 = Math.floor(this.readPos);
      const frac = this.readPos - i0;
      out.push(this.buf[i0] * (1 - frac) + this.buf[i0 + 1] * frac);
      this.readPos += this.step;
    }

    // Discard samples we've fully moved past, keeping readPos's fractional part.
    const drop = Math.floor(this.readPos);
    if (drop > 0) {
      this.buf.splice(0, drop);
      this.readPos -= drop;
    }
    return Float32Array.from(out);
  }
}

/**
 * Buffers a stream of variable-length blocks and emits them re-chunked into
 * exact `hopSize` blocks. Leftover samples are retained for the next push.
 */
export class HopAccumulator {
  private buf: number[] = [];

  constructor(private readonly hopSize: number) {
    if (hopSize < 1 || !Number.isInteger(hopSize)) {
      throw new Error("[HopAccumulator] hopSize must be a positive integer");
    }
  }

  push(samples: Float32Array): Float32Array[] {
    for (let i = 0; i < samples.length; i++) this.buf.push(samples[i]);
    const hops: Float32Array[] = [];
    while (this.buf.length >= this.hopSize) {
      hops.push(Float32Array.from(this.buf.slice(0, this.hopSize)));
      this.buf = this.buf.slice(this.hopSize);
    }
    return hops;
  }
}

/** Per-hop reading for a live meter. Distance is intentionally NOT here — it's
 * a per-phrase aggregate, not a per-frame value (see proximityDetector.ts). */
export interface ProximityHopReading {
  rms: number;
  speaking: boolean;
}

export interface ProximityMonitorOptions {
  /** Reuse an existing capture stream instead of calling getUserMedia. */
  stream?: MediaStream;
  /** Fires ~every 250 ms with the live RMS / speaking state. */
  onHop?: (reading: ProximityHopReading) => void;
  /** Fires when a phrase ends on silence, with the aggregated proximity data. */
  onPhrase?: (phrase: ProximityPhrase) => void;
  onError?: (err: Error) => void;
}

export interface ProximityMonitor {
  /** The sample rate the AudioContext actually gave us (before resampling). */
  readonly captureSampleRate: number;
  stop: () => Promise<void>;
}

/**
 * Start listening. Resolves once the mic + audio graph are live; audio then
 * flows through the callbacks until you call `stop()`.
 */
export async function startProximityMonitor(
  options: ProximityMonitorOptions = {},
): Promise<ProximityMonitor> {
  const ownsStream = !options.stream;
  const stream =
    options.stream ??
    (await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    }));

  // Ask for a 16 kHz context so no resampling is needed on the common path.
  const AudioCtx: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  const audioContext = new AudioCtx({ sampleRate: PROXIMITY_SAMPLE_RATE });
  const captureSampleRate = audioContext.sampleRate;

  const blobUrl = createCaptureWorkletBlobUrl();
  await audioContext.audioWorklet.addModule(blobUrl);

  const source = audioContext.createMediaStreamSource(stream);
  const captureNode = new AudioWorkletNode(
    audioContext,
    CAPTURE_PROCESSOR_NAME,
  );

  const resampler = new StreamingLinearResampler(
    captureSampleRate,
    PROXIMITY_SAMPLE_RATE,
  );
  const accumulator = new HopAccumulator(PROXIMITY_HOP_SAMPLES);
  const detector = new ProximityStreamDetector((phrase) =>
    options.onPhrase?.(phrase),
  );

  captureNode.port.onmessage = (event: MessageEvent) => {
    try {
      const native = event.data as Float32Array;
      const resampled = resampler.process(native);
      for (const hop of accumulator.push(resampled)) {
        const rms = blockRms(hop);
        options.onHop?.({
          rms,
          speaking: rms > PROXIMITY_SPEECH_RMS_THRESHOLD,
        });
        detector.pushHop(hop);
      }
    } catch (err) {
      options.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  // The processor never writes to its output, so connecting to destination is
  // silent — it exists only to keep the graph pulling audio through the node.
  source.connect(captureNode);
  captureNode.connect(audioContext.destination);

  return {
    captureSampleRate,
    stop: async () => {
      try {
        captureNode.port.onmessage = null;
        detector.flush();
        source.disconnect();
        captureNode.disconnect();
        await audioContext.close();
      } finally {
        URL.revokeObjectURL(blobUrl);
        if (ownsStream) {
          for (const track of stream.getTracks()) track.stop();
        }
      }
    },
  };
}
