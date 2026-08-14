declare global {
  interface ImportMetaEnv {
    readonly VITE_AZURE_SPEECH_KEY?: string;
    readonly VITE_AZURE_SPEECH_REGION?: string;
    readonly VITE_BEDROCK_MODEL_ID?: string;
    readonly VITE_BEDROCK_REGION?: string;
    readonly VITE_AWS_ACCESS_KEY_ID?: string;
    readonly VITE_AWS_SECRET_ACCESS_KEY?: string;
    readonly VITE_AWS_SESSION_TOKEN?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
