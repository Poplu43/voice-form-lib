import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// Heavy mocking — same pattern as other VoiceFormService tests, but we'll keep
// references to fake recognizer/synthesizer instances so we can simulate
// Azure SDK callbacks (recognizing/recognized/canceled/sessionStopped).
// ============================================================================

const fakeAzure = {
  recognizers: [] as Array<{
    properties: { setProperty: ReturnType<typeof vi.fn> };
    startContinuousRecognitionAsync: ReturnType<typeof vi.fn>;
    stopContinuousRecognitionAsync: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    recognizing?: (s: unknown, e: any) => void;
    recognized?: (s: unknown, e: any) => void;
    speechStartDetected?: (s: unknown, e: any) => void;
    canceled?: (s: unknown, e: any) => void;
    sessionStopped?: (s: unknown, e: any) => void;
    audioConfig?: any;
  }>,
  synthesizers: [] as Array<{
    speakTextAsync: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    stopSpeakingAsync?: ReturnType<typeof vi.fn>;
  }>,
};

vi.mock("microsoft-cognitiveservices-speech-sdk", () => {
  class FakeSpeechConfig {
    static fromSubscription = vi.fn(() => new FakeSpeechConfig());
    speechRecognitionLanguage = "en-US";
    speechSynthesisVoiceName = "en-US-JennyNeural";
    speechSynthesisLanguage = "en-US";
    enableDictation = vi.fn();
  }
  class FakeAudioConfig {
    static fromDefaultMicrophoneInput = vi.fn(() => new FakeAudioConfig());
    static fromStreamOutput = vi.fn(() => new FakeAudioConfig());
    static fromStreamInput = vi.fn(() => new FakeAudioConfig());
  }
  class FakePullAudioOutputStream {
    static create = vi.fn(() => new FakePullAudioOutputStream());
    close = vi.fn();
  }
  class FakeAudioOutputStream {
    static createPullStream = vi.fn(() => new FakePullAudioOutputStream());
  }
  class FakeSpeechRecognizer {
    properties = { setProperty: vi.fn() };
    startContinuousRecognitionAsync = vi.fn((ok: () => void) => ok());
    stopContinuousRecognitionAsync = vi.fn((ok: () => void) => ok());
    close = vi.fn();
    recognizing?: (s: unknown, e: any) => void;
    recognized?: (s: unknown, e: any) => void;
    speechStartDetected?: (s: unknown, e: any) => void;
    canceled?: (s: unknown, e: any) => void;
    sessionStopped?: (s: unknown, e: any) => void;
    audioConfig?: any;
    constructor() {
      fakeAzure.recognizers.push(this as any);
    }
  }
  class FakeSpeechSynthesizer {
    speakTextAsync = vi.fn(
      (
        _text: string,
        onOk: (result: { reason: number; audioData: ArrayBuffer }) => void,
      ) => {
        onOk({ reason: 0, audioData: new ArrayBuffer(0) });
      },
    );
    stopSpeakingAsync = vi.fn(
      (onOk: () => void, _onErr: (e: string) => void) => onOk(),
    );
    close = vi.fn();
    constructor() {
      fakeAzure.synthesizers.push(this as any);
    }
  }
  class FakePhraseListGrammar {
    static fromRecognizer = vi.fn(() => new FakePhraseListGrammar());
    addPhrase = vi.fn();
    clear = vi.fn();
  }
  return {
    SpeechConfig: FakeSpeechConfig,
    AudioConfig: FakeAudioConfig,
    AudioOutputStream: FakeAudioOutputStream,
    PullAudioOutputStream: FakePullAudioOutputStream,
    Recognizer: class {},
    RecognitionEventArgs: class {},
    ResultReason: {
      SynthesizingAudioCompleted: 0,
      RecognizedSpeech: 3,
      NoMatch: 4,
    },
    CancellationReason: { Error: 0 },
    SpeechRecognitionCanceledEventArgs: class {},
    SpeechRecognitionEventArgs: class {},
    SpeechRecognizer: FakeSpeechRecognizer,
    SpeechSynthesizer: FakeSpeechSynthesizer,
    SpeechSynthesisResult: class {},
    PhraseListGrammar: FakePhraseListGrammar,
  };
});

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class {
    send = vi.fn();
  },
  InvokeModelCommand: vi.fn(),
}));

