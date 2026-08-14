import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { V2VoiceFormService } from "../src/v2/voiceFormService";
import type {
  BedrockRouter,
  SarvamSpeechProvider,
  SarvamSTTHandlers,
  V2VoiceFormInitOptions,
} from "../src/v2/types";

// Reproduces the cold-start race in askAndListen(): startContinuousListening()
// is kicked off fire-and-forget when TTS audio starts, racing a hardcoded
// warmup timer that flips listeningState to LISTENING_FOR_ANSWER regardless
// of whether the mic pipeline has actually come online yet. On a slow first
// start (RNNoise/Silero WASM+model fetch/compile, first-time mic permission),
// the old code resolved an empty transcript before a single audio sample was
// ever captured, surfacing "I did not hear anything. Please speak clearly
// and try again." on the very first attempt.

function flushPromises(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

function makeSlowSpeechProvider() {
  let handlers: SarvamSTTHandlers | null = null;
  let resolveStartListening: (() => void) | null = null;
  let rejectStartListening: ((err: Error) => void) | null = null;

  const provider: SarvamSpeechProvider = {
    usesClientVAD: true,
    setLanguage: vi.fn(),
    startListening: vi.fn((nextHandlers: SarvamSTTHandlers) => {
      handlers = nextHandlers;
      return new Promise<void>((resolve, reject) => {
        resolveStartListening = resolve;
        rejectStartListening = reject;
      });
    }),
    stopListening: vi.fn(async () => undefined),
    speak: vi.fn(
      async (
        _text: string,
        opts?: { onAudioStart?: () => void },
      ): Promise<void> => {
        opts?.onAudioStart?.();
      },
    ),
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
    resolveMicReady() {
      resolveStartListening?.();
    },
    rejectMicReady(err: Error) {
      rejectStartListening?.(err);
    },
  };
}

async function makeService(
  provider: SarvamSpeechProvider,
  options: Partial<V2VoiceFormInitOptions> = {},
  router: BedrockRouter = { routeAnswer: vi.fn(async () => ({ assignments: [] })) },
) {
  document.body.innerHTML = `
    <form id="form">
      <label for="firstName">First Name</label>
      <input id="firstName" name="firstName" type="text" />
    </form>
  `;
  const service = new V2VoiceFormService({
    formSelector: "#form",
    language: "en-IN",
    bhashiniProxy: {
      provider,
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
  return service;
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

describe("askAndListen() cold-start warmup race", () => {
  it("keeps waiting instead of resolving empty when the mic pipeline is still warming up past the fixed warmup window", async () => {
    vi.useFakeTimers();
    const speech = makeSlowSpeechProvider();
    const service = await makeService(speech.provider);

    const askPromise = (service as any).askAndListen(
      "What is your first name?",
      "firstName",
    ) as Promise<string>;
    let resolved = false;
    let value = "";
    askPromise.then((result) => {
      resolved = true;
      value = result;
    });

    // Let speak()'s onAudioStart fire and arm the warmup timer.
    await flushPromises();

    // Advance past the fixed 1000ms warmup, plus one 100ms poll tick — the
    // mic pipeline (startListening()) has NOT resolved yet at this point.
    await vi.advanceTimersByTimeAsync(1100);

    expect(resolved).toBe(false);

    // Now let the (slow) mic pipeline actually finish coming online.
    speech.resolveMicReady();
    await flushPromises();

    // Simulate the user answering.
    speech.handlers.onSpeechStart?.();
    speech.handlers.onPartial?.("Ravi");
    speech.handlers.onSpeechEnd?.();
    await vi.advanceTimersByTimeAsync(2500);

    await askPromise;
    expect(resolved).toBe(true);
    expect(value).toBe("Ravi");
  });

  it("still fails promptly (not after MAX_LISTEN_MS) when the mic pipeline permanently fails to start", async () => {
    vi.useFakeTimers();
    // startContinuousListening() retries startListening() once internally
    // (after a 250ms delay) before giving up — this must reject on BOTH
    // the initial call and the retry to simulate a permanent failure.
    const provider: SarvamSpeechProvider = {
      usesClientVAD: true,
      setLanguage: vi.fn(),
      startListening: vi.fn(async () => {
        throw new Error("mic init failed");
      }),
      stopListening: vi.fn(async () => undefined),
      speak: vi.fn(
        async (
          _text: string,
          opts?: { onAudioStart?: () => void },
        ): Promise<void> => {
          opts?.onAudioStart?.();
        },
      ),
      stopSpeaking: vi.fn(),
      dispose: vi.fn(),
    };
    const service = await makeService(provider);

    const askPromise = (service as any).askAndListen(
      "What is your first name?",
      "firstName",
    ) as Promise<string>;
    let resolved = false;
    askPromise.then(() => {
      resolved = true;
    });

    // Let speak()'s onAudioStart fire, arming the warmup timer and kicking
    // off the (permanently failing) startContinuousListening() chain.
    await flushPromises();

    // Covers: the fixed 1000ms warmup window, the internal one-shot retry's
    // 250ms delay, and at least one 100ms poll tick after that — all well
    // under MAX_LISTEN_MS (120_000ms).
    await vi.advanceTimersByTimeAsync(1500);

    expect(resolved).toBe(true);
    await expect(askPromise).resolves.toBe("");
  });
});
