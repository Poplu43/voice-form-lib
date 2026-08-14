import { V2VoiceFormService } from "./voiceFormService";
import type {
  V2VoiceFormController,
  V2VoiceFormInitOptions,
} from "./types";

export async function initializeVoiceForm(
  options: V2VoiceFormInitOptions,
): Promise<V2VoiceFormController> {
  const service = new V2VoiceFormService(options);
  await service.initialize();

  const controller: V2VoiceFormController = {
    start: () => service.start(),
    stop: () => service.stop(),
    setLanguage: (lang) => service.setLanguage(lang),
    getExtractedFields: () => service.getExtractedFields(),
    announceAndStop: (message) => service.announceAndStop(message),
    getAudioRecordings: () => service.getAudioRecordings(),
  };

  if (options.autoStart ?? false) {
    void service.start().catch((err) => {
      const normalized =
        err instanceof Error ? err : new Error(String(err));
      options.uiHooks?.onError?.({ error: normalized });
    });
  }

  return controller;
}

export { SarvamSpeechService } from "./sarvamSpeech";
export * from "./proximityMonitor";
export * from "./proximityDetector";
export { SarvamHttpProxyProvider } from "./sarvamProxyProvider";
export { BhashiniSpeechService } from "./bhashiniSpeech";
export {
  BrowserNoiseSuppressor,
  type NoiseSuppressionConfig,
  type NoiseSuppressedCaptureOptions,
} from "./noiseSuppression";
export { BedrockTranslator } from "./bedrockTranslator";
export { V2BedrockRouter, type V2BedrockRouterOptions } from "./v2BedrockRouter";
export {
  BedrockProxyRouter,
  BedrockProxyTranslator,
  type BedrockProxyTranslatorOptions,
  type BedrockProxyTranslatorTranslateOptionsRequest,
  type BedrockProxyTranslatorTranslatePromptRequest,
} from "./proxyRouters";
export { V2VoiceFormService } from "./voiceFormService";
export {
  EvaluationLogger,
  type EvaluationSample,
} from "./evaluationLogger";
export * from "./types";