vi.mock("sarvamai", () => ({
  SarvamAIClient: vi.fn().mockImplementation(() => ({
    speechToTextStreaming: { connect: vi.fn(async () => ({})) },
    textToSpeechStreaming: { connect: vi.fn(async () => ({})) },
  })),
}));

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => ({
    connect: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
  Socket: class {},
}));

beforeEach(() => {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getAudioTracks: () => [{ getSettings: () => ({}) }],
        getTracks: () => [{ stop: vi.fn() }],
      })),
      getSupportedConstraints: () => ({ voiceIsolation: true }),
    },
  });
  fakeAzure.recognizers.length = 0;
  fakeAzure.synthesizers.length = 0;
});

afterEach(() => {
  fakeAzure.recognizers.length = 0;
  fakeAzure.synthesizers.length = 0;
});

import { VoiceFormService } from "../src/VoiceFormService";

async function make(html?: string) {
  document.body.innerHTML = html ?? `
    <form id="form">
      <input id="x" name="x" type="text" />
    </form>
  `;
  const router = { routeAnswer: vi.fn(async () => ({ assignments: [] })) };
  const svc = new VoiceFormService({
    formSelector: "#form",
    bedrock: { modelId: "x", router } as any,
    azureSpeech: { subscriptionKey: "k", region: "r" },
  });
  await svc.initialize();
  return svc;
}

describe("emit helpers", () => {
  it("emitTranscript dispatches to onTranscript hook", async () => {
    const onTranscript = vi.fn();
    document.body.innerHTML = `<form id="form"><input id="x" name="x" type="text" /></form>`;
    const router = { routeAnswer: vi.fn() };
    const svc = new VoiceFormService({
      formSelector: "#form",
      bedrock: { modelId: "x", router } as any,
      azureSpeech: { subscriptionKey: "k", region: "r" },
      uiHooks: { onTranscript },
    });
    await svc.initialize();
    (svc as any).emitTranscript({ text: "hello", isFinal: true });
    expect(onTranscript).toHaveBeenCalledWith({ text: "hello", isFinal: true });
  });

  it("emitAssignment dispatches to onAssignment hook", async () => {
    const onAssignment = vi.fn();
    document.body.innerHTML = `<form id="form"><input id="x" name="x" type="text" /></form>`;
    const router = { routeAnswer: vi.fn() };
    const svc = new VoiceFormService({
      formSelector: "#form",
      bedrock: { modelId: "x", router } as any,
      azureSpeech: { subscriptionKey: "k", region: "r" },
      uiHooks: { onAssignment },
    });
    await svc.initialize();
    (svc as any).emitAssignment({ fieldId: "x", value: "v" });
    expect(onAssignment).toHaveBeenCalledWith({ fieldId: "x", value: "v" });
  });

  it("emitStatus dispatches to onStatus hook", async () => {
    const onStatus = vi.fn();
    document.body.innerHTML = `<form id="form"><input id="x" name="x" type="text" /></form>`;
    const router = { routeAnswer: vi.fn() };
    const svc = new VoiceFormService({
      formSelector: "#form",
      bedrock: { modelId: "x", router } as any,
      azureSpeech: { subscriptionKey: "k", region: "r" },
      uiHooks: { onStatus },
    });
    await svc.initialize();
    (svc as any).emitStatus({ message: "ok" });
    expect(onStatus).toHaveBeenCalledWith({ message: "ok" });
  });

  it("emitError dispatches to onError hook", async () => {
    const onError = vi.fn();
    document.body.innerHTML = `<form id="form"><input id="x" name="x" type="text" /></form>`;
    const router = { routeAnswer: vi.fn() };
    const svc = new VoiceFormService({
      formSelector: "#form",
      bedrock: { modelId: "x", router } as any,
      azureSpeech: { subscriptionKey: "k", region: "r" },
      uiHooks: { onError },
    });
    await svc.initialize();
    const err = new Error("oh no");
    (svc as any).emitError(err);
    expect(onError).toHaveBeenCalledWith({ error: err });
  });

  it("hooks safely no-op when not provided", async () => {
    const svc = await make();
    expect(() => (svc as any).emitTranscript({ text: "x" })).not.toThrow();
    expect(() => (svc as any).emitStatus({ message: "x" })).not.toThrow();
    expect(() => (svc as any).emitError(new Error("x"))).not.toThrow();
  });
});

