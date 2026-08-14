import { AwsBedrockRouter } from "./bedrockRouter";
import { VoiceFormService } from "./VoiceFormService";
import {
  BedrockRouter,
  BedrockRouterConfig,
  BedrockRoutingRequest,
  BedrockRoutingResponse,
  BhashiniSpeechConfig,
  SarvamSpeechConfig,
  FieldAssignment,
  SpeechProvider,
  SupportedLanguage,
  UiHooks,
  VoiceFormDebugApi,
  VoiceFormFieldDescriptor,
  VoiceFormInitOptions,
} from "./types";
import { getLatestExtractedFields } from "./debugState";

export interface VoiceFormController {
  start(): Promise<void>;
  stop(): Promise<void>;
  announceAndStop(message: string): Promise<void>;
  setLanguage(language: SupportedLanguage): Promise<void>;
  getExtractedFields(): VoiceFormFieldDescriptor[];
  restartBhashiniSession?: () => void; // Optional, only available for Bhashini provider
  debug?: VoiceFormDebugApi;
}

export async function initializeVoiceForm(
  options: VoiceFormInitOptions,
): Promise<VoiceFormController> {
  if (options.debug?.logExtractedFields) {
    console.log("[VoiceForm] initializeVoiceForm called with options:", {
      formSelector: options.formSelector,
      autoStart: options.autoStart,
    });
  }

  const mergedOptions: VoiceFormInitOptions = {
    ...options,
    autoStart: options.autoStart ?? true,
  };

  if (mergedOptions.debug?.logExtractedFields) {
    console.log("[VoiceForm] Creating VoiceFormService instance...");
  }
  const service = new VoiceFormService(mergedOptions);

  if (mergedOptions.debug?.logExtractedFields) {
    console.log("[VoiceForm] Calling service.initialize()...");
  }
  await service.initialize();

  if (mergedOptions.debug?.logExtractedFields) {
    console.log("[VoiceForm] Service initialized, creating controller...");
  }
  const controller: VoiceFormController = {
    start: () => service.start(),
    stop: () => service.stop(),
    announceAndStop: (message: string) => service.announceAndStop(message),
    setLanguage: (language: SupportedLanguage) => service.setLanguage(language),
    getExtractedFields: () => service.getExtractedFields(),
    restartBhashiniSession: () => service.restartBhashiniSession(),
    debug: {
      getExtractedFields: () => service.getExtractedFields(),
      getLatestExtractedFields,
    },
  };

  if (mergedOptions.autoStart) {
    if (mergedOptions.debug?.logExtractedFields) {
      console.log("[VoiceForm] autoStart is enabled, starting service...");
    }
    void service.start().catch((error) => {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      if (mergedOptions.debug?.logExtractedFields) {
        console.error("[VoiceForm] Error during autoStart:", normalized);
      }
      mergedOptions.uiHooks?.onError?.({ error: normalized });
    });
  }

  if (mergedOptions.debug?.logExtractedFields) {
    console.log("[VoiceForm] Controller created and ready to return");
  }
  return controller;
}

export {
  AwsBedrockRouter,
  type BedrockRouter,
  type BedrockRouterConfig,
  type BedrockRoutingRequest,
  type BedrockRoutingResponse,
  type BhashiniSpeechConfig,
  type SarvamSpeechConfig,
  type FieldAssignment,
  type SpeechProvider,
  type SupportedLanguage,
  type UiHooks,
  type VoiceFormInitOptions,
  type VoiceFormFieldDescriptor,
  type VoiceFormDebugApi,
};

export { getLatestExtractedFields };
