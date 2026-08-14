import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("socket.io-client", () => {
  const socketEvents = new Map<string, (...args: unknown[]) => void>();
  const fakeSocket = {
    connect: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      socketEvents.set(event, cb);
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
  };
  const io = vi.fn(() => fakeSocket);
  return {
    __socketHarness: { socketEvents, fakeSocket, io },
    io,
    Socket: class {},
  };
});

import { BhashiniSpeechService } from "../src/bhashiniSpeech";
// @ts-expect-error - test harness
import { __socketHarness } from "socket.io-client";
const { socketEvents, fakeSocket, io } = __socketHarness as {
  socketEvents: Map<string, (...args: unknown[]) => void>;
  fakeSocket: {
    connect: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
  io: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  socketEvents.clear();
  vi.clearAllMocks();
});

describe("BhashiniSpeechService — construction & language mapping", () => {
  it("uses hi default with conformer service id", () => {
    const svc = new BhashiniSpeechService({ apiKey: "k", socketUrl: "ws://x" });
    expect((svc as any).config.language).toBe("hi");
    expect((svc as any).config.serviceId).toBe(
      "bhashini/ai4bharat/conformer-multilingual-asr",
    );
    expect((svc as any).config.ttsGender).toBe("female");
    expect((svc as any).config.ttsSpeed).toBe(1.0);
  });

  it("uses whisper service id for English", () => {
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "ws://x",
      language: "en",
    });
    expect((svc as any).config.serviceId).toBe(
      "ai4bharat/whisper-medium-en--gpu--t4",
    );
  });

  it("maps en-US to en", () => {
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "ws://x",
      language: "en-US",
    });
    expect((svc as any).config.language).toBe("en");
  });

  it("maps hi-IN to hi", () => {
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "ws://x",
      language: "hi-IN",
    });
    expect((svc as any).config.language).toBe("hi");
  });

  it("passes through unmapped codes unchanged", () => {
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "ws://x",
      language: "bn",
    });
    expect((svc as any).config.language).toBe("bn");
  });

  it("logs init when debug=true", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    new BhashiniSpeechService({ apiKey: "k", socketUrl: "ws://x", debug: true });
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("respects ttsGender and ttsSpeed", () => {
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "ws://x",
      ttsGender: "male",
      ttsSpeed: 1.5,
    });
    expect((svc as any).config.ttsGender).toBe("male");
    expect((svc as any).config.ttsSpeed).toBe(1.5);
  });
});

describe("fetchCredentials — direct config & configEndpoint", () => {
  it("uses direct socketUrl/apiKey path when provided", async () => {
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://direct",
    });
    const cb = vi.fn();
    await svc.createClient(cb, false);
    expect(io).toHaveBeenCalledWith(
      "wss://direct",
      expect.objectContaining({
        auth: { authorization: "k" },
      }),
    );
  });

  it("fetches from configEndpoint when present", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ socketUrl: "wss://from-server", apiKey: "ak" }),
    }));
    // @ts-expect-error replace global fetch
    globalThis.fetch = fetchMock;

    const svc = new BhashiniSpeechService({
      configEndpoint: "https://server/api/config",
      language: "hi",
    });
    await svc.createClient(vi.fn(), false);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://server/api/config",
      expect.objectContaining({ method: "POST" }),
    );
    expect(io).toHaveBeenCalledWith("wss://from-server", expect.any(Object));
  });

  it("throws when configEndpoint response is not ok", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      statusText: "500",
      json: async () => ({}),
    }));
    // @ts-expect-error replace global fetch
    globalThis.fetch = fetchMock;
    const svc = new BhashiniSpeechService({
      configEndpoint: "https://server/api/config",
    });
    await expect(svc.createClient(vi.fn(), false)).rejects.toThrow(
      /credentials/i,
    );
  });

  it("throws when neither configEndpoint nor direct creds provided", async () => {
    const svc = new BhashiniSpeechService({ language: "hi" });
    await expect(svc.createClient(vi.fn(), false)).rejects.toThrow(
      /configEndpoint or both/i,
    );
  });
});

describe("createClient event handlers", () => {
  it("emits start on connect when autoStart=true", async () => {
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
    });
    await svc.createClient(vi.fn(), true);
    socketEvents.get("connect")?.();
    expect(fakeSocket.emit).toHaveBeenCalledWith("start", expect.any(Array));
    expect(svc.connected).toBe(true);
  });

  it("does not emit start on connect when autoStart=false", async () => {
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
    });
    await svc.createClient(vi.fn(), false);
    socketEvents.get("connect")?.();
    expect(fakeSocket.emit).not.toHaveBeenCalled();
  });

  it("sets connected=false on disconnect", async () => {
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
      debug: true,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await svc.createClient(vi.fn(), false);
    socketEvents.get("connect")?.();
    socketEvents.get("disconnect")?.("io server disconnect");
    expect(svc.connected).toBe(false);
    logSpy.mockRestore();
  });

  it("logs socket errors when debug=true", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
      debug: true,
    });
    await svc.createClient(vi.fn(), false);
    socketEvents.get("error")?.(new Error("err"));
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("logs connect_error when debug=true", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
      debug: true,
    });
    await svc.createClient(vi.fn(), false);
    socketEvents.get("connect_error")?.(new Error("err"));
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("forwards response messages to callback", async () => {
    const callback = vi.fn();
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
    });
    await svc.createClient(callback, false);
    socketEvents.get("response")?.({ output: [{ source: "hi" }] }, "active");
    expect(callback).toHaveBeenCalledWith(
      { output: [{ source: "hi" }] },
      "active",
    );
  });
});