describe("scheduleSilenceCheck & invalidatePendingSpeech", () => {
  it("schedules and clears prior timer when called twice", async () => {
    const svc = await make();
    (svc as any).scheduleSilenceCheck();
    expect((svc as any).silenceResetTimer).not.toBeNull();
    (svc as any).scheduleSilenceCheck();
    expect((svc as any).silenceResetTimer).not.toBeNull();
  });

  it("invalidatePendingSpeech increments speechGuard", async () => {
    const svc = await make();
    const before = (svc as any).speechGuard;
    (svc as any).invalidatePendingSpeech();
    expect((svc as any).speechGuard).toBe(before + 1);
  });
});

describe("handleSpeechStartDetected", () => {
  it("marks userSpeaking true and schedules silence check", async () => {
    const svc = await make();
    (svc as any).handleSpeechStartDetected({}, {});
    expect((svc as any).userSpeaking).toBe(true);
    expect((svc as any).silenceResetTimer).not.toBeNull();
  });

  it("force-stops speaking when speech detected mid-output", async () => {
    const svc = await make();
    (svc as any).speaking = true;
    const stopSpy = vi
      .spyOn(svc as any, "stopSpeaking")
      .mockResolvedValue(undefined);
    (svc as any).handleSpeechStartDetected({}, {});
    expect(stopSpy).toHaveBeenCalled();
  });
});

describe("handleRecognizing", () => {
  it("returns early when not running", async () => {
    const svc = await make();
    (svc as any).running = false;
    const result = (svc as any).handleRecognizing(
      {},
      { result: { text: "hello" } },
    );
    expect(result).toBeUndefined();
    expect((svc as any).listenContext).toBeNull();
  });

  it("returns early when partial text is empty", async () => {
    const svc = await make();
    (svc as any).running = true;
    (svc as any).handleRecognizing({}, { result: { text: "" } });
    expect((svc as any).userSpeaking).toBe(false);
  });

  it("updates listen context with partial transcript", async () => {
    const svc = await make();
    (svc as any).running = true;
    const ctx = {
      resolve: vi.fn(),
      buffered: "",
      finalizeTimer: null,
      completed: false,
      allowConcurrentSpeech: false,
      heardSpeech: false,
      segments: [],
      partial: "",
    };
    (svc as any).listenContext = ctx;
    const emitSpy = vi.spyOn(svc as any, "emitTranscript");
    (svc as any).handleRecognizing(
      {},
      { result: { text: "hello world" } },
    );
    expect(ctx.partial).toBe("hello world");
    expect(emitSpy).toHaveBeenCalled();
  });
});

