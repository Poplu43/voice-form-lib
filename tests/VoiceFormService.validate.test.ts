import { describe, it, expect, vi, beforeEach } from "vitest";

// Reuse the same mocks pattern from VoiceFormService.test.ts (each test file has
// its own module graph in vitest, so mocks defined here only apply here).

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
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [],
      })),
    },
  });
});

import { VoiceFormService } from "../src/VoiceFormService";

async function makeService(
  formHtml: string = `
    <form id="form">
      <input id="x" name="x" type="text" />
    </form>
  `,
) {
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

function getField(svc: any, id: string) {
  return svc.fields.find((f: any) => f.id === id);
}

describe("validateAssignment — text fields", () => {
  it("rejects empty value with missing_value", async () => {
    const svc = await makeService();
    const result = (svc as any).validateAssignment(getField(svc, "x"), "");
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/still need/i);
  });

  it("trims whitespace from valid value", async () => {
    const svc = await makeService();
    const result = (svc as any).validateAssignment(getField(svc, "x"), "  Alice  ");
    expect(result.valid).toBe(true);
    expect(result.value).toBe("Alice");
  });
});

describe("validateAssignment — number fields", () => {
  it("rejects non-numeric input", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="age" name="age" type="number" />
      </form>
    `);
    const result = (svc as any).validateAssignment(getField(svc, "age"), "abc");
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/number/i);
  });

  it("normalizes comma-separated numbers", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="income" name="income" type="number" />
      </form>
    `);
    const result = (svc as any).validateAssignment(
      getField(svc, "income"),
      "3,00,000",
    );
    expect(result.valid).toBe(true);
    expect(result.value).toBe("300000");
  });

  it("enforces min", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="age" name="age" type="number" min="18" />
      </form>
    `);
    const result = (svc as any).validateAssignment(getField(svc, "age"), "10");
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/at least/i);
  });

  it("enforces max", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="age" name="age" type="number" max="100" />
      </form>
    `);
    const result = (svc as any).validateAssignment(getField(svc, "age"), "150");
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/at most/i);
  });

  it("enforces step increments", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="x" name="x" type="number" min="0" step="5" />
      </form>
    `);
    const r1 = (svc as any).validateAssignment(getField(svc, "x"), "23");
    expect(r1.valid).toBe(false);
    expect(r1.message).toMatch(/increment/i);
    const r2 = (svc as any).validateAssignment(getField(svc, "x"), "25");
    expect(r2.valid).toBe(true);
  });
});

describe("validateAssignment — pattern, minLength, maxLength", () => {
  it("rejects when minLength not met", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="x" name="x" type="text" minlength="5" />
      </form>
    `);
    const r = (svc as any).validateAssignment(getField(svc, "x"), "abc");
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/at least/i);
  });

  it("rejects when maxLength exceeded", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="x" name="x" type="text" maxlength="3" />
      </form>
    `);
    const r = (svc as any).validateAssignment(getField(svc, "x"), "abcdef");
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/no more/i);
  });

  it("rejects when pattern doesn't match", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="x" name="x" type="text" pattern="[0-9]+" />
      </form>
    `);
    const r = (svc as any).validateAssignment(getField(svc, "x"), "abc");
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/format/i);
  });
});

describe("validateAssignment — select fields", () => {
  it("approves exact option value match", async () => {
    const svc = await makeService(`
      <form id="form">
        <select id="cat" name="cat">
          <option value="A">Alpha</option>
          <option value="B">Beta</option>
        </select>
      </form>
    `);
    const r = (svc as any).validateAssignment(getField(svc, "cat"), "A");
    expect(r.valid).toBe(true);
    expect(r.value).toBe("A");
  });

  it("approves exact option label match", async () => {
    const svc = await makeService(`
      <form id="form">
        <select id="cat" name="cat">
          <option value="A">Alpha</option>
        </select>
      </form>
    `);
    const r = (svc as any).validateAssignment(getField(svc, "cat"), "Alpha");
    expect(r.valid).toBe(true);
    expect(r.value).toBe("A");
  });

  it("uses fuzzy match for near-matches", async () => {
    const svc = await makeService(`
      <form id="form">
        <select id="cat" name="cat">
          <option value="alpha">alpha</option>
          <option value="beta">beta</option>
        </select>
      </form>
    `);
    const r = (svc as any).validateAssignment(getField(svc, "cat"), "ALPHAA");
    expect(r.valid).toBe(true);
  });

  it("rejects when nothing matches", async () => {
    const svc = await makeService(`
      <form id="form">
        <select id="cat" name="cat">
          <option value="A">Alpha</option>
        </select>
      </form>
    `);
    const r = (svc as any).validateAssignment(getField(svc, "cat"), "xyzzy");
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/not one of/i);
  });
});

