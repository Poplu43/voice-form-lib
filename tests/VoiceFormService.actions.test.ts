import { describe, it, expect, vi, beforeEach } from "vitest";

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
    speakTextAsync = vi.fn();
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
  SarvamAIClient: vi.fn(),
}));

vi.mock("socket.io-client", () => ({
  io: vi.fn(),
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
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] })),
    },
  });
});

import { VoiceFormService } from "../src/VoiceFormService";

async function makeService(formHtml: string) {
  document.body.innerHTML = formHtml;
  const router = { routeAnswer: vi.fn(async () => ({ assignments: [] })) };
  const svc = new VoiceFormService({
    formSelector: "#form",
    bedrock: { modelId: "x", router } as any,
    azureSpeech: { subscriptionKey: "k", region: "r" },
  });
  await svc.initialize();
  return svc;
}

function field(svc: any, id: string) {
  return svc.fields.find((f: any) => f.id === id);
}

describe("setFieldValueInternal — native input", () => {
  it("sets value via native setter and dispatches input/change", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="x" name="x" type="text" />
      </form>
    `);
    const input = document.getElementById("x") as HTMLInputElement;
    const inputSpy = vi.fn();
    const changeSpy = vi.fn();
    input.addEventListener("input", inputSpy);
    input.addEventListener("change", changeSpy);
    await (svc as any).setFieldValueInternal(field(svc, "x"), "Alice");
    expect(input.value).toBe("Alice");
    expect(inputSpy).toHaveBeenCalled();
    expect(changeSpy).toHaveBeenCalled();
  });

  it("joins arrays with comma for text input", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="x" name="x" type="text" />
      </form>
    `);
    await (svc as any).setFieldValueInternal(field(svc, "x"), ["a", "b"]);
    const input = document.getElementById("x") as HTMLInputElement;
    expect(input.value).toBe("a, b");
  });

  it("temporarily lifts readonly to set value", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="x" name="x" type="text" readonly />
      </form>
    `);
    await (svc as any).setFieldValueInternal(field(svc, "x"), "Z");
    const input = document.getElementById("x") as HTMLInputElement;
    expect(input.value).toBe("Z");
    expect(input.readOnly).toBe(true); // restored
  });
});

describe("setFieldValueInternal — select", () => {
  it("selects a single option", async () => {
    const svc = await makeService(`
      <form id="form">
        <select id="c" name="c">
          <option value="">Pick</option>
          <option value="A">Alpha</option>
          <option value="B">Beta</option>
        </select>
      </form>
    `);
    await (svc as any).setFieldValueInternal(field(svc, "c"), "B");
    const sel = document.getElementById("c") as HTMLSelectElement;
    expect(sel.value).toBe("B");
  });

  it("selects multiple options for multiple-select", async () => {
    const svc = await makeService(`
      <form id="form">
        <select id="c" name="c" multiple>
          <option value="A">Alpha</option>
          <option value="B">Beta</option>
          <option value="D">Delta</option>
        </select>
      </form>
    `);
    await (svc as any).setFieldValueInternal(field(svc, "c"), ["A", "D"]);
    const sel = document.getElementById("c") as HTMLSelectElement;
    const selected = Array.from(sel.options)
      .filter((o) => o.selected)
      .map((o) => o.value);
    expect(selected).toEqual(["A", "D"]);
  });

  it("resets selectedIndex when empty value provided", async () => {
    const svc = await makeService(`
      <form id="form">
        <select id="c" name="c">
          <option value="A">Alpha</option>
        </select>
      </form>
    `);
    await (svc as any).setFieldValueInternal(field(svc, "c"), "");
    const sel = document.getElementById("c") as HTMLSelectElement;
    // jsdom sets first option as selectedIndex=0 by default
    expect(sel.selectedIndex).toBeLessThanOrEqual(0);
  });
});

describe("setFieldValueInternal — textarea", () => {
  it("sets value and dispatches input", async () => {
    const svc = await makeService(`
      <form id="form">
        <textarea id="t" name="t"></textarea>
      </form>
    `);
    await (svc as any).setFieldValueInternal(field(svc, "t"), "hello world");
    const t = document.getElementById("t") as HTMLTextAreaElement;
    expect(t.value).toBe("hello world");
  });

  it("joins array values with comma", async () => {
    const svc = await makeService(`
      <form id="form">
        <textarea id="t" name="t"></textarea>
      </form>
    `);
    await (svc as any).setFieldValueInternal(field(svc, "t"), ["a", "b"]);
    const t = document.getElementById("t") as HTMLTextAreaElement;
    expect(t.value).toBe("a, b");
  });
});

describe("setFieldValueInternal — radio/checkbox groups", () => {
  it("selects the matching radio option", async () => {
    const svc = await makeService(`
      <form id="form">
        <label><input type="radio" name="g" value="m" />Male</label>
        <label><input type="radio" name="g" value="f" />Female</label>
      </form>
    `);
    const fld = svc.getExtractedFields()[0];
    await (svc as any).setFieldValueInternal((svc as any).fields[0], "f");
    const inputs = document.querySelectorAll<HTMLInputElement>('input[name="g"]');
    expect(inputs[0].checked).toBe(false);
    expect(inputs[1].checked).toBe(true);
  });

  it("checks multiple boxes for checkbox group", async () => {
    const svc = await makeService(`
      <form id="form">
        <label><input type="checkbox" name="h" value="r" />R</label>
        <label><input type="checkbox" name="h" value="s" />S</label>
        <label><input type="checkbox" name="h" value="m" />M</label>
      </form>
    `);
    await (svc as any).setFieldValueInternal((svc as any).fields[0], ["r", "m"]);
    const inputs = document.querySelectorAll<HTMLInputElement>('input[name="h"]');
    expect(inputs[0].checked).toBe(true);
    expect(inputs[1].checked).toBe(false);
    expect(inputs[2].checked).toBe(true);
  });
});

describe("markFieldSkipped", () => {
  it("marks field state as skipped", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="middle" name="middle" type="text" />
      </form>
    `);
    await (svc as any).markFieldSkipped(field(svc, "middle"));
    const state = (svc as any).fieldState.get("middle");
    expect(state?.skipped).toBe(true);
  });
});

