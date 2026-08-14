import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

import { bedrockProxyPlugin } from "./server/bedrockProxyPlugin";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveHttpsConfig():
  | {
      key: Buffer;
      cert: Buffer;
      ca?: Buffer;
    }
  | undefined {
  const useHttpsEnv = process.env.DEV_SERVER_USE_HTTPS;
  if (!useHttpsEnv) {
    return undefined;
  }

  const normalized = useHttpsEnv.trim().toLowerCase();
  const useHttps = normalized === "1" || normalized === "true";
  if (!useHttps) {
    return undefined;
  }

  const keyPath = process.env.DEV_SERVER_SSL_KEY;
  const certPath = process.env.DEV_SERVER_SSL_CERT;
  if (!keyPath || !certPath) {
    throw new Error(
      "DEV_SERVER_USE_HTTPS is enabled, but DEV_SERVER_SSL_KEY or DEV_SERVER_SSL_CERT is not set.",
    );
  }

  const resolvedKey = resolve("demo-myscheme", keyPath);
  const resolvedCert = resolve("demo-myscheme", certPath);
  const httpsConfig: {
    key: Buffer;
    cert: Buffer;
    ca?: Buffer;
  } = {
    key: readFileSync(resolvedKey),
    cert: readFileSync(resolvedCert),
  };

  const caPath = process.env.DEV_SERVER_SSL_CA;
  if (caPath) {
    httpsConfig.ca = readFileSync(resolve(__dirname, caPath));
  }

  return httpsConfig;
}

const httpsConfig = resolveHttpsConfig();

// Pick which demo folder to serve via DEMO_ROOT (defaults to the original demo).
// Examples: DEMO_ROOT=demo-umang-second yarn dev
//           DEMO_ROOT=demo-myscheme    yarn dev
const demoRoot = (process.env.DEMO_ROOT || "demo-myscheme").trim();

export default defineConfig({
  root: "demo-myscheme",
  envDir: __dirname,
  // Expose all VITE_* variables to the browser (direct-credentials mode).
  envPrefix: ["VITE_"],
  plugins: [bedrockProxyPlugin()],
  server: {
    port: 3045,
    host: "0.0.0.0",
    allowedHosts: [".myscheme.in"],
    https: httpsConfig,
    proxy: {
      // Proxy Sarvam TTS to avoid CORS — browser calls /api/sarvam-tts (same-origin),
      // Vite server forwards to api.sarvam.ai (server-side, no CORS).
      "/api/sarvam-tts": {
        target: "https://api.sarvam.ai",
        changeOrigin: true,
        rewrite: () => "/text-to-speech",
      },
      // Proxy Sarvam STT to avoid CORS — the ported voiceform.ts posts to
      // /api/sarvam-stt (same-origin); Vite forwards it to api.sarvam.ai.
      "/api/sarvam-stt": {
        target: "https://api.sarvam.ai",
        changeOrigin: true,
        rewrite: () => "/speech-to-text",
      },
    },
  },
  build: {
    outDir: "../demo-dist",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@voice-form": resolve(__dirname, "src"),
    },
  },
});