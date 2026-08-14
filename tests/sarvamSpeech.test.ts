import { describe, it, expect, vi, beforeEach } from "vitest";

const sttSocketEvents = new Map<string, (arg?: unknown) => void>();
const ttsSocketEvents = new Map<string, (arg?: unknown) => void>();

const sttSocket = {
  on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
    sttSocketEvents.set(event, cb);
  }),
  connect: vi.fn(),
  transcribe: vi.fn(),
  flush: vi.fn(),
  close: vi.fn(),
};

const ttsSocket = {
  on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
    ttsSocketEvents.set(event, cb);
  }),
  configureConnection: vi.fn(),
  convert: vi.fn(),
  close: vi.fn(),
};

const speechToTextStreamingConnect = vi.fn(async () => sttSocket);
const textToSpeechStreamingConnect = vi.fn(async () => ttsSocket);

vi.mock("sarvamai", () => {
  return {
    SarvamAIClient: vi.fn().mockImplementation(() => ({
      speechToTextStreaming: { connect: speechToTextStreamingConnect },
      textToSpeechStreaming: { connect: textToSpeechStreamingConnect },
    })),
  };
});

import { SarvamSpeechService } from "../src/sarvamSpeech";

beforeEach(() => {
  sttSocketEvents.clear();
  ttsSocketEvents.clear();
  vi.clearAllMocks();
});

describe("SarvamSpeechService — construction & language mapping", () => {
  it("uses defaults when no config overrides given", () => {
    const svc = new SarvamSpeechService({ apiKey: "k" });
    // private property accessed via any
    expect((svc as any).config.language).toBe("hi-IN");
    expect((svc as any).config.speaker).toBe("meera");
    expect((svc as any).config.model).toBe("saaras:v3");
    expect((svc as any).config.sampleRate).toBe(16000);
  });

  it("maps short en code to en-IN with arvind speaker", () => {
    const svc = new SarvamSpeechService({
      apiKey: "k",
      language: "en",
    });
    expect((svc as any).config.language).toBe("en-IN");
    expect((svc as any).config.speaker).toBe("arvind");
  });

  it("maps en-US to en-IN", () => {
    const svc = new SarvamSpeechService({
      apiKey: "k",
      language: "en-US",
    });
    expect((svc as any).config.language).toBe("en-IN");
  });

  it("handles unknown language code by defaulting to hi-IN", () => {
    const svc = new SarvamSpeechService({
      apiKey: "k",
      language: "xx-YY",
    });
    expect((svc as any).config.language).toBe("hi-IN");
  });

  it.each([
    ["bn-IN", "anushka"],
    ["ta-IN", "kanha"],
    ["te-IN", "priya"],
    ["ml-IN", "lakshmi"],
    ["mr-IN", "aarav"],
    ["gu-IN", "diya"],
    ["kn-IN", "ishaan"],
    ["pa-IN", "kabir"],
  ])("picks correct speaker for %s -> %s", (lang, speaker) => {
    const svc = new SarvamSpeechService({
      apiKey: "k",
      language: lang,
    });
    expect((svc as any).config.speaker).toBe(speaker);
  });

  it("honors user-specified speaker", () => {
    const svc = new SarvamSpeechService({
      apiKey: "k",
      language: "hi-IN",
      speaker: "custom",
    });
    expect((svc as any).config.speaker).toBe("custom");
  });

  it("respects pace/pitch/loudness overrides", () => {
    const svc = new SarvamSpeechService({
      apiKey: "k",
      pace: 1.5,
      pitch: 0.7,
      loudness: 1.2,
    });
    expect((svc as any).config.pace).toBe(1.5);
    expect((svc as any).config.pitch).toBe(0.7);
    expect((svc as any).config.loudness).toBe(1.2);
  });
});

