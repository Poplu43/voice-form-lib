import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rnnoiseDestroy = vi.fn();
const loadRnnoiseMock = vi.fn(async () => new ArrayBuffer(8));

vi.mock("@sapphi-red/web-noise-suppressor", () => {
  class FakeRnnoiseWorkletNode {
    connect = vi.fn(() => this);
    disconnect = vi.fn();
    destroy = rnnoiseDestroy;
    constructor(..._args: unknown[]) {}
  }
  return {
    RnnoiseWorkletNode: FakeRnnoiseWorkletNode,
    loadRnnoise: loadRnnoiseMock,
  };
});

const sileroModelRelease = vi.fn(async () => undefined);
const sileroModelProcess = vi.fn(async () => ({ isSpeech: 0.9, notSpeech: 0.1 }));

vi.mock("@ricky0123/vad-web/dist/models/v5", () => {
  return {
    SileroV5: {
      new: vi.fn(async () => ({
        process: sileroModelProcess,
        reset_state: vi.fn(),
        release: sileroModelRelease,
      })),
    },
  };
});

vi.mock("@ricky0123/vad-web/dist/real-time-vad", () => {
  return { ort: { env: { wasm: {} } } };
});

// Imported after the mocks above so the mocked modules are wired in.
const { BrowserNoiseSuppressor, resolveNoiseSuppressionConfig } = await import(
  "../src/v2/noiseSuppression"
);

function fakeInputEvent(length: number, value: number) {
  const data = new Float32Array(length).fill(value);
  return { inputBuffer: { getChannelData: () => data } };
}

describe("resolveNoiseSuppressionConfig", () => {
  it("returns false when explicitly disabled", () => {
    expect(resolveNoiseSuppressionConfig(false)).toBe(false);
  });

  it("returns enabled:true defaults for true/undefined", () => {
    expect(resolveNoiseSuppressionConfig(true)).toEqual({ enabled: true });
    expect(resolveNoiseSuppressionConfig(undefined)).toEqual({ enabled: true });
  });

  it("passes through an object config, defaulting enabled to true", () => {
    expect(resolveNoiseSuppressionConfig({ mode: "legacy-rms" })).toEqual({
      enabled: true,
      mode: "legacy-rms",
    });
  });

  it("honors an explicit enabled:false inside an object config", () => {
    expect(resolveNoiseSuppressionConfig({ enabled: false })).toEqual({
      enabled: false,
    });
  });
});

describe("BrowserNoiseSuppressor — legacy-rms mode", () => {
  it("emits Int16 chunks once enough samples have buffered", async () => {
    const onChunk = vi.fn();
    const sup = new BrowserNoiseSuppressor({
      mode: "legacy-rms",
      chunkSizeSamples: 1024,
      sampleRate: 16000,
      onChunk,
    });
    await sup.start();

    const processor = (sup as any).processor;
    expect(processor).toBeTruthy();
    processor.onaudioprocess(fakeInputEvent(2048, 0.9));

    expect(onChunk).toHaveBeenCalled();
    const chunk = onChunk.mock.calls[0][0] as Int16Array;
    expect(chunk).toBeInstanceOf(Int16Array);
    expect(chunk.length).toBe(1024);

    await sup.stop();
  });

  it("throws if navigator.mediaDevices is unavailable", async () => {
    const original = (navigator as any).mediaDevices;
    // @ts-expect-error simulating an environment without mic access
    delete (navigator as any).mediaDevices;
    const sup = new BrowserNoiseSuppressor({
      mode: "legacy-rms",
      onChunk: vi.fn(),
    });
    await expect(sup.start()).rejects.toThrow(/mediaDevices is unavailable/);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: original,
    });
  });

  it("updates the adaptive noise floor and drops non-speech frames below threshold", async () => {
    const onChunk = vi.fn();
    const sup = new BrowserNoiseSuppressor({
      mode: "legacy-rms",
      chunkSizeSamples: 1024,
      sampleRate: 16000,
      dropNonSpeech: true,
      onChunk,
    });
    await sup.start();
    const processor = (sup as any).processor;
    // A very quiet frame stays under both minSpeechRms and the noise-floor
    // threshold, exercising the "!isSpeech" noise-floor-update branch.
    processor.onaudioprocess(fakeInputEvent(2048, 0.0001));

    const chunk = onChunk.mock.calls[0][0] as Int16Array;
    expect(chunk.every((v) => v === 0)).toBe(true);

    await sup.stop();
  });

  it("resamples when the AudioContext's native rate differs from the target rate", async () => {
    const onChunk = vi.fn();
    // The test AudioContext stub always reports sampleRate=16000 regardless
    // of constructor args, so requesting a different target rate here forces
    // the emitResampled() resampling branch (as opposed to the passthrough).
    const sup = new BrowserNoiseSuppressor({
      mode: "legacy-rms",
      chunkSizeSamples: 256,
      sampleRate: 8000,
      onChunk,
    });
    await sup.start();
    const processor = (sup as any).processor;
    processor.onaudioprocess(fakeInputEvent(2048, 0.9));
    expect(onChunk).toHaveBeenCalled();
    await sup.stop();
  });

  it("reports errors raised inside the audio-processing callback via onError", async () => {
    const onChunk = vi.fn();
    const onError = vi.fn();
    const sup = new BrowserNoiseSuppressor({
      mode: "legacy-rms",
      onChunk,
      onError,
    });
    await sup.start();
    const processor = (sup as any).processor;
    processor.onaudioprocess({
      inputBuffer: {
        getChannelData: () => {
          throw new Error("boom");
        },
      },
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
    await sup.stop();
  });

  it("resumes a suspended AudioContext after starting", async () => {
    const originalAudioContext = (globalThis as any).AudioContext;
    class SuspendedAudioContextStub extends originalAudioContext {
      state = "suspended";
      resume = vi.fn(async () => {
        this.state = "running";
      });
    }
    (globalThis as any).AudioContext = SuspendedAudioContextStub;

    const sup = new BrowserNoiseSuppressor({ mode: "legacy-rms", onChunk: vi.fn() });
    await sup.start();
    expect((sup as any).audioContext.resume).toHaveBeenCalled();
    await sup.stop();

    (globalThis as any).AudioContext = originalAudioContext;
  });
});