describe("validateAssignment — multi-select checkbox fields", () => {
  it("returns array of matched values", async () => {
    const svc = await makeService(`
      <form id="form">
        <label><input type="checkbox" name="h" value="reading" />R</label>
        <label><input type="checkbox" name="h" value="sports" />S</label>
        <label><input type="checkbox" name="h" value="music" />M</label>
      </form>
    `);
    const f = (svc as any).fields[0];
    const r = (svc as any).validateAssignment(f, ["reading", "music"]);
    expect(r.valid).toBe(true);
    expect(r.value).toEqual(["reading", "music"]);
  });

  it("warns on unknown values but accepts known", async () => {
    const svc = await makeService(`
      <form id="form">
        <label><input type="checkbox" name="h" value="reading" />R</label>
        <label><input type="checkbox" name="h" value="sports" />S</label>
      </form>
    `);
    const f = (svc as any).fields[0];
    const r = (svc as any).validateAssignment(f, ["reading", "unknown"]);
    expect(r.valid).toBe(true);
    expect(r.warnings?.length).toBeGreaterThan(0);
  });

  it("rejects when all values unknown", async () => {
    const svc = await makeService(`
      <form id="form">
        <label><input type="checkbox" name="h" value="reading" />R</label>
      </form>
    `);
    const f = (svc as any).fields[0];
    const r = (svc as any).validateAssignment(f, ["foo", "bar"]);
    expect(r.valid).toBe(false);
  });

  it("rejects empty array as missing_value", async () => {
    const svc = await makeService(`
      <form id="form">
        <label><input type="checkbox" name="h" value="reading" />R</label>
      </form>
    `);
    const f = (svc as any).fields[0];
    const r = (svc as any).validateAssignment(f, []);
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/still need/i);
  });
});

describe("buildQuestion variations", () => {
  it("returns text-only question for text fields", async () => {
    const svc = await makeService();
    const q = (svc as any).buildQuestion(getField(svc, "x"));
    expect(q).toMatch(/Please provide/i);
  });

  it("includes options for select fields", async () => {
    const svc = await makeService(`
      <form id="form">
        <select id="c" name="c">
          <option value="A">Alpha</option>
          <option value="B">Beta</option>
        </select>
      </form>
    `);
    const q = (svc as any).buildQuestion(getField(svc, "c"));
    expect(q).toMatch(/Alpha|Beta/);
  });

  it("includes labels of many options", async () => {
    const opts = Array.from({ length: 30 }, (_, i) => `<option value="v${i}">L${i}</option>`).join("");
    const svc = await makeService(`<form id="form"><select id="big" name="big">${opts}</select></form>`);
    const q = (svc as any).buildQuestion(getField(svc, "big"));
    expect(q).toMatch(/L0/);
  });
});

describe("snapshot, locale, message", () => {
  it("locale defaults to 'en'", async () => {
    const svc = await makeService();
    expect((svc as any).locale).toBe("en");
  });

  it("locale switches to 'hi' for hi-IN", async () => {
    const svc = await makeService();
    await svc.setLanguage("hi-IN");
    expect((svc as any).locale).toBe("hi");
  });

  it("snapshot copies constraints by value", async () => {
    const svc = await makeService();
    const a = (svc as any).snapshotExtractedFields();
    const b = (svc as any).snapshotExtractedFields();
    expect(a[0].constraints).not.toBe(b[0].constraints);
  });
});

describe("isFieldVisible & isFieldDisabledOrReadonly", () => {
  it("treats hidden parent as not visible", async () => {
    const svc = await makeService(`
      <form id="form">
        <div style="display:none"><input id="hid" name="hid" type="text" /></div>
        <input id="vis" name="vis" type="text" />
      </form>
    `);
    const hid = getField(svc, "hid");
    const vis = getField(svc, "vis");
    expect((svc as any).isFieldVisible(hid)).toBe(false);
    expect((svc as any).isFieldVisible(vis)).toBe(true);
  });

  it("treats readonly/disabled as such", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="r" name="r" type="text" readonly />
        <input id="d" name="d" type="text" disabled />
        <input id="ok" name="ok" type="text" />
      </form>
    `);
    expect((svc as any).isFieldDisabledOrReadonly(getField(svc, "r"))).toBe(true);
    expect((svc as any).isFieldDisabledOrReadonly(getField(svc, "d"))).toBe(true);
    expect((svc as any).isFieldDisabledOrReadonly(getField(svc, "ok"))).toBe(false);
  });
});

describe("isCurrentStepCompleted", () => {
  it("returns true when no steps and all fields complete", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="a" name="a" type="text" value="x" />
      </form>
    `);
    (svc as any).steps = [];
    expect((svc as any).isCurrentStepCompleted()).toBe(true);
  });

  it("returns false when fields incomplete and no steps", async () => {
    const svc = await makeService();
    (svc as any).steps = [];
    expect((svc as any).isCurrentStepCompleted()).toBe(false);
  });
});

describe("allFieldsCompleted/allStepsCompleted", () => {
  it("returns false when fields still need answers", async () => {
    const svc = await makeService();
    expect((svc as any).allFieldsCompleted()).toBe(false);
  });

  it("returns true when DOM has all values", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="a" name="a" type="text" value="ok" />
        <input id="b" name="b" type="text" value="ok" />
      </form>
    `);
    expect((svc as any).allFieldsCompleted()).toBe(true);
  });
});

describe("findNextFieldForCurrentStep", () => {
  it("returns the first unanswered visible field", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="a" name="a" type="text" value="filled" />
        <input id="b" name="b" type="text" />
      </form>
    `);
    const next = (svc as any).findNextFieldForCurrentStep();
    expect(next?.id).toBe("b");
  });

  it("returns undefined when nothing pending", async () => {
    const svc = await makeService(`
      <form id="form">
        <input id="a" name="a" type="text" value="x" />
      </form>
    `);
    const next = (svc as any).findNextFieldForCurrentStep();
    expect(next).toBeUndefined();
  });
});
