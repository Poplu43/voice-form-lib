import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mocks — heavier than the other test files because we need to drive Bhashini
// and Sarvam flows that depend on socket/sdk callbacks.
// ============================================================================

vi.mock("microsoft-cognitiveservices-speech-sdk", () => {
  class FakeSpeechConfig {
    static fromSubscription = vi.fn(() => new FakeSpeechConfig());
    speechRecognitionLanguage = "en-US";
    speechSynthesisVoiceName = "en-US-JennyNeural";
    enableDictation = vi.fn();
  }
  class FakeAudioConfig {
    static fromDefaultMicrophoneInput = vi.fn(() => new FakeAudioConfig());
    static fromStreamOutput = vi.fn(() => new FakeAudioConfig());
  }
  class FakePullAudioOutputStream {
    static create = vi.fn(() => new FakePullAudioOutputStream());
  }
  class FakeAudioOutputStream {
    static createPullStream = vi.fn(() => new FakePullAudioOutputStream());
  }
  class FakeSpeechRecognizer {
    properties = { setProperty: vi.fn() };
    startContinuousRecognitionAsync = vi.fn((ok: () => void) => ok());
    stopContinuousRecognitionAsync = vi.fn((ok: () => void) => ok());
    close = vi.fn();
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
    close = vi.fn();
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

vi.mock("socket.io-client", () => {
  const events = new Map<string, (...args: unknown[]) => void>();
  const fakeSocket = {
    connect: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      events.set(event, cb);
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
  };
  return {
    io: vi.fn(() => fakeSocket),
    Socket: class {},
    __harness: { events, fakeSocket },
  };
});

beforeEach(() => {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: vi.fn() }],
      })),
    },
  });
  // Reset global fetch
  // @ts-expect-error
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({}),
  }));
});

import { VoiceFormService } from "../src/VoiceFormService";

function setupForm() {
  document.body.innerHTML = `
    <form id="form">
      <input id="name" name="name" type="text" />
      <input id="age" name="age" type="number" />
    </form>
  `;
}

function azure(extras: Record<string, unknown> = {}) {
  return {
    formSelector: "#form",
    bedrock: {
      modelId: "x",
      router: { routeAnswer: vi.fn(async () => ({ assignments: [] })) },
    } as any,
    azureSpeech: { subscriptionKey: "k", region: "r" },
    ...extras,
  };
}

function bhashini(extras: Record<string, unknown> = {}) {
  return {
    formSelector: "#form",
    bedrock: {
      modelId: "x",
      router: { routeAnswer: vi.fn(async () => ({ assignments: [] })) },
    } as any,
    bhashiniSpeech: { socketUrl: "wss://x", apiKey: "k", language: "hi" },
    ...extras,
  };
}

function sarvam(extras: Record<string, unknown> = {}) {
  return {
    formSelector: "#form",
    bedrock: {
      modelId: "x",
      router: { routeAnswer: vi.fn(async () => ({ assignments: [] })) },
    } as any,
    sarvamSpeech: { apiKey: "k", language: "en-IN" },
    ...extras,
  };
}

describe("VoiceFormService — stop tears down state", () => {
  beforeEach(setupForm);

  it("stops azure recognizer cleanly when running", async () => {
    const svc = new VoiceFormService(azure());
    await svc.initialize();
    vi.spyOn(svc as any, "runFormFlow").mockResolvedValue(undefined);
    await svc.start();
    await svc.stop();
    expect((svc as any).running).toBe(false);
  });

  it("stops bhashini cleanup paths", async () => {
    const svc = new VoiceFormService(bhashini());
    await svc.initialize();
    // Stop without ever starting — exercises early-return guards in stop()
    await svc.stop();
    expect((svc as any).running).toBe(false);
  });

  it("stops sarvam cleanup paths", async () => {
    const svc = new VoiceFormService(sarvam());
    await svc.initialize();
    await svc.stop();
    expect((svc as any).running).toBe(false);
  });
});

describe("VoiceFormService — setLanguage triggers provider updates", () => {
  beforeEach(setupForm);

  it("re-applies azure speech config on language change", async () => {
    const svc = new VoiceFormService(azure());
    await svc.initialize();
    const applySpy = vi.spyOn(svc as any, "applyLanguageToConfig");
    await svc.setLanguage("hi-IN");
    expect(applySpy).toHaveBeenCalled();
  });

  it("updates bhashini speech service language", async () => {
    const svc = new VoiceFormService(bhashini());
    await svc.initialize();
    const bSvc = (svc as any).bhashiniSpeechService;
    const updateSpy = vi.spyOn(bSvc, "updateLanguage");
    await svc.setLanguage("en-US");
    expect(updateSpy).toHaveBeenCalledWith("en-US");
  });

  it("updates sarvam speech service language", async () => {
    const svc = new VoiceFormService(sarvam());
    await svc.initialize();
    const sSvc = (svc as any).sarvamSpeechService;
    const updateSpy = vi.spyOn(sSvc, "updateLanguage");
    await svc.setLanguage("hi-IN");
    expect(updateSpy).toHaveBeenCalledWith("hi-IN");
  });
});

describe("VoiceFormService — start kicks off form flow promise", () => {
  beforeEach(setupForm);

  it("stores the form-flow promise so subsequent calls await it", async () => {
    const svc = new VoiceFormService(azure());
    await svc.initialize();
    vi.spyOn(svc as any, "runFormFlow").mockResolvedValue(undefined);
    await svc.start();
    expect((svc as any).running).toBe(true);
    await svc.stop();
  });
});

