import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/VoiceFormService", () => {
  const initialize = vi.fn(async () => {});
  const start = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const announceAndStop = vi.fn(async (_msg: string) => {});
  const setLanguage = vi.fn(async (_lang: string) => {});
  const getExtractedFields = vi.fn(() => [
    {
      id: "x",
      name: "x",
      label: "X",
      type: "text",
      constraints: { required: false },
    },
  ]);
  const restartBhashiniSession = vi.fn();

  return {
    __mockFns: {
      initialize,
      start,
      stop,
      announceAndStop,
      setLanguage,
      getExtractedFields,
      restartBhashiniSession,
    },
    VoiceFormService: vi.fn().mockImplementation(() => ({
      initialize,
      start,
      stop,
      announceAndStop,
      setLanguage,
      getExtractedFields,
      restartBhashiniSession,
    })),
  };
});

vi.mock("../src/bedrockRouter", () => {
  return {
    AwsBedrockRouter: vi.fn(),
    findBestOptionMatch: vi.fn(),
  };
});

import { initializeVoiceForm, getLatestExtractedFields } from "../src/index";
// @ts-expect-error - test-only mock helper
import { __mockFns } from "../src/VoiceFormService";

describe("initializeVoiceForm", () => {
  beforeEach(() => {
    for (const fn of Object.values(__mockFns as Record<string, ReturnType<typeof vi.fn>>)) {
      fn.mockClear();
    }
  });

  it("creates a controller with all public methods", async () => {
    const controller = await initializeVoiceForm({
      formSelector: "#form",
      bedrock: { modelId: "anthropic.claude-3" },
      autoStart: false,
    });

    expect(__mockFns.initialize).toHaveBeenCalled();
    expect(typeof controller.start).toBe("function");
    expect(typeof controller.stop).toBe("function");
    expect(typeof controller.announceAndStop).toBe("function");
    expect(typeof controller.setLanguage).toBe("function");
    expect(typeof controller.getExtractedFields).toBe("function");
    expect(typeof controller.restartBhashiniSession).toBe("function");
  });

  it("auto-starts service when autoStart is true (default)", async () => {
    await initializeVoiceForm({
      formSelector: "#form",
      bedrock: { modelId: "anthropic.claude-3" },
    });
    await Promise.resolve();
    expect(__mockFns.start).toHaveBeenCalled();
  });

  it("does not auto-start when autoStart is false", async () => {
    await initializeVoiceForm({
      formSelector: "#form",
      bedrock: { modelId: "anthropic.claude-3" },
      autoStart: false,
    });
    await Promise.resolve();
    expect(__mockFns.start).not.toHaveBeenCalled();
  });

  it("controller methods delegate to the service", async () => {
    const controller = await initializeVoiceForm({
      formSelector: "#form",
      bedrock: { modelId: "anthropic.claude-3" },
      autoStart: false,
    });

    await controller.start();
    expect(__mockFns.start).toHaveBeenCalled();

    await controller.stop();
    expect(__mockFns.stop).toHaveBeenCalled();

    await controller.announceAndStop("done");
    expect(__mockFns.announceAndStop).toHaveBeenCalledWith("done");

    await controller.setLanguage("en-US");
    expect(__mockFns.setLanguage).toHaveBeenCalledWith("en-US");

    expect(controller.getExtractedFields()).toHaveLength(1);
    expect(__mockFns.getExtractedFields).toHaveBeenCalled();

    controller.restartBhashiniSession?.();
    expect(__mockFns.restartBhashiniSession).toHaveBeenCalled();
  });

  it("debug API exposes getExtractedFields and getLatestExtractedFields", async () => {
    const controller = await initializeVoiceForm({
      formSelector: "#form",
      bedrock: { modelId: "anthropic.claude-3" },
      autoStart: false,
    });

    expect(typeof controller.debug?.getExtractedFields).toBe("function");
    expect(typeof controller.debug?.getLatestExtractedFields).toBe("function");
    expect(controller.debug!.getExtractedFields()).toHaveLength(1);
    expect(controller.debug!.getLatestExtractedFields).toBe(
      getLatestExtractedFields,
    );
  });

  it("logs debug messages when logExtractedFields is set", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await initializeVoiceForm({
      formSelector: "#form",
      bedrock: { modelId: "anthropic.claude-3" },
      autoStart: false,
      debug: { logExtractedFields: true },
    });
    expect(logSpy).toHaveBeenCalled();
  });

  it("forwards autoStart errors to onError hook", async () => {
    const onError = vi.fn();
    const startErr = new Error("boom");
    __mockFns.start.mockRejectedValueOnce(startErr);
    await initializeVoiceForm({
      formSelector: "#form",
      bedrock: { modelId: "anthropic.claude-3" },
      autoStart: true,
      uiHooks: { onError },
      debug: { logExtractedFields: true },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ error: startErr }),
    );
  });

  it("normalizes non-Error rejections from start", async () => {
    const onError = vi.fn();
    __mockFns.start.mockRejectedValueOnce("string failure");
    await initializeVoiceForm({
      formSelector: "#form",
      bedrock: { modelId: "anthropic.claude-3" },
      autoStart: true,
      uiHooks: { onError },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });
});