describe("updateLanguage", () => {
  it("changes language and default speaker", () => {
    const svc = new SarvamSpeechService({ apiKey: "k" });
    svc.updateLanguage("ta-IN");
    expect((svc as any).config.language).toBe("ta-IN");
    expect((svc as any).config.speaker).toBe("kanha");
  });

  it("emits debug log when enabled", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const svc = new SarvamSpeechService({ apiKey: "k", debug: true });
    svc.updateLanguage("en-US");
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe("createSTTClient", () => {
  it("connects and wires up event handlers", async () => {
    const svc = new SarvamSpeechService({ apiKey: "k" });
    const callback = vi.fn();
    const socket = await svc.createSTTClient(callback);
    expect(socket).toBe(sttSocket);
    expect(sttSocket.on).toHaveBeenCalledWith("message", expect.any(Function));
    expect(sttSocket.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(sttSocket.on).toHaveBeenCalledWith("close", expect.any(Function));
    expect(sttSocket.on).toHaveBeenCalledWith("open", expect.any(Function));
  });

  it("dispatches messages to callback", async () => {
    const svc = new SarvamSpeechService({ apiKey: "k" });
    const callback = vi.fn();
    await svc.createSTTClient(callback);
    const msg = { type: "transcript", data: { transcript: "hello" } };
    sttSocketEvents.get("message")?.(msg);
    expect(callback).toHaveBeenCalledWith(msg);
  });

  it("marks sttActive=true on open", async () => {
    const svc = new SarvamSpeechService({ apiKey: "k", debug: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await svc.createSTTClient(vi.fn());
    sttSocketEvents.get("open")?.();
    expect((svc as any).sttActive).toBe(true);
    logSpy.mockRestore();
  });

  it("marks sttActive=false on close", async () => {
    const svc = new SarvamSpeechService({ apiKey: "k", debug: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await svc.createSTTClient(vi.fn());
    sttSocketEvents.get("open")?.();
    sttSocketEvents.get("close")?.();
    expect((svc as any).sttActive).toBe(false);
    logSpy.mockRestore();
  });

  it("logs errors from socket", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const svc = new SarvamSpeechService({ apiKey: "k" });
    await svc.createSTTClient(vi.fn());
    sttSocketEvents.get("error")?.(new Error("boom"));
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("throws and logs when underlying connect rejects", async () => {
    speechToTextStreamingConnect.mockRejectedValueOnce(new Error("nope"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const svc = new SarvamSpeechService({ apiKey: "k" });
    await expect(svc.createSTTClient(vi.fn())).rejects.toThrow();
    errSpy.mockRestore();
  });
});

describe("sendAudioToSTT", () => {
  it("does nothing and warns when STT inactive", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const svc = new SarvamSpeechService({ apiKey: "k" });
    svc.sendAudioToSTT(new Int16Array([1, 2, 3]));
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("encodes Int16Array as base64 and calls transcribe", async () => {
    const svc = new SarvamSpeechService({ apiKey: "k" });
    await svc.createSTTClient(vi.fn());
    sttSocketEvents.get("open")?.();
    svc.sendAudioToSTT(new Int16Array([1, 2, 3, 4]));
    expect(sttSocket.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.any(String),
        encoding: "audio/pcm",
        sample_rate: 16000,
      }),
    );
  });

  it("catches transcribe errors silently", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sttSocket.transcribe.mockImplementationOnce(() => {
      throw new Error("send failure");
    });
    const svc = new SarvamSpeechService({ apiKey: "k" });
    await svc.createSTTClient(vi.fn());
    sttSocketEvents.get("open")?.();
    svc.sendAudioToSTT(new Int16Array([1]));
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("flushSTT", () => {
  it("flushes when socket is active", async () => {
    const svc = new SarvamSpeechService({ apiKey: "k" });
    await svc.createSTTClient(vi.fn());
    await svc.flushSTT();
    expect(sttSocket.flush).toHaveBeenCalled();
  });

  it("no-ops when no socket", async () => {
    const svc = new SarvamSpeechService({ apiKey: "k" });
    await svc.flushSTT();
    expect(sttSocket.flush).not.toHaveBeenCalled();
  });
});

describe("closeSTT and disconnect", () => {
  it("closes the socket and resets state", async () => {
    const svc = new SarvamSpeechService({ apiKey: "k", debug: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await svc.createSTTClient(vi.fn());
    sttSocketEvents.get("open")?.();
    svc.closeSTT();
    expect(sttSocket.close).toHaveBeenCalled();
    expect((svc as any).sttActive).toBe(false);
    logSpy.mockRestore();
  });

  it("disconnect calls closeSTT", async () => {
    const svc = new SarvamSpeechService({ apiKey: "k", debug: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await svc.createSTTClient(vi.fn());
    sttSocketEvents.get("open")?.();
    svc.disconnect();
    expect(sttSocket.close).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe("synthesizeSpeech", () => {
  it("connects, configures, and returns concatenated base64 audio", async () => {
    const svc = new SarvamSpeechService({ apiKey: "k" });
    const promise = svc.synthesizeSpeech("Hello");

    // Wait for open handler to be registered
    await new Promise((r) => setTimeout(r, 0));
    ttsSocketEvents.get("open")?.();
    expect(ttsSocket.configureConnection).toHaveBeenCalled();
    expect(ttsSocket.convert).toHaveBeenCalledWith("Hello");

    // Push 2 audio chunks then a final event
    const audioA = Buffer.from([1, 2, 3]).toString("base64");
    const audioB = Buffer.from([4, 5, 6]).toString("base64");
    ttsSocketEvents.get("message")?.({
      type: "audio",
      data: { audio: audioA },
    });
    ttsSocketEvents.get("message")?.({
      type: "audio",
      data: { audio: audioB },
    });
    ttsSocketEvents.get("message")?.({
      type: "event",
      data: { event_type: "final" },
    });

    const result = await promise;
    expect(typeof result).toBe("string");
    // Decoded length should be 6 bytes (3+3)
    expect(Buffer.from(result, "base64").length).toBe(6);
  });

  it("returns single audio chunk unchanged when only one received", async () => {
    const svc = new SarvamSpeechService({ apiKey: "k" });
    const promise = svc.synthesizeSpeech("Hi");
    await new Promise((r) => setTimeout(r, 0));
    ttsSocketEvents.get("open")?.();

    const onlyAudio = Buffer.from([9, 9, 9]).toString("base64");
    ttsSocketEvents.get("message")?.({
      type: "audio",
      data: { audio: onlyAudio },
    });
    ttsSocketEvents.get("message")?.({
      type: "event",
      data: { event_type: "final" },
    });
    const result = await promise;
    expect(result).toBe(onlyAudio);
  });

  it("resolves when close arrives before final and there is audio", async () => {
    const svc = new SarvamSpeechService({ apiKey: "k", debug: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const promise = svc.synthesizeSpeech("Bye");
    await new Promise((r) => setTimeout(r, 0));
    ttsSocketEvents.get("open")?.();

    const audio = Buffer.from([1]).toString("base64");
    ttsSocketEvents.get("message")?.({ type: "audio", data: { audio } });
    ttsSocketEvents.get("close")?.();
    const result = await promise;
    expect(result).toBe(audio);
    logSpy.mockRestore();
  });

  it("rejects on close without audio and without completion", async () => {
    const svc = new SarvamSpeechService({ apiKey: "k" });
    const promise = svc.synthesizeSpeech("X");
    await new Promise((r) => setTimeout(r, 0));
    ttsSocketEvents.get("open")?.();
    ttsSocketEvents.get("close")?.();
    await expect(promise).rejects.toThrow();
  });

  it("rejects when TTS socket errors before completion", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const svc = new SarvamSpeechService({ apiKey: "k" });
    const promise = svc.synthesizeSpeech("X");
    await new Promise((r) => setTimeout(r, 0));
    ttsSocketEvents.get("open")?.();
    ttsSocketEvents.get("error")?.(new Error("ws fail"));
    await expect(promise).rejects.toThrow();
    errSpy.mockRestore();
  });

});

describe("Debug logging in initialization", () => {
  it("logs when debug=true on client init", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const svc = new SarvamSpeechService({ apiKey: "k", debug: true });
    await svc.createSTTClient(vi.fn());
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
