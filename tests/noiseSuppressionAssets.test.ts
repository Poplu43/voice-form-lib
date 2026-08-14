import { describe, expect, it } from "vitest";
import {
  DEFAULT_ASSET_VERSIONS,
  resolveNoiseSuppressionAssetUrls,
} from "../src/v2/noiseSuppressionAssets";

describe("resolveNoiseSuppressionAssetUrls", () => {
  it("defaults to jsdelivr CDN URLs pinned to the installed dependency versions", () => {
    const urls = resolveNoiseSuppressionAssetUrls();
    expect(urls.rnnoiseWorkletUrl).toBe(
      `https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@${DEFAULT_ASSET_VERSIONS.webNoiseSuppressor}/dist/rnnoise/workletProcessor.js`,
    );
    expect(urls.rnnoiseWasmUrl).toBe(
      `https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@${DEFAULT_ASSET_VERSIONS.webNoiseSuppressor}/dist/rnnoise.wasm`,
    );
    expect(urls.rnnoiseWasmSimdUrl).toBe(
      `https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@${DEFAULT_ASSET_VERSIONS.webNoiseSuppressor}/dist/rnnoise_simd.wasm`,
    );
    expect(urls.sileroModelUrl).toBe(
      `https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@${DEFAULT_ASSET_VERSIONS.vadWeb}/dist/silero_vad_v5.onnx`,
    );
    expect(urls.onnxWasmBasePath).toBe(
      `https://cdn.jsdelivr.net/npm/onnxruntime-web@${DEFAULT_ASSET_VERSIONS.onnxruntimeWeb}/dist/`,
    );
  });

  it("uses a self-hosted base URL override when provided", () => {
    const urls = resolveNoiseSuppressionAssetUrls("https://example.gov.in/voice-assets");
    expect(urls.rnnoiseWorkletUrl).toBe(
      "https://example.gov.in/voice-assets/rnnoise/workletProcessor.js",
    );
    expect(urls.sileroModelUrl).toBe(
      "https://example.gov.in/voice-assets/silero_vad_v5.onnx",
    );
    expect(urls.onnxWasmBasePath).toBe("https://example.gov.in/voice-assets/");
  });

  it("tolerates a trailing slash on the override base URL", () => {
    const urls = resolveNoiseSuppressionAssetUrls("https://example.gov.in/voice-assets/");
    expect(urls.rnnoiseWasmUrl).toBe(
      "https://example.gov.in/voice-assets/rnnoise.wasm",
    );
  });
});