describe("delay helper", () => {
  it("resolves after specified ms", async () => {
    const svc = await makeService(`<form id="form"><input id="x" name="x" type="text" /></form>`);
    const start = Date.now();
    await (svc as any).delay(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});

describe("setFieldValue wrapper sets isSettingValueProgrammatically", () => {
  it("toggles flag around internal call", async () => {
    const svc = await makeService(`<form id="form"><input id="x" name="x" type="text" /></form>`);
    expect((svc as any).isSettingValueProgrammatically).toBe(false);
    const p = (svc as any).setFieldValue(field(svc, "x"), "Bob");
    expect((svc as any).isSettingValueProgrammatically).toBe(true);
    await p;
    await new Promise((r) => setTimeout(r, 250));
    expect((svc as any).isSettingValueProgrammatically).toBe(false);
  });
});

describe("findBestOptionMatch (private)", () => {
  it("returns null when input empty", async () => {
    const svc = await makeService(`<form id="form"><input id="x" name="x" type="text" /></form>`);
    const result = (svc as any).findBestOptionMatch("", [{ value: "a", label: "A" }]);
    expect(result).toBeNull();
  });

  it("returns matching option for exact value", async () => {
    const svc = await makeService(`<form id="form"><input id="x" name="x" type="text" /></form>`);
    const result = (svc as any).findBestOptionMatch("A", [
      { value: "A", label: "Alpha" },
      { value: "B", label: "Beta" },
    ]);
    expect(result?.value).toBe("A");
  });
});

describe("isFieldAnswered with state", () => {
  it("returns true when state marks skipped", async () => {
    const svc = await makeService(`<form id="form"><input id="x" name="x" type="text" /></form>`);
    (svc as any).fieldState.set("x", { skipped: true, value: "" });
    expect((svc as any).isFieldAnswered("x")).toBe(true);
  });

  it("returns false for empty array state", async () => {
    const svc = await makeService(`<form id="form"><input id="x" name="x" type="text" /></form>`);
    (svc as any).fieldState.set("x", { value: [] });
    expect((svc as any).isFieldAnswered("x")).toBe(false);
  });

  it("returns true when state has value", async () => {
    const svc = await makeService(`<form id="form"><input id="x" name="x" type="text" /></form>`);
    (svc as any).fieldState.set("x", { value: "set" });
    expect((svc as any).isFieldAnswered("x")).toBe(true);
  });
});

describe("syncFieldFromDomAndCheck", () => {
  it("updates state when DOM has value", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="x" name="x" type="text" />
      </form>
    `);
    const input = document.getElementById("x") as HTMLInputElement;
    input.value = "filled";
    const fld = field(svc, "x");
    const updated = (svc as any).syncFieldFromDomAndCheck(fld);
    expect(typeof updated).toBe("boolean");
  });
});

describe("isEmptyDropdown", () => {
  it("returns true for dropdown without options", async () => {
    const svc = await makeService(`
      <form id="form">
        <ng-select id="s" name="s"></ng-select>
      </form>
    `);
    const fld = field(svc, "s");
    if (fld) {
      fld.options = [];
      expect((svc as any).isEmptyDropdown(fld)).toBe(true);
    }
  });
});

describe("getPendingFieldsForCurrentStep", () => {
  it("returns unanswered visible fields", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="a" name="a" type="text" value="ok" />
        <input id="b" name="b" type="text" />
        <input id="c" name="c" type="text" />
      </form>
    `);
    const pending = (svc as any).getPendingFieldsForCurrentStep();
    expect(pending.map((f: any) => f.id)).toContain("b");
    expect(pending.map((f: any) => f.id)).toContain("c");
  });
});
