import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { V2VoiceFormService } from "../src/v2/voiceFormService";
import type {
  BedrockRouter,
  SarvamSpeechProvider,
  SarvamSTTHandlers,
  V2VoiceFormInitOptions,
} from "../src/v2/types";

function flushPromises(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

function makeSpeechProvider() {
  let handlers: SarvamSTTHandlers | null = null;
  const provider: SarvamSpeechProvider = {
    usesClientVAD: true,
    setLanguage: vi.fn(),
    startListening: vi.fn(async (nextHandlers: SarvamSTTHandlers) => {
      handlers = nextHandlers;
    }),
    stopListening: vi.fn(async () => undefined),
    speak: vi.fn(async () => undefined),
    stopSpeaking: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    provider,
    get handlers() {
      if (!handlers) {
        throw new Error("Speech handlers were not registered");
      }
      return handlers;
    },
  };
}

async function makeService(
  options: Partial<V2VoiceFormInitOptions> = {},
  router: BedrockRouter = { routeAnswer: vi.fn(async () => ({ assignments: [] })) },
) {
  document.body.innerHTML = `
    <form id="form">
      <label for="firstName">First Name</label>
      <input id="firstName" name="firstName" type="text" />
    </form>
  `;
  const speech = makeSpeechProvider();
  const service = new V2VoiceFormService({
    formSelector: "#form",
    language: "en-IN",
    // These tests assert exact routeAnswer call counts to pin down GUARD
    // behaviour. Mid-answer routing calls the same router for its own reasons,
    // so it is switched off here to keep the two features independently
    // testable; incremental routing has its own suite.
    incrementalRouting: false,
    bhashiniProxy: {
      provider: speech.provider,
      language: "en-IN",
    },
    bedrock: {
      proxy: {
        routerUrl: "/bedrock-route",
        translatorUrl: "/bedrock-translate",
      },
    },
    ...options,
  });
  await service.initialize();
  (service as any).router = router;
  return { service, speech, router };
}

async function startListen(service: V2VoiceFormService) {
  (service as any).currentQuestionFieldId = "firstName";
  const promise = (service as any).listenOnce() as Promise<string>;
  await flushPromises();
  let resolved = false;
  let value = "";
  promise.then((result) => {
    resolved = true;
    value = result;
  });
  return {
    promise,
    get resolved() {
      return resolved;
    },
    get value() {
      return value;
    },
  };
}

async function stopPendingListen(
  service: V2VoiceFormService,
  listen: { promise: Promise<string>; resolved: boolean },
) {
  if (listen.resolved) return;
  (service as any).stopRequested = true;
  vi.advanceTimersByTime(100);
  await listen.promise;
}

beforeEach(() => {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("V2VoiceFormService transcript guard", () => {
  it("defaults to 3s and clamps client intervals to 10s", async () => {
    const defaultService = await makeService();
    expect((defaultService.service as any).transcriptGuard).toEqual({
      enabled: true,
      intervalMs: 3000,
    });

    const clampedService = await makeService({
      transcriptGuard: { intervalMs: 20_000 },
    });
    expect((clampedService.service as any).transcriptGuard).toEqual({
      enabled: true,
      intervalMs: 10_000,
    });
  });

  it("does not finalize before any transcript exists", async () => {
    vi.useFakeTimers();
    const { service, router } = await makeService();
    const listen = await startListen(service);

    vi.advanceTimersByTime(3000);
    await flushPromises();

    expect(listen.resolved).toBe(false);
    expect(router.routeAnswer).not.toHaveBeenCalled();

    await stopPendingListen(service, listen);
  });

  it("finalizes when the transcript is unchanged between checkpoints", async () => {
    vi.useFakeTimers();
    const router: BedrockRouter = {
      routeAnswer: vi.fn(async () => ({
        assignments: [{ fieldId: "firstName", value: "Ravi", confidence: 0.9 }],
      })),
    };
    const { service, speech } = await makeService({}, router);
    const listen = await startListen(service);

    speech.handlers.onSpeechStart?.();
    speech.handlers.onPartial?.("Ravi");

    vi.advanceTimersByTime(3000);
    await flushPromises();
    expect(listen.resolved).toBe(false);
    expect(router.routeAnswer).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3000);
    await listen.promise;

    expect(listen.resolved).toBe(true);
    expect(listen.value).toBe("Ravi");
  });

  it("keeps listening when changed transcript remains relevant", async () => {
    vi.useFakeTimers();
    const router: BedrockRouter = {
      routeAnswer: vi.fn(async () => ({
        assignments: [{ fieldId: "firstName", value: "Ravi", confidence: 0.9 }],
      })),
    };
    const { service, speech } = await makeService({}, router);
    const listen = await startListen(service);

    speech.handlers.onSpeechStart?.();
    speech.handlers.onPartial?.("Ravi");
    vi.advanceTimersByTime(3000);
    await flushPromises();

    speech.handlers.onPartial?.("Ravi Kumar");
    vi.advanceTimersByTime(3000);
    await flushPromises();

    expect(listen.resolved).toBe(false);
    expect(router.routeAnswer).toHaveBeenCalledTimes(2);

    await stopPendingListen(service, listen);
  });

  it("finalizes when changed transcript is not relevant", async () => {
    vi.useFakeTimers();
    const router: BedrockRouter = {
      routeAnswer: vi.fn(async () => ({ assignments: [] })),
    };
    const { service, speech } = await makeService({}, router);
    const listen = await startListen(service);

    speech.handlers.onSpeechStart?.();
    speech.handlers.onPartial?.("fan noise");
    vi.advanceTimersByTime(3000);
    await listen.promise;

    expect(listen.value).toBe("fan noise");
    expect(router.routeAnswer).toHaveBeenCalledTimes(1);
  });

  it("clears the guard timer when silence finalization wins", async () => {
    vi.useFakeTimers();
    const router: BedrockRouter = {
      routeAnswer: vi.fn(async () => ({ assignments: [] })),
    };
    const { service, speech } = await makeService({}, router);
    const listen = await startListen(service);

    speech.handlers.onSpeechStart?.();
    speech.handlers.onPartial?.("Ravi");
    speech.handlers.onSpeechEnd?.();
    vi.advanceTimersByTime(2500);
    await listen.promise;

    vi.advanceTimersByTime(500);
    await flushPromises();
    expect(router.routeAnswer).not.toHaveBeenCalled();
  });

  it("clears the silence timer when guard finalization wins", async () => {
    vi.useFakeTimers();
    const onTranscript = vi.fn();
    const router: BedrockRouter = {
      routeAnswer: vi.fn(async () => ({ assignments: [] })),
    };
    const { service, speech } = await makeService(
      {
        transcriptGuard: { intervalMs: 1000 },
        uiHooks: { onTranscript },
      },
      router,
    );
    const listen = await startListen(service);

    speech.handlers.onSpeechStart?.();
    speech.handlers.onPartial?.("fan noise");
    speech.handlers.onSpeechEnd?.();
    vi.advanceTimersByTime(1000);
    await listen.promise;

    vi.advanceTimersByTime(2000);
    await flushPromises();
    expect(
      onTranscript.mock.calls.filter((call) => call[0]?.isFinal === true),
    ).toHaveLength(1);
  });

  it("preserves current behavior when transcriptGuard is false", async () => {
    vi.useFakeTimers();
    const router: BedrockRouter = {
      routeAnswer: vi.fn(async () => ({ assignments: [] })),
    };
    const { service, speech } = await makeService(
      { transcriptGuard: false },
      router,
    );
    const listen = await startListen(service);

    speech.handlers.onSpeechStart?.();
    speech.handlers.onPartial?.("fan noise");
    vi.advanceTimersByTime(5000);
    await flushPromises();

    expect(listen.resolved).toBe(false);
    expect(router.routeAnswer).not.toHaveBeenCalled();

    speech.handlers.onSpeechEnd?.();
    vi.advanceTimersByTime(2500);
    await listen.promise;
    expect(listen.value).toBe("fan noise");
  });
});
