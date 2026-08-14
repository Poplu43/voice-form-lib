import type { VoiceFormFieldDescriptor } from "./types";

let latestExtractedFields: VoiceFormFieldDescriptor[] = [];

export function storeExtractedFields(
  fields: VoiceFormFieldDescriptor[],
): void {
  latestExtractedFields = fields;
}

export function getLatestExtractedFields(): VoiceFormFieldDescriptor[] {
  return latestExtractedFields;
}
