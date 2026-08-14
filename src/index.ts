// Top-level router. Dispatches to v1 (Azure) or v2 (Sarvam) based on which
// speech-provider config the caller supplies.
//
// - sarvamSpeech / sarvamProxy in options → v2 path (new, Sarvam-first).
// - azureSpeech / bhashiniSpeech / (legacy) sarvamSpeech-via-v1 in options → v1 path.
//
// Both v1 and v2 are also exported under named namespaces for callers that
// want to pin a version explicitly.

import {
  initializeVoiceForm as initializeV1,
  type VoiceFormController as V1Controller,
} from "./v1";
import {
  initializeVoiceForm as initializeV2,
  type V2VoiceFormController,
} from "./v2";

export * as v1 from "./v1";
export * as v2 from "./v2";

export type AnyVoiceFormController = V1Controller | V2VoiceFormController;

export async function initializeVoiceForm(
  options: any,
): Promise<AnyVoiceFormController> {
  if (
    options &&
    (options.sarvamSpeech?.apiKey || options.sarvamProxy?.provider)
  ) {
    return initializeV2(options);
  }
  return initializeV1(options);
}