describe("BrowserNoiseSuppressor — rnnoise-vad mode", () => {
  beforeEach(() => {
    rnnoiseDestroy.mockClear();
    loadRnnoiseMock.mockClear();
    sileroModelProcess.mockClear();
    sileroModelRelease.mockClear();
  });

  it("wires the RNNoise + VAD graph and delivers onChunk from captured frames", async () => {
    const onChunk = vi.fn();
    const onError = vi.fn();
    const sup = new BrowserNoiseSuppressor({
      mode: "rnnoise-vad",
      chunkSizeSamples: 1024,
      sampleRate: 16000,
      onChunk,
      onError,
    });
    await sup.start();

    expect(loadRnnoiseMock).toHaveBeenCalled();

    const captureNode = (sup as any).captureNode;
    expect(captureNode).toBeTruthy();
    expect(typeof captureNode.port.onmessage).toBe("function");

    // Feed 2048 samples through the capture tap — with the test AudioContext
    // stub's sampleRate (16000) matching opts.sampleRate, the decimation
    // factor resolves to 1, so this should flow straight through to two
    // 1024-sample onChunk calls.
    const frame = new Float32Array(2048).fill(0.5);
    captureNode.port.onmessage({ data: frame } as MessageEvent<Float32Array>);

    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();

    // Let the queued VAD frame-processing microtasks flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(sileroModelProcess).toHaveBeenCalled();

    await sup.stop();
    expect(rnnoiseDestroy).toHaveBeenCalled();
    expect(sileroModelRelease).toHaveBeenCalled();
  });

  it("falls back to legacy-rms when AudioWorkletNode is unavailable", async () => {
    const original = (globalThis as any).AudioWorkletNode;
    delete (globalThis as any).AudioWorkletNode;
    const onError = vi.fn();
    const sup = new BrowserNoiseSuppressor({
      mode: "rnnoise-vad",
      onChunk: vi.fn(),
      onError,
    });
    await sup.start();
    expect(onError).toHaveBeenCalled();
    expect((sup as any).processor).toBeTruthy();
    await sup.stop();
    (globalThis as any).AudioWorkletNode = original;
  });

  it("reports decimator/capture errors via onError instead of throwing", async () => {
    const onChunk = vi.fn();
    const onError = vi.fn();
    const sup = new BrowserNoiseSuppressor({
      mode: "rnnoise-vad",
      onChunk,
      onError,
    });
    await sup.start();
    const captureNode = (sup as any).captureNode;
    const originalDecimator = (sup as any).decimator;
    (sup as any).decimator = {
      processBlock: () => {
        throw new Error("decimation failed");
      },
    };
    captureNode.port.onmessage({ data: new Float32Array(4) } as MessageEvent<Float32Array>);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "decimation failed" }),
    );
    (sup as any).decimator = originalDecimator;
    await sup.stop();
  });

  it("resumes a suspended AudioContext in rnnoise-vad mode too", async () => {
    const originalAudioContext = (globalThis as any).AudioContext;
    class SuspendedAudioContextStub extends originalAudioContext {
      state = "suspended";
      resume = vi.fn(async () => {
        this.state = "running";
      });
    }
    (globalThis as any).AudioContext = SuspendedAudioContextStub;

    const sup = new BrowserNoiseSuppressor({ mode: "rnnoise-vad", onChunk: vi.fn() });
    await sup.start();
    expect((sup as any).audioContext.resume).toHaveBeenCalled();
    await sup.stop();

    (globalThis as any).AudioContext = originalAudioContext;
  });

  it("ignores FrameProcessor events that aren't FrameProcessed and no-ops once torn down", async () => {
    const sup = new BrowserNoiseSuppressor({ mode: "rnnoise-vad", onChunk: vi.fn() });
    await sup.start();
    // Directly exercise the guard branches in handleVadEvent.
    (sup as any).handleVadEvent({ msg: "SPEECH_START" });
    (sup as any).vadGateNode = null;
    (sup as any).handleVadEvent({ msg: "FRAME_PROCESSED", probs: { isSpeech: 0.9, notSpeech: 0.1 }, frame: new Float32Array(1) });
    await sup.stop();
  });

  it("loads both the RNNoise worklet module and the shared capture-worklet module exactly once each, even with the recording tap active", async () => {
    const sup = new BrowserNoiseSuppressor({
      mode: "rnnoise-vad",
      recordAudio: true,
      onChunk: vi.fn(),
    });
    await sup.start();
    const addModule = (sup as any).audioContext.audioWorklet.addModule;
    // Two distinct worklet modules must be registered: RNNoise's own
    // compiled processor (CDN URL) and our first-party capture processor
    // (a Blob URL) — shared by both the main capture tap and the
    // raw-recording tap, so it must be registered only once despite two
    // AudioWorkletNode instances using it.
    expect(addModule).toHaveBeenCalledTimes(2);
    const calledUrls = addModule.mock.calls.map((call: unknown[]) => call[0]);
    expect(calledUrls.some((url: string) => url.includes("@sapphi-red/web-noise-suppressor"))).toBe(true);
    expect(calledUrls.some((url: string) => url.startsWith("blob:"))).toBe(true);
    await sup.stop();
  });

  it("falls back to legacy-rms if the rnnoise-vad pipeline fails to initialize", async () => {
    loadRnnoiseMock.mockRejectedValueOnce(new Error("network error"));
    const onChunk = vi.fn();
    const onError = vi.fn();
    const sup = new BrowserNoiseSuppressor({
      mode: "rnnoise-vad",
      chunkSizeSamples: 1024,
      sampleRate: 16000,
      onChunk,
      onError,
    });

    await sup.start();

    expect(onError).toHaveBeenCalled();
    // Fallback should have constructed the legacy ScriptProcessor path.
    expect((sup as any).processor).toBeTruthy();
    expect((sup as any).captureNode).toBeNull();

    await sup.stop();
  });
});