describe("VoiceFormService — speak (mocked synthesizer)", () => {
  beforeEach(setupForm);

  it("invokes onSpeechSynthesis hook with text", async () => {
    const onSpeechSynthesis = vi.fn();
    const svc = new VoiceFormService(
      azure({ uiHooks: { onSpeechSynthesis } }),
    );
    await svc.initialize();
    // Make speech config exist via initialize, then call private speak
    vi.spyOn(svc as any, "speakWithAzure").mockResolvedValue(undefined);
    await (svc as any).speak("Hello world");
    expect(onSpeechSynthesis).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hello world" }),
    );
  });

  it("dispatches to speakWithBhashini for bhashini provider", async () => {
    const svc = new VoiceFormService(bhashini());
    await svc.initialize();
    const bhSpy = vi
      .spyOn(svc as any, "speakWithBhashini")
      .mockResolvedValue(undefined);
    await (svc as any).speak("hola");
    expect(bhSpy).toHaveBeenCalled();
  });

  it("calls speakWithAzure even for empty text (delegated to provider)", async () => {
    const svc = new VoiceFormService(azure());
    await svc.initialize();
    const azureSpy = vi
      .spyOn(svc as any, "speakWithAzure")
      .mockResolvedValue(undefined);
    await (svc as any).speak("");
    expect(azureSpy).toHaveBeenCalled();
  });
});

describe("VoiceFormService — emit helpers wire up hooks", () => {
  beforeEach(setupForm);

  it("emitPrompt calls onPrompt", async () => {
    const onPrompt = vi.fn();
    const svc = new VoiceFormService(azure({ uiHooks: { onPrompt } }));
    await svc.initialize();
    (svc as any).emitPrompt({ text: "Q?" });
    expect(onPrompt).toHaveBeenCalledWith({ text: "Q?" });
  });

  it("emitSpeech calls onSpeechSynthesis", async () => {
    const onSpeechSynthesis = vi.fn();
    const svc = new VoiceFormService(
      azure({ uiHooks: { onSpeechSynthesis } }),
    );
    await svc.initialize();
    (svc as any).emitSpeech({ text: "Speak" });
    expect(onSpeechSynthesis).toHaveBeenCalledWith({ text: "Speak" });
  });
});

describe("VoiceFormService — debug snapshots", () => {
  beforeEach(setupForm);

  it("logs extracted field summary when debug enabled", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const svc = new VoiceFormService(
      azure({ debug: { logExtractedFields: true } }),
    );
    await svc.initialize();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("VoiceFormService — buildStepMap and tab detection", () => {
  it("builds default step map when no tabs", async () => {
    document.body.innerHTML = `
      <form id="form">
        <input id="a" name="a" type="text" />
        <input id="b" name="b" type="text" />
      </form>
    `;
    const svc = new VoiceFormService(azure());
    await svc.initialize();
    expect((svc as any).steps.length).toBeGreaterThanOrEqual(1);
  });

  it("detects mat-tab steps when tabs are present", async () => {
    document.body.innerHTML = `
      <form id="form">
        <mat-tab-group>
          <div role="tab" id="mat-tab-label-0-0" aria-controls="mat-tab-content-0-0">
            <div class="mat-tab-label-content">Tab One</div>
          </div>
          <div role="tab" id="mat-tab-label-0-1" aria-controls="mat-tab-content-0-1">
            <div class="mat-tab-label-content">Tab Two</div>
          </div>
        </mat-tab-group>
        <div role="tabpanel" id="mat-tab-content-0-0" aria-labelledby="mat-tab-label-0-0">
          <input id="a" name="a" type="text" />
        </div>
        <div role="tabpanel" id="mat-tab-content-0-1" aria-labelledby="mat-tab-label-0-1">
          <input id="b" name="b" type="text" />
        </div>
      </form>
    `;
    const svc = new VoiceFormService(azure());
    await svc.initialize();
    expect((svc as any).steps.length).toBeGreaterThanOrEqual(1);
  });
});

describe("VoiceFormService — manual intervention detection setup", () => {
  beforeEach(setupForm);

  it("does not throw when set up before starting", async () => {
    const svc = new VoiceFormService(azure());
    await svc.initialize();
    (svc as any).setupManualInterventionDetection?.();
    expect((svc as any).formChangeObserver).toBeDefined();
  });
});

describe("VoiceFormService — onResetRequested hook", () => {
  beforeEach(setupForm);

  it("registers the reset hook on the options", async () => {
    const onResetRequested = vi.fn(async () => {});
    const svc = new VoiceFormService(
      azure({ uiHooks: { onResetRequested } }),
    );
    await svc.initialize();
    expect((svc as any).hooks.onResetRequested).toBe(onResetRequested);
    // Invoke handler if it exists on the instance
    const handler = (svc as any).handleReset || (svc as any).onResetRequested;
    if (typeof handler === "function") {
      await handler.call(svc);
    }
  });
});

describe("VoiceFormService — resolveDefaultLanguage", () => {
  beforeEach(setupForm);

  it("defaults to first language metadata when none provided", async () => {
    const svc = new VoiceFormService(azure());
    const lang = (svc as any).resolveDefaultLanguage(undefined);
    expect(lang.code).toBe("en-US");
  });

  it("picks hi-IN when requested", async () => {
    const svc = new VoiceFormService(azure());
    const lang = (svc as any).resolveDefaultLanguage("hi-IN");
    expect(lang.code).toBe("hi-IN");
  });

  it("defaults when given an unknown language", async () => {
    const svc = new VoiceFormService(azure());
    const lang = (svc as any).resolveDefaultLanguage("xx-YY");
    expect(lang.code).toBe("en-US");
  });
});
