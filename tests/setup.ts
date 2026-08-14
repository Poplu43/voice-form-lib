import { vi, beforeEach } from "vitest";

// jsdom does not provide AudioContext, AudioWorkletNode, or related Web Audio
// APIs; provide stubs so modules that reference them at construction/import
// time (including `class X extends AudioWorkletNode` in third-party
// packages) don't blow up.

function fakeAudioNode() {
  return {
    connect: vi.fn(function (this: unknown) {
      return arguments[0];
    }),
    disconnect: vi.fn(),
  };
}

class FakeAudioParam {
  value = 0;
  setTargetAtTime = vi.fn((target: number) => {
    this.value = target;
  });
}

if (typeof (globalThis as any).AudioWorkletNode === "undefined") {
  class FakeAudioWorkletNode {
    port = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: vi.fn() };
    connect = vi.fn(() => this);
    disconnect = vi.fn();
    constructor(..._args: unknown[]) {}
  }
  (globalThis as any).AudioWorkletNode = FakeAudioWorkletNode;
}

class FakeAudioContextStub {
  state = "running";
  destination = {};
  sampleRate = 16000;
  currentTime = 0;
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  createMediaStreamSource() {
    return fakeAudioNode();
  }
  createScriptProcessor() {
    return {
      ...fakeAudioNode(),
      onaudioprocess: null as ((e: unknown) => void) | null,
    };
  }
  createBiquadFilter() {
    return {
      ...fakeAudioNode(),
      type: "lowpass",
      frequency: new FakeAudioParam(),
      Q: new FakeAudioParam(),
    };
  }
  createDynamicsCompressor() {
    return {
      ...fakeAudioNode(),
      threshold: new FakeAudioParam(),
      knee: new FakeAudioParam(),
      ratio: new FakeAudioParam(),
      attack: new FakeAudioParam(),
      release: new FakeAudioParam(),
    };
  }
  createGain() {
    return { ...fakeAudioNode(), gain: new FakeAudioParam() };
  }
  async close() {
    this.state = "closed";
  }
  resume() {
    return Promise.resolve();
  }
}

if (typeof (globalThis as any).AudioContext === "undefined") {
  (globalThis as any).AudioContext = FakeAudioContextStub;
}
if (typeof (globalThis as any).webkitAudioContext === "undefined") {
  (globalThis as any).webkitAudioContext = FakeAudioContextStub;
}

// MediaDevices stub used by some flows
if (typeof navigator !== "undefined" && !navigator.mediaDevices) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: vi.fn() }],
      })),
    },
  });
}

// URL.createObjectURL / revokeObjectURL stubs
if (typeof URL.createObjectURL === "undefined") {
  // @ts-expect-error injecting jsdom shim
  URL.createObjectURL = vi.fn(() => "blob:fake");
}
if (typeof URL.revokeObjectURL === "undefined") {
  // @ts-expect-error injecting jsdom shim
  URL.revokeObjectURL = vi.fn();
}

// Default fetch stub - individual tests override as needed
if (typeof globalThis.fetch === "undefined") {
  // @ts-expect-error fetch shim
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    statusText: "OK",
    json: async () => ({}),
    text: async () => "",
  }));
}

beforeEach(() => {
  document.body.innerHTML = "";
});

// NOTE: do NOT call vi.restoreAllMocks() here — it would also clear the
// implementations of vi.fn() factories created in vi.mock() blocks.
// Tests that use vi.spyOn() should restore explicitly when needed.