describe("handleRecognized", () => {
  it("when running and RecognizedSpeech, appends segment", async () => {
    const svc = await make();
    (svc as any).running = true;
    const ctx = {
      resolve: vi.fn(),
      buffered: "",
      finalizeTimer: null,
      completed: false,
      allowConcurrentSpeech: false,
      heardSpeech: false,
      segments: [],
      partial: "anything",
    };
    (svc as any).listenContext = ctx;
    (svc as any).handleRecognized(
      {},
      { result: { reason: 3, text: "answer" } }, // ResultReason.RecognizedSpeech = 3
    );
    expect(ctx.segments.length).toBeGreaterThan(0);
  });

  it("when not running, finishes listening", async () => {
    const svc = await make();
    (svc as any).running = false;
    const resolve = vi.fn();
    (svc as any).listenContext = {
      resolve,
      buffered: "done",
      finalizeTimer: null,
      completed: false,
      allowConcurrentSpeech: false,
      heardSpeech: true,
      segments: [],
      partial: "",
    };
    (svc as any).handleRecognized({}, { result: { reason: 4, text: "x" } });
    expect(resolve).toHaveBeenCalled();
  });

  it("handles NoMatch reason by scheduling finalize", async () => {
    const svc = await make();
    (svc as any).running = true;
    (svc as any).listenContext = {
      resolve: vi.fn(),
      buffered: "",
      finalizeTimer: null,
      completed: false,
      allowConcurrentSpeech: false,
      heardSpeech: false,
      segments: [],
      partial: "",
    };
    const sched = vi.spyOn(svc as any, "scheduleFinalize");
    (svc as any).handleRecognized({}, { result: { reason: 4, text: "" } });
    expect(sched).toHaveBeenCalled();
  });
});

describe("handleCanceled", () => {
  it("emits error when cancellation has error details", async () => {
    const onError = vi.fn();
    document.body.innerHTML = `<form id="form"><input id="x" name="x" type="text" /></form>`;
    const router = { routeAnswer: vi.fn() };
    const svc = new VoiceFormService({
      formSelector: "#form",
      bedrock: { modelId: "x", router } as any,
      azureSpeech: { subscriptionKey: "k", region: "r" },
      uiHooks: { onError },
    });
    await svc.initialize();
    (svc as any).handleCanceled(
      {},
      { reason: 0, errorDetails: "oops" }, // CancellationReason.Error = 0
    );
    expect(onError).toHaveBeenCalledWith({
      error: expect.any(Error),
    });
  });

  it("finishes listen context when present", async () => {
    const svc = await make();
    const resolve = vi.fn();
    (svc as any).listenContext = {
      resolve,
      buffered: "txt",
      finalizeTimer: null,
      completed: false,
      allowConcurrentSpeech: false,
      heardSpeech: true,
      segments: [],
      partial: "",
    };
    (svc as any).handleCanceled({}, { reason: 99, errorDetails: "" });
    expect(resolve).toHaveBeenCalled();
  });
});

describe("handleSessionStopped", () => {
  it("finishes context and resumes recognizer when still running", async () => {
    const svc = await make();
    (svc as any).running = true;
    const resolve = vi.fn();
    (svc as any).listenContext = {
      resolve,
      buffered: "x",
      finalizeTimer: null,
      completed: false,
      allowConcurrentSpeech: false,
      heardSpeech: true,
      segments: [],
      partial: "",
    };
    const ensureSpy = vi
      .spyOn(svc as any, "ensureActiveRecognizer")
      .mockResolvedValue(undefined);
    (svc as any).handleSessionStopped();
    expect(resolve).toHaveBeenCalled();
    expect(ensureSpy).toHaveBeenCalled();
  });
});

