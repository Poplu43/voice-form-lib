/// <reference types="vite/client" />
/// <reference path="./v1/vite-env.d.ts" />

declare interface ImportMetaEnv {
  readonly VITE_SARVAM_API_KEY?: string;
  readonly VITE_LANGFUSE_PUBLIC_KEY?: string;
  readonly VITE_LANGFUSE_SECRET_KEY?: string;
  readonly VITE_LANGFUSE_BASE_URL?: string;
}
