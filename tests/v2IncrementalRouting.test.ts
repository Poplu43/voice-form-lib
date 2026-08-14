import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { V2VoiceFormService } from "../src/v2/voiceFormService";
import type {
  BedrockRouter,
  SarvamSpeechProvider,
  SarvamSTTHandlers,
  V2VoiceFormInitOptions,
} from "../src/v2/types";

/**
 * Lets the whole route -> apply chain settle. applyAssignments waits 120ms after
 * each write before re-validating it, so a microtask flush returns while the
 * routing pass is still in flight.
 */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

function makeSpeechProvider() {
  let handlers: SarvamSTTHandlers | null = null;
  const provider: SarvamSpeechProvider = {
    usesClientVAD: true,
    setLanguage: vi.fn(),
    startListening: vi.fn(async (next: SarvamSTTHandlers) => {
      handlers = next;
    }),
    stopListening: vi.fn(async () => undefined),
    speak: vi.fn(async () => undefined),
    stopSpeaking: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    provider,
    get handlers() {
      if (!handlers) throw new Error("Speech handlers were not registered");
      return handlers;
    },
  };
}

async function makeService(
  options: Partial<V2VoiceFormInitOptions> = {},
  router: BedrockRouter = {
    routeAnswer: vi.fn(async () => ({ assignments: [] })),
  },
) {
  document.body.innerHTML = `
    <form id="form">
      <label for="community">Community</label>
      <input id="community" name="community" type="text" />
      <label for="annualIncome">Annual Income</label>
      <input id="annualIncome" name="annualIncome" type="text" />
      <label for="district">District</label>
      <input id="district" name="district" type="text" />
    </form>
  `;
  const speech = makeSpeechProvider();
  const service = new V2VoiceFormService({
    formSelector: "#form",
    language: "en-IN",
    transcriptGuard: false,
    bhashiniProxy: { provider: speech.provider, language: "en-IN" },
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
  (service as any).currentQuestionFieldId = "community";
  const promise = (service as any).listenOnce() as Promise<string>;
  await flushPromises();
  let resolved = false;
  promise.then(() => {
    resolved = true;
  });
  return {
    promise,
    get resolved() {
      return resolved;
    },
  };
}

const valueOf = (id: string) =>
  (document.getElementById(id) as HTMLInputElement).value;

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

describe("V2VoiceFormService incremental routing", () => {
  it("fills a field while the user is still speaking", async () => {
    const router: BedrockRouter = {
      routeAnswer: vi.fn(async () => ({
        assignments: [
          { fieldId: "community", value: "OBC", confidence: 0.95 },
        ],
      })),
    };
    const { service, speech } = await makeService({}, router);
    const listen = await startListen(service);

    speech.handlers.onSpeechStart?.();
    speech.handlers.onPartial?.("my community is OBC");
    await flushPromises();

    // Filled mid-sentence: the turn has NOT ended.
    expect(valueOf("community")).toBe("OBC");
    expect(listen.resolved).toBe(false);

    await (service as any).stop();
  });

  it("keeps filling later details as they are spoken", async () => {
    const router: BedrockRouter = {
      routeAnswer: vi
        .fn()
        .mockResolvedValueOnce({
          assignments: [
            { fieldId: "community", value: "OBC", confidence: 0.95 },
          ],
        })
        .mockResolvedValueOnce({
          assignments: [
            { fieldId: "community", value: "OBC", confidence: 0.95 },
            { fieldId: "annualIncome", value: "200000", confidence: 0.9 },
          ],
        }),
    };
    const { service, speech } = await makeService({}, router);
    const listen = await startListen(service);

    speech.handlers.onSpeechStart?.();
    speech.handlers.onPartial?.("my community is OBC");
    await flushPromises();
    expect(valueOf("community")).toBe("OBC");

    // Enough time for the next mid-answer route, and enough new words.
    (service as any).lastIncrementalRouteAt = Date.now() - 5000;
    speech.handlers.onPartial?.("my community is OBC and my income is two lakh");
    await flushPromises();

    expect(valueOf("annualIncome")).toBe("200000");
    expect(listen.resolved).toBe(false);

    await (service as any).stop();
  });

  it("does not re-apply an assignment it already applied", async () => {
    const router: BedrockRouter = {
      routeAnswer: vi.fn(async () => ({
        assignments: [
          { fieldId: "community", value: "OBC", confidence: 0.95 },
        ],
      })),
    };
    const { service, speech } = await makeService({}, router);
    await startListen(service);

    speech.handlers.onSpeechStart?.();
    speech.handlers.onPartial?.("my community is OBC");
    await flushPromises();

    const applySpy = vi.spyOn(service as any, "applyAssignments");
    (service as any).lastIncrementalRouteAt = Date.now() - 5000;
    speech.handlers.onPartial?.("my community is OBC please");
    await flushPromises();

    // Router consulted again, but the unchanged assignment is not re-applied.
    expect(applySpy).not.toHaveBeenCalled();

    await (service as any).stop();
  });

  it("ignores skips and low-confidence guesses mid-answer", async () => {
    const router: BedrockRouter = {
      routeAnswer: vi.fn(async () => ({
        assignments: [
          { fieldId: "community", value: "OBC", confidence: 0.4 },
          { fieldId: "district", value: "SONIPAT", confidence: 0.99, skip: true },
        ],
      })),
    };
    const { service, speech } = await makeService({}, router);
    await startListen(service);

    speech.handlers.onSpeechStart?.();
    speech.handlers.onPartial?.("maybe OBC or something");
    await flushPromises();

    // A half-heard guess must not land in the form while more is being said.
    expect(valueOf("community")).toBe("");
    expect(valueOf("district")).toBe("");

    await (service as any).stop();
  });

  it("can be turned off", async () => {
    const router: BedrockRouter = {
      routeAnswer: vi.fn(async () => ({
        assignments: [
          { fieldId: "community", value: "OBC", confidence: 0.95 },
        ],
      })),
    };
    const { service, speech } = await makeService(
      { incrementalRouting: false },
      router,
    );
    await startListen(service);

    speech.handlers.onSpeechStart?.();
    speech.handlers.onPartial?.("my community is OBC");
    await flushPromises();

    expect(router.routeAnswer).not.toHaveBeenCalled();
    expect(valueOf("community")).toBe("");

    await (service as any).stop();
  });

  it("waits for minNewWords before consulting the router", async () => {
    const router: BedrockRouter = {
      routeAnswer: vi.fn(async () => ({ assignments: [] })),
    };
    const { service, speech } = await makeService(
      { incrementalRouting: { minNewWords: 5 } },
      router,
    );
    await startListen(service);

    speech.handlers.onSpeechStart?.();
    speech.handlers.onPartial?.("my community");
    await flushPromises();
    expect(router.routeAnswer).not.toHaveBeenCalled();

    speech.handlers.onPartial?.("my community is OBC and my income is high");
    await flushPromises();
    expect(router.routeAnswer).toHaveBeenCalledTimes(1);

    await (service as any).stop();
  });
});