async function readWavHeader(blob: Blob) {
  // jsdom's Blob doesn't implement arrayBuffer(), and Node's Response can't
  // read jsdom's Blob internals either — FileReader is the one API jsdom
  // implements natively against its own Blob.
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
  const view = new DataView(buffer);
  const riff = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  return {
    riff,
    sampleRate: view.getUint32(24, true),
    dataSize: view.getUint32(40, true),
    byteLength: buffer.byteLength,
  };
}

describe("BrowserNoiseSuppressor — recordAudio", () => {
  it("is disabled by default: getRecordings() stays null even with samples flowing", async () => {
    const sup = new BrowserNoiseSuppressor({ mode: "legacy-rms", onChunk: vi.fn() });
    await sup.start();
    (sup as any).processor.onaudioprocess(fakeInputEvent(2048, 0.9));
    await sup.stop();
    expect(sup.getRecordings()).toBeNull();
  });

  it("captures both a raw and processed WAV recording in legacy-rms mode", async () => {
    const onRecordingsReady = vi.fn();
    const sup = new BrowserNoiseSuppressor({
      mode: "legacy-rms",
      sampleRate: 16000,
      chunkSizeSamples: 512,
      recordAudio: true,
      onChunk: vi.fn(),
      onRecordingsReady,
    });
    await sup.start();

    const recordingTapNode = (sup as any).recordingTapNode;
    expect(recordingTapNode).toBeTruthy();
    recordingTapNode.port.onmessage({ data: new Float32Array(1000).fill(0.4) });

    (sup as any).processor.onaudioprocess(fakeInputEvent(2048, 0.9));

    await sup.stop();

    expect(onRecordingsReady).toHaveBeenCalledTimes(1);
    const recordings = sup.getRecordings();
    expect(recordings).not.toBeNull();
    expect(recordings!.raw).toBeInstanceOf(Blob);
    expect(recordings!.processed).toBeInstanceOf(Blob);

    const rawHeader = await readWavHeader(recordings!.raw);
    expect(rawHeader.riff).toBe("RIFF");
    expect(rawHeader.dataSize).toBe(1000 * 2);

    const processedHeader = await readWavHeader(recordings!.processed);
    expect(processedHeader.riff).toBe("RIFF");
    expect(processedHeader.dataSize).toBe(2048 * 2);
    expect(processedHeader.sampleRate).toBe(16000);
  });

  it("connects the raw-recording tap onward to the destination so a real browser actually pulls it for processing", async () => {
    // Web Audio's rendering graph is pulled backward from `destination` — a
    // node with no path onward to it is never actually processed by a real
    // browser, regardless of what feeds into it. Firing `.onmessage`
    // manually (as the other tests here do) can't catch a tap that would
    // never receive real frames in the first place, so this test instead
    // asserts on the graph shape itself.
    const sup = new BrowserNoiseSuppressor({
      mode: "legacy-rms",
      recordAudio: true,
      onChunk: vi.fn(),
    });
    await sup.start();

    const tapNode = (sup as any).recordingTapNode;
    const audioContext = (sup as any).audioContext;
    expect(tapNode.connect).toHaveBeenCalled();
    const downstream = tapNode.connect.mock.calls[0][0];
    expect(downstream.connect).toHaveBeenCalledWith(audioContext.destination);

    await sup.stop();
  });

  it("captures both recordings in rnnoise-vad mode too", async () => {
    const onRecordingsReady = vi.fn();
    const sup = new BrowserNoiseSuppressor({
      mode: "rnnoise-vad",
      sampleRate: 16000,
      chunkSizeSamples: 512,
      recordAudio: true,
      onChunk: vi.fn(),
      onRecordingsReady,
    });
    await sup.start();

    const recordingTapNode = (sup as any).recordingTapNode;
    const captureNode = (sup as any).captureNode;
    expect(recordingTapNode).toBeTruthy();
    expect(captureNode).toBeTruthy();

    recordingTapNode.port.onmessage({ data: new Float32Array(500).fill(0.2) });
    captureNode.port.onmessage({ data: new Float32Array(512).fill(0.5) });

    await sup.stop();

    expect(onRecordingsReady).toHaveBeenCalledTimes(1);
    const recordings = sup.getRecordings();
    const rawHeader = await readWavHeader(recordings!.raw);
    expect(rawHeader.dataSize).toBe(500 * 2);
    const processedHeader = await readWavHeader(recordings!.processed);
    expect(processedHeader.dataSize).toBe(512 * 2);
  });

  it("does not throw and skips the raw tap when AudioWorkletNode is unavailable in legacy-rms + recordAudio", async () => {
    const original = (globalThis as any).AudioWorkletNode;
    delete (globalThis as any).AudioWorkletNode;
    const onError = vi.fn();
    const sup = new BrowserNoiseSuppressor({
      mode: "legacy-rms",
      recordAudio: true,
      onChunk: vi.fn(),
      onError,
    });
    await sup.start();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("AudioWorklet is unavailable") }),
    );
    expect((sup as any).recordingTapNode).toBeNull();
    (sup as any).processor.onaudioprocess(fakeInputEvent(1024, 0.9));
    await sup.stop();
    // Processed recording still works without the raw tap.
    expect(sup.getRecordings()?.processed).toBeInstanceOf(Blob);
    (globalThis as any).AudioWorkletNode = original;
  });

  it("returns null and skips onRecordingsReady when no samples were ever captured", async () => {
    const onRecordingsReady = vi.fn();
    const sup = new BrowserNoiseSuppressor({
      mode: "legacy-rms",
      recordAudio: true,
      onChunk: vi.fn(),
      onRecordingsReady,
    });
    await sup.start();
    await sup.stop();
    expect(onRecordingsReady).not.toHaveBeenCalled();
    expect(sup.getRecordings()).toBeNull();
  });
});
