// Resolves the CDN (or self-hosted override) URLs for the binary assets the
// "rnnoise-vad" noise-suppression pipeline needs at runtime: RNNoise's
// worklet + wasm, and Silero VAD's ONNX model + onnxruntime-web wasm runtime.
//
// Defaulting to jsdelivr (which serves any published npm package's files
// as-is) means consuming apps (hp_charcert, myscheme-form-builder) get this
// entirely by bumping the library version — no build/asset-copy step needed.
// `assetBaseUrl` lets a host override this with a self-hosted path (e.g. for
// offline/restricted-network deployments) without any API change.

// Pinned to the exact versions resolved in this package's own dependency
// tree (see package-lock.json) so the worklet JS and wasm binaries loaded
// from the CDN are guaranteed to be from matching builds.
export const DEFAULT_ASSET_VERSIONS = {
  vadWeb: "0.0.30",
  webNoiseSuppressor: "0.3.5",
  onnxruntimeWeb: "1.24.3",
} as const;

export interface NoiseSuppressionAssetUrls {
  rnnoiseWorkletUrl: string;
  rnnoiseWasmUrl: string;
  rnnoiseWasmSimdUrl: string;
  sileroModelUrl: string;
  /** Base path handed to onnxruntime-web's `ort.env.wasm.wasmPaths`. */
  onnxWasmBasePath: string;
}

function jsdelivr(pkg: string, version: string, path: string): string {
  return `https://cdn.jsdelivr.net/npm/${pkg}@${version}/${path}`;
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

export function resolveNoiseSuppressionAssetUrls(
  assetBaseUrl?: string,
): NoiseSuppressionAssetUrls {
  if (assetBaseUrl) {
    const base = withTrailingSlash(assetBaseUrl);
    return {
      rnnoiseWorkletUrl: `${base}rnnoise/workletProcessor.js`,
      rnnoiseWasmUrl: `${base}rnnoise.wasm`,
      rnnoiseWasmSimdUrl: `${base}rnnoise_simd.wasm`,
      sileroModelUrl: `${base}silero_vad_v5.onnx`,
      onnxWasmBasePath: base,
    };
  }

  const { vadWeb, webNoiseSuppressor, onnxruntimeWeb } = DEFAULT_ASSET_VERSIONS;
  return {
    rnnoiseWorkletUrl: jsdelivr(
      "@sapphi-red/web-noise-suppressor",
      webNoiseSuppressor,
      "dist/rnnoise/workletProcessor.js",
    ),
    rnnoiseWasmUrl: jsdelivr(
      "@sapphi-red/web-noise-suppressor",
      webNoiseSuppressor,
      "dist/rnnoise.wasm",
    ),
    rnnoiseWasmSimdUrl: jsdelivr(
      "@sapphi-red/web-noise-suppressor",
      webNoiseSuppressor,
      "dist/rnnoise_simd.wasm",
    ),
    sileroModelUrl: jsdelivr(
      "@ricky0123/vad-web",
      vadWeb,
      "dist/silero_vad_v5.onnx",
    ),
    onnxWasmBasePath: jsdelivr("onnxruntime-web", onnxruntimeWeb, "dist/"),
  };
}
