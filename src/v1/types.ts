export type SupportedLanguage = "en-US" | "hi-IN";

export interface LanguageMetadata {
  code: SupportedLanguage;
  speechName: string;
  ttsVoice: string;
  displayLabel: string;
}

export interface UiHooks {
  onPrompt?: (payload: { text: string; fieldId?: string }) => void;
  onSpeechSynthesis?: (payload: { text: string }) => void;
  onTranscript?: (payload: { text: string; isFinal?: boolean }) => void;
  onAssignment?: (payload: {
    fieldId: string;
    value: string | string[];
  }) => void;
  onStatus?: (payload: { message: string }) => void;
  onError?: (payload: { error: Error }) => void;
  onStepChange?: (payload: {
    stepId: string;
    label: string;
    index: number;
    fieldIds: string[];
  }) => void;
  onFieldsExtracted?: (payload: { fields: VoiceFormFieldDescriptor[] }) => void;
  onQuit?: (payload: {
    confirmed: boolean;
    reason?: "no-response" | "completed" | "user-stop" | "cancelled";
  }) => void;
  onResetRequested?: () => Promise<void> | void;
}

export interface VoiceFormDebugOptions {
  logExtractedFields?: boolean;
}

export interface VoiceFormDebugApi {
  getExtractedFields(): VoiceFormFieldDescriptor[];
  getLatestExtractedFields(): VoiceFormFieldDescriptor[];
}

export type SpeechProvider = "azure" | "bhashini" | "sarvam";

export interface BhashiniSpeechConfig {
  // Either configEndpoint (recommended) or both socketUrl+apiKey must be provided
  configEndpoint?: string; // Server-side proxy endpoint (RECOMMENDED)
  socketUrl?: string; // Bhashini WebSocket URL (for direct connection)
  apiKey?: string; // Bhashini API key (for direct connection)

  // Language selection (required)
  language?: string; // Language code: "hi" for Hindi, "en" for English, etc.

  // Optional TTS customization
  ttsGender?: "male" | "female"; // TTS voice gender (default: female)
  ttsSpeed?: number; // TTS speech speed, 0.5 to 2.0 (default: 1.0)
}

export interface SarvamSpeechConfig {
  // Required
  apiKey: string; // Sarvam API subscription key

  // Language selection (required)
  language?: string; // Language code: "hi-IN" for Hindi, "en-IN" for English, etc.

  // Optional TTS customization
  speaker?: string; // Voice speaker name (default: varies by language)
  pitch?: number; // TTS pitch: 0.5 to 2.0 (default: 1.0)
  pace?: number; // TTS speed: 0.3 to 3.0 (default: 1.0)
  loudness?: number; // TTS loudness: 0.5 to 2.0 (default: 1.0)
}

export interface VoiceFormInitOptions {
  formSelector: string;
  // One of azureSpeech, bhashiniSpeech, or sarvamSpeech must be provided
  azureSpeech?: {
    subscriptionKey: string;
    region: string;
  };
  bhashiniSpeech?: BhashiniSpeechConfig;
  sarvamSpeech?: SarvamSpeechConfig;
  bedrock: BedrockRouterConfig;
  uiHooks?: UiHooks;
  autoStart?: boolean;
  language?: SupportedLanguage;
  defaultLanguage?: SupportedLanguage;
  debug?: VoiceFormDebugOptions;
}

export interface BedrockRouterConfig {
  modelId: string;
  client?: import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;
  router?: BedrockRouter;
}

export interface BedrockRouter {
  routeAnswer(input: BedrockRoutingRequest): Promise<BedrockRoutingResponse>;
}

export interface BedrockRoutingRequest {
  userInput: string;
  /** Field currently being asked. pendingFields[0] should also be this field. */
  currentFieldId?: string;
  pendingFields: VoiceFormFieldDescriptor[];
  completedFields: VoiceFormFieldDescriptor[];
  language?: SupportedLanguage;
  isEditMode?: boolean;
}

export interface BedrockRoutingResponse {
  assignments: FieldAssignment[];
  followUp?: string;
  specialCommand?: {
    type: "reset" | "quit" | "finish";
    confidence: number;
  };
}

export interface FieldAssignment {
  fieldId: string;
  value?: string | string[];
  confidence?: number;
  skip?: boolean;
}

export type VoiceFormFieldType =
  | "text"
  | "number"
  | "email"
  | "tel"
  | "date"
  | "select"
  | "radio"
  | "checkbox"
  | "textarea"
  | "file";

export interface ConstraintSet {
  required: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface VoiceFormFieldDescriptor {
  id: string;
  name: string;
  label: string;
  type: VoiceFormFieldType;
  options?: Array<{ value: string; label: string }>;
  allowMultiple?: boolean;
  constraints: ConstraintSet;
  groupId?: string;
  groupLabel?: string;
  groupIndex?: number;
}
