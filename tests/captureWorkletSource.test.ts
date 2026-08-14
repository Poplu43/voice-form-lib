import { describe, expect, it } from "vitest";
import {
  CAPTURE_PROCESSOR_NAME,
  createCaptureWorkletBlobUrl,
} from "../src/v2/captureWorkletSource";

describe("createCaptureWorkletBlobUrl", () => {
  it("returns a Blob URL string", () => {
    const url = createCaptureWorkletBlobUrl();
    expect(typeof url).toBe("string");
    expect(url.length).toBeGreaterThan(0);
  });

  it("uses a stable, non-empty processor name", () => {
    expect(CAPTURE_PROCESSOR_NAME).toBe("vff-capture-processor");
  });
});