describe("sendAudioData", () => {
  it("warns and does nothing when not connected", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
      debug: true,
    });
    const client = await svc.createClient(vi.fn(), false);
    svc.sendAudioData(client, new Int16Array([1, 2, 3]));
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("emits data when connected", async () => {
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
    });
    const client = await svc.createClient(vi.fn(), false);
    socketEvents.get("connect")?.();
    fakeSocket.emit.mockClear();
    svc.sendAudioData(client, new Int16Array([1, 2, 3]));
    expect(fakeSocket.emit).toHaveBeenCalledWith(
      "data",
      expect.any(Object),
      expect.any(Object),
      false,
      false,
    );
  });
});

describe("restartSession", () => {
  it("warns when not connected", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
      debug: true,
    });
    const client = await svc.createClient(vi.fn(), false);
    svc.restartSession(client);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("emits restart sequence when connected", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
      debug: true,
    });
    const client = await svc.createClient(vi.fn(), false);
    socketEvents.get("connect")?.();
    fakeSocket.emit.mockClear();
    svc.restartSession(client);
    expect(fakeSocket.emit).toHaveBeenCalledWith("data", null, null, true, false);
    expect(fakeSocket.emit).toHaveBeenCalledWith("data", null, null, true, true);
    vi.advanceTimersByTime(200);
    expect(fakeSocket.emit).toHaveBeenCalledWith("start", expect.any(Array));
    vi.useRealTimers();
    logSpy.mockRestore();
  });
});

describe("disconnect", () => {
  it("does nothing when no client connected", () => {
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
    });
    expect(() => svc.disconnect()).not.toThrow();
    expect(fakeSocket.disconnect).not.toHaveBeenCalled();
  });

  it("emits ends, disconnects, clears state", async () => {
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
      debug: true,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await svc.createClient(vi.fn(), false);
    socketEvents.get("connect")?.();
    svc.disconnect();
    expect(fakeSocket.disconnect).toHaveBeenCalled();
    expect(svc.connected).toBe(false);
    logSpy.mockRestore();
  });
});

describe("getDefaultTaskSequence", () => {
  it("emits the expected ASR config shape", () => {
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
      language: "hi",
    });
    const seq = svc.getDefaultTaskSequence();
    expect(seq[0].taskType).toBe("asr");
    expect(seq[0].config.language.sourceLanguage).toBe("hi");
    expect(seq[1].responseFrequencyInSecs).toBe(2);
  });
});

describe("updateLanguage", () => {
  it("changes language and reflects serviceId switch", () => {
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
      language: "hi",
    });
    svc.updateLanguage("en");
    expect((svc as any).config.language).toBe("en");
    expect((svc as any).config.serviceId).toBe(
      "ai4bharat/whisper-medium-en--gpu--t4",
    );
  });

  it("debug logs language change", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
      debug: true,
    });
    svc.updateLanguage("en-US");
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe("synthesizeSpeech", () => {
  it("throws when no ttsApiUrl (handled via clearing in private)", async () => {
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
    });
    (svc as any).config.ttsApiUrl = undefined;
    await expect(svc.synthesizeSpeech("hi")).rejects.toThrow(/TTS API URL/);
  });

  it("throws when no apiKey", async () => {
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
    });
    (svc as any).config.apiKey = undefined;
    await expect(svc.synthesizeSpeech("hi")).rejects.toThrow(/API key/);
  });

  it("returns audioContent on successful response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        pipelineResponse: [
          { audio: [{ audioContent: "BASE64STRING" }] },
        ],
      }),
    }));
    // @ts-expect-error stub
    globalThis.fetch = fetchMock;
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
      debug: true,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await svc.synthesizeSpeech("hello");
    expect(result).toBe("BASE64STRING");
    logSpy.mockRestore();
  });

  it("throws when response is not ok", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      statusText: "500 Internal Error",
      json: async () => ({}),
    }));
    // @ts-expect-error
    globalThis.fetch = fetchMock;
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
    });
    await expect(svc.synthesizeSpeech("hi")).rejects.toThrow(/500/);
  });

  it("throws when audioContent missing in response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ pipelineResponse: [] }),
    }));
    // @ts-expect-error
    globalThis.fetch = fetchMock;
    const svc = new BhashiniSpeechService({
      apiKey: "k",
      socketUrl: "wss://x",
    });
    await expect(svc.synthesizeSpeech("hi")).rejects.toThrow(/invalid response/i);
  });
});