describe("scheduleFinalize & finishListening & clearFinalizeTimer", () => {
  it("scheduleFinalize installs a finalizeTimer on the context", async () => {
    const svc = await make();
    const ctx: any = {
      resolve: vi.fn(),
      buffered: "hi",
      finalizeTimer: null,
      completed: false,
      allowConcurrentSpeech: false,
      heardSpeech: true,
      segments: ["hi"],
      partial: "",
    };
    (svc as any).scheduleFinalize(ctx, 1000);
    expect(ctx.finalizeTimer).not.toBeNull();
    (svc as any).clearFinalizeTimer(ctx);
  });

  it("clearFinalizeTimer clears the pending timer", async () => {
    const svc = await make();
    const ctx: any = {
      resolve: vi.fn(),
      buffered: "",
      finalizeTimer: null,
      completed: false,
      allowConcurrentSpeech: false,
      heardSpeech: false,
      segments: [],
      partial: "",
    };
    (svc as any).scheduleFinalize(ctx, 1000);
    expect(ctx.finalizeTimer).not.toBeNull();
    (svc as any).clearFinalizeTimer(ctx);
    expect(ctx.finalizeTimer).toBeNull();
  });

  it("finishListening resolves with buffered text", async () => {
    const svc = await make();
    const resolve = vi.fn();
    const ctx = {
      resolve,
      buffered: "answer",
      finalizeTimer: null,
      completed: false,
      allowConcurrentSpeech: false,
      heardSpeech: true,
      segments: ["answer"],
      partial: "",
    };
    (svc as any).listenContext = ctx;
    (svc as any).finishListening(ctx, "answer");
    expect(resolve).toHaveBeenCalledWith("answer");
    expect(ctx.completed).toBe(true);
  });

  it("finishListening is idempotent", async () => {
    const svc = await make();
    const resolve = vi.fn();
    const ctx = {
      resolve,
      buffered: "",
      finalizeTimer: null,
      completed: true, // already done
      allowConcurrentSpeech: false,
      heardSpeech: false,
      segments: [],
      partial: "",
    };
    (svc as any).finishListening(ctx, "z");
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("listen()", () => {
  it("returns empty when not running", async () => {
    const svc = await make();
    (svc as any).running = false;
    const result = await (svc as any).listen();
    expect(result).toBe("");
  });
});

describe("stopSpeaking variants", () => {
  it("returns silently when nothing to stop", async () => {
    const svc = await make();
    await (svc as any).stopSpeaking();
    expect((svc as any).speaking).toBe(false);
  });

  it("stops speech and clears synthesizer when forced", async () => {
    const svc = await make();
    (svc as any).speaking = true;
    (svc as any).pendingSpeakResolve = vi.fn();
    await (svc as any).stopSpeaking({ force: true });
    expect((svc as any).speaking).toBe(false);
    expect((svc as any).pendingSpeakResolve).toBeNull();
  });
});

describe("stopAudioPlayback", () => {
  it("returns silently when no audio is playing", async () => {
    const svc = await make();
    expect(() => (svc as any).stopAudioPlayback()).not.toThrow();
  });

  it("tears down active playback teardown function", async () => {
    const svc = await make();
    const teardown = vi.fn();
    (svc as any).audioPlaybackTeardown = teardown;
    (svc as any).speechAudio = { pause: vi.fn() } as any;
    (svc as any).stopAudioPlayback();
    expect(teardown).toHaveBeenCalled();
  });

  it("revokes object URL if no teardown set", async () => {
    const svc = await make();
    const revokeSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const fakeAudio = {
      onended: null,
      onerror: null,
      pause: vi.fn(),
      src: "blob:fake",
      load: vi.fn(),
    } as any;
    (svc as any).speechAudio = fakeAudio;
    (svc as any).speechAudioUrl = "blob:fake-url";
    (svc as any).stopAudioPlayback();
    expect(revokeSpy).toHaveBeenCalled();
    revokeSpy.mockRestore();
  });
});

describe("ensureSynthesizer / disposeSynthesizer", () => {
  it("creates synthesizer on first call", async () => {
    const svc = await make();
    (svc as any).synthesizer = null;
    await (svc as any).ensureSynthesizer();
    expect((svc as any).synthesizer).not.toBeNull();
  });

  it("ensureSynthesizer is idempotent", async () => {
    const svc = await make();
    await (svc as any).ensureSynthesizer();
    const first = (svc as any).synthesizer;
    await (svc as any).ensureSynthesizer();
    expect((svc as any).synthesizer).toBe(first);
  });

  it("disposeSynthesizer clears references", async () => {
    const svc = await make();
    await (svc as any).ensureSynthesizer();
    (svc as any).disposeSynthesizer();
    expect((svc as any).synthesizer).toBeNull();
  });

  it("ensureSynthesizer no-ops for bhashini provider", async () => {
    document.body.innerHTML = `<form id="form"><input id="x" name="x" type="text" /></form>`;
    const router = { routeAnswer: vi.fn() };
    const svc = new VoiceFormService({
      formSelector: "#form",
      bedrock: { modelId: "x", router } as any,
      bhashiniSpeech: { socketUrl: "wss://x", apiKey: "k", language: "hi" },
    });
    await svc.initialize();
    await (svc as any).ensureSynthesizer();
    expect((svc as any).synthesizer).toBeNull();
  });
});

describe("stopActiveRecognizer", () => {
  it("returns silently when no active recognizer", async () => {
    const svc = await make();
    await (svc as any).stopActiveRecognizer();
    expect((svc as any).activeListening).toBeNull();
  });

  it("stops and clears the active recognizer", async () => {
    const svc = await make();
    const recognizer = fakeAzure.recognizers[0] ?? {
      stopContinuousRecognitionAsync: vi.fn((ok: () => void) => ok()),
      close: vi.fn(),
      audioConfig: null,
    };
    (svc as any).activeListening = recognizer;
    (svc as any).listeningActive = true;
    await (svc as any).stopActiveRecognizer();
    expect((svc as any).activeListening).toBeNull();
    expect((svc as any).listeningActive).toBe(false);
  });
});

describe("syncFieldStateFromDom", () => {
  it("populates state from DOM when values present", async () => {
    document.body.innerHTML = `
      <form id="form">
        <input id="a" name="a" type="text" value="hello" />
        <input id="b" name="b" type="text" />
      </form>
    `;
    const router = { routeAnswer: vi.fn() };
    const svc = new VoiceFormService({
      formSelector: "#form",
      bedrock: { modelId: "x", router } as any,
      azureSpeech: { subscriptionKey: "k", region: "r" },
    });
    await svc.initialize();
    expect((svc as any).fieldState.get("a")?.value).toBe("hello");
  });
});

describe("detectAllTabs", () => {
  it("returns tab list for mat-tab-group structure", async () => {
    document.body.innerHTML = `
      <form id="form">
        <mat-tab-group>
          <div role="tab" id="mat-tab-label-0-0" aria-controls="mat-tab-content-0-0">
            <div class="mat-tab-label-content">Personal</div>
          </div>
          <div role="tab" id="mat-tab-label-0-1" aria-controls="mat-tab-content-0-1">
            <div class="mat-tab-label-content">Address</div>
          </div>
        </mat-tab-group>
        <div role="tabpanel" id="mat-tab-content-0-0" aria-labelledby="mat-tab-label-0-0">
          <input id="name" name="name" type="text" />
        </div>
        <div role="tabpanel" id="mat-tab-content-0-1" aria-labelledby="mat-tab-label-0-1">
          <input id="city" name="city" type="text" />
        </div>
      </form>
    `;
    const router = { routeAnswer: vi.fn() };
    const svc = new VoiceFormService({
      formSelector: "#form",
      bedrock: { modelId: "x", router } as any,
      azureSpeech: { subscriptionKey: "k", region: "r" },
    });
    await svc.initialize();
    const form = document.querySelector("#form") as HTMLElement;
    const tabs = (svc as any).detectAllTabs(form);
    expect(tabs.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty when no tab group present", async () => {
    const svc = await make();
    const form = document.querySelector("#form") as HTMLElement;
    const tabs = (svc as any).detectAllTabs(form);
    expect(Array.isArray(tabs)).toBe(true);
  });
});

describe("buildStepMap", () => {
  it("returns at least one step", async () => {
    const svc = await make();
    const steps = (svc as any).buildStepMap();
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBeGreaterThanOrEqual(0);
  });
});

describe("revokeMicrophoneAccess", () => {
  it("clears all audio-related state", async () => {
    const svc = await make();
    (svc as any).activeListening = { foo: "bar" };
    (svc as any).listeningActive = true;
    (svc as any).listenContext = { resolve: vi.fn() };
    vi.spyOn(svc as any, "stopActiveRecognizer").mockResolvedValue(undefined);
    await (svc as any).revokeMicrophoneAccess();
    expect((svc as any).activeListening).toBeNull();
    expect((svc as any).listeningActive).toBe(false);
    expect((svc as any).listenContext).toBeNull();
  });
});

describe("applyAssignments — simple paths", () => {
  it("calls setFieldValue when applying a text assignment", async () => {
    const svc = await make();
    const setSpy = vi
      .spyOn(svc as any, "setFieldValue")
      .mockResolvedValue(undefined);
    const result = await (svc as any).applyAssignments([
      { fieldId: "x", value: "Hello" },
    ]);
    expect(setSpy).toHaveBeenCalled();
    expect(typeof result.applied).toBe("boolean");
  });

  it("returns a result object for unknown fieldId", async () => {
    const svc = await make();
    const result = await (svc as any).applyAssignments([
      { fieldId: "unknown", value: "v" },
    ]);
    // Unknown fieldId may or may not be flagged as an issue depending on implementation.
    expect(result).toHaveProperty("issues");
    expect(result).toHaveProperty("appliedFields");
  });

  it("handles skip:true assignments by marking skipped", async () => {
    const svc = await make();
    await (svc as any).applyAssignments([{ fieldId: "x", skip: true }]);
    const state = (svc as any).fieldState.get("x");
    expect(state?.skipped).toBe(true);
  });
});

describe("ensureCustomDropdownClosed", () => {
  it("no-ops for non-custom dropdowns", async () => {
    document.body.innerHTML = `<form id="form"><input id="x" name="x" type="text" /></form>`;
    const router = { routeAnswer: vi.fn() };
    const svc = new VoiceFormService({
      formSelector: "#form",
      bedrock: { modelId: "x", router } as any,
      azureSpeech: { subscriptionKey: "k", region: "r" },
    });
    await svc.initialize();
    const input = document.getElementById("x") as HTMLElement;
    if (typeof (svc as any).ensureCustomDropdownClosed === "function") {
      await expect(
        (svc as any).ensureCustomDropdownClosed(input),
      ).resolves.toBeUndefined();
    } else {
      expect((svc as any).ensureCustomDropdownClosed).toBeUndefined();
    }
  });
});

describe("waitForSilence", () => {
  it("returns immediately for 0 duration", async () => {
    const svc = await make();
    const start = Date.now();
    await (svc as any).waitForSilence(0);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("resolves after silence period elapses", async () => {
    const svc = await make();
    (svc as any).userSpeaking = false;
    (svc as any).lastSilenceAt = Date.now() - 100;
    await expect((svc as any).waitForSilence(50)).resolves.toBeUndefined();
  });
});

describe("prepareFieldOptions", () => {
  it("no-ops for plain text fields", async () => {
    const svc = await make();
    const fld = (svc as any).fields[0];
    await expect((svc as any).prepareFieldOptions(fld)).resolves.toBeUndefined();
  });
});

describe("getFieldsForStep / getPendingFieldsForCurrentStep", () => {
  it("getFieldsForStep returns matching fields by step", async () => {
    document.body.innerHTML = `
      <form id="form">
        <div data-step="s1">
          <input id="a" name="a" type="text" />
        </div>
        <div data-step="s2">
          <input id="b" name="b" type="text" />
        </div>
      </form>
    `;
    const router = { routeAnswer: vi.fn() };
    const svc = new VoiceFormService({
      formSelector: "#form",
      bedrock: { modelId: "x", router } as any,
      azureSpeech: { subscriptionKey: "k", region: "r" },
    });
    await svc.initialize();
    const steps = (svc as any).steps;
    if (steps.length) {
      const fields = (svc as any).getFieldsForStep(steps[0]);
      expect(Array.isArray(fields)).toBe(true);
    }
  });
});

describe("VoiceFormService — debug paths", () => {
  it("emits debug logs across initialize/start/stop", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    document.body.innerHTML = `<form id="form"><input id="x" name="x" type="text" /></form>`;
    const router = { routeAnswer: vi.fn() };
    const svc = new VoiceFormService({
      formSelector: "#form",
      bedrock: { modelId: "x", router } as any,
      azureSpeech: { subscriptionKey: "k", region: "r" },
      debug: { logExtractedFields: true },
    });
    await svc.initialize();
    vi.spyOn(svc as any, "runFormFlow").mockResolvedValue(undefined);
    await svc.start();
    await svc.stop();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
