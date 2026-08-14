import {
  AudioConfig,
  AudioOutputStream,
  PullAudioOutputStream,
  CancellationReason,
  Recognizer,
  RecognitionEventArgs,
  ResultReason,
  SpeechConfig,
  SpeechRecognitionCanceledEventArgs,
  SpeechRecognitionEventArgs,
  SpeechRecognizer,
  SpeechSynthesizer,
  SpeechSynthesisResult,
  PhraseListGrammar,
} from "microsoft-cognitiveservices-speech-sdk";
import { AwsBedrockRouter, findBestOptionMatch } from "./bedrockRouter";
import {
  extractFormFields,
  ExtractedFormField,
  ensureCustomDropdownOptions,
  getDropdownOptionContainers,
  isCustomDropdownElement,
  openDropdownElement,
  isDropdownExpanded,
  readDropdownOptionMetadata,
  waitForCustomDropdownRender,
  closeDropdownElement,
} from "./formExtractor";
import {
  BedrockRouter,
  FieldAssignment,
  LanguageMetadata,
  SpeechProvider,
  SupportedLanguage,
  UiHooks,
  VoiceFormDebugOptions,
  VoiceFormFieldDescriptor,
  VoiceFormInitOptions,
} from "./types";
import { storeExtractedFields } from "./debugState";
import { BhashiniSpeechService, BhashiniASRClient } from "./bhashiniSpeech";
import { SarvamSpeechService, SarvamSTTMessage } from "./sarvamSpeech";

const LANGUAGE_CHOICES: LanguageMetadata[] = [
  {
    code: "en-US",
    speechName: "English",
    ttsVoice: "en-US-JennyNeural",
    displayLabel: "English",
  },
  {
    code: "hi-IN",
    speechName: "Hindi",
    ttsVoice: "hi-IN-MadhurNeural",
    displayLabel: "हिंदी / Hindi",
  },
];

const INITIAL_SILENCE_TIMEOUT_MS = 5000;
const SILENCE_TIMEOUT_MS = 2000;
const DROPDOWN_SELECTION_RETRY_MS = 100;

const LOCALE_MESSAGES = {
  en: {
    status_voice_started: "Voice assistant is ready. You can start speaking.",
    status_form_completed: "All fields completed successfully!",
    status_skipped: "Skipped {label}",
    status_reviewing: "Reviewing {label}",
    status_now_on: "Moving to {label}",
    all_complete: "All questions are complete. Thank you!",
    final_review_prompt:
      "All visible fields are complete. Would you like to edit any value? Say yes to edit or no to finish.",
    final_review_which_field:
      "Please tell me which field you would like to edit and what the new value should be.",
    final_edit_continue_prompt:
      "Would you like to edit any other field? Please say the field name and new value, or say no to finish.",
    final_edit_no_change: "No problem. Thank you for completing the form!",
    final_review_no_edits: "No problem. Thank you for completing the form!",
    final_review_updated:
      "Updated {labels}. Checking if any new fields need to be filled.",
    final_edit_updated: "Updated {labels}.",
    field_updated: "Updated {labels}.",
    final_review_retry:
      "I did not hear you. Please say yes to edit or no to finish.",
    final_edit_retry:
      "I did not hear you. Please say the field name and new value, or say no to finish.",
    final_review_new_fields:
      "Some new fields are now available. Let me ask about them.",
    optional_skip: "{label} is optional, so I'll skip it.",
    optional_skip_status: "{label} is optional, skipping it.",
    prompt_retry: "I did not hear anything. Let's try again.",
    no_response_closing: "No response detected. Closing the form.",
    mapping_failure: "I could not map that to any question. Let's try again.",
    apply_failure: "I could not apply that input. Please try again.",
    revisit_field: "Let's revisit {label}.",
    recorded_fields: "Recorded {labels}.",
    issues_error_prefix:
      "I applied what I could, but I still need attention on",
    issues_warning_prefix: "I captured your answers, but a few notes",
    step_advance_prompt:
      "You have completed {current}. Would you like to move to {next}? Say yes to continue or no to stay on {current}.",
    step_yes_no_retry: "I did not hear you. Please say yes or no.",
    step_stay: "No problem, we will stay on {current}.",
    step_stop: "Voice assistant stopped. You can restart anytime.",
    manual_intervention_detected:
      "Manual intervention detected. Stopping voice assistant. You can restart anytime.",
    step_clarify:
      "Please clearly say yes to continue or no to stay on this step.",
    step_review_intro:
      "Alright, we will stay on {current}. Tell me what you'd like to update.",
    step_review_no_changes:
      "I did not hear any changes. We will stay on this section until you're ready.",
    step_review_map_failure:
      "I could not map that update to this section. We can try again whenever you're ready.",
    step_review_apply_failure:
      "I could not apply that update. We will stay on this section.",
    step_review_updated: "Updated {labels}.",
    step_begin: "Let's begin with {current}.",
    step_move: "Moving to {current}.",
    reset_confirm:
      "Are you sure you want to reset the entire form? All entered data will be cleared. Say yes to reset or no to continue.",
    reset_confirm_retry:
      "I did not hear you. Please say yes to reset or no to continue.",
    reset_completed:
      "Form has been reset. All fields have been cleared. Let's start from the beginning.",
    reset_cancelled: "Reset cancelled. Continuing with the form.",
    quit_confirm:
      "Are you sure you want to quit? Say yes to stop the voice flow or no to continue.",
    quit_confirm_retry:
      "I did not hear you. Please say yes to quit or no to continue.",
    quit_cancelled: "Continuing with the form.",
    question_base: "Please provide {label}.",
    question_options: "Please provide {label}. Options include: {options}.",
    question_options_more:
      "Please provide {label}. Options include: {options}, and more options are available.",
    missing_value: "I still need a value for {label}.",
    invalid_generic: "That value does not meet the field requirements.",
    skip_not_allowed: "{label} is required and cannot be skipped.",
    min_length: "{label} should be at least {min} characters.",
    max_length: "{label} should be no more than {max} characters.",
    pattern_mismatch: "{label} does not match the expected format.",
    must_be_number: "{label} must be a number.",
    min_value: "{label} must be at least {min}.",
    max_value: "{label} must be at most {max}.",
    step_increment: "{label} must follow increments of {step}.",
    option_not_available:
      "{value} is not one of the available options for {label}.",
    multi_select_warning: "I do not recognize {values}.",
    invalid_digit_code: "{label} should contain digits in the expected format.",
    invalid_digit_code_length: "{label} should be exactly {length} digits.",
  },
  hi: {
    status_voice_started: "वॉइस सहायक शुरू हो गया है",
    status_form_completed: "फ़ॉर्म पूरा हो गया है",
    status_skipped: "{label} को छोड़ दिया गया है",
    status_reviewing: "{label} की समीक्षा चल रही है",
    status_now_on: "अब {label} पर हैं",
    all_complete: "सभी प्रश्न पूरे हो गए हैं। धन्यवाद!",
    final_review_prompt:
      "सभी दृश्य फ़ील्ड पूर्ण हैं। क्या आप कोई मान संपादित करना चाहेंगे? संपादित करने के लिए हाँ या समाप्त करने के लिए नहीं कहें।",
    final_review_which_field:
      "कृपया बताइए कि आप कौन सा फ़ील्ड संपादित करना चाहते हैं और नया मान क्या होना चाहिए।",
    final_edit_continue_prompt:
      "क्या आप कोई अन्य फ़ील्ड संपादित करना चाहेंगे? कृपया फ़ील्ड का नाम और नया मान बताएं, या समाप्त करने के लिए नहीं कहें।",
    final_edit_no_change: "कोई बात नहीं। फ़ॉर्म पूरा करने के लिए धन्यवाद!",
    final_review_no_edits: "कोई बात नहीं। फ़ॉर्म पूरा करने के लिए धन्यवाद!",
    final_review_updated:
      "{labels} अपडेट कर दिया है। जाँच रहा हूँ कि कोई नया फ़ील्ड भरने की आवश्यकता है या नहीं।",
    final_edit_updated: "{labels} अपडेट कर दिया है।",
    field_updated: "{labels} अपडेट कर दिया है।",
    final_review_retry:
      "मुझे आपको नहीं सुना। कृपया संपादित करने के लिए हाँ या समाप्त करने के लिए नहीं कहें।",
    final_edit_retry:
      "मुझे सुनाई नहीं दिया। कृपया फ़ील्ड का नाम और नया मान बताएं, या समाप्त करने के लिए नहीं कहें।",
    final_review_new_fields:
      "कुछ नए फ़ील्ड अब उपलब्ध हैं। मैं उनके बारे में पूछता हूँ।",
    optional_skip: "{label} वैकल्पिक है, इसे छोड़ रहा हूँ।",
    optional_skip_status: "{label} वैकल्पिक है, इसे छोड़ दिया गया है।",
    prompt_retry: "मुझे कुछ सुनाई नहीं दिया। चलिए फिर से कोशिश करते हैं।",
    no_response_closing: "कोई प्रतिक्रिया नहीं मिली। फ़ॉर्म बंद कर रहे हैं।",
    mapping_failure:
      "मैं उसे किसी प्रश्न से नहीं जोड़ पाया। चलिए फिर से कोशिश करते हैं।",
    apply_failure:
      "मैं उस इनपुट को लागू नहीं कर पाया। कृपया दोबारा प्रयास करें।",
    revisit_field: "चलिए {label} पर फिर से ध्यान देते हैं।",
    recorded_fields: "{labels} दर्ज कर लिया है।",
    issues_error_prefix:
      "मैंने जहाँ संभव था वहाँ भर दिया है, लेकिन अभी इन पर ध्यान चाहिए",
    issues_warning_prefix:
      "मैंने आपके उत्तर दर्ज कर लिए हैं, लेकिन कुछ बातें ध्यान देने योग्य हैं",
    step_advance_prompt:
      "आपने {current} पूरा कर लिया है। क्या आप {next} पर जाना चाहेंगे? आगे बढ़ने के लिए हाँ कहें या इस खंड पर बने रहने के लिए नहीं कहें।",
    step_yes_no_retry:
      "मुझे आपका उत्तर नहीं सुनाई दिया। कृपया हाँ या नहीं कहें।",
    step_stay: "कोई बात नहीं, हम {current} पर ही रहेंगे।",
    step_stop: "वॉइस सहायक को रोक रहा हूँ। आप कभी भी फिर से शुरू कर सकते हैं।",
    manual_intervention_detected:
      "मैनुअल हस्तक्षेप का पता चला। वॉइस सहायक बंद कर रहा हूँ। आप कभी भी फिर से शुरू कर सकते हैं।",
    step_clarify:
      "कृपया स्पष्ट रूप से आगे बढ़ने के लिए हाँ या रुकने के लिए नहीं कहें।",
    step_review_intro:
      "ठीक है, हम {current} पर ही रहेंगे। बताइए आप क्या बदलना चाहेंगे।",
    step_review_no_changes:
      "मुझे कोई बदलाव सुनाई नहीं दिया। हम तब तक यहीं रहेंगे जब तक आप तैयार न हों।",
    step_review_map_failure:
      "मैं उस अपडेट को इस खंड से नहीं जोड़ पाया। जब भी आप तैयार हों हम फिर कोशिश कर सकते हैं।",
    step_review_apply_failure:
      "मैं उस अपडेट को लागू नहीं कर पाया। हम इसी खंड में रहेंगे।",
    step_review_updated: "{labels} अपडेट कर दिया है।",
    step_begin: "चलिए {current} से शुरू करते हैं।",
    step_move: "{current} पर जा रहे हैं।",
    reset_confirm:
      "क्या आप पूरा फ़ॉर्म रीसेट करना चाहते हैं? सभी दर्ज डेटा साफ़ हो जाएगा। रीसेट करने के लिए हाँ या जारी रखने के लिए नहीं कहें।",
    reset_confirm_retry:
      "मुझे सुनाई नहीं दिया। कृपया रीसेट करने के लिए हाँ या जारी रखने के लिए नहीं कहें।",
    reset_completed:
      "फ़ॉर्म रीसेट हो गया है। सभी फ़ील्ड साफ़ कर दिए गए हैं। चलिए शुरू से शुरू करते हैं।",
    reset_cancelled: "रीसेट रद्द कर दिया गया। फ़ॉर्म जारी रख रहे हैं।",
    quit_confirm:
      "क्या आप निकलना चाहते हैं? वॉइस फ़्लो बंद करने के लिए हाँ या जारी रखने के लिए नहीं कहें।",
    quit_confirm_retry:
      "मुझे सुनाई नहीं दिया। कृपया बाहर निकलने के लिए हाँ या जारी रखने के लिए नहीं कहें।",
    quit_cancelled: "फ़ॉर्म जारी रख रहे हैं।",
    question_base: "कृपया {label} बताइए।",
    question_options: "कृपया {label} बताइए। उपलब्ध विकल्प हैं: {options}।",
    question_options_more:
      "कृपया {label} बताइए। उपलब्ध विकल्प हैं: {options}, और भी विकल्प उपलब्ध हैं।",
    missing_value: "मुझे अभी भी {label} का मान चाहिए।",
    invalid_generic: "यह मान फ़ील्ड की शर्तों को पूरा नहीं करता।",
    skip_not_allowed: "{label} अनिवार्य है, इसे छोड़ा नहीं जा सकता।",
    min_length: "{label} कम से कम {min} अक्षर का होना चाहिए।",
    max_length: "{label} अधिकतम {max} अक्षरों का होना चाहिए।",
    pattern_mismatch: "{label} अपेक्षित स्वरूप से मेल नहीं खाता।",
    must_be_number: "{label} संख्या होनी चाहिए।",
    min_value: "{label} कम से कम {min} होना चाहिए।",
    max_value: "{label} अधिकतम {max} होना चाहिए।",
    step_increment: "{label} को {step} के अंतराल का पालन करना चाहिए।",
    option_not_available: "{value}, {label} के उपलब्ध विकल्पों में नहीं है।",
    multi_select_warning: "{values} को पहचान नहीं पाया।",
    invalid_digit_code:
      "{label} में अपेक्षित स्वरूप के अनुसार केवल अंक होने चाहिए।",
    invalid_digit_code_length: "{label} ठीक {length} अंकों का होना चाहिए।",
  },
} as const;

type MessagesByLocale = typeof LOCALE_MESSAGES;
type MessageKey = keyof MessagesByLocale["en"];

type AssignmentIssue = {
  field: ExtractedFormField;
  message: string;
  type: "error" | "warning";
};

type StepInfo = {
  id: string;
  label: string;
  index: number;
  fieldIds: string[];
};

type FieldStateEntry = {
  fieldId: string;
  value: string | string[];
  confidence?: number;
  skipped?: boolean;
};

type ListenContext = {
  resolve: (value: string) => void;
  buffered: string;
  finalizeTimer: ReturnType<typeof setTimeout> | null;
  completed: boolean;
  allowConcurrentSpeech: boolean;
  heardSpeech: boolean;
  segments: string[];
  partial: string;
};

export class VoiceFormService {
  private speechProvider: SpeechProvider;
  private speechConfig!: SpeechConfig;
  private synthesizer: SpeechSynthesizer | null = null;
  private language: LanguageMetadata = LANGUAGE_CHOICES[0];
  private fields: ExtractedFormField[] = [];
  private router!: BedrockRouter;
  private fieldState = new Map<string, FieldStateEntry>();
  private readonly hooks: UiHooks;
  private readonly debug: VoiceFormDebugOptions;
  private initialized = false;
  private running = false;
  private formWasReset = false; // Flag to track when form is reset in edit flow
  private speakToken = 0;
  private speaking = false;
  private pendingSpeakResolve: (() => void) | null = null;
  private userSpeaking = false;
  private speechOngoingSince: number | null = null;
  private lastUserSpeechAt = 0;
  private lastSilenceAt = Date.now();
  private listenContext: ListenContext | null = null;
  private recognizerSetupPromise: Promise<void> | null = null;
  private silenceResetTimer: ReturnType<typeof setTimeout> | null = null;
  private speechGuard = 0;
  private flowPromise: Promise<void> | null = null;
  private speakingPromise: Promise<void> | null = null;
  private speechAudio: HTMLAudioElement | null = null;
  private speechAudioUrl: string | null = null;
  private audioContext: AudioContext | null = null;
  private audioPlaybackTeardown: ((error?: Error) => void) | null = null;
  private speechStream: PullAudioOutputStream | null = null;
  private steps: StepInfo[] = [];
  private currentStepIndex = 0;
  private activeListening: SpeechRecognizer | null = null;
  private listeningActive = false;
  private phraseListGrammar: PhraseListGrammar | null = null;

  // Bhashini-specific fields
  private bhashiniSpeechService: BhashiniSpeechService | null = null;
  private bhashiniClient: BhashiniASRClient | null = null;
  private bhashiniMediaStream: MediaStream | null = null;
  private bhashiniAudioContext: AudioContext | null = null;
  private bhashiniScriptProcessor: ScriptProcessorNode | null = null;
  private bhashiniSendInterval: ReturnType<typeof setInterval> | null = null;

  // Sarvam-specific fields
  private sarvamSpeechService: SarvamSpeechService | null = null;
  private sarvamSTTClient: any = null; // Connection from sarvamai library
  private sarvamMediaStream: MediaStream | null = null;
  private sarvamAudioContext: AudioContext | null = null;
  private sarvamScriptProcessor: ScriptProcessorNode | null = null;
  private sarvamSendInterval: ReturnType<typeof setInterval> | null = null;

  // Manual intervention detection
  private formChangeObserver: MutationObserver | null = null;
  private manualInterventionDetected = false;
  private isSettingValueProgrammatically = false;

  constructor(private readonly options: VoiceFormInitOptions) {
    this.hooks = options.uiHooks ?? {};
    this.debug = options.debug ?? {};

    if (this.debug.logExtractedFields) {
      console.log("[VoiceForm] VoiceFormService constructor called");
    }

    // Determine speech provider
    if (options.bhashiniSpeech) {
      this.speechProvider = "bhashini";
      this.bhashiniSpeechService = new BhashiniSpeechService({
        ...options.bhashiniSpeech,
        debug: this.debug.logExtractedFields,
      });
      if (this.debug.logExtractedFields) {
        console.log("[VoiceForm] Using Bhashini speech provider");
      }
    } else if (options.sarvamSpeech) {
      this.speechProvider = "sarvam";
      this.sarvamSpeechService = new SarvamSpeechService({
        ...options.sarvamSpeech,
        debug: this.debug.logExtractedFields,
      });
      if (this.debug.logExtractedFields) {
        console.log("[VoiceForm] Using Sarvam speech provider");
      }
    } else if (options.azureSpeech) {
      this.speechProvider = "azure";
      if (this.debug.logExtractedFields) {
        console.log("[VoiceForm] Using Azure speech provider");
      }
    } else {
      throw new Error(
        "Either azureSpeech, bhashiniSpeech, or sarvamSpeech configuration is required",
      );
    }

    if (this.debug.logExtractedFields) {
      console.log("[VoiceForm] VoiceFormService initialized successfully");
    }
  }

  private async playSynthesizedAudio(
    result: SpeechSynthesisResult,
    token: number,
    guard: number,
  ): Promise<void> {
    if (
      this.speechGuard !== guard ||
      this.speakToken !== token ||
      !result.audioData ||
      result.audioData.byteLength === 0
    ) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      if (this.speechGuard !== guard || this.speakToken !== token) {
        resolve();
        return;
      }

      const blob = new Blob([result.audioData], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.preload = "auto";

      let settled = false;

      const finalize = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;

        if (this.audioPlaybackTeardown === finalize) {
          this.audioPlaybackTeardown = null;
        }

        if (this.speechAudio === audio) {
          this.speechAudio = null;
        }

        if (this.speechAudioUrl === url) {
          URL.revokeObjectURL(url);
          this.speechAudioUrl = null;
        } else {
          URL.revokeObjectURL(url);
        }

        audio.onended = null;
        audio.onerror = null;

        if (!audio.paused) {
          try {
            audio.pause();
          } catch (_error) {
            // ignore pause errors during teardown
          }
        }
        audio.src = "";
        audio.load();

        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      this.audioPlaybackTeardown = finalize;

      audio.onended = () => finalize();
      audio.onerror = () => finalize(new Error("Audio playback failed."));

      this.speechAudio = audio;
      this.speechAudioUrl = url;

      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch((error) => {
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          finalize(normalized);
        });
      }
    });
  }

  private stopAudioPlayback(): void {
    if (!this.speechAudio && !this.audioPlaybackTeardown) {
      return;
    }

    if (this.speechAudio) {
      try {
        this.speechAudio.pause();
      } catch (_error) {
        // ignore pause errors during forced stop
      }
    }

    const teardown = this.audioPlaybackTeardown;
    this.audioPlaybackTeardown = null;

    if (teardown) {
      teardown();
      return;
    }

    if (this.speechAudio) {
      this.speechAudio.onended = null;
      this.speechAudio.onerror = null;
      this.speechAudio.src = "";
      this.speechAudio.load();
      this.speechAudio = null;
    }

    if (this.speechAudioUrl) {
      URL.revokeObjectURL(this.speechAudioUrl);
      this.speechAudioUrl = null;
    }
  }

  private get locale(): "en" | "hi" {
    return this.language.code === "hi-IN" ? "hi" : "en";
  }

  private reportExtractedFields(): void {
    const snapshot = this.snapshotExtractedFields();
    storeExtractedFields(snapshot);

    if (this.debug.logExtractedFields) {
      const summary = snapshot.map((field) => ({
        id: field.id,
        name: field.name,
        label: field.label,
        type: field.type,
        allowMultiple: Boolean(field.allowMultiple),
        optionsCount: field.options?.length ?? 0,
        groupId: field.groupId,
        groupLabel: field.groupLabel,
        groupIndex: field.groupIndex,
      }));
      if (this.debug.logExtractedFields) {
        console.info("[VoiceForm] Extracted fields", summary);
      }
    }

    if (this.hooks.onFieldsExtracted) {
      this.hooks.onFieldsExtracted({ fields: snapshot });
    }
  }

  private message(
    key: MessageKey,
    replacements: Record<string, string | number> = {},
  ): string {
    const template =
      LOCALE_MESSAGES[this.locale][key] ?? LOCALE_MESSAGES.en[key];
    return Object.entries(replacements).reduce<string>(
      (result, [token, value]) =>
        result.replace(new RegExp(`{${token}}`, "g"), String(value)),
      template,
    );
  }

  async initialize(): Promise<void> {
    if (this.debug.logExtractedFields) {
      console.log("[VoiceForm] initialize() method called");
    }

    if (this.initialized) {
      if (this.debug.logExtractedFields) {
        console.log("[VoiceForm] Already initialized, returning early");
      }
      return;
    }

    if (this.debug.logExtractedFields) {
      console.log("[VoiceForm] Checking secure context...");
    }
    if (typeof window !== "undefined" && !window.isSecureContext) {
      throw new Error(
        "Microphone access requires a secure context (HTTPS or localhost). Please reload the app over https://.",
      );
    }

    if (
      typeof navigator !== "undefined" &&
      (!navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== "function")
    ) {
      throw new Error(
        "This browser cannot access the microphone. Verify permissions and update to a modern browser.",
      );
    }

    const form = document.querySelector<HTMLElement>(this.options.formSelector);
    if (!form) {
      throw new Error(
        `VoiceFormService could not find form with selector ${this.options.formSelector}`,
      );
    }

    if (this.debug.logExtractedFields) {
      console.log(
        `[VoiceForm] Found form element with selector: ${this.options.formSelector}`,
      );
    }

    await waitForCustomDropdownRender(form, 4000);
    this.fields = extractFormFields(form);
    if (this.debug.logExtractedFields) {
      console.log(`[VoiceForm] Extracted ${this.fields.length} form fields`);
    }
    this.reportExtractedFields();

    // Detect all tabs upfront (even if their content isn't rendered yet)
    const detectedTabs = this.detectAllTabs(form);
    this.steps = detectedTabs.length > 0 ? detectedTabs : this.buildStepMap();

    if (this.fields.length === 0) {
      throw new Error(
        "No eligible form fields were found to power the voice experience.",
      );
    }

    this.router = this.resolveRouter();

    const defaultLanguage = this.resolveDefaultLanguage(
      this.options.language ?? this.options.defaultLanguage,
    );

    // Only setup Azure speech config if using Azure provider
    if (this.speechProvider === "azure") {
      this.language = defaultLanguage;
      if (!this.options.azureSpeech) {
        throw new Error("Azure speech configuration is required");
      }
      this.speechConfig = SpeechConfig.fromSubscription(
        this.options.azureSpeech.subscriptionKey,
        this.options.azureSpeech.region,
      );
      // Enable dictation mode to reduce automatic date formatting for numbers
      this.speechConfig.enableDictation();
      this.applyLanguageToConfig(defaultLanguage.code);
      await this.ensureSynthesizer();
    } else if (this.speechProvider === "bhashini") {
      // For Bhashini, prefer the bhashiniSpeech.language config over defaultLanguage
      if (this.options.bhashiniSpeech?.language) {
        // Map Bhashini language code (hi, en) to full locale code (hi-IN, en-US)
        const bhashiniLang = this.options.bhashiniSpeech.language;
        const mappedCode: SupportedLanguage =
          bhashiniLang === "hi" ? "hi-IN" : "en-US";
        const bhashiniLanguage = this.resolveDefaultLanguage(mappedCode);
        this.language = bhashiniLanguage;
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Using Bhashini language: ${bhashiniLang} (mapped to ${mappedCode})`,
          );
        }
      } else {
        // Use defaultLanguage if no Bhashini language specified
        this.language = defaultLanguage;
        if (this.bhashiniSpeechService) {
          this.bhashiniSpeechService.updateLanguage(defaultLanguage.code);
        }
      }
    } else if (this.speechProvider === "sarvam") {
      // For Sarvam, use the sarvamSpeech.language config or defaultLanguage
      if (this.options.sarvamSpeech?.language) {
        const sarvamLanguage = this.resolveDefaultLanguage(
          this.options.sarvamSpeech.language as SupportedLanguage,
        );
        this.language = sarvamLanguage;
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Using Sarvam language: ${this.options.sarvamSpeech.language}`,
          );
        }
      } else {
        // Use defaultLanguage if no Sarvam language specified
        this.language = defaultLanguage;
        if (this.sarvamSpeechService) {
          this.sarvamSpeechService.updateLanguage(defaultLanguage.code);
        }
      }
    }

    this.syncFieldStateFromDom();
    this.initialized = true;
  }

  public getExtractedFields(): VoiceFormFieldDescriptor[] {
    const snapshot = this.snapshotExtractedFields();
    storeExtractedFields(snapshot);
    return snapshot;
  }

  private snapshotExtractedFields(): VoiceFormFieldDescriptor[] {
    return this.fields.map((field) => ({
      id: field.id,
      name: field.name,
      label: field.label,
      type: field.type,
      options: field.options
        ? field.options.map((option) => ({
            value: option.value,
            label: option.label,
          }))
        : undefined,
      allowMultiple: field.allowMultiple,
      constraints: { ...field.constraints },
      groupId: field.groupId,
      groupLabel: field.groupLabel,
      groupIndex: field.groupIndex,
    }));
  }

  async start(): Promise<void> {
    if (this.debug.logExtractedFields) {
      console.log("[VoiceForm] start() method called");
    }

    if (!this.initialized) {
      if (this.debug.logExtractedFields) {
        console.log("[VoiceForm] Not initialized yet, calling initialize()");
      }
      await this.initialize();
    }
    if (this.running) {
      if (this.debug.logExtractedFields) {
        console.log("[VoiceForm] Already running, returning early");
      }
      return;
    }

    if (this.debug.logExtractedFields) {
      console.log("[VoiceForm] Starting voice assistant...");
    }
    this.running = true;
    this.emitStatus({ message: this.message("status_voice_started") });

    // Set up manual intervention detection
    this.setupManualInterventionDetection();

    // Sync field state but preserve step index at 0 (first tab) for initial start
    this.syncFieldStateFromDom({ preserveStepIndex: true });

    // Ensure we start at the first step/tab
    this.currentStepIndex = 0;

    if (this.steps.length) {
      await this.announceStepEntry(this.steps[this.currentStepIndex], {
        isInitial: true,
      });
      if (!this.running) {
        return;
      }
    }

    const flow = this.runFormFlow();
    this.flowPromise = flow;
    try {
      await flow;
    } finally {
      if (this.flowPromise === flow) {
        this.flowPromise = null;
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.running && !this.initialized) {
      return;
    }
    this.running = false;
    this.invalidatePendingSpeech();

    // Clean up manual intervention detection
    this.cleanupManualInterventionDetection();

    // Stop recognizer based on provider
    if (this.speechProvider === "azure") {
      await this.stopActiveRecognizer();
    } else if (this.speechProvider === "bhashini") {
      this.cleanupBhashiniResources();
    } else if (this.speechProvider === "sarvam") {
      this.cleanupSarvamResources();
    }

    await this.stopSpeaking({ force: true });
    const pendingSpeech = this.speakingPromise;
    if (pendingSpeech) {
      try {
        await pendingSpeech;
      } catch (_error) {
        // The speech promise may reject when we force-stop audio; ignore.
      } finally {
        if (this.speakingPromise === pendingSpeech) {
          this.speakingPromise = null;
        }
      }
    }
    this.speaking = false;
    this.disposeSynthesizer();
    this.activeListening = null;
    this.listeningActive = false;
    this.userSpeaking = false;
    this.speechOngoingSince = null;
    this.lastSilenceAt = Date.now();
    this.listenContext = null;

    // Clear UI state when stopping
    this.emitPrompt({ text: "", fieldId: undefined });
    this.emitTranscript({ text: "", isFinal: true });
    this.emitSpeech({ text: "" });

    const flow = this.flowPromise;
    if (flow) {
      try {
        await flow;
      } catch (error) {
        if (error instanceof Error) {
          this.emitError(error);
        }
      } finally {
        if (this.flowPromise === flow) {
          this.flowPromise = null;
        }
      }
    }
  }

  /**
   * Announce a message to the user and then stop the voice assistant
   * Use this for manual resets where user should be informed before stopping
   */
  async announceAndStop(message: string): Promise<void> {
    if (!this.initialized) {
      return;
    }

    // If currently running, speak the announcement first
    if (this.running) {
      try {
        // Emit status message
        this.emitStatus({ message });

        // Speak the announcement
        await this.speak(message);
      } catch (error) {
        // If speech fails, just log it and continue with stop
        if (this.debug.logExtractedFields) {
          console.warn("[VoiceForm] Failed to announce message:", error);
        }
      }
    }

    // Now stop the voice assistant
    await this.stop();
  }

  private resolveRouter(): BedrockRouter {
    if (this.options.bedrock.router) {
      return this.options.bedrock.router;
    }

    if (this.options.bedrock.client) {
      return new AwsBedrockRouter({
        client: this.options.bedrock.client,
        modelId: this.options.bedrock.modelId,
        debug: this.debug.logExtractedFields,
      });
    }

    throw new Error(
      "No Bedrock router configured. Provide options.bedrock.router or options.bedrock.client to enable routing.",
    );
  }

  private resolveDefaultLanguage(
    language?: SupportedLanguage,
  ): LanguageMetadata {
    const selected = LANGUAGE_CHOICES.find((entry) => entry.code === language);
    return selected ?? LANGUAGE_CHOICES[0];
  }

  private applyLanguageToConfig(language: SupportedLanguage) {
    // Only apply to Azure speech config (not used for Bhashini)
    if (this.speechProvider === "azure" && this.speechConfig) {
      this.speechConfig.speechRecognitionLanguage = language;
      this.speechConfig.speechSynthesisLanguage = language;
      const metadata =
        LANGUAGE_CHOICES.find((entry) => entry.code === language) ??
        LANGUAGE_CHOICES[0];
      this.speechConfig.speechSynthesisVoiceName = metadata.ttsVoice;
      this.language = metadata;
      this.disposeSynthesizer();
    } else {
      // For Bhashini, just update language metadata
      const metadata =
        LANGUAGE_CHOICES.find((entry) => entry.code === language) ??
        LANGUAGE_CHOICES[0];
      this.language = metadata;
    }
  }

  async setLanguage(language: SupportedLanguage): Promise<void> {
    if (this.language.code === language) {
      return;
    }

    this.invalidatePendingSpeech();
    await this.stopSpeaking({ force: true });

    if (this.speechProvider === "azure") {
      // Dispose active Azure recognizer so it gets recreated with new language
      if (this.activeListening) {
        try {
          this.activeListening.close();
        } catch (error) {
          // Ignore close errors
        }
        this.activeListening = null;
        this.listeningActive = false;
      }
      this.applyLanguageToConfig(language);
      await this.ensureSynthesizer();
    } else if (this.speechProvider === "bhashini") {
      // Cleanup and restart Bhashini with new language
      this.cleanupBhashiniResources();
      if (this.bhashiniSpeechService) {
        this.bhashiniSpeechService.updateLanguage(language);
      }
      const metadata =
        LANGUAGE_CHOICES.find((entry) => entry.code === language) ??
        LANGUAGE_CHOICES[0];
      this.language = metadata;
    } else if (this.speechProvider === "sarvam") {
      // Cleanup and restart Sarvam with new language
      this.cleanupSarvamResources();
      if (this.sarvamSpeechService) {
        this.sarvamSpeechService.updateLanguage(language);
      }
      const metadata =
        LANGUAGE_CHOICES.find((entry) => entry.code === language) ??
        LANGUAGE_CHOICES[0];
      this.language = metadata;
    }
  }

  private async runFormFlow(): Promise<void> {
    this.setupTabChangeObserver();

    // Outer loop to handle form resets during final review
    while (this.running) {
      // Inner loop to fill all fields
      while (this.running && !this.allStepsCompleted()) {
        // Check for manual resets - if user manually cleared previously filled fields
        this.detectManualResets();

        const nextField = this.findNextFieldForCurrentStep();

        if (!nextField) {
          const outcome = await this.handleStepCompletion();
          if (!this.running || outcome === "halt") {
            return;
          }
          continue;
        }

        // Main flow - starting fresh field, reset attempt counter to 1
        await this.collectAnswerForField(nextField, 1);
      }

      if (this.running && this.allStepsCompleted()) {
        this.emitStatus({ message: this.message("status_form_completed") });
        // Ask user if they want to edit any field before finishing
        await this.finalReview();
        if (!this.running) {
          return;
        }
        // After final review, check again if form is still completed
        // User might have reset during review, so we need to loop back and fill fields
        if (this.allStepsCompleted()) {
          await this.finishFlowAsConfirmedQuit({ announceStop: false });
          return;
        }
        // Form was reset - loop back to fill it again
        if (this.debug.logExtractedFields) {
          console.log(
            "[VoiceForm] Form no longer completed after final review - looping back to fill",
          );
        }
        // Update status to reflect we're starting the form again
        this.emitStatus({ message: this.message("status_voice_started") });
        // Continue outer loop to re-fill fields
      } else {
        // Inner loop exited but form not completed (shouldn't happen)
        break;
      }
    }
  }

  private allFieldsCompleted(): boolean {
    // Only consider visible fields when checking if form is complete
    return this.fields
      .filter((field) => this.isFieldVisible(field))
      .every((field) => this.isFieldAnswered(field.id));
  }

  private allStepsCompleted(): boolean {
    // Check if all steps are completed (not just current visible fields)
    if (!this.steps.length) {
      return this.allFieldsCompleted();
    }
    return (
      this.currentStepIndex === this.steps.length - 1 &&
      this.isCurrentStepCompleted()
    );
  }

  private isCurrentStepCompleted(): boolean {
    if (!this.steps.length) {
      return this.allFieldsCompleted();
    }
    const currentStep = this.steps[this.currentStepIndex];
    if (!currentStep) {
      return true;
    }
    return currentStep.fieldIds
      .map((fieldId) => this.fields.find((field) => field.id === fieldId))
      .filter((field): field is ExtractedFormField => Boolean(field))
      .every(
        (field) =>
          this.isFieldAnswered(field.id) || !this.isFieldVisible(field),
      );
  }

  private isFieldAnswered(fieldId: string): boolean {
    const state = this.fieldState.get(fieldId);
    if (!state) {
      return false;
    }

    if (state.skipped) {
      return true;
    }

    if (Array.isArray(state.value)) {
      // Check if has value
      if (state.value.length === 0) {
        return false;
      }
    } else if (!Boolean(state.value)) {
      return false;
    }

    // Field has a value, but check for validation errors in DOM
    const field = this.fields.find((f) => f.id === fieldId);
    if (field && this.isFieldVisible(field)) {
      const validationCheck = this.checkFieldForDomValidationErrors(field);
      if (validationCheck.hasError) {
        // Field has validation error, so it's not truly answered
        if (this.debug.logExtractedFields) {
          console.warn(
            `[VoiceForm] Field "${field.label}" has value but validation error: ${validationCheck.errorMessage}`,
          );
        }
        return false;
      }
    }

    return true;
  }

  private syncFieldFromDomAndCheck(field: ExtractedFormField): boolean {
    // First, read the current value from DOM
    const domValue = this.readFieldValue(field);

    // If DOM has a value, sync it to our state
    if (domValue) {
      const hasValue = Array.isArray(domValue)
        ? domValue.length > 0
        : Boolean(domValue);

      if (hasValue) {
        this.fieldState.set(field.id, {
          fieldId: field.id,
          value: domValue,
          skipped: false,
        });
        return true;
      }
    }

    // If no DOM value, check our existing state
    return this.isFieldAnswered(field.id);
  }

  private isFieldVisible(field: ExtractedFormField): boolean {
    if (!field.element) return false;
    let el: HTMLElement | null = field.element;
    // Check visibility up the DOM tree
    while (el) {
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        el.hasAttribute("hidden")
      ) {
        return false;
      }
      el = el.parentElement;
    }
    return true;
  }

  private isFieldDisabledOrReadonly(field: ExtractedFormField): boolean {
    // Check if the field itself is disabled or readonly
    if (field.inputElements && field.inputElements.length > 0) {
      const isDisabled = field.inputElements.some(
        (input) => input.disabled || input.readOnly,
      );
      if (isDisabled) {
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Field "${field.label}" detected as disabled: input element is disabled/readonly`,
          );
        }
      }
      return isDisabled;
    }

    if (field.selectElement) {
      if (field.selectElement.disabled) {
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Field "${field.label}" detected as disabled: select element is disabled`,
          );
        }
        return true;
      }
    }

    if (field.textareaElement) {
      const isDisabled =
        field.textareaElement.disabled || field.textareaElement.readOnly;
      if (isDisabled) {
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Field "${field.label}" detected as disabled: textarea is disabled/readonly`,
          );
        }
      }
      return isDisabled;
    }

    // Check custom dropdowns for disabled state
    if (isCustomDropdownElement(field.element)) {
      const dropdown = field.element;

      // Check if ng-select is disabled
      if (dropdown.classList.contains("ng-select-disabled")) {
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Field "${field.label}" detected as disabled: has ng-select-disabled class`,
          );
        }
        return true;
      }

      // Check if there's a disabled attribute
      if (
        dropdown.hasAttribute("disabled") ||
        dropdown.getAttribute("aria-disabled") === "true"
      ) {
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Field "${field.label}" detected as disabled: has disabled attribute or aria-disabled=true`,
          );
        }
        return true;
      }

      // Check if the input inside is disabled (NOT readonly - readonly doesn't mean pre-filled for dropdowns)
      const comboboxInput = dropdown.querySelector<HTMLInputElement>(
        "input[role='combobox'], .ng-input input",
      );
      if (comboboxInput && comboboxInput.disabled) {
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Field "${field.label}" detected as disabled: combobox input is disabled`,
          );
        }
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a field is a dropdown (custom or native select)
   */
  private isDropdownField(field: ExtractedFormField): boolean {
    return (
      field.type === "select" ||
      isCustomDropdownElement(field.element) ||
      Boolean(field.selectElement)
    );
  }

  /**
   * Check if a dropdown field has available options
   */
  private hasDropdownOptions(field: ExtractedFormField): boolean {
    if (!this.isDropdownField(field)) {
      return true; // Non-dropdowns always "have options"
    }
    return Boolean(field.options && field.options.length > 0);
  }

  /**
   * Check if a field is an empty dropdown (no options available)
   * Empty dropdowns typically occur when dependent on another field's value
   */
  private isEmptyDropdown(field: ExtractedFormField): boolean {
    return this.isDropdownField(field) && !this.hasDropdownOptions(field);
  }

  private findNextFieldForCurrentStep(): ExtractedFormField | undefined {
    if (!this.steps.length) {
      return this.fields.find(
        (field) =>
          !this.isFieldAnswered(field.id) && this.isFieldVisible(field),
      );
    }

    const currentStep = this.steps[this.currentStepIndex];
    if (!currentStep) {
      return undefined;
    }

    return currentStep.fieldIds
      .map((fieldId) => this.fields.find((field) => field.id === fieldId))
      .find((field): field is ExtractedFormField =>
        Boolean(
          field &&
          !this.isFieldAnswered(field.id) &&
          this.isFieldVisible(field),
        ),
      );
  }

  private async handleStepCompletion(): Promise<"advance" | "stay" | "halt"> {
    if (!this.steps.length) {
      return "halt";
    }

    const currentStep = this.steps[this.currentStepIndex];
    if (!currentStep) {
      return "halt";
    }

    const nextStep = this.steps[this.currentStepIndex + 1];
    if (!nextStep) {
      return "halt";
    }

    const outcome = await this.requestStepAdvance(currentStep, nextStep);
    if (!this.running || outcome === "stop") {
      return "halt";
    }

    if (outcome === "advance") {
      this.currentStepIndex = Math.min(
        this.currentStepIndex + 1,
        this.steps.length - 1,
      );

      // Navigate to the next tab before announcing entry
      const nextStepInfo = this.steps[this.currentStepIndex];
      if (nextStepInfo) {
        await this.navigateToTab(nextStepInfo);
      }

      await this.announceStepEntry(this.steps[this.currentStepIndex], {
        isInitial: false,
      });
      return this.running ? "advance" : "halt";
    }

    await this.reviewStep(currentStep);
    return this.running ? "stay" : "halt";
  }

  private getPendingFieldsForCurrentStep(): ExtractedFormField[] {
    // Only consider fields that are not answered AND are visible in the DOM
    if (!this.steps.length) {
      return this.fields.filter(
        (field) =>
          !this.isFieldAnswered(field.id) && this.isFieldVisible(field),
      );
    }

    const currentStep = this.steps[this.currentStepIndex];
    if (!currentStep) {
      return [];
    }

    return currentStep.fieldIds
      .map((fieldId) => this.fields.find((field) => field.id === fieldId))
      .filter((field): field is ExtractedFormField =>
        Boolean(
          field &&
          !this.isFieldAnswered(field.id) &&
          this.isFieldVisible(field),
        ),
      );
  }

  private getFieldsForStep(step: StepInfo): ExtractedFormField[] {
    return step.fieldIds
      .map((fieldId) => this.fields.find((field) => field.id === fieldId))
      .filter((field): field is ExtractedFormField => Boolean(field));
  }

  private async collectAnswerForField(
    field: ExtractedFormField,
    attemptNumber: number = 1,
  ): Promise<void> {
    if (this.debug.logExtractedFields) {
      console.log(
        `[VoiceForm] collectAnswerForField called for: ${field.label} (${field.type})`,
      );
    }

    if (!this.running) {
      return;
    }

    // CRITICAL: Check for manual resets BEFORE processing this field
    // User might have reset the form while we were preparing or speaking for previous field
    this.detectManualResets();

    // Close any open dropdowns from previous interactions
    const openDropdowns = document.querySelectorAll<HTMLElement>(
      '.ng-select.ng-select-opened, [role="listbox"][aria-expanded="true"]',
    );
    openDropdowns.forEach((dropdown) => {
      try {
        closeDropdownElement(dropdown);
      } catch (error) {
        // Ignore errors from closing dropdowns
        if (this.debug.logExtractedFields) {
          console.warn("[VoiceForm] Could not close dropdown:", error);
        }
      }
    });

    // Stop any ongoing speech from previous field
    await this.stopSpeaking({ force: false });

    // CRITICAL: First read the DOM value directly to check for pre-filled values
    // This catches manually entered values even if they're not yet in fieldState
    const domValue = this.readFieldValue(field);
    const hasDomValue =
      domValue &&
      (Array.isArray(domValue) ? domValue.length > 0 : Boolean(domValue));

    if (hasDomValue) {
      if (this.debug.logExtractedFields) {
        console.log(
          `[VoiceForm] Field "${field.label}" has a DOM value, checking for validation errors...`,
        );
      }

      // Check if the value has validation errors
      const validationCheck = this.checkFieldForDomValidationErrors(field);
      if (validationCheck.hasError) {
        if (this.debug.logExtractedFields) {
          console.warn(
            `[VoiceForm] Pre-filled value for "${field.label}" has validation error: ${validationCheck.errorMessage}`,
          );
        }
        // Clear the invalid value from both DOM and state
        const emptyValue = field.allowMultiple ? [] : "";
        await this.setFieldValue(field, emptyValue);
        this.fieldState.delete(field.id);

        // Announce the error and ask for correct input
        const errorMsg =
          validationCheck.errorMessage || this.message("invalid_generic");
        const revisitMessage = this.message("revisit_field", {
          label: field.label,
        });
        await this.speak(`${errorMsg}. ${revisitMessage}`);
        if (!this.running) {
          return;
        }
        // Continue to collect voice answer below
      } else {
        // Value is valid, sync to state and skip this field
        this.fieldState.set(field.id, {
          fieldId: field.id,
          value: domValue,
          skipped: false,
        });
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Captured valid pre-filled value for "${field.label}": ${domValue}`,
          );
        }
        return;
      }
    }

    // Prepare field options BEFORE checking if dropdown is empty
    await this.prepareFieldOptions(field);

    // Update Azure Speech phrase list with field-specific hints
    this.updatePhraseListForField(field);

    // CRITICAL: Check if this is an empty dropdown AFTER loading options
    if (this.isEmptyDropdown(field)) {
      if (this.debug.logExtractedFields) {
        console.log(
          `[VoiceForm] Skipping empty dropdown "${field.label}" - no options available (likely dependent on another field)`,
        );
      }
      // Mark as skipped so it won't be picked up again in findNextFieldForCurrentStep
      this.fieldState.set(field.id, {
        fieldId: field.id,
        value: "",
        skipped: true,
      });
      return; // Exit early - don't try to collect answer
    }

    if (this.debug.logExtractedFields) {
      console.info("[VoiceForm] Current field options after prepare:", {
        fieldId: field.id,
        fieldLabel: field.label,
        fieldType: field.type,
        optionsCount: field.options?.length ?? 0,
        firstOptions: field.options
          ?.slice(0, 5)
          .map(
            (o: { value: string; label: string }) => `${o.value} (${o.label})`,
          ),
      });
    }

    const question = this.buildQuestion(field);
    // Clear previous user transcript before asking new question
    this.emitTranscript({ text: "", isFinal: true });
    this.emitPrompt({ text: question, fieldId: field.id });

    // Create snapshots of ALL pending fields with options preserved RIGHT NOW
    // This prevents race conditions where options might get cleared by mutation observers
    // CRITICAL: Must capture options BEFORE async operations (speak/listen) that give time for options to be cleared

    // Get all unanswered fields
    const allPendingFields = this.fields.filter(
      (f) => !this.isFieldAnswered(f.id) && this.isFieldVisible(f),
    );

    // Create snapshots for all pending fields
    // Note: Only current field has options loaded at this point
    // We'll load more options on-demand during validation if needed
    const allFieldSnapshots: VoiceFormFieldDescriptor[] = allPendingFields.map(
      (f) => ({
        id: f.id,
        name: f.name,
        label: f.label,
        type: f.type,
        options: f.options ? [...f.options] : undefined, // Clone options array
        constraints: f.constraints,
      }),
    );

    // Find the current field snapshot
    const currentFieldSnapshot = allFieldSnapshots.find(
      (s) => s.id === field.id,
    );

    // Reorder: current field first, then others (for LLM prioritization)
    const orderedSnapshots = currentFieldSnapshot
      ? [
          currentFieldSnapshot,
          ...allFieldSnapshots.filter((s) => s.id !== field.id),
        ]
      : allFieldSnapshots;

    if (this.debug.logExtractedFields) {
      console.info("[VoiceForm] Created field snapshots:", {
        totalSnapshots: orderedSnapshots.length,
        currentField: orderedSnapshots[0]?.label,
        currentFieldOptions: orderedSnapshots[0]?.options?.length ?? 0,
        allFields: orderedSnapshots.map((s) => ({
          label: s.label,
          type: s.type,
          optionsCount: s.options?.length ?? 0,
        })),
      });
    }

    // CRITICAL: Sync from DOM and check if answered RIGHT BEFORE speaking
    // User might have manually filled this field while we were preparing options
    if (this.syncFieldFromDomAndCheck(field)) {
      if (this.debug.logExtractedFields) {
        console.log(
          `[VoiceForm] Field "${field.label}" was manually filled before speaking, skipping`,
        );
      }
      return;
    }

    const transcriptPromise = this.listen({ allowConcurrentSpeech: true });
    await this.speak(question);
    if (!this.running) {
      await transcriptPromise;
      return;
    }

    const transcript = await transcriptPromise;
    if (!this.running) {
      return;
    }

    // Preprocess transcript for numeric fields to handle Azure's date formatting
    let processedTranscript = transcript;
    if (transcript && isLikelyNumericField(field) && field.type !== "date") {
      // For numeric non-date fields, check if transcript looks like misformatted number
      // Pattern: single digit, slash, two or more digits (e.g., "4/23" should be "423")
      if (/^\d\/\d{2,}$/.test(transcript.trim())) {
        processedTranscript = transcript.replace(/\//g, "");
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Preprocessed numeric transcript: "${transcript}" -> "${processedTranscript}"`,
          );
        }
      }
    }

    if (this.debug.logExtractedFields) {
      console.log(`[VoiceForm] User said: "${processedTranscript}"`);
    }

    // Sync from DOM and check again if field was manually filled while we were listening
    if (this.syncFieldFromDomAndCheck(field)) {
      if (this.debug.logExtractedFields) {
        console.log(
          `[VoiceForm] Field "${field.label}" was manually filled while listening, skipping voice processing`,
        );
      }
      return;
    }

    if (!processedTranscript) {
      // Check if we've exhausted retry attempts
      if (attemptNumber >= 3) {
        await this.speak(this.message("no_response_closing"));
        if (this.running) {
          this.emitStatus({ message: this.message("no_response_closing") });
        }
        // Emit onQuit to notify UI that flow is stopping due to no response
        this.hooks.onQuit?.({ confirmed: true, reason: "no-response" });
        this.stop(); // Preserve partial data, don't clear form
        return;
      }

      // Retry with incremented attempt number
      await this.speak(this.message("prompt_retry"));
      if (!this.running) {
        return;
      }
      await this.collectAnswerForField(field, attemptNumber + 1);
      return;
    }

    if (this.debug.logExtractedFields) {
      console.info("[VoiceForm] User transcript:", processedTranscript);
      if (this.debug.logExtractedFields) {
        console.info("[VoiceForm] Sending to LLM - allFieldSnapshots:", {
          count: orderedSnapshots.length,
          currentFieldId: field.id,
          snapshots: orderedSnapshots.map((s) => ({
            id: s.id,
            label: s.label,
            type: s.type,
            optionsCount: s.options?.length ?? 0,
            firstOptions: s.options
              ?.slice(0, 3)
              .map((o) => ({ value: o.value, label: o.label })),
          })),
        });
      }
    }

    // Pass ALL pending fields so correction can work for multi-field extraction
    const routingResponse = await this.router.routeAnswer({
      userInput: processedTranscript,
      pendingFields: orderedSnapshots, // ALL pending fields with preserved options
      completedFields: this.fields.filter((item) =>
        this.isFieldAnswered(item.id),
      ),
      language: this.language.code,
    });
    if (!this.running) {
      return;
    }

    if (this.debug.logExtractedFields) {
      console.log("[VoiceForm] LLM routing response:", routingResponse);
    }

    // Check if LLM detected a special command (reset or quit)
    if (
      routingResponse.specialCommand &&
      routingResponse.specialCommand.confidence >= 0.7
    ) {
      if (this.debug.logExtractedFields) {
        console.log(
          "[VoiceForm] Special command detected:",
          routingResponse.specialCommand,
        );
      }

      // Immediately clear previous UI state before showing confirmation
      this.emitTranscript({ text: "", isFinal: true });

      if (routingResponse.specialCommand.type === "reset") {
        // Emit the reset confirmation prompt to UI
        const message = this.message("reset_confirm");
        this.emitPrompt({ text: message });

        // Ask user to confirm reset via voice
        const confirmed = await this.confirmReset();
        if (!this.running) {
          return;
        }

        if (confirmed) {
          // Call the client's reset hook to perform the actual reset
          if (this.hooks.onResetRequested) {
            if (this.debug.logExtractedFields) {
              console.log(
                "[VoiceForm] Reset confirmed - calling onResetRequested hook...",
              );
            }
            const hookResult = this.hooks.onResetRequested();
            if (hookResult && typeof (hookResult as any).then === "function") {
              await hookResult;
            }
          } else {
            if (this.debug.logExtractedFields) {
              console.warn("[VoiceForm] No onResetRequested hook provided.");
            }
          }

          if (!this.running) {
            return;
          }

          // Announce reset completed and restart from beginning
          await this.speak(this.message("reset_completed"));
          if (!this.running) {
            return;
          }

          // Reset to first step and sync field state
          this.syncFieldStateFromDom({ preserveStepIndex: false });
          this.currentStepIndex = 0;

          // Navigate to first tab if steps exist
          if (this.steps.length && this.steps[0]) {
            await this.navigateToTab(this.steps[0]);
            await this.announceStepEntry(this.steps[0], { isInitial: true });
          }

          // Flow will continue from runFormFlow loop
          return;
        } else {
          // Reset was cancelled - announce and continue with current field
          await this.speak(this.message("reset_cancelled"));
          if (!this.running) {
            return;
          }
          // Preserve attempt counter for same field
          await this.collectAnswerForField(field, attemptNumber);
          return;
        }
      }

      if (
        routingResponse.specialCommand.type === "quit" ||
        routingResponse.specialCommand.type === "finish"
      ) {
        const commandType = routingResponse.specialCommand.type;
        if (this.debug.logExtractedFields) {
          console.log(`[VoiceForm] User wants to ${commandType}`);
        }
        const message = this.message("quit_confirm");
        this.emitPrompt({ text: message });
        const confirmed = await this.confirmQuit();
        if (!this.running || confirmed) {
          return;
        }
        // User cancelled quit/finish, preserve attempt counter for same field
        await this.collectAnswerForField(field, attemptNumber);
        return;
      }
    }

    if (this.debug.logExtractedFields) {
      const currentSnapshot = orderedSnapshots.find((s) => s.id === field.id);
      if (this.debug.logExtractedFields) {
        console.info("[VoiceForm] LLM routing response:", {
          userInput: transcript,
          fieldLabel: field.label,
          assignments: routingResponse.assignments,
          assignmentsCount: routingResponse.assignments.length,
          followUp: routingResponse.followUp,
          snapshotOptions: currentSnapshot?.options?.slice(0, 10) ?? [],
          fieldOptionsLive: field.options?.slice(0, 10) ?? [],
        });
      }
    }

    if (!routingResponse.assignments.length) {
      if (this.debug.logExtractedFields) {
        console.warn(
          "[VoiceForm] LLM returned empty assignments array - retrying",
        );
      }
      if (routingResponse.followUp) {
        await this.speak(routingResponse.followUp);
      } else {
        await this.speak(this.message("mapping_failure"));
      }
      if (!this.running) {
        return;
      }
      // LLM returned empty assignments - preserve attempt counter
      await this.collectAnswerForField(field, attemptNumber);
      return;
    }

    // Check if LLM returned assignment for the current field
    const currentFieldAssignment = routingResponse.assignments.find(
      (a) => a.fieldId === field.id || a.fieldId === field.name,
    );

    // Check if LLM returned assignments for OTHER fields (including completed fields)
    const hasOtherFieldAssignments =
      routingResponse.assignments.length > 0 && !currentFieldAssignment;

    if (!currentFieldAssignment && !hasOtherFieldAssignments) {
      // No assignments at all - this is an error
      if (this.debug.logExtractedFields) {
        console.warn(
          "[VoiceForm] LLM returned empty assignments - no current field and no other fields",
        );
      }
      await this.speak(this.message("mapping_failure"));
      if (!this.running) {
        return;
      }
      // No current field assignment - preserve attempt counter
      await this.collectAnswerForField(field, attemptNumber);
      return;
    }

    // User wants to edit OTHER fields (not answering current question)
    if (!currentFieldAssignment && hasOtherFieldAssignments) {
      if (this.debug.logExtractedFields) {
        console.info(
          "[VoiceForm] User wants to edit other fields instead of answering current question:",
          {
            currentFieldId: field.id,
            currentFieldLabel: field.label,
            editingFields: routingResponse.assignments.map((a) => ({
              fieldId: a.fieldId,
              value: a.value,
            })),
          },
        );
      }

      // Apply the assignments for the fields user wants to edit
      const { applied, issues, appliedFields } = await this.applyAssignments(
        routingResponse.assignments,
        orderedSnapshots,
      );
      if (!this.running) {
        return;
      }

      if (this.debug.logExtractedFields) {
        console.info("[VoiceForm] Edit assignments result:", {
          applied,
          appliedFieldsCount: appliedFields.length,
          appliedFields: appliedFields.map((f) => ({
            id: f.id,
            label: f.label,
            value: this.fieldState.get(f.id)?.value,
          })),
          issuesCount: issues.length,
        });
      }

      // Describe issues but don't speak yet (will be combined with update message if needed)
      const issuesText = this.describeIssues(issues);

      // If applied successfully, announce the changes and continue with current question
      if (applied && appliedFields.length > 0) {
        const fieldLabels = appliedFields.map((f) => f.label).join(", ");
        const updateMessage =
          this.message("field_updated", { labels: fieldLabels }) ||
          `Updated ${fieldLabels}.`;

        // Combine issue description with update message
        const issuesText = this.describeIssues(issues);
        const fullMessage = issuesText
          ? `${issuesText} ${updateMessage}`
          : updateMessage;

        await this.speak(fullMessage);
        if (!this.running) {
          return;
        }
      }

      // Now continue asking the current question - preserve attempt counter
      await this.collectAnswerForField(field, attemptNumber);
      return;
    }

    // Apply ALL assignments returned by LLM (supports multi-field extraction)
    // This allows user to provide multiple answers at once, e.g., "I am Hindu, income 500000, unmarried"
    if (
      this.debug.logExtractedFields &&
      routingResponse.assignments.length > 1
    ) {
      if (this.debug.logExtractedFields) {
        console.info("[VoiceForm] Multi-field extraction detected:", {
          totalAssignments: routingResponse.assignments.length,
          assignments: routingResponse.assignments.map((a) => ({
            fieldId: a.fieldId,
            value: a.value,
            skip: a.skip,
          })),
        });
      }
    }

    const { applied, issues, appliedFields } = await this.applyAssignments(
      routingResponse.assignments, // Apply all assignments, not just current field
      orderedSnapshots, // Pass snapshots with preserved options
    );
    if (!this.running) {
      return;
    }

    if (this.debug.logExtractedFields) {
      console.info("[VoiceForm] Apply assignments result:", {
        applied,
        appliedFieldsCount: appliedFields.length,
        appliedFields: appliedFields.map((f) => ({
          id: f.id,
          label: f.label,
          type: f.type,
          value: this.fieldState.get(f.id)?.value,
        })),
        issuesCount: issues.length,
        issues: issues.map((i) => ({
          field: i.field.label,
          message: i.message,
          type: i.type,
        })),
      });
    }

    // Get issues description message
    const issuesText = this.describeIssues(issues);

    const currentFieldAnswered = this.isFieldAnswered(field.id);

    if (!applied && !issues.length) {
      await this.speak(this.message("apply_failure"));
      if (!this.running) {
        return;
      }
      // Apply failure - preserve attempt counter
      await this.collectAnswerForField(field, attemptNumber);
      return;
    }

    if (
      !currentFieldAnswered ||
      issues.some(
        (issue) => issue.type === "error" && issue.field.id === field.id,
      )
    ) {
      if (this.running) {
        // Combine issues description with revisit message
        const revisitMessage = this.message("revisit_field", {
          label: field.label,
        });
        const fullMessage = issuesText
          ? `${issuesText} ${revisitMessage}`
          : revisitMessage;

        await this.speak(fullMessage);
        if (!this.running) {
          return;
        }
        // Validation errors - preserve attempt counter
        await this.collectAnswerForField(field, attemptNumber);
      }
      return;
    }

    // Simplified feedback for single field
    if (applied && currentFieldAnswered) {
      // No need to announce "Recorded X" since we just got the answer for this specific field
      // The user knows what they just answered

      // Give Angular time to run async validators and DOM to update
      await this.delay(300);

      // Re-read field value to ensure it's still there (field might have been cleared by validator)
      const rereadValue = this.readFieldValue(field);
      const isEmpty =
        !rereadValue ||
        (Array.isArray(rereadValue) && rereadValue.length === 0) ||
        (typeof rereadValue === "string" && rereadValue.trim() === "");

      if (isEmpty) {
        if (this.debug.logExtractedFields) {
          console.warn(
            `[VoiceForm] Field ${field.label} became empty after assignment, retrying`,
          );
        }
        this.fieldState.delete(field.id);
        await this.collectAnswerForField(field, attemptNumber);
        return;
      }

      // Check if the field we just filled now has DOM validation errors
      const validationCheck = this.checkFieldForDomValidationErrors(field);
      if (validationCheck.hasError) {
        if (this.debug.logExtractedFields) {
          console.warn(
            `[VoiceForm] Dynamic validation error detected for ${field.label} after assignment`,
          );
        }

        // CRITICAL: Clear the field value from DOM, not just field state
        // Otherwise syncFieldFromDomAndCheck will see the invalid value and skip re-asking
        const emptyValue = field.allowMultiple ? [] : "";
        await this.setFieldValue(field, emptyValue);
        this.fieldState.delete(field.id);

        // Announce the error and retry
        const errorMsg =
          validationCheck.errorMessage || this.message("invalid_generic");
        const revisitMessage = this.message("revisit_field", {
          label: field.label,
        });
        await this.speak(`${errorMsg}. ${revisitMessage}`);

        if (!this.running) {
          return;
        }

        // Retry the same field, preserving attempt counter
        await this.collectAnswerForField(field, attemptNumber);
        return;
      }

      // Close any dropdown before ending this field's processing
      if (isCustomDropdownElement(field.element)) {
        await this.ensureCustomDropdownClosed(field.element);
        // Extra delay to ensure dropdown is fully closed
        await this.delay(100);
      }
    }

    // Only speak followUp if current field was NOT answered successfully
    // This prevents contradictory messages like "could not map" when value was actually set
    if (routingResponse.followUp && !currentFieldAnswered) {
      await this.speak(routingResponse.followUp);
    }

    // CRITICAL: Close any open dropdowns after field processing
    const stillOpenDropdowns = document.querySelectorAll<HTMLElement>(
      '.ng-select.ng-select-opened, [role="listbox"][aria-expanded="true"]',
    );
    if (stillOpenDropdowns.length > 0) {
      if (this.debug.logExtractedFields) {
        console.log(
          `[VoiceForm] Found ${stillOpenDropdowns.length} dropdowns still open after field processing, closing them...`,
        );
      }
      stillOpenDropdowns.forEach((dropdown) => {
        try {
          closeDropdownElement(dropdown);
        } catch (error) {
          if (this.debug.logExtractedFields) {
            console.warn("[VoiceForm] Could not close dropdown:", error);
          }
        }
      });
    }
  }

  private buildQuestion(field: ExtractedFormField): string {
    if (field.options && field.options.length > 0) {
      const displayOptions = field.options
        .map((option) => option.label)
        .join(", ");
      return this.message("question_options", {
        label: field.label,
        options: displayOptions,
      });
    }
    return this.message("question_base", { label: field.label });
  }

  private async prepareFieldOptions(field: ExtractedFormField): Promise<void> {
    if (!isCustomDropdownElement(field.element)) {
      return;
    }
    await ensureCustomDropdownOptions(field, 2000);
  }

  private async applyAssignments(
    assignments: FieldAssignment[],
    fieldSnapshots?: VoiceFormFieldDescriptor[],
  ): Promise<{
    applied: boolean;
    issues: AssignmentIssue[];
    appliedFields: ExtractedFormField[];
  }> {
    const issues: AssignmentIssue[] = [];
    let applied = false;
    const appliedFields: ExtractedFormField[] = [];

    for (const assignment of assignments) {
      const field = this.fields.find(
        (item) =>
          item.id === assignment.fieldId || item.name === assignment.fieldId,
      );
      if (!field) {
        continue;
      }

      if (assignment.skip) {
        if (this.debug.logExtractedFields) {
          console.info("[VoiceForm] LLM requested skip for field:", {
            fieldLabel: field.label,
            isRequired: field.constraints.required,
          });
        }

        // If field is required, reject the skip
        if (field.constraints.required) {
          issues.push({
            field,
            message: this.message("skip_not_allowed", { label: field.label }),
            type: "error",
          });
          continue;
        }

        // If field is optional, accept the skip
        this.fieldState.set(field.id, {
          fieldId: field.id,
          value: "",
          skipped: true,
        });
        applied = true;
        appliedFields.push(field);
        this.emitStatus({
          message: this.message("optional_skip_status", { label: field.label }),
        });
        continue;
      }

      if (assignment.value === undefined) {
        if (this.debug.logExtractedFields) {
          console.warn(
            "[VoiceForm] LLM returned assignment with undefined value:",
            {
              fieldLabel: field.label,
              assignment,
            },
          );
        }
        issues.push({
          field,
          message: this.message("invalid_generic"),
          type: "error",
        });
        continue;
      }

      // Early validation: Reject non-numeric values for numeric fields
      if (isLikelyNumericField(field) && field.type !== "date") {
        const valueStr = String(assignment.value).trim();
        // Check if value contains at least one digit
        if (valueStr && !/\d/.test(valueStr)) {
          if (this.debug.logExtractedFields) {
            console.warn(
              "[VoiceForm] Non-numeric value rejected for numeric field:",
              {
                fieldLabel: field.label,
                fieldType: field.type,
                providedValue: valueStr,
              },
            );
          }
          issues.push({
            field,
            message: `Please provide a numeric value for ${field.label}`,
            type: "error",
          });
          continue;
        }
      }

      // Find snapshot for this field to use preserved options
      let fieldSnapshot = fieldSnapshots?.find(
        (s) => s.id === field.id || s.name === field.name,
      );

      // On-demand loading: If snapshot has no options but field needs them, load now
      if (
        fieldSnapshot &&
        (!fieldSnapshot.options || fieldSnapshot.options.length === 0) &&
        (field.type === "select" || field.type === "radio")
      ) {
        if (this.debug.logExtractedFields) {
          console.info(
            "[VoiceForm] Snapshot has no options, loading on-demand:",
            {
              fieldLabel: field.label,
              fieldType: field.type,
              fieldOptionsBeforeLoad: field.options?.length ?? 0,
            },
          );
        }

        await this.prepareFieldOptions(field);

        // Manually collect options from DOM if field.options is still empty
        if (!field.options || field.options.length === 0) {
          if (this.debug.logExtractedFields) {
            console.warn(
              "[VoiceForm] field.options still empty after prepareFieldOptions, manually collecting from DOM",
            );
          }
          const containers = getDropdownOptionContainers(field.element);
          const optionsMap = new Map<
            string,
            { value: string; label: string }
          >();

          for (const container of containers) {
            const optionElements =
              container.querySelectorAll<HTMLElement>("[role='option']");
            optionElements.forEach((optionElement) => {
              const { value, label } =
                readDropdownOptionMetadata(optionElement);
              const normalizedLabel = label?.trim();
              const normalizedValue = value?.trim() ?? normalizedLabel;
              if (normalizedLabel && normalizedValue) {
                const key = `${normalizedLabel.toLowerCase()}\u0000${normalizedValue.toLowerCase()}`;
                if (!optionsMap.has(key)) {
                  optionsMap.set(key, {
                    value: normalizedValue,
                    label: normalizedLabel,
                  });
                }
              }
            });
          }

          const collectedOptions = Array.from(optionsMap.values());
          if (this.debug.logExtractedFields) {
            console.info("[VoiceForm] Manually collected options from DOM:", {
              fieldLabel: field.label,
              optionsCount: collectedOptions.length,
              firstOptions: collectedOptions
                .slice(0, 5)
                .map((o) => `${o.value} (${o.label})`),
            });
          }

          // Update field.options so MutationObserver doesn't override
          field.options = collectedOptions;
        }

        // Update snapshot with newly loaded options
        fieldSnapshot = {
          ...fieldSnapshot,
          options: field.options ? [...field.options] : undefined,
        };
        if (this.debug.logExtractedFields) {
          console.info("[VoiceForm] Loaded options on-demand:", {
            fieldLabel: field.label,
            optionsCount: fieldSnapshot.options?.length ?? 0,
            firstOptions: fieldSnapshot.options
              ?.slice(0, 3)
              .map((o: { value: string; label: string }) => o.value),
          });
        }
      }

      if (this.debug.logExtractedFields) {
        console.info("[VoiceForm] Validating assignment:", {
          fieldLabel: field.label,
          fieldType: field.type,
          value: assignment.value,
          hasSnapshot: !!fieldSnapshot,
          snapshotOptions: fieldSnapshot?.options?.length ?? 0,
          fieldOptions: field.options?.length ?? 0,
          usingOptions:
            fieldSnapshot?.options?.length ?? field.options?.length ?? 0,
        });
      }

      const result = this.validateAssignment(
        field,
        assignment.value,
        fieldSnapshot?.options,
      );
      if (!result.valid || result.value === undefined) {
        if (this.debug.logExtractedFields) {
          console.warn("[VoiceForm] Validation failed:", {
            fieldLabel: field.label,
            fieldType: field.type,
            attemptedValue: assignment.value,
            validationMessage: result.message,
            availableOptions:
              fieldSnapshot?.options?.slice(0, 10) ??
              field.options?.slice(0, 10),
          });
        }
        issues.push({
          field,
          message: result.message ?? this.message("invalid_generic"),
          type: "error",
        });
        continue;
      }

      await this.setFieldValue(field, result.value);

      // CRITICAL: Re-fetch field reference in case re-extraction happened during setFieldValue
      // This ensures we have the current field object with preserved options
      const currentField = this.fields.find(
        (item) =>
          item.id === assignment.fieldId || item.name === assignment.fieldId,
      );
      if (!currentField) {
        if (this.debug.logExtractedFields) {
          console.error(
            `[VoiceForm] Field ${field.label} not found after setFieldValue - this should not happen`,
          );
        }
        continue;
      }

      if (this.debug.logExtractedFields) {
        console.log(
          `[VoiceForm] DEBUG Before copy - field.options: ${field.options?.length ?? "undefined"}, currentField.options: ${currentField.options?.length ?? "undefined"}, are same object: ${field === currentField}`,
        );
      }

      // CRITICAL: If options were loaded in the original field but not in currentField,
      // copy them over (in case re-extraction happened during setFieldValue)
      if (
        field.options &&
        field.options.length > 0 &&
        (!currentField.options || currentField.options.length === 0)
      ) {
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Copying ${field.options.length} options from original field to currentField for ${field.label}`,
          );
        }
        currentField.options = field.options;
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] DEBUG After copy - currentField.options: ${currentField.options?.length ?? "undefined"}`,
          );
        }
      }

      // CRITICAL: Verify the value was actually set in the DOM
      // This is especially important for custom dropdowns after reset
      // Use longer delay for custom dropdowns to ensure Angular has updated the state
      const verificationDelay = isCustomDropdownElement(currentField.element)
        ? 250
        : 100;
      await this.delay(verificationDelay);

      // CRITICAL: Re-ensure options are available before verification
      // Options can be lost between setFieldValue and verification if field gets re-extracted
      if (
        isCustomDropdownElement(currentField.element) &&
        (!currentField.options || currentField.options.length === 0)
      ) {
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Options missing before verification for ${currentField.label}, re-loading...`,
          );
        }
        await ensureCustomDropdownOptions(currentField, 5000);
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Re-loaded ${currentField.options?.length ?? 0} options for ${currentField.label}`,
          );
        }
      }

      // Log current options state before reading value
      if (isCustomDropdownElement(currentField.element)) {
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] DEBUG Before verification - currentField.options: ${currentField.options?.length ?? "undefined"}`,
          );
        }
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Verification for ${currentField.label}: field has ${currentField.options?.length ?? 0} options`,
          );
        }
      }

      const domValue = this.readFieldValue(currentField);

      // For custom dropdowns, also check if the label matches
      const isCustomDropdown = isCustomDropdownElement(currentField.element);
      let valueWasSet = false;

      if (Array.isArray(result.value)) {
        valueWasSet =
          Array.isArray(domValue) &&
          result.value.length === domValue.length &&
          result.value.every((v) => domValue.includes(v));
      } else {
        valueWasSet = domValue === result.value;

        // For custom dropdowns, also check if value matches any option's label
        if (
          !valueWasSet &&
          isCustomDropdown &&
          domValue &&
          currentField.options &&
          typeof result.value === "string" &&
          typeof domValue === "string"
        ) {
          const expectedValue = result.value;
          const actualValue = domValue;
          const matchedOption = currentField.options.find(
            (opt) =>
              (opt.value.toLowerCase() === expectedValue.toLowerCase() &&
                opt.label.toLowerCase() === actualValue.toLowerCase()) ||
              (opt.label.toLowerCase() === expectedValue.toLowerCase() &&
                opt.label.toLowerCase() === actualValue.toLowerCase()),
          );
          if (matchedOption) {
            if (this.debug.logExtractedFields) {
              console.log(
                `[VoiceForm] Value verified via label match for ${currentField.label}: ${actualValue} -> ${expectedValue}`,
              );
            }
            valueWasSet = true;
          }
        }
      }

      // Close dropdown after successful assignment (if custom dropdown)
      if (valueWasSet && isCustomDropdown) {
        closeDropdownElement(currentField.element);
      }

      if (!valueWasSet) {
        if (this.debug.logExtractedFields) {
          console.error(
            "[VoiceForm] Value was not actually set in DOM after setFieldValue:",
            {
              fieldLabel: currentField.label,
              fieldType: currentField.type,
              isCustomDropdown,
              expectedValue: result.value,
              actualDomValue: domValue,
              availableOptions: currentField.options
                ?.slice(0, 5)
                .map((o) => `${o.value}=${o.label}`),
            },
          );
        }

        // For custom dropdowns, try one more time with a longer delay
        if (isCustomDropdown) {
          if (this.debug.logExtractedFields) {
            console.warn(
              `[VoiceForm] Retrying value verification for ${currentField.label} after additional delay...`,
            );
          }
          await this.delay(500);
          const retryDomValue = this.readFieldValue(currentField);

          let retryValueWasSet = false;
          if (Array.isArray(result.value)) {
            retryValueWasSet =
              Array.isArray(retryDomValue) &&
              result.value.length === retryDomValue.length &&
              result.value.every((v) => retryDomValue.includes(v));
          } else {
            retryValueWasSet = retryDomValue === result.value;

            if (
              !retryValueWasSet &&
              retryDomValue &&
              currentField.options &&
              typeof result.value === "string" &&
              typeof retryDomValue === "string"
            ) {
              const expectedValue = result.value;
              const actualValue = retryDomValue;
              const matchedOption = currentField.options.find(
                (opt) =>
                  (opt.value.toLowerCase() === expectedValue.toLowerCase() &&
                    opt.label.toLowerCase() === actualValue.toLowerCase()) ||
                  (opt.label.toLowerCase() === expectedValue.toLowerCase() &&
                    opt.label.toLowerCase() === actualValue.toLowerCase()),
              );
              if (matchedOption) {
                if (this.debug.logExtractedFields) {
                  console.log(
                    `[VoiceForm] Value verified after retry for ${currentField.label}: ${actualValue} -> ${expectedValue}`,
                  );
                }
                retryValueWasSet = true;
              }
            }
          }

          if (retryValueWasSet) {
            if (this.debug.logExtractedFields) {
              console.log(
                `[VoiceForm] Value successfully verified after retry for ${currentField.label}`,
              );
            }
            // Continue to apply the field
            this.fieldState.set(currentField.id, {
              fieldId: currentField.id,
              value: result.value,
              confidence: assignment.confidence,
              skipped: false,
            });
            this.emitAssignment({
              fieldId: currentField.id,
              value: result.value,
            });
            applied = true;
            if (!appliedFields.includes(currentField)) {
              appliedFields.push(currentField);
            }
            continue;
          }
        }

        issues.push({
          field: currentField,
          message: `Failed to set value for ${currentField.label}. Please try again.`,
          type: "error",
        });
        continue;
      }

      this.fieldState.set(currentField.id, {
        fieldId: currentField.id,
        value: result.value,
        confidence: assignment.confidence,
        skipped: false,
      });
      this.emitAssignment({ fieldId: currentField.id, value: result.value });
      applied = true;
      if (!appliedFields.includes(currentField)) {
        appliedFields.push(currentField);
      }

      if (this.debug.logExtractedFields) {
        console.info("[VoiceForm] Successfully applied and verified value:", {
          fieldLabel: currentField.label,
          fieldType: currentField.type,
          appliedValue: result.value,
          domValue: domValue,
        });
      }

      if (result.warnings) {
        for (const warning of result.warnings) {
          issues.push({ field, message: warning, type: "warning" });
        }
      }
    }

    return { applied, issues, appliedFields };
  }

  private async markFieldSkipped(field: ExtractedFormField): Promise<void> {
    const emptyValue: string | string[] = field.allowMultiple ? [] : "";
    await this.setFieldValue(field, emptyValue);
    this.fieldState.set(field.id, {
      fieldId: field.id,
      value: emptyValue,
      skipped: true,
    });
    this.emitAssignment({ fieldId: field.id, value: emptyValue });
    this.emitStatus({
      message: this.message("status_skipped", { label: field.label }),
    });
  }

  private validateAssignment(
    field: ExtractedFormField,
    value: string | string[],
    snapshotOptions?: Array<{ value: string; label: string }>,
  ): {
    valid: boolean;
    value: string | string[] | undefined;
    message?: string;
    warnings?: string[];
  } {
    // Use snapshot options if provided (to avoid race condition where field.options gets cleared)
    const options = snapshotOptions ?? field.options;
    if (field.allowMultiple) {
      const values = Array.isArray(value) ? value : splitValues(value);
      const sanitized = values
        .map((item) => sanitizeTranscriptValue(item))
        .filter(Boolean);
      if (!sanitized.length) {
        return {
          valid: false,
          value,
          message: this.message("missing_value", { label: field.label }),
        };
      }
      if (options && options.length) {
        const allowed = new Map<string, string>();
        for (const option of options) {
          allowed.set(option.value.toLowerCase(), option.value);
        }
        const accepted: string[] = [];
        const unknown: string[] = [];
        for (const item of sanitized) {
          const match = allowed.get(item.toLowerCase());
          if (match) {
            accepted.push(match);
          } else {
            unknown.push(item);
          }
        }

        if (accepted.length && unknown.length) {
          return {
            valid: true,
            value: accepted,
            warnings: [
              this.message("multi_select_warning", {
                values: unknown.join(", "),
              }),
            ],
          };
        }

        if (!accepted.length) {
          return {
            valid: false,
            value,
            message: this.message("multi_select_warning", {
              values: unknown.join(", "),
            }),
          };
        }

        return { valid: true, value: accepted };
      }
      return { valid: true, value: sanitized };
    }

    const rawTextValue = Array.isArray(value) ? value[0] : value;
    const cleanedTextValue = rawTextValue
      ? sanitizeTranscriptValue(rawTextValue)
      : "";
    if (!cleanedTextValue) {
      return {
        valid: false,
        value,
        message: this.message("missing_value", { label: field.label }),
      };
    }

    // Normalize numeric speech artifacts (commas/trailing punctuation) before validation.
    // This also covers numeric-like text inputs (e.g. income fields rendered as type="text").
    const shouldNormalizeNumeric =
      field.type === "number" ||
      (isNumericLikeSpokenValue(cleanedTextValue) &&
        isLikelyNumericField(field)) ||
      // CRITICAL: Always normalize for income/amount/salary fields even if LLM didn't extract properly
      /\b(income|salary|amount|price|cost|fee|revenue|profit|expense|budget|wage)\b/i.test(
        field.name + " " + field.label,
      );
    let textValue = shouldNormalizeNumeric
      ? sanitizeNumericAssignmentValue(cleanedTextValue)
      : cleanedTextValue;

    if (!textValue) {
      return {
        valid: false,
        value,
        message: this.message("missing_value", { label: field.label }),
      };
    }

    const digitCodeRule = getStrictDigitCodeRule(field);
    if (digitCodeRule) {
      const normalizedCode = normalizeDigitCodeValue(textValue);
      if (!normalizedCode) {
        return {
          valid: false,
          value,
          message: this.message("invalid_digit_code", { label: field.label }),
        };
      }

      if (
        digitCodeRule.exactLength !== undefined &&
        normalizedCode.length !== digitCodeRule.exactLength
      ) {
        return {
          valid: false,
          value,
          message: this.message("invalid_digit_code_length", {
            label: field.label,
            length: digitCodeRule.exactLength,
          }),
        };
      }

      textValue = normalizedCode;
    }

    if (
      field.constraints.minLength &&
      textValue.length < field.constraints.minLength
    ) {
      return {
        valid: false,
        value,
        message: this.message("min_length", {
          label: field.label,
          min: field.constraints.minLength,
        }),
      };
    }

    if (
      field.constraints.maxLength &&
      textValue.length > field.constraints.maxLength
    ) {
      return {
        valid: false,
        value,
        message: this.message("max_length", {
          label: field.label,
          max: field.constraints.maxLength,
        }),
      };
    }

    if (field.constraints.pattern) {
      const pattern = new RegExp(field.constraints.pattern);
      if (!pattern.test(textValue)) {
        return {
          valid: false,
          value,
          message: this.message("pattern_mismatch", { label: field.label }),
        };
      }
    }

    if (field.type === "number") {
      const numeric = Number(textValue);
      if (Number.isNaN(numeric)) {
        return {
          valid: false,
          value,
          message: this.message("must_be_number", { label: field.label }),
        };
      }
      if (
        field.constraints.min !== undefined &&
        numeric < field.constraints.min
      ) {
        return {
          valid: false,
          value,
          message: this.message("min_value", {
            label: field.label,
            min: field.constraints.min,
          }),
        };
      }
      if (
        field.constraints.max !== undefined &&
        numeric > field.constraints.max
      ) {
        return {
          valid: false,
          value,
          message: this.message("max_value", {
            label: field.label,
            max: field.constraints.max,
          }),
        };
      }
      if (field.constraints.step !== undefined) {
        const step = field.constraints.step;
        const origin = field.constraints.min ?? 0;
        const relative = (numeric - origin) / step;
        const nearest = Math.round(relative);
        const delta = Math.abs(relative - nearest);
        if (delta > 1e-8) {
          return {
            valid: false,
            value,
            message: this.message("step_increment", {
              label: field.label,
              step: field.constraints.step,
            }),
          };
        }
        const precision = Math.max(
          countDecimalPlaces(step),
          countDecimalPlaces(origin),
        );
        const normalized = Number((origin + nearest * step).toFixed(precision));
        return { valid: true, value: normalized.toString() };
      }
      return { valid: true, value: numeric.toString() };
    }

    if (field.type === "select" || field.type === "radio") {
      if (options && options.length) {
        // First check if LLM returned exact value
        const exactMatch = options.find((opt) => opt.value === textValue);
        if (exactMatch) {
          return { valid: true, value: exactMatch.value };
        }

        // Allow exact label match as a strict fallback.
        const normalizedInput = textValue.trim().toLowerCase();
        const labelMatch = options.find(
          (opt) => opt.label.trim().toLowerCase() === normalizedInput,
        );
        if (labelMatch) {
          return { valid: true, value: labelMatch.value };
        }

        // Use fuzzy matching (same logic as initial field filling)
        // This handles phonetic variations, case differences, etc.
        const fuzzyMatch = findBestOptionMatch(textValue, options);
        if (fuzzyMatch && fuzzyMatch.score >= 0.72) {
          if (this.debug.logExtractedFields) {
            console.info("[VoiceForm] Fuzzy match found during validation:", {
              input: textValue,
              matched: fuzzyMatch.option.value,
              score: fuzzyMatch.score,
              fieldLabel: field.label,
            });
          }
          return { valid: true, value: fuzzyMatch.option.value };
        }

        // No match found
        if (this.debug.logExtractedFields) {
          console.warn("[VoiceForm] Value not found in options:", {
            valueToSelect: textValue,
            fieldLabel: field.label,
            availableOptions: options.map((o) => o.value),
          });
        }
        return {
          valid: false,
          value: textValue,
          message: this.message("option_not_available", {
            value: textValue,
            label: field.label,
          }),
        };
      }
    }

    if (field.constraints.required && !textValue.trim()) {
      return {
        valid: false,
        value,
        message: this.message("missing_value", { label: field.label }),
      };
    }

    return { valid: true, value: textValue.trim() };
  }

  private findBestOptionMatch(
    input: string,
    options: Array<{ value: string; label: string }>,
  ): { value: string; label: string } | null {
    if (!input || !options.length) {
      return null;
    }

    const normalize = (text: string): string => {
      return text
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .trim();
    };

    const phoneticKey = (text: string): string => {
      const normalized = normalize(text);
      if (!normalized) {
        return "";
      }

      const transformed = normalized
        .replace(/ph/g, "f")
        .replace(/ck/g, "k")
        .replace(/dg/g, "j")
        .replace(/gh/g, "g")
        .replace(/kh/g, "k")
        .replace(/sh/g, "s")
        .replace(/ch/g, "c")
        .replace(/th/g, "t")
        .replace(/dh/g, "d")
        .replace(/qu/g, "k")
        .replace(/q/g, "k")
        .replace(/x/g, "ks")
        .replace(/z/g, "s")
        .replace(/c/g, "k")
        .replace(/h/g, "");

      if (!transformed) {
        return "";
      }

      const first = transformed.charAt(0);
      const rest = transformed.slice(1).replace(/[aeiouy]/g, "");
      return `${first}${rest}`;
    };

    // Calculate Levenshtein distance for string similarity
    const levenshteinDistance = (str1: string, str2: string): number => {
      const len1 = str1.length;
      const len2 = str2.length;
      const matrix: number[][] = [];

      for (let i = 0; i <= len1; i++) {
        matrix[i] = [i];
      }
      for (let j = 0; j <= len2; j++) {
        matrix[0][j] = j;
      }

      for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
          if (str1.charAt(i - 1) === str2.charAt(j - 1)) {
            matrix[i][j] = matrix[i - 1][j - 1];
          } else {
            matrix[i][j] = Math.min(
              matrix[i - 1][j - 1] + 1, // substitution
              matrix[i][j - 1] + 1, // insertion
              matrix[i - 1][j] + 1, // deletion
            );
          }
        }
      }

      return matrix[len1][len2];
    };

    // Calculate similarity percentage (0-1)
    const similarity = (str1: string, str2: string): number => {
      const maxLen = Math.max(str1.length, str2.length);
      if (maxLen === 0) return 1.0;
      const distance = levenshteinDistance(str1, str2);
      return 1 - distance / maxLen;
    };

    const inputNorm = normalize(input);
    const inputPhonetic = phoneticKey(inputNorm);

    // Common phonetic mappings for speech recognition errors
    const phoneticMappings: Record<string, string[]> = {
      journal: ["general"],
      sick: ["sikh"],
      seek: ["sikh"],
      sec: ["sikh"],
      hindo: ["hindu"],
      moslem: ["muslim"],
      kristian: ["christian"],
      christan: ["christian"],
    };

    // Check if input has a known phonetic variant
    const phoneticVariants = new Set<string>([inputNorm]);
    if (phoneticMappings[inputNorm]) {
      phoneticMappings[inputNorm].forEach((variant) =>
        phoneticVariants.add(variant),
      );
    }
    const phoneticVariantList = Array.from(phoneticVariants).filter(Boolean);

    // Try exact normalized match (including phonetic variants)
    for (const variant of phoneticVariantList) {
      for (const opt of options) {
        if (
          normalize(opt.value) === variant ||
          normalize(opt.label) === variant
        ) {
          return opt;
        }
      }
    }

    // Phonetic exact match for full words (skip very short options like SC/ST).
    if (inputPhonetic) {
      for (const opt of options) {
        const valueNorm = normalize(opt.value);
        const labelNorm = normalize(opt.label);

        const valuePhonetic =
          valueNorm.length >= 4 ? phoneticKey(valueNorm) : "";
        const labelPhonetic =
          labelNorm.length >= 4 ? phoneticKey(labelNorm) : "";

        if (
          (valuePhonetic && valuePhonetic === inputPhonetic) ||
          (labelPhonetic && labelPhonetic === inputPhonetic)
        ) {
          return opt;
        }
      }
    }

    // Try substring match
    for (const opt of options) {
      const valueNorm = normalize(opt.value);
      const labelNorm = normalize(opt.label);
      if (
        (inputNorm.includes(valueNorm) && valueNorm.length > 2) ||
        (valueNorm.includes(inputNorm) && inputNorm.length > 2) ||
        (inputNorm.includes(labelNorm) && labelNorm.length > 2) ||
        (labelNorm.includes(inputNorm) && inputNorm.length > 2)
      ) {
        return opt;
      }
    }

    // Try similarity-based matching (edit distance)
    // Find the option with highest similarity score
    let bestMatch: { value: string; label: string } | null = null;
    let bestScore = 0;

    for (const opt of options) {
      const valueNorm = normalize(opt.value);
      const labelNorm = normalize(opt.label);

      // Calculate similarity for both value and label
      const valueSimilarity = similarity(inputNorm, valueNorm);
      const labelSimilarity = similarity(inputNorm, labelNorm);
      const score = Math.max(valueSimilarity, labelSimilarity);

      // For phonetic matching, also check against known variants
      let phoneticScore = 0;
      for (const variant of phoneticVariantList.slice(1)) {
        // Skip first one (original input)
        const variantValueSim = similarity(variant, valueNorm);
        const variantLabelSim = similarity(variant, labelNorm);
        phoneticScore = Math.max(
          phoneticScore,
          variantValueSim,
          variantLabelSim,
        );
      }

      const valuePhonetic = valueNorm.length >= 4 ? phoneticKey(valueNorm) : "";
      const labelPhonetic = labelNorm.length >= 4 ? phoneticKey(labelNorm) : "";
      if (inputPhonetic && valuePhonetic) {
        phoneticScore = Math.max(
          phoneticScore,
          similarity(inputPhonetic, valuePhonetic),
        );
      }
      if (inputPhonetic && labelPhonetic) {
        phoneticScore = Math.max(
          phoneticScore,
          similarity(inputPhonetic, labelPhonetic),
        );
      }

      if (
        inputPhonetic &&
        ((valuePhonetic && inputPhonetic === valuePhonetic) ||
          (labelPhonetic && inputPhonetic === labelPhonetic))
      ) {
        phoneticScore = Math.max(phoneticScore, 0.98);
      }

      const finalScore = Math.max(score, phoneticScore);

      // Threshold: 70% similarity required for a match
      if (finalScore > bestScore && finalScore >= 0.7) {
        bestScore = finalScore;
        bestMatch = opt;
      }
    }

    return bestMatch;
  }

  private async setFieldValue(
    field: ExtractedFormField,
    value: string | string[],
  ): Promise<void> {
    this.isSettingValueProgrammatically = true;
    try {
      await this.setFieldValueInternal(field, value);
    } finally {
      // Delay reset to allow DOM events to complete
      setTimeout(() => {
        this.isSettingValueProgrammatically = false;
      }, 200);
    }
  }

  private async setFieldValueInternal(
    field: ExtractedFormField,
    value: string | string[],
  ): Promise<void> {
    if (field.selectElement) {
      const select = field.selectElement;
      if (select.multiple) {
        const valuesArray = Array.isArray(value) ? value : [value];
        const sanitized = valuesArray.filter((item) => item !== "");
        const set = new Set(sanitized);
        Array.from(select.options).forEach((option) => {
          option.selected = set.has(option.value);
        });
      } else {
        const targetValue = Array.isArray(value) ? (value[0] ?? "") : value;
        select.value = targetValue;
        if (targetValue === "" && select.value !== "") {
          select.selectedIndex = -1;
        }
      }
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    if (field.textareaElement) {
      field.textareaElement.value = Array.isArray(value)
        ? value.join(", ")
        : value;
      field.textareaElement.dispatchEvent(
        new Event("input", { bubbles: true }),
      );
      return;
    }

    if (field.inputElements.length > 1) {
      const values = Array.isArray(value) ? value : [value];
      const set = new Set(values.map((item) => item.toLowerCase()));
      for (const input of field.inputElements) {
        input.checked = set.has(input.value.toLowerCase());
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }

    // Custom dropdowns (ng-select, div[role=listbox], etc.)
    if (isCustomDropdownElement(field.element)) {
      const valuesArr = Array.isArray(value) ? value : [value];

      // Check if options need to be loaded
      const needsOptionsLoad = !field.options || field.options.length === 0;

      if (needsOptionsLoad) {
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Options missing or empty for ${field.label}, loading options before setting value...`,
          );
        }
        // Force reload by clearing first
        field.options = undefined;
        await ensureCustomDropdownOptions(field, 2500);

        const optionCount1 = (field.options as any[] | undefined)?.length ?? 0;
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Loaded ${optionCount1} options for ${field.label} and options are`,
            field.options,
          );
        }

        // If still no options, try opening and closing dropdown to trigger Angular
        if (optionCount1 === 0) {
          if (this.debug.logExtractedFields) {
            console.warn(
              `[VoiceForm] No options found for ${field.label} after first attempt, loading options again...`,
            );
          }

          // Reload options without opening dropdown (selectCustomDropdownValue will open it)
          field.options = undefined;
          await ensureCustomDropdownOptions(field, 4000);

          const optionCount2 =
            (field.options as any[] | undefined)?.length ?? 0;
          if (this.debug.logExtractedFields) {
            console.log(
              `[VoiceForm] After second attempt: ${optionCount2} options for ${field.label}`,
            );
          }
        }
      } else {
        const cachedCount = field.options?.length ?? 0;
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Using cached ${cachedCount} options for ${field.label}`,
          );
        }
      }

      // CRITICAL: After loading options, update the corresponding field in this.fields
      // This handles the case where mutation observer fired during option loading
      if (field.options && field.options.length > 0) {
        const fieldInArray = this.fields.find(
          (f) => f.id === field.id || f.name === field.name,
        );
        if (fieldInArray && fieldInArray !== field) {
          if (this.debug.logExtractedFields) {
            console.log(
              `[VoiceForm] Updating field in this.fields array with ${field.options.length} loaded options for ${field.label}`,
            );
          }
          fieldInArray.options = field.options;
        }
      }

      // Verify options were loaded and contain the values we want to set
      const hasAllValues = valuesArr.every((val) =>
        field.options?.some((opt) => opt.value === val),
      );

      if (!hasAllValues) {
        if (this.debug.logExtractedFields) {
          console.warn(`[VoiceForm] Not all values found in field.options:`, {
            fieldLabel: field.label,
            valuesToSet: valuesArr,
            optionsCount: field.options?.length ?? 0,
            availableOptions: field.options?.map((o) => o.value),
          });
        }

        // If options exist but value not found, it might be a label vs value issue
        // or the dropdown needs more time to populate
        if (field.options && field.options.length > 0) {
          if (this.debug.logExtractedFields) {
            console.warn(
              `[VoiceForm] Options exist but value not found, this might be a value/label mismatch`,
            );
          }
        } else {
          // No options at all - this is a critical issue
          if (this.debug.logExtractedFields) {
            console.error(
              `[VoiceForm] CRITICAL: No options available for ${field.label}. Cannot set value.`,
            );
          }
          // Try one last desperate attempt
          await this.delay(300);
          field.options = undefined;
          await ensureCustomDropdownOptions(field, 5000);
          const finalCount = (field.options as any[] | undefined)?.length ?? 0;
          if (this.debug.logExtractedFields) {
            console.log(
              `[VoiceForm] Final attempt: ${finalCount} options for ${field.label}`,
            );
          }
        }
      }

      if (this.debug.logExtractedFields) {
        console.info("[VoiceForm] Setting custom dropdown value:", {
          fieldLabel: field.label,
          fieldId: field.id,
          valuesToSet: valuesArr,
          availableOptions: field.options
            ?.slice(0, 10)
            .map((o) => `${o.value} (${o.label})`),
        });
      }

      for (const val of valuesArr) {
        // Pass true to indicate options were just loaded, skip re-opening dropdown
        await this.selectCustomDropdownValue(field, val, needsOptionsLoad);
      }

      // Add extra delay after custom dropdown selection to ensure Angular has updated the DOM
      // This is especially critical after form reset
      await this.delay(200);
      await this.ensureCustomDropdownClosed(field.element);
      return;
    }

    const target = field.inputElements[0];
    if (target) {
      const stringValue = Array.isArray(value) ? value.join(", ") : value;

      // Angular Material datepicker inputs are readonly (to prevent keyboard entry)
      // but their internal _onInput handler may bail out early when readonly is set.
      // Temporarily lift readonly, set value via the native prototype setter (to
      // bypass any Angular value-interception), dispatch events, then restore.
      const wasReadonly = target.readOnly;
      if (wasReadonly) {
        target.readOnly = false;
      }

      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(target, stringValue);
      } else {
        target.value = stringValue;
      }

      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));

      if (wasReadonly) {
        target.readOnly = true;
      }
      return;
    }

    return;
  }

  private async waitForSilence(durationMs: number): Promise<void> {
    if (durationMs <= 0) {
      return;
    }

    const pollInterval = 100;
    while (true) {
      const now = Date.now();
      const silentFor =
        !this.userSpeaking && this.lastSilenceAt ? now - this.lastSilenceAt : 0;

      if (silentFor >= durationMs) {
        return;
      }

      if (!this.running && !this.listeningActive) {
        return;
      }

      await this.delay(pollInterval);
    }
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async speak(text: string): Promise<void> {
    const guard = ++this.speechGuard;

    // FIRST: Emit the new speech text to UI (so user sees what assistant will say)
    this.emitSpeech({ text });

    // SECOND: Clear previous user transcript from display
    this.emitTranscript({ text: "", isFinal: true });

    // THEN: Do async operations
    await this.stopSpeaking({ force: true });
    if (guard !== this.speechGuard) {
      return;
    }

    await this.waitForSilence(SILENCE_TIMEOUT_MS);
    if (guard !== this.speechGuard) {
      return;
    }

    // Use different TTS based on provider
    if (this.speechProvider === "bhashini") {
      await this.speakWithBhashini(text, guard);
    } else if (this.speechProvider === "sarvam") {
      await this.speakWithSarvam(text, guard);
    } else {
      await this.speakWithAzure(text, guard);
    }
  }

  /**
   * Speak using Azure TTS
   */
  private async speakWithAzure(text: string, guard: number): Promise<void> {
    await this.ensureSynthesizer();
    if (guard !== this.speechGuard) {
      return;
    }

    const token = ++this.speakToken;
    this.speaking = true;

    const completion = new Promise<void>((resolve, reject) => {
      let finished = false;

      const finalize = (error?: Error) => {
        if (finished) {
          return;
        }
        finished = true;
        if (this.pendingSpeakResolve === finalize) {
          this.pendingSpeakResolve = null;
        }
        if (this.speakToken === token) {
          this.speaking = false;
        }
        const activeContext = this.listenContext;
        if (
          activeContext &&
          !activeContext.completed &&
          activeContext.allowConcurrentSpeech
        ) {
          this.scheduleFinalize(activeContext);
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      const handleResult = async (result: SpeechSynthesisResult) => {
        if (guard !== this.speechGuard || this.speakToken !== token) {
          finalize();
          return;
        }

        try {
          if (result.reason !== ResultReason.SynthesizingAudioCompleted) {
            const errorMessage =
              result.errorDetails || "Speech synthesis failed.";
            const synthesisError = new Error(errorMessage);
            this.emitError(synthesisError);
            finalize(synthesisError);
            return;
          }

          await this.playSynthesizedAudio(result, token, guard);
          finalize();
        } catch (error) {
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          this.emitError(normalized);
          finalize(normalized);
        }
      };

      this.pendingSpeakResolve = finalize;

      this.synthesizer!.speakTextAsync(
        text,
        (result: SpeechSynthesisResult) => {
          void handleResult(result);
        },
        (error: string) => {
          const err = new Error(error);
          this.emitError(err);
          finalize(err);
        },
      );
    });

    this.speakingPromise = completion;
    try {
      await completion;
    } finally {
      if (this.speakingPromise === completion) {
        this.speakingPromise = null;
      }
    }
  }

  /**
   * Speak using Bhashini TTS
   */
  private async speakWithBhashini(text: string, guard: number): Promise<void> {
    if (!this.bhashiniSpeechService) {
      if (this.debug.logExtractedFields) {
        console.warn("[VoiceForm] Bhashini TTS not available, skipping speech");
      }
      return;
    }

    const token = ++this.speakToken;
    this.speaking = true;

    const completion = new Promise<void>((resolve, reject) => {
      let finished = false;

      const finalize = (error?: Error) => {
        if (finished) {
          return;
        }
        finished = true;
        if (this.pendingSpeakResolve === finalize) {
          this.pendingSpeakResolve = null;
        }
        if (this.speakToken === token) {
          this.speaking = false;
        }
        const activeContext = this.listenContext;
        if (
          activeContext &&
          !activeContext.completed &&
          activeContext.allowConcurrentSpeech
        ) {
          this.scheduleFinalize(activeContext);
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      this.pendingSpeakResolve = finalize;

      // Synthesize speech with Bhashini
      this.bhashiniSpeechService!.synthesizeSpeech(text)
        .then((audioContent) => {
          if (guard !== this.speechGuard || this.speakToken !== token) {
            finalize();
            return;
          }

          // Play the audio
          return this.playBhashiniAudio(audioContent, token, guard);
        })
        .then(() => {
          finalize();
        })
        .catch((error) => {
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          this.emitError(normalized);
          finalize(normalized);
        });
    });

    this.speakingPromise = completion;
    try {
      await completion;
    } finally {
      if (this.speakingPromise === completion) {
        this.speakingPromise = null;
      }
    }
  }

  /**
   * Play Bhashini base64-encoded audio
   */
  private async playBhashiniAudio(
    audioContent: string,
    token: number,
    guard: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.speechGuard !== guard || this.speakToken !== token) {
        resolve();
        return;
      }

      // Create audio element with base64 data URL
      const audio = new Audio(`data:audio/wav;base64,${audioContent}`);
      audio.preload = "auto";

      const cleanup = () => {
        if (this.speechAudio === audio) {
          this.speechAudio = null;
        }
        if (this.audioPlaybackTeardown === teardown) {
          this.audioPlaybackTeardown = null;
        }
      };

      const teardown = (error?: Error) => {
        cleanup();
        try {
          audio.pause();
          audio.src = "";
        } catch (_err) {
          // Ignore cleanup errors
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      audio.onended = () => {
        if (this.speechGuard === guard && this.speakToken === token) {
          teardown();
        }
      };

      audio.onerror = () => {
        const error = new Error("Audio playback failed");
        teardown(error);
      };

      this.speechAudio = audio;
      this.audioPlaybackTeardown = teardown;

      audio
        .play()
        .then(() => {
          if (this.speechGuard !== guard || this.speakToken !== token) {
            teardown();
          }
        })
        .catch((error) => {
          const playError =
            error instanceof Error ? error : new Error(String(error));
          teardown(playError);
        });
    });
  }

  private async ensureActiveRecognizer(): Promise<
    SpeechRecognizer | BhashiniASRClient | any
  > {
    if (this.speechProvider === "bhashini") {
      return this.ensureBhashiniRecognizer();
    }

    if (this.speechProvider === "sarvam") {
      return this.ensureSarvamRecognizer();
    }

    // Azure provider
    if (!this.activeListening) {
      // Configure enhanced microphone constraints for noise suppression
      const audioConfig = await this.createNoiseSuppressionAudioConfig();
      const recognizer = new SpeechRecognizer(this.speechConfig, audioConfig);

      // Add phrase list grammar to improve recognition of specific terms
      const phraseListGrammar = PhraseListGrammar.fromRecognizer(recognizer);
      // Store reference for dynamic updates based on current field
      this.phraseListGrammar = phraseListGrammar;

      phraseListGrammar.addPhrase("Sikh");
      phraseListGrammar.addPhrase("Jain");
      phraseListGrammar.addPhrase("ST");
      phraseListGrammar.addPhrase("Un married");
      phraseListGrammar.addPhrase("Ganaur");
      phraseListGrammar.addPhrase("Kharkhoda");
      phraseListGrammar.addPhrase("Number");
      phraseListGrammar.addPhrase("Street");
      phraseListGrammar.addPhrase("Divyang Jan");
      phraseListGrammar.addPhrase("Divyangjan");
      phraseListGrammar.addPhrase("Divyang");
      phraseListGrammar.addPhrase("Beedi Worker");
      phraseListGrammar.addPhrase("Cine Worker");
      phraseListGrammar.addPhrase("Assam Rifles");
      phraseListGrammar.addPhrase("Mica Mines");

      this.attachRecognizerHandlers(recognizer);
      this.activeListening = recognizer;
      this.listeningActive = false;
    }

    if (
      !this.listeningActive &&
      !this.recognizerSetupPromise &&
      this.activeListening
    ) {
      this.recognizerSetupPromise = new Promise<void>((resolve) => {
        this.activeListening!.startContinuousRecognitionAsync(
          () => {
            this.listeningActive = true;
            this.lastSilenceAt = Date.now();
            resolve();
          },
          (error: string) => {
            this.emitError(new Error(error));
            this.listeningActive = false;
            resolve();
          },
        );
      });
    }

    if (this.recognizerSetupPromise) {
      await this.recognizerSetupPromise;
      this.recognizerSetupPromise = null;
    }

    return this.activeListening!;
  }

  private attachRecognizerHandlers(recognizer: SpeechRecognizer): void {
    recognizer.speechStartDetected = this.handleSpeechStartDetected;
    recognizer.recognizing = this.handleRecognizing;
    recognizer.recognized = this.handleRecognized;
    recognizer.canceled = this.handleCanceled;
    recognizer.sessionStopped = this.handleSessionStopped;
  }

  private clearFinalizeTimer(context: ListenContext): void {
    if (context.finalizeTimer) {
      clearTimeout(context.finalizeTimer);
      context.finalizeTimer = null;
    }
  }

  private scheduleFinalize(
    context: ListenContext,
    timeout: number = SILENCE_TIMEOUT_MS,
  ): void {
    this.clearFinalizeTimer(context);
    context.finalizeTimer = setTimeout(() => {
      if (context.completed || this.listenContext !== context) {
        return;
      }

      const synthesizerActive =
        context.allowConcurrentSpeech &&
        (this.speaking || this.pendingSpeakResolve);
      const userSpeechActive =
        this.userSpeaking || this.speechOngoingSince !== null;
      const now = Date.now();
      const insufficientSilence =
        context.heardSpeech &&
        (this.lastSilenceAt === 0 ||
          now - this.lastSilenceAt < SILENCE_TIMEOUT_MS);

      if (synthesizerActive || userSpeechActive || insufficientSilence) {
        const retryDelay =
          userSpeechActive || context.heardSpeech
            ? Math.min(timeout, 500)
            : timeout;
        this.scheduleFinalize(context, retryDelay);
        return;
      }

      this.finishListening(context, context.buffered.trim());
    }, timeout);
  }

  private finishListening(context: ListenContext, transcript: string): void {
    if (context.completed) {
      return;
    }
    context.completed = true;
    this.clearFinalizeTimer(context);
    if (this.listenContext === context) {
      this.listenContext = null;
    }
    updateBufferedFromSegments(context);
    this.userSpeaking = false;
    this.speechOngoingSince = null;
    this.lastSilenceAt = Date.now();
    this.scheduleSilenceCheck();
    context.resolve(context.buffered.trim());
  }

  private scheduleSilenceCheck(): void {
    if (this.silenceResetTimer) {
      clearTimeout(this.silenceResetTimer);
    }
    this.silenceResetTimer = setTimeout(() => {
      this.userSpeaking = false;
      this.speechOngoingSince = null;
      this.lastSilenceAt = Date.now();
    }, SILENCE_TIMEOUT_MS);
  }

  private invalidatePendingSpeech(): void {
    this.speechGuard++;
  }

  private handleSpeechStartDetected = (
    _sender: Recognizer,
    _event: RecognitionEventArgs,
  ) => {
    const now = Date.now();
    if (!this.userSpeaking) {
      this.userSpeaking = true;
      this.speechOngoingSince = now;
    }
    this.lastUserSpeechAt = now;
    this.lastSilenceAt = 0;
    this.invalidatePendingSpeech();
    if (this.speaking || this.pendingSpeakResolve) {
      void this.stopSpeaking({ force: true });
    }
    this.scheduleSilenceCheck();
  };

  private handleRecognizing = (
    _sender: Recognizer,
    event: SpeechRecognitionEventArgs,
  ) => {
    if (!this.running) {
      return;
    }

    if (this.debug.logExtractedFields) {
      console.log("[VoiceForm] Recognizing event received:", event);
    }

    const partial = event.result?.text?.trim();
    if (!partial) {
      return;
    }

    const now = Date.now();
    if (!this.userSpeaking) {
      this.userSpeaking = true;
      this.speechOngoingSince = now;
    }
    this.lastUserSpeechAt = now;
    this.lastSilenceAt = 0;
    this.invalidatePendingSpeech();
    if (this.speaking || this.pendingSpeakResolve) {
      void this.stopSpeaking({ force: true });
    }
    this.scheduleSilenceCheck();

    const context = this.listenContext;
    if (!context) {
      return;
    }

    context.partial = partial;
    context.heardSpeech = true;
    updateBufferedFromSegments(context);
    this.emitTranscript({ text: context.buffered, isFinal: false });
    this.scheduleFinalize(context);
  };

  private handleRecognized = (
    _sender: Recognizer,
    event: SpeechRecognitionEventArgs,
  ) => {
    if (!this.running) {
      if (this.listenContext) {
        this.finishListening(this.listenContext, this.listenContext.buffered);
      }
      return;
    }

    if (this.debug.logExtractedFields) {
      console.log("[VoiceForm] Recognized event received:", event);
    }

    const context = this.listenContext;
    const now = Date.now();
    this.lastUserSpeechAt = now;
    this.lastSilenceAt = 0;
    this.scheduleSilenceCheck();

    if (event.result.reason === ResultReason.RecognizedSpeech) {
      const text = event.result.text.trim();
      if (text && context) {
        pushTranscriptSegment(context.segments, text);
        context.partial = "";
        context.heardSpeech = true;
        updateBufferedFromSegments(context);
        this.emitTranscript({ text: context.buffered, isFinal: true });
        this.scheduleFinalize(context);
        return;
      }
    }

    if (event.result.reason === ResultReason.NoMatch && context) {
      this.scheduleFinalize(context);
      return;
    }

    const fallback = event.result.text?.trim();
    if (fallback && context) {
      pushTranscriptSegment(context.segments, fallback);
      context.partial = "";
      context.heardSpeech = true;
      updateBufferedFromSegments(context);
      this.emitTranscript({ text: context.buffered, isFinal: true });
      this.scheduleFinalize(context);
    }
  };

  private handleCanceled = (
    _sender: Recognizer,
    event: SpeechRecognitionCanceledEventArgs,
  ) => {
    if (event.reason === CancellationReason.Error && event.errorDetails) {
      this.emitError(new Error(event.errorDetails));
    }
    if (this.listenContext) {
      this.finishListening(
        this.listenContext,
        this.listenContext.buffered.trim(),
      );
    }
  };

  private handleSessionStopped = () => {
    this.listeningActive = false;
    if (this.listenContext) {
      this.finishListening(
        this.listenContext,
        this.listenContext.buffered.trim(),
      );
    }
    if (this.running) {
      void this.ensureActiveRecognizer();
    }
  };

  private async listen(options?: {
    allowConcurrentSpeech?: boolean;
  }): Promise<string> {
    if (!this.running) {
      return "";
    }

    if (!options?.allowConcurrentSpeech) {
      await this.stopSpeaking();
    }

    await this.ensureActiveRecognizer();

    if (this.listenContext) {
      this.finishListening(
        this.listenContext,
        this.listenContext.buffered.trim(),
      );
    }

    return new Promise<string>((resolve) => {
      const context: ListenContext = {
        resolve,
        buffered: "",
        finalizeTimer: null,
        completed: false,
        allowConcurrentSpeech: Boolean(options?.allowConcurrentSpeech),
        heardSpeech: false,
        segments: [],
        partial: "",
      };
      this.listenContext = context;
      this.scheduleFinalize(context, INITIAL_SILENCE_TIMEOUT_MS);
    });
  }

  private emitPrompt(payload: { text: string; fieldId?: string }) {
    this.hooks.onPrompt?.(payload);
  }

  private emitSpeech(payload: { text: string }) {
    this.hooks.onSpeechSynthesis?.(payload);
  }

  private emitTranscript(payload: { text: string; isFinal?: boolean }) {
    this.hooks.onTranscript?.(payload);
  }

  private emitAssignment(payload: {
    fieldId: string;
    value: string | string[];
  }) {
    this.hooks.onAssignment?.(payload);
  }

  private emitStatus(payload: { message: string }) {
    this.hooks.onStatus?.(payload);
  }

  private emitError(error: Error) {
    this.hooks.onError?.({ error });
  }

  private async stopSpeaking(options?: { force?: boolean }): Promise<void> {
    const hadPendingCompletion = Boolean(this.pendingSpeakResolve);
    const shouldForce = options?.force ?? false;
    const hadActiveSpeech = this.speaking || hadPendingCompletion;

    if (hadActiveSpeech || shouldForce) {
      this.speakToken++;
    }

    this.speaking = false;
    this.stopAudioPlayback();

    if (this.pendingSpeakResolve) {
      const completion = this.pendingSpeakResolve;
      this.pendingSpeakResolve = null;
      completion();
    }

    const activeSynthesizer = this.synthesizer;
    if (!activeSynthesizer) {
      return;
    }

    if (!hadActiveSpeech && !shouldForce) {
      return;
    }

    const stopSpeakingAsync = (
      activeSynthesizer as SpeechSynthesizer & {
        stopSpeakingAsync?: (
          onSuccess: () => void,
          onError: (error: string) => void,
        ) => void;
      }
    ).stopSpeakingAsync;

    if (typeof stopSpeakingAsync === "function") {
      await new Promise<void>((resolve) => {
        stopSpeakingAsync.call(
          activeSynthesizer,
          () => resolve(),
          (error: string) => {
            if (error) {
              this.emitError(new Error(error));
            }
            resolve();
          },
        );
      });
      if (shouldForce) {
        this.disposeSynthesizer();
      }
      return;
    }

    if (shouldForce) {
      this.disposeSynthesizer();
      return;
    }

    try {
      activeSynthesizer.close();
    } catch (error) {
      if (error instanceof Error) {
        this.emitError(error);
      }
    }

    if (this.synthesizer === activeSynthesizer) {
      this.synthesizer = null;
    }
  }

  private async stopActiveRecognizer(): Promise<void> {
    if (this.listenContext) {
      this.finishListening(
        this.listenContext,
        this.listenContext.buffered.trim(),
      );
    }

    if (this.silenceResetTimer) {
      clearTimeout(this.silenceResetTimer);
      this.silenceResetTimer = null;
    }

    const recognizer = this.activeListening;
    if (!recognizer) {
      return;
    }

    await new Promise<void>((resolve) => {
      recognizer.stopContinuousRecognitionAsync(
        () => {
          try {
            recognizer.close();
          } catch (_error) {
            // Recognizer might already be disposed; ignore errors here.
          }
          resolve();
        },
        (error: string) => {
          if (error) {
            this.emitError(new Error(error));
          }
          try {
            recognizer.close();
          } catch (_closeError) {
            // Ignore close errors.
          }
          resolve();
        },
      );
    });

    // Stop all media stream tracks to release microphone
    try {
      const audioConfig = (recognizer as any).audioConfig;
      if (audioConfig && audioConfig.privSource) {
        const stream = audioConfig.privSource.privMediaStream;
        if (stream && stream.getTracks) {
          stream.getTracks().forEach((track: MediaStreamTrack) => {
            if (this.debug.logExtractedFields) {
              console.log(
                `[VoiceForm] Stopping media track: ${track.kind} (${track.label})`,
              );
            }
            track.stop();
          });
        }
      }
    } catch (error) {
      if (this.debug.logExtractedFields) {
        console.warn("[VoiceForm] Could not stop media stream tracks:", error);
      }
    }

    // Clear the reference to release microphone access
    this.activeListening = null;
    this.listeningActive = false;
    if (this.debug.logExtractedFields) {
      console.log("[VoiceForm] Microphone access released");
    }
  }

  private async createNoiseSuppressionAudioConfig(): Promise<AudioConfig> {
    if (this.debug.logExtractedFields) {
      console.log(
        "[VoiceForm] Creating audio config with noise suppression...",
      );
    }

    try {
      // Check if voiceIsolation is supported
      const hasVoiceIsolation =
        typeof navigator !== "undefined" &&
        typeof (navigator.mediaDevices as any).getSupportedConstraints !==
          "undefined" &&
        (navigator.mediaDevices as any).getSupportedConstraints()
          .voiceIsolation === true;

      // Request microphone with enhanced noise suppression constraints
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        // Advanced constraints for better noise filtering
        channelCount: 1, // Mono audio
        sampleRate: 16000, // Optimal for speech recognition
        sampleSize: 16,
        // Additional constraints to focus on speech
        latency: 0,
      };

      // Add voice isolation if supported (Chrome 96+, Safari 15+)
      if (hasVoiceIsolation) {
        (audioConstraints as any).voiceIsolation = true;
        if (this.debug.logExtractedFields) {
          console.log("[VoiceForm] Voice isolation supported and enabled");
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });

      if (this.debug.logExtractedFields) {
        console.log(
          "[VoiceForm] Microphone stream acquired with noise suppression",
        );
      }

      // Get audio track settings to verify configuration
      const audioTrack = stream.getAudioTracks()[0];
      const settings = audioTrack.getSettings();
      if (this.debug.logExtractedFields) {
        console.log("[VoiceForm] Audio track settings:", {
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl,
          sampleRate: settings.sampleRate,
          channelCount: settings.channelCount,
          voiceIsolation: (settings as any).voiceIsolation,
        });
      }

      // Create audio config from the enhanced stream
      const audioConfig = AudioConfig.fromStreamInput(stream);

      if (this.debug.logExtractedFields) {
        console.log(
          "[VoiceForm] Audio config created with noise suppression enabled",
        );
      }

      return audioConfig;
    } catch (error) {
      if (this.debug.logExtractedFields) {
        console.warn(
          "[VoiceForm] Failed to create enhanced audio config, falling back to default:",
          error,
        );
      }
      // Fallback to default microphone if enhanced config fails
      return AudioConfig.fromDefaultMicrophoneInput();
    }
  }

  private async revokeMicrophoneAccess(): Promise<void> {
    if (this.debug.logExtractedFields) {
      console.log("[VoiceForm] Revoking microphone access...");
    }

    // Stop active recognizer and release mic
    await this.stopActiveRecognizer();

    // Dispose synthesizer
    this.disposeSynthesizer();

    // Clear all audio-related state
    this.activeListening = null;
    this.listeningActive = false;
    this.listenContext = null;

    if (this.debug.logExtractedFields) {
      console.log("[VoiceForm] Microphone access revoked successfully");
    }
  }

  private async ensureSynthesizer(): Promise<void> {
    // Skip synthesizer for Bhashini provider (no TTS support yet)
    if (this.speechProvider === "bhashini") {
      return;
    }

    if (this.synthesizer) {
      return;
    }

    if (this.speechStream) {
      try {
        this.speechStream.close();
      } catch (_error) {
        // ignore close errors when refreshing the stream
      }
      this.speechStream = null;
    }

    this.speechStream = AudioOutputStream.createPullStream();
    const audioConfig = AudioConfig.fromStreamOutput(this.speechStream);
    this.synthesizer = new SpeechSynthesizer(this.speechConfig, audioConfig);
  }

  private disposeSynthesizer(): void {
    // Skip for Bhashini provider
    if (this.speechProvider === "bhashini") {
      return;
    }

    if (!this.synthesizer) {
      return;
    }

    this.stopAudioPlayback();

    if (this.speechStream) {
      try {
        this.speechStream.close();
      } catch (_error) {
        // ignore close errors on the auxiliary audio stream
      }
      this.speechStream = null;
    }

    try {
      this.synthesizer.close();
    } catch (error) {
      if (error instanceof Error) {
        this.emitError(error);
      }
    }

    this.synthesizer = null;
  }

  private async navigateToTab(step: StepInfo): Promise<void> {
    const form = document.querySelector<HTMLElement>(this.options.formSelector);
    if (!form) return;

    // Look for tab container (mat-tab-group or similar)
    const tabContainer =
      form.closest("mat-tab-group") || form.querySelector("mat-tab-group");
    if (!tabContainer) return;

    // Find tab labels (mat-tab-label or similar)
    const tabLabels = Array.from(
      tabContainer.querySelectorAll<HTMLElement>(
        '.mat-tab-label, [role="tab"], .mat-mdc-tab',
      ),
    );

    if (!tabLabels.length) return;

    // Find the tab that matches the step label or index
    let targetTab: HTMLElement | undefined;

    // Try to match by label text
    for (const tabLabel of tabLabels) {
      const tabText = tabLabel.textContent?.trim().toLowerCase();
      const stepLabel = step.label.toLowerCase();
      if (tabText && tabText.includes(stepLabel)) {
        targetTab = tabLabel;
        break;
      }
    }

    // If not found by label, try by index
    if (!targetTab && step.index < tabLabels.length) {
      targetTab = tabLabels[step.index];
    }

    // Click on the target tab to navigate
    if (targetTab) {
      // Check if tab is already active
      const isActive =
        targetTab.classList.contains("mat-tab-label-active") ||
        targetTab.classList.contains("mat-mdc-tab-label-active") ||
        targetTab.getAttribute("aria-selected") === "true";

      if (!isActive) {
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Navigating to tab: ${step.label} (index ${step.index})`,
          );
        }

        // Click the tab
        targetTab.click();

        // Wait for tab content to render
        await this.delay(500);

        // Re-extract fields from the new tab
        await waitForCustomDropdownRender(form, 2000);
        const newFields = extractFormFields(form);

        // CRITICAL: Preserve options from old fields to prevent loss during re-extraction
        for (const newField of newFields) {
          const oldField = this.fields.find((f) => f.id === newField.id);
          if (oldField && oldField.options && oldField.options.length > 0) {
            newField.options = oldField.options;
          }
        }

        // Update fields but preserve existing field state
        this.fields = newFields;
        this.reportExtractedFields();

        // Update the current step's field IDs with newly extracted fields
        const fieldsInCurrentTab = newFields.filter(
          (field) => field.groupId === step.id,
        );
        step.fieldIds = fieldsInCurrentTab.map((f) => f.id);

        // Sync state from DOM (to pick up any pre-filled values)
        for (const field of this.fields) {
          if (!this.fieldState.has(field.id)) {
            const value = this.readFieldValue(field);
            if (value) {
              const normalized = value ?? (field.allowMultiple ? [] : "");
              this.fieldState.set(field.id, {
                fieldId: field.id,
                value: normalized,
                skipped: false,
              });
            }
          }
        }

        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Tab navigation complete. Extracted ${this.fields.length} total fields, ${fieldsInCurrentTab.length} in current tab`,
          );
        }
      }
    }
  }

  private setupTabChangeObserver(): void {
    const form = document.querySelector<HTMLElement>(this.options.formSelector);
    if (!form) return;

    // Look for tab container (mat-tab-group or similar)
    const tabContainer =
      form.closest("mat-tab-group") || form.querySelector("mat-tab-group");
    if (!tabContainer) return;

    // Create observer to detect tab changes
    const observer = new MutationObserver(() => {
      if (!this.running) return;

      // Re-extract visible fields when tabs change
      const previousFieldCount = this.fields.length;
      const previousVisibleCount = this.fields.filter((f) =>
        this.isFieldVisible(f),
      ).length;

      // Small delay to let Angular render the new tab content
      setTimeout(async () => {
        const form = document.querySelector<HTMLElement>(
          this.options.formSelector,
        );
        if (!form) return;

        await waitForCustomDropdownRender(form, 1000);
        const newFields = extractFormFields(form);
        const newVisibleCount = newFields.filter((f) =>
          this.isFieldVisible(f),
        ).length;

        // If visible field count changed significantly, tab likely changed
        if (Math.abs(newVisibleCount - previousVisibleCount) > 2) {
          if (this.debug.logExtractedFields) {
            console.log(
              `[VoiceForm] Mutation observer detected tab change, re-extracting fields (visible count: ${previousVisibleCount} -> ${newVisibleCount})`,
            );
          }

          // CRITICAL: Preserve options from old fields to prevent loss during re-extraction
          for (const newField of newFields) {
            const oldField = this.fields.find((f) => f.id === newField.id);
            if (oldField && oldField.options && oldField.options.length > 0) {
              newField.options = oldField.options;
              if (this.debug.logExtractedFields) {
                console.log(
                  `[VoiceForm] Preserved ${oldField.options.length} options for ${newField.label} during re-extraction`,
                );
              }
            }
          }

          this.fields = newFields;

          // Re-detect tabs and update field assignments
          const detectedTabs = this.detectAllTabs(form);
          this.steps =
            detectedTabs.length > 0 ? detectedTabs : this.buildStepMap();

          this.syncFieldStateFromDom();
        }
      }, 300);
    });

    observer.observe(tabContainer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-hidden", "hidden", "style", "class"],
    });
  }

  private syncFieldStateFromDom(options?: {
    preserveStepIndex?: boolean;
  }): void {
    for (const field of this.fields) {
      const value = this.readFieldValue(field);
      const normalized = value ?? (field.allowMultiple ? [] : "");
      this.fieldState.set(field.id, {
        fieldId: field.id,
        value: normalized,
        skipped: false,
      });
    }
    if (!options?.preserveStepIndex) {
      this.resetCurrentStepIndex();
    }
  }

  /**
   * Detect if user manually cleared/reset previously filled fields
   * If detected, remove from fieldState so they'll be asked again
   */
  private detectManualResets(): void {
    // Only check fields that were previously answered (exist in fieldState)
    const answeredFieldIds = Array.from(this.fieldState.keys());

    for (const fieldId of answeredFieldIds) {
      const field = this.fields.find((f) => f.id === fieldId);
      if (!field || !this.isFieldVisible(field)) {
        continue;
      }

      const state = this.fieldState.get(fieldId);
      if (!state || state.skipped) {
        continue;
      }

      // Read current DOM value
      const currentValue = this.readFieldValue(field);

      // Check if field is now empty
      const isEmpty =
        !currentValue ||
        (Array.isArray(currentValue) && currentValue.length === 0) ||
        (typeof currentValue === "string" && currentValue.trim() === "");

      if (isEmpty) {
        // Field was filled but is now empty - user manually cleared it
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Detected manual reset for field "${field.label}" - removing from fieldState`,
          );
        }
        this.fieldState.delete(fieldId);
      }
    }
  }

  /**
   * Set up observer to detect manual intervention during voice flow
   * (user manually typing or changing values while voice assistant is running)
   */
  private setupManualInterventionDetection(): void {
    const form = document.querySelector<HTMLElement>(this.options.formSelector);
    if (!form) return;

    // Listen for input/change events which indicate user interaction
    const handleUserInput = (event: Event) => {
      if (
        !this.running ||
        this.manualInterventionDetected ||
        this.isSettingValueProgrammatically
      ) {
        return;
      }

      const target = event.target as HTMLElement;

      // Check if this is a form field
      if (
        target.tagName === "INPUT" ||
        target.tagName === "SELECT" ||
        target.tagName === "TEXTAREA" ||
        target.classList.contains("ng-select")
      ) {
        // Find which field this belongs to
        const changedField = this.fields.find((field) => {
          if (field.inputElements.includes(target as HTMLInputElement))
            return true;
          if (field.selectElement === target) return true;
          if (field.textareaElement === target) return true;
          if (field.element.contains(target)) return true;
          return false;
        });

        if (changedField) {
          if (this.debug.logExtractedFields) {
            console.log(
              `[VoiceForm] Manual input detected on field "${changedField.label}" via ${event.type} event`,
            );
          }
          this.handleManualIntervention();
        }
      }
    };

    // Listen for input and change events (these only fire on user interaction, not programmatic changes)
    form.addEventListener("input", handleUserInput, true);
    form.addEventListener("change", handleUserInput, true);

    // Store cleanup function
    const cleanup = () => {
      form.removeEventListener("input", handleUserInput, true);
      form.removeEventListener("change", handleUserInput, true);
    };

    // Store cleanup for later
    this.formChangeObserver = {
      disconnect: cleanup,
    } as MutationObserver;
  }

  /**
   * Handle manual intervention detected during voice flow
   */
  private async handleManualIntervention(): Promise<void> {
    if (this.manualInterventionDetected) return;

    this.manualInterventionDetected = true;

    if (this.debug.logExtractedFields) {
      console.log(
        "[VoiceForm] Handling manual intervention - stopping voice flow",
      );
    }

    // Stop any ongoing speech
    await this.stopSpeaking({ force: true });

    // Announce manual intervention
    const message = this.message("manual_intervention_detected");
    this.emitStatus({ message });
    await this.speak(message);

    // Notify the UI that the voice flow is stopping due to manual input
    if (this.hooks.onQuit) {
      this.hooks.onQuit({ confirmed: true, reason: "user-stop" });
    }

    // Stop the voice flow
    await this.stop();
  }

  /**
   * Clean up manual intervention detection observer
   */
  private cleanupManualInterventionDetection(): void {
    if (this.formChangeObserver) {
      this.formChangeObserver.disconnect();
      this.formChangeObserver = null;
    }
    this.manualInterventionDetected = false;
  }

  /**
   * Update Azure Speech PhraseListGrammar with field-specific hints
   * to improve transcription accuracy for numeric vs date fields
   */
  private updatePhraseListForField(field: ExtractedFormField): void {
    // Only update if using Azure provider and phraseListGrammar is available
    if (this.speechProvider !== "azure" || !this.phraseListGrammar) {
      return;
    }

    // For numeric fields (but NOT date fields), add hints to prefer numeric transcription
    const isNumeric = isLikelyNumericField(field);
    const isDate = field.type === "date";

    if (isNumeric && !isDate) {
      // Add context phrases to help Azure recognize this as a numeric field
      // This may reduce automatic date formatting (e.g., "4/23" for "four twenty three")
      const fieldLabel = field.label.toLowerCase();

      if (
        fieldLabel.includes("house") ||
        fieldLabel.includes("flat") ||
        fieldLabel.includes("building")
      ) {
        this.phraseListGrammar.addPhrase("house number");
        this.phraseListGrammar.addPhrase("flat number");
        this.phraseListGrammar.addPhrase("building number");
      } else if (
        fieldLabel.includes("pin") ||
        fieldLabel.includes("postal") ||
        fieldLabel.includes("zip")
      ) {
        this.phraseListGrammar.addPhrase("PIN code");
        this.phraseListGrammar.addPhrase("postal code");
        this.phraseListGrammar.addPhrase("zip code");
      } else if (
        fieldLabel.includes("phone") ||
        fieldLabel.includes("mobile") ||
        fieldLabel.includes("contact")
      ) {
        this.phraseListGrammar.addPhrase("phone number");
        this.phraseListGrammar.addPhrase("mobile number");
        this.phraseListGrammar.addPhrase("contact number");
      } else if (fieldLabel.includes("age")) {
        this.phraseListGrammar.addPhrase("age");
        this.phraseListGrammar.addPhrase("years old");
      }
      // Generic numeric hint for all numeric fields
      this.phraseListGrammar.addPhrase("number");
    } else if (isDate) {
      // For date fields, add date-related context
      this.phraseListGrammar.addPhrase("date");
      this.phraseListGrammar.addPhrase("date of birth");
      this.phraseListGrammar.addPhrase("birth date");
    }

    // For dropdown/select fields, add option labels as phrases
    if (
      (field.type === "select" || field.type === "radio") &&
      field.options &&
      field.options.length > 0
    ) {
      // Add first few option labels to help recognition
      const optionsToAdd = field.options.slice(0, 10); // Limit to avoid too many phrases
      for (const option of optionsToAdd) {
        if (option.label && option.label.trim()) {
          this.phraseListGrammar.addPhrase(option.label.trim());
        }
      }
    }
  }

  /**
   * Check if a field has validation errors in the DOM
   * (e.g., Angular validators that run after value assignment)
   */
  private checkFieldForDomValidationErrors(field: ExtractedFormField): {
    hasError: boolean;
    errorMessage?: string;
  } {
    // Check for Angular ng-invalid class
    const isNgInvalid = field.element.classList.contains("ng-invalid");

    // Check for aria-invalid attribute
    const isAriaInvalid = field.element.getAttribute("aria-invalid") === "true";

    // Check input/select/textarea elements for validation state
    let hasNativeValidation = false;
    if (
      field.inputElements.length > 0 &&
      field.inputElements[0] &&
      !field.inputElements[0].validity.valid
    ) {
      hasNativeValidation = true;
    }
    if (field.selectElement && !field.selectElement.validity.valid) {
      hasNativeValidation = true;
    }
    if (field.textareaElement && !field.textareaElement.validity.valid) {
      hasNativeValidation = true;
    }

    // Check for Angular Material error messages
    const errorElements = field.element.querySelectorAll(
      '.mat-error, .error-message, [role="alert"]',
    );
    let errorMessage: string | undefined;

    for (const errorEl of errorElements) {
      const text = errorEl.textContent?.trim();
      if (text) {
        errorMessage = text;
        break;
      }
    }

    const hasError =
      isNgInvalid || isAriaInvalid || hasNativeValidation || !!errorMessage;

    if (hasError) {
      if (this.debug.logExtractedFields) {
        console.warn(
          `[VoiceForm] DOM validation error detected for ${field.label}:`,
          {
            isNgInvalid,
            isAriaInvalid,
            hasNativeValidation,
            errorMessage,
          },
        );
      }
    }

    return { hasError, errorMessage };
  }

  private readFieldValue(
    field: ExtractedFormField,
  ): string | string[] | undefined {
    if (field.selectElement) {
      return field.selectElement.value;
    }
    if (field.textareaElement) {
      const text = field.textareaElement.value.trim();
      return text ? text : undefined;
    }
    if (field.inputElements.length > 1) {
      const checked = field.inputElements
        .filter((input) => input.checked)
        .map((input) => input.value);
      return checked.length ? checked : undefined;
    }
    // Custom dropdowns (ng-select, div[role=listbox], etc.)
    if (isCustomDropdownElement(field.element)) {
      const dropdown = field.element;

      // Method 1: Try ng-select's internal selectedItems property
      const ngSelectElement =
        dropdown.tagName.toLowerCase() === "ng-select"
          ? (dropdown as any)
          : dropdown.querySelector("ng-select");

      if (ngSelectElement && ngSelectElement.selectedItems) {
        const selectedItems = ngSelectElement.selectedItems;
        if (Array.isArray(selectedItems) && selectedItems.length > 0) {
          const firstItem = selectedItems[0];
          if (firstItem && firstItem.value) {
            return firstItem.value;
          }
          if (firstItem && firstItem.label) {
            return firstItem.label;
          }
        }
      }

      // Method 2: Try to find the selected value element with data-value attribute
      const selectedValueElement = dropdown.querySelector<HTMLElement>(
        ".ng-value[data-value], [data-value]:not(.ng-option)",
      );
      if (selectedValueElement) {
        const dataValue = selectedValueElement.getAttribute("data-value");
        if (dataValue) {
          return dataValue;
        }
      }

      // Method 3: Try to read from ng-value-label and map back to value using field.options
      const selectedLabel = dropdown.querySelector<HTMLElement>(
        ".ng-value-label, .selected, .ng-option-selected, [data-selected='true']",
      );
      if (selectedLabel) {
        const labelText = selectedLabel.innerText.trim();
        if (labelText) {
          // Try to find the actual value from field.options by matching label
          const matchedOption = field.options?.find(
            (opt) =>
              opt.label.toLowerCase() === labelText.toLowerCase() ||
              opt.value.toLowerCase() === labelText.toLowerCase(),
          );
          if (matchedOption) {
            return matchedOption.value;
          }
          // Fallback to label text if no match found
          return labelText;
        }
      }

      const ariaSelected = dropdown.querySelector<HTMLElement>(
        "[aria-selected='true']",
      );
      if (ariaSelected) {
        const text = ariaSelected.innerText.trim();
        if (text) {
          // Try to map back to value
          const matchedOption = field.options?.find(
            (opt) =>
              opt.label.toLowerCase() === text.toLowerCase() ||
              opt.value.toLowerCase() === text.toLowerCase(),
          );
          if (matchedOption) {
            return matchedOption.value;
          }
          return text;
        }
      }

      const comboboxInput = dropdown.querySelector<HTMLInputElement>(
        "input[role='combobox']",
      );
      if (comboboxInput) {
        const text = comboboxInput.value.trim();
        if (text) {
          // Try to map back to value
          const matchedOption = field.options?.find(
            (opt) =>
              opt.label.toLowerCase() === text.toLowerCase() ||
              opt.value.toLowerCase() === text.toLowerCase(),
          );
          if (matchedOption) {
            return matchedOption.value;
          }
          return text;
        }
      }

      // Mobile bottom-drawer fallback: read the checked radio input inside app-mobile-view-list
      const parent = dropdown.parentElement;
      if (parent) {
        const mobileDrawer = parent.querySelector<HTMLElement>(
          "app-mobile-view-list",
        );
        if (mobileDrawer) {
          const checkedRadio = mobileDrawer.querySelector<HTMLInputElement>(
            "input[type='radio']:checked",
          );
          if (checkedRadio) {
            const radioValue = checkedRadio.value?.trim();
            if (radioValue) {
              // Map radio value back to field option for consistency
              const matchedOption = field.options?.find(
                (opt) =>
                  opt.value.toLowerCase() === radioValue.toLowerCase() ||
                  opt.label.toLowerCase() === radioValue.toLowerCase(),
              );
              return matchedOption ? matchedOption.value : radioValue;
            }
          }
        }
      }

      return undefined;
    }
    const input = field.inputElements[0];
    if (input) {
      const text = input.value.trim();
      return text ? text : undefined;
    }
    return undefined;
  }

  private async selectCustomDropdownValue(
    field: ExtractedFormField,
    value: string,
    optionsJustLoaded: boolean = false,
  ): Promise<void> {
    const dropdown = field.element;
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }

    const hasTargetInOptions = Boolean(
      field.options?.some(
        (option) =>
          option.value.trim().toLowerCase() === trimmed.toLowerCase() ||
          option.label.trim().toLowerCase() === trimmed.toLowerCase(),
      ),
    );

    // Fast path: avoid expensive refresh if target option is already available.
    let needsOptionsLoad = !field.options?.length || !hasTargetInOptions;
    if (needsOptionsLoad) {
      if (this.debug.logExtractedFields) {
        console.log(
          `[VoiceForm] Ensuring options are loaded for ${field.label} before selecting...`,
        );
      }
      await ensureCustomDropdownOptions(field, 3000);
      // After ensuring options, dropdown is now closed
      // Set optionsJustLoaded to true to prevent redundant reopening
      optionsJustLoaded = true;
    }

    if (this.debug.logExtractedFields) {
      console.log(
        `[VoiceForm] Attempting to select "${trimmed}" for ${field.label}...`,
        field.options,
      );
    }

    if (!field.options || field.options.length === 0) {
      if (this.debug.logExtractedFields) {
        console.error(
          `[VoiceForm] No options available for ${field.label} after ensureCustomDropdownOptions. Cannot select value.`,
        );
      }
      return;
    }

    // Use case-insensitive matching to find the option (handles "rural" → "Rural")
    const matchedOption = field.options.find(
      (option) =>
        option.value.trim().toLowerCase() === trimmed.toLowerCase() ||
        option.label.trim().toLowerCase() === trimmed.toLowerCase(),
    );

    if (!matchedOption) {
      if (this.debug.logExtractedFields) {
        console.error(
          `[VoiceForm] Value "${trimmed}" not found in options for ${field.label}:`,
          {
            valueToSelect: trimmed,
            availableOptions: field.options.map((o) => o.value),
          },
        );
      }
      return;
    }

    const normalizedTargets = new Set<string>([trimmed.toLowerCase()]);
    const rawTargets = new Set<string>([trimmed]);

    const displayLabel = matchedOption.label?.trim();
    if (displayLabel) {
      normalizedTargets.add(displayLabel.toLowerCase());
      rawTargets.add(displayLabel);
    }

    if (this.debug.logExtractedFields) {
      console.info("[VoiceForm] selectCustomDropdownValue:", {
        fieldLabel: field.label,
        valueToSelect: trimmed,
        matchedOption: `${matchedOption.value} (${matchedOption.label})`,
        optionsCount: field.options.length,
      });
    }

    // Since options are guaranteed to be loaded, single attempt should work
    const maxAttempts = 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Open the dropdown to find and click the option
      // NOTE: ensureCustomDropdownOptions closes the dropdown after loading,
      // but we need to reopen it to find the option element in DOM
      if (!isDropdownExpanded(dropdown)) {
        await this.delay(120);
        openDropdownElement(dropdown);
        await this.delay(120);
      }

      // Find the option in DOM
      const option = await this.findCustomDropdownOptionWithFallback(
        dropdown,
        normalizedTargets,
        rawTargets,
        [displayLabel, trimmed].filter((item): item is string => Boolean(item)),
      );

      if (!option) {
        if (this.debug.logExtractedFields) {
          console.error("[VoiceForm] Option not found in DOM:", {
            fieldLabel: field.label,
            valueToSelect: trimmed,
            dropdownExpanded: isDropdownExpanded(dropdown),
            availableOptionsInField: field.options
              .slice(0, 10)
              .map((o) => `${o.value}=${o.label}`),
          });
        }

        // Log what's actually visible in DOM for debugging
        const containers = getDropdownOptionContainers(dropdown);
        const allVisibleOptions: string[] = [];
        for (const container of containers) {
          const optionElements = container.querySelectorAll<HTMLElement>(
            ".ng-option, [role='option'], [data-value], option",
          );
          optionElements.forEach((opt, idx) => {
            if (idx < 10) {
              const { value, label } = readDropdownOptionMetadata(opt);
              allVisibleOptions.push(`${value}=${label}`);
            }
          });
        }
        if (this.debug.logExtractedFields) {
          console.error(
            "[VoiceForm] Visible options in DOM:",
            allVisibleOptions,
          );
        }
        return;
      }

      // Click the option
      if (this.debug.logExtractedFields) {
        console.info("[VoiceForm] Found and clicking option:", {
          fieldLabel: field.label,
          optionText: option.textContent?.trim(),
        });
      }
      this.clickDropdownOption(option);
      await this.delay(220);

      // Verify the selection worked
      const verifiedValue = this.readFieldValue(field);
      const isMatch =
        verifiedValue === trimmed ||
        (matchedOption &&
          (verifiedValue === matchedOption.value ||
            verifiedValue === matchedOption.label));

      if (isMatch) {
        if (this.debug.logExtractedFields) {
          console.log(
            `[VoiceForm] Value successfully set for ${field.label}: ${verifiedValue}`,
          );
        }
        return;
      } else {
        if (this.debug.logExtractedFields) {
          console.error(
            `[VoiceForm] Value mismatch after clicking for ${field.label}:`,
            { expected: trimmed, actual: verifiedValue },
          );
        }
      }
    }

    if (this.debug.logExtractedFields) {
      console.error("[VoiceForm] Failed to select dropdown option:", {
        fieldLabel: field.label,
        valueToSelect: trimmed,
      });
    }
  }

  private async ensureCustomDropdownClosed(
    dropdown: HTMLElement,
  ): Promise<void> {
    if (!isDropdownExpanded(dropdown)) {
      return;
    }

    closeDropdownElement(dropdown);
    await this.delay(80);
    if (!isDropdownExpanded(dropdown)) {
      return;
    }

    const combobox = dropdown.querySelector<HTMLElement>("[role='combobox']");
    if (combobox) {
      combobox.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Escape",
          code: "Escape",
        }),
      );
      (combobox as HTMLElement).blur?.();
    }

    await this.delay(60);
    if (!isDropdownExpanded(dropdown)) {
      return;
    }

    const doc = dropdown.ownerDocument ?? document;
    doc.body?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    doc.body?.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
    );
    doc.body?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await this.delay(80);
  }

  private async findCustomDropdownOptionWithFallback(
    dropdown: HTMLElement,
    normalizedTargets: Set<string>,
    rawTargets: Set<string>,
    searchTerms: string[],
  ): Promise<HTMLElement | null> {
    const directMatch = this.findCustomDropdownOption(
      dropdown,
      normalizedTargets,
      rawTargets,
    );
    if (directMatch) {
      return directMatch;
    }

    const typedMatch = await this.findCustomDropdownOptionByTyping(
      dropdown,
      normalizedTargets,
      rawTargets,
      searchTerms,
    );
    if (typedMatch) {
      return typedMatch;
    }

    return this.findCustomDropdownOptionByScrolling(
      dropdown,
      normalizedTargets,
      rawTargets,
    );
  }

  private async findCustomDropdownOptionByTyping(
    dropdown: HTMLElement,
    normalizedTargets: Set<string>,
    rawTargets: Set<string>,
    searchTerms: string[],
  ): Promise<HTMLElement | null> {
    const comboboxInput = dropdown.querySelector<HTMLInputElement>(
      "input[role='combobox'], input[type='text']",
    );
    if (
      !comboboxInput ||
      comboboxInput.disabled ||
      comboboxInput.readOnly ||
      !searchTerms.length
    ) {
      return null;
    }

    const previousValue = comboboxInput.value;
    try {
      for (const term of searchTerms) {
        const query = term.trim();
        if (!query) {
          continue;
        }

        comboboxInput.focus();
        comboboxInput.value = "";
        comboboxInput.dispatchEvent(new Event("input", { bubbles: true }));
        comboboxInput.dispatchEvent(new Event("change", { bubbles: true }));
        await this.delay(60);

        comboboxInput.value = query;
        comboboxInput.dispatchEvent(new Event("input", { bubbles: true }));
        comboboxInput.dispatchEvent(new Event("change", { bubbles: true }));
        comboboxInput.dispatchEvent(
          new KeyboardEvent("keyup", {
            bubbles: true,
            key: query.slice(-1),
          }),
        );
        await this.delay(100);

        const match = this.findCustomDropdownOption(
          dropdown,
          normalizedTargets,
          rawTargets,
        );
        if (match) {
          return match;
        }
      }
    } finally {
      comboboxInput.value = previousValue;
      comboboxInput.dispatchEvent(new Event("input", { bubbles: true }));
      comboboxInput.dispatchEvent(new Event("change", { bubbles: true }));
    }

    return null;
  }

  private async findCustomDropdownOptionByScrolling(
    dropdown: HTMLElement,
    normalizedTargets: Set<string>,
    rawTargets: Set<string>,
  ): Promise<HTMLElement | null> {
    const scrollTargets = this.getDropdownScrollTargets(dropdown);
    if (!scrollTargets.length) {
      return null;
    }

    const tryMatch = () =>
      this.findCustomDropdownOption(dropdown, normalizedTargets, rawTargets);

    for (const target of scrollTargets) {
      target.scrollTop = 0;
      target.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
    await this.delay(DROPDOWN_SELECTION_RETRY_MS);
    let match = tryMatch();
    if (match) {
      return match;
    }

    const maxPasses = 50;
    for (let pass = 0; pass < maxPasses; pass++) {
      let moved = false;
      for (const target of scrollTargets) {
        const maxScrollTop = Math.max(
          0,
          target.scrollHeight - target.clientHeight,
        );
        if (maxScrollTop <= 0) {
          continue;
        }
        const step = Math.max(48, Math.floor(target.clientHeight * 0.85));
        const next = Math.min(maxScrollTop, target.scrollTop + step);
        if (next > target.scrollTop + 0.5) {
          target.scrollTop = next;
          target.dispatchEvent(new Event("scroll", { bubbles: true }));
          moved = true;
        }
      }

      await this.delay(DROPDOWN_SELECTION_RETRY_MS);
      match = tryMatch();
      if (match) {
        return match;
      }

      if (!moved) {
        break;
      }
    }

    return null;
  }

  private getDropdownScrollTargets(dropdown: HTMLElement): HTMLElement[] {
    const containers = getDropdownOptionContainers(dropdown);
    const targets: HTMLElement[] = [];

    for (const container of containers) {
      if (!(container instanceof HTMLElement)) {
        continue;
      }

      const candidates = new Set<HTMLElement>([
        container,
        ...Array.from(
          container.querySelectorAll<HTMLElement>(
            ".ng-dropdown-panel-items, .scroll-host, .cdk-virtual-scroll-viewport, [role='listbox'], [role='presentation']",
          ),
        ),
      ]);

      candidates.forEach((candidate) => {
        if (
          candidate.scrollHeight > candidate.clientHeight + 1 &&
          !targets.includes(candidate)
        ) {
          targets.push(candidate);
        }
      });
    }

    return targets;
  }

  private findCustomDropdownOption(
    dropdown: HTMLElement,
    normalizedTargets: Set<string>,
    rawTargets: Set<string>,
  ): HTMLElement | null {
    const containers = getDropdownOptionContainers(dropdown);
    for (const container of containers) {
      const optionElements = container.querySelectorAll<HTMLElement>(
        ".ng-option, [role='option'], [data-value], option, mat-radio-button",
      );
      for (const option of optionElements) {
        const { value, label } = readDropdownOptionMetadata(option);
        const labelTrimmed = label?.trim();
        const valueTrimmed = value?.trim();
        if (
          (labelTrimmed && normalizedTargets.has(labelTrimmed.toLowerCase())) ||
          (valueTrimmed && normalizedTargets.has(valueTrimmed.toLowerCase())) ||
          (labelTrimmed && rawTargets.has(labelTrimmed)) ||
          (valueTrimmed && rawTargets.has(valueTrimmed))
        ) {
          return option;
        }
      }
    }
    return null;
  }

  private clickDropdownOption(option: HTMLElement): void {
    const events = ["mousedown", "mouseup", "click"] as const;
    for (const type of events) {
      option.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true }),
      );
    }

    // For Angular Material radio buttons (mat-radio-button) also check the inner
    // input[type=radio] and dispatch change/input so the Angular form control updates.
    if (option.tagName.toLowerCase() === "mat-radio-button") {
      const radioInput = option.querySelector<HTMLInputElement>(
        "input[type='radio']",
      );
      if (radioInput && !radioInput.checked) {
        radioInput.checked = true;
        radioInput.dispatchEvent(new Event("change", { bubbles: true }));
        radioInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  }

  private resetCurrentStepIndex(): void {
    if (!this.steps.length) {
      this.currentStepIndex = 0;
      return;
    }

    const firstUnanswered = this.fields.find(
      (field) => !this.isFieldAnswered(field.id),
    );

    if (!firstUnanswered) {
      this.currentStepIndex = 0;
    } else {
      const targetIndex = this.steps.findIndex((step) =>
        step.fieldIds.includes(firstUnanswered.id),
      );
      this.currentStepIndex = targetIndex === -1 ? 0 : targetIndex;
    }

    const normalizedIndex = Math.min(
      this.currentStepIndex,
      Math.max(this.steps.length - 1, 0),
    );
    if (this.steps[normalizedIndex]) {
      this.emitStepChange(this.steps[normalizedIndex]);
    }
  }

  private detectAllTabs(form: HTMLElement): StepInfo[] {
    const tabContainer =
      form.closest("mat-tab-group") || form.querySelector("mat-tab-group");
    if (!tabContainer) {
      return [];
    }

    const tabLabels = Array.from(
      tabContainer.querySelectorAll<HTMLElement>(
        '.mat-tab-label, [role="tab"], .mat-mdc-tab',
      ),
    );

    if (tabLabels.length === 0) {
      return [];
    }

    const steps: StepInfo[] = [];

    for (let i = 0; i < tabLabels.length; i++) {
      const tabLabel = tabLabels[i];
      const ariaControls = tabLabel.getAttribute("aria-controls");
      const labelContent = tabLabel.querySelector(".mat-tab-label-content");
      const labelText = labelContent?.textContent?.trim() || `Tab ${i + 1}`;

      // Get fields that are currently assigned to this tab
      const tabId = ariaControls || `mat-tab-content-0-${i}`;
      const fieldsInThisTab = this.fields.filter(
        (field) => field.groupId === tabId,
      );

      steps.push({
        id: tabId,
        label: labelText,
        index: i,
        fieldIds: fieldsInThisTab.map((f) => f.id),
      });
    }

    if (this.debug.logExtractedFields) {
      console.log(
        `[VoiceForm] Detected ${steps.length} tabs:`,
        steps.map((s) => ({
          id: s.id,
          label: s.label,
          index: s.index,
          fieldCount: s.fieldIds.length,
        })),
      );
    }

    return steps;
  }

  private buildStepMap(): StepInfo[] {
    if (!this.fields.length) {
      return [];
    }

    const map = new Map<string, StepInfo>();
    const defaultId = "__default__";
    const defaultLabel = "Form";

    this.fields.forEach((field, sequenceIndex) => {
      const stepId = field.groupId ?? defaultId;
      const label =
        field.groupLabel ?? (stepId === defaultId ? defaultLabel : stepId);
      const candidateIndex =
        field.groupIndex !== undefined
          ? field.groupIndex
          : stepId === defaultId
            ? 0
            : Number.isNaN(Number(stepId))
              ? sequenceIndex
              : Number(stepId);

      const existing = map.get(stepId);
      if (existing) {
        existing.fieldIds.push(field.id);
        if (!existing.label && label) {
          existing.label = label;
        }
        existing.index = Math.min(existing.index, candidateIndex);
        return;
      }

      map.set(stepId, {
        id: stepId,
        label: label ?? defaultLabel,
        index: candidateIndex,
        fieldIds: [field.id],
      });
    });

    const steps = Array.from(map.values()).sort((a, b) => a.index - b.index);

    if (this.debug.logExtractedFields) {
      console.log(
        `[VoiceForm] Built ${steps.length} steps:`,
        steps.map((s) => ({
          id: s.id,
          label: s.label,
          index: s.index,
          fieldCount: s.fieldIds.length,
        })),
      );
    }

    return steps;
  }

  private describeIssues(issues: AssignmentIssue[]): string {
    if (!issues.length) {
      return "";
    }

    const parts = issues.map(
      (issue) => `${issue.field.label}: ${issue.message}`,
    );
    const hasErrors = issues.some((issue) => issue.type === "error");
    const prefix = this.message(
      hasErrors ? "issues_error_prefix" : "issues_warning_prefix",
    );
    return `${prefix} ${parts.join("; ")}.`;
  }

  private async requestStepAdvance(
    currentStep: StepInfo,
    nextStep: StepInfo,
  ): Promise<"advance" | "stay" | "stop"> {
    if (!this.running) {
      return "stop";
    }

    const prompt = this.message("step_advance_prompt", {
      current: currentStep.label,
      next: nextStep.label,
    });
    const transcriptPromise = this.listen({ allowConcurrentSpeech: true });
    await this.speak(prompt);
    if (!this.running) {
      await transcriptPromise;
      return "stop";
    }

    for (let attempt = 0; attempt < 3 && this.running; attempt++) {
      const transcript =
        attempt === 0 ? await transcriptPromise : await this.listen();
      if (!this.running) {
        return "stop";
      }

      if (!transcript) {
        await this.speak(this.message("step_yes_no_retry"));
        if (!this.running) {
          return "stop";
        }
        continue;
      }

      const decision = this.interpretConfirmation(transcript);

      if (decision === "advance") {
        return this.running ? "advance" : "stop";
      }

      if (decision === "stay") {
        await this.speak(
          this.message("step_stay", { current: currentStep.label }),
        );
        return this.running ? "stay" : "stop";
      }

      if (decision === "stop") {
        await this.speak(this.message("step_stop"));
        this.running = false;
        return "stop";
      }

      await this.speak(this.message("step_clarify"));
      if (!this.running) {
        return "stop";
      }
    }

    return "stay";
  }

  private interpretConfirmation(
    transcript: string,
  ): "advance" | "stay" | "stop" | "unknown" {
    const normalized = transcript.trim().toLowerCase();
    if (!normalized) {
      return "unknown";
    }

    if (
      normalized.includes("stop") ||
      normalized.includes("cancel") ||
      normalized.includes("quit")
    ) {
      return "stop";
    }

    if (
      /\b(yes|yeah|yep|sure|proceed|continue|next|move on|haan|ha)\b/.test(
        normalized,
      )
    ) {
      return "advance";
    }

    if (
      normalized.includes("हाँ") ||
      normalized.includes("हां") ||
      normalized.includes("जी")
    ) {
      return "advance";
    }

    if (
      /\b(no|nah|not yet|stay|hold on|wait|review|nahi|ruk)\b/.test(normalized)
    ) {
      return "stay";
    }

    if (
      normalized.includes("नहीं") ||
      normalized.includes("मत") ||
      normalized.includes("रुको")
    ) {
      return "stay";
    }

    return "unknown";
  }

  private async confirmReset(): Promise<boolean> {
    const transcriptPromise = this.listen({ allowConcurrentSpeech: true });
    await this.speak(this.message("reset_confirm"));
    if (!this.running) {
      await transcriptPromise;
      return false;
    }

    for (let attempt = 0; attempt < 3 && this.running; attempt++) {
      const transcript =
        attempt === 0 ? await transcriptPromise : await this.listen();
      if (!this.running) {
        return false;
      }

      if (!transcript) {
        await this.speak(this.message("reset_confirm_retry"));
        if (!this.running) {
          return false;
        }
        continue;
      }

      const decision = this.interpretConfirmation(transcript);

      if (decision === "advance") {
        // User said yes to reset
        return true;
      }

      if (decision === "stay" || decision === "stop") {
        // User said no, don't reset
        return false;
      }

      await this.speak(this.message("reset_confirm_retry"));
      if (!this.running) {
        return false;
      }
    }

    // Default to not resetting if unclear
    return false;
  }

  private async confirmQuit(): Promise<boolean> {
    const transcriptPromise = this.listen({ allowConcurrentSpeech: true });
    await this.speak(this.message("quit_confirm"));
    if (!this.running) {
      await transcriptPromise;
      return false;
    }

    for (let attempt = 0; attempt < 3 && this.running; attempt++) {
      const transcript =
        attempt === 0 ? await transcriptPromise : await this.listen();
      if (!this.running) {
        return false;
      }

      if (!transcript) {
        await this.speak(this.message("quit_confirm_retry"));
        if (!this.running) {
          return false;
        }
        continue;
      }

      const decision = this.interpretConfirmation(transcript);

      if (decision === "advance") {
        // User said yes to quit
        await this.finishFlowAsConfirmedQuit({ announceStop: true });
        return true;
      }

      if (decision === "stay" || decision === "stop") {
        // User said no, continue with form
        await this.speak(this.message("quit_cancelled"));
        // Emit quit event to client (cancelled)
        if (this.hooks.onQuit) {
          this.hooks.onQuit({ confirmed: false, reason: "cancelled" });
        }
        return false;
      }

      await this.speak(this.message("quit_confirm_retry"));
      if (!this.running) {
        return false;
      }
    }

    // Default to not quitting if unclear
    await this.speak(this.message("quit_cancelled"));
    // Emit quit event to client (cancelled)
    if (this.hooks.onQuit) {
      this.hooks.onQuit({ confirmed: false, reason: "cancelled" });
    }
    return false;
  }

  private async handleSpecialCommandInEditFlow(specialCommand: {
    type: string;
    confidence: number;
  }): Promise<void> {
    // Clear previous UI state
    this.emitTranscript({ text: "", isFinal: true });

    if (specialCommand.type === "reset") {
      const message = this.message("reset_confirm");
      this.emitPrompt({ text: message });

      const confirmed = await this.confirmReset();
      if (!this.running) {
        return;
      }

      if (confirmed) {
        // Call the client's reset hook to perform the actual reset
        if (this.hooks.onResetRequested) {
          if (this.debug.logExtractedFields) {
            console.log(
              "[VoiceForm] Reset confirmed - calling onResetRequested hook...",
            );
          }
          const hookResult = this.hooks.onResetRequested();
          if (hookResult && typeof (hookResult as any).then === "function") {
            await hookResult;
          }
        } else {
          if (this.debug.logExtractedFields) {
            console.warn("[VoiceForm] No onResetRequested hook provided.");
          }
        }

        if (!this.running) {
          return;
        }

        // Announce reset completed and restart from beginning
        await this.speak(this.message("reset_completed"));
        if (!this.running) {
          return;
        }

        // Reset to first step and sync field state
        this.syncFieldStateFromDom({ preserveStepIndex: false });
        this.currentStepIndex = 0;

        // Set flag to indicate reset was performed
        this.formWasReset = true;

        // Navigate to first tab if steps exist
        if (this.steps.length && this.steps[0]) {
          await this.navigateToTab(this.steps[0]);
          await this.announceStepEntry(this.steps[0], { isInitial: true });
        }

        return;
      } else {
        // Reset was cancelled
        await this.speak(this.message("reset_cancelled"));
        return;
      }
    }

    if (specialCommand.type === "quit" || specialCommand.type === "finish") {
      const message = this.message("quit_confirm");
      this.emitPrompt({ text: message });
      const confirmed = await this.confirmQuit();
      if (!this.running || confirmed) {
        return; // Exit flow
      }
      // Cancelled - return to continue flow
    }
  }

  private async finishFlowAsConfirmedQuit(options?: {
    announceStop?: boolean;
  }): Promise<void> {
    const announceStop = options?.announceStop ?? true;

    if (announceStop && this.running) {
      await this.speak(this.message("step_stop"));
    }

    // Clear UI state before stopping
    this.emitPrompt({ text: "", fieldId: undefined });
    this.emitTranscript({ text: "", isFinal: true });
    this.emitSpeech({ text: "" });

    this.running = false;

    if (this.hooks.onQuit) {
      this.hooks.onQuit({ confirmed: true, reason: "completed" });
    }

    await this.revokeMicrophoneAccess();
  }

  private async reviewStep(step: StepInfo): Promise<void> {
    if (!this.running) {
      return;
    }

    this.emitStatus({
      message: this.message("status_reviewing", { label: step.label }),
    });
    const transcriptPromise = this.listen({ allowConcurrentSpeech: true });
    await this.speak(
      this.message("step_review_intro", { current: step.label }),
    );
    if (!this.running) {
      await transcriptPromise;
      return;
    }

    const transcript = await transcriptPromise;
    if (!this.running) {
      return;
    }

    if (!transcript) {
      await this.speak(this.message("step_review_no_changes"));
      return;
    }

    const stepFields = this.getFieldsForStep(step);
    const routingResponse = await this.router.routeAnswer({
      userInput: transcript,
      pendingFields: stepFields,
      completedFields: this.fields.filter((item) =>
        this.isFieldAnswered(item.id),
      ),
      language: this.language.code,
    });
    if (!this.running) {
      return;
    }

    if (!routingResponse.assignments.length) {
      await this.speak(this.message("step_review_map_failure"));
      return;
    }

    const { applied, issues, appliedFields } = await this.applyAssignments(
      routingResponse.assignments,
    );
    if (!this.running) {
      return;
    }

    // Get issues description message
    const issuesText = this.describeIssues(issues);

    if (!applied && !issues.length) {
      await this.speak(this.message("step_review_apply_failure"));
      return;
    }

    if (applied && appliedFields.length) {
      const labels = appliedFields.map((item) => item.label).join(", ");
      const updateMessage = this.message("step_review_updated", { labels });

      // Combine issues with update message
      const fullMessage = issuesText
        ? `${issuesText} ${updateMessage}`
        : updateMessage;

      await this.speak(fullMessage);
      if (!this.running) {
        return;
      }
    } else if (issuesText) {
      // Only issues, no successful updates
      await this.speak(issuesText);
      if (!this.running) {
        return;
      }
    }

    if (routingResponse.followUp) {
      await this.speak(routingResponse.followUp);
    }
  }

  /**
   * Recheck dropdowns that were previously skipped because they were empty.
   * If they now have options (because dependent fields were filled), unmark them as skipped.
   */
  private recheckEmptyDropdowns(): void {
    for (const field of this.fields) {
      const state = this.fieldState.get(field.id);

      // Only recheck fields that were skipped and are dropdowns
      if (state && state.skipped && this.isDropdownField(field)) {
        // Check if the dropdown now has options
        if (this.hasDropdownOptions(field)) {
          // Before unmarking as skipped, check if the dropdown already has a value
          const currentValue = this.readFieldValue(field);
          if (currentValue) {
            // Field already has a value (filled manually or by voice), update state
            if (this.debug.logExtractedFields) {
              console.log(
                `[VoiceForm] Dropdown "${field.label}" now has options and already has a value - keeping it filled`,
              );
            }
            this.fieldState.set(field.id, {
              fieldId: field.id,
              value: currentValue,
              skipped: false,
            });
          } else {
            // Field has no value, safe to unmark as skipped so it can be filled
            if (this.debug.logExtractedFields) {
              console.log(
                `[VoiceForm] Dropdown "${field.label}" now has options - unmarking as skipped`,
              );
            }
            this.fieldState.delete(field.id);
          }
        }
      }
    }
  }

  private async finalReview(): Promise<void> {
    // Before final review, check if any previously empty dropdowns now have options
    this.recheckEmptyDropdowns();

    while (this.running) {
      // Check for manual resets (user manually cleared fields)
      this.detectManualResets();

      // Ask if user wants to edit anything
      const prompt = this.message("final_review_prompt");
      // Update UI to show we're asking about final review
      this.emitPrompt({ text: prompt });
      const transcriptPromise = this.listen({ allowConcurrentSpeech: true });
      await this.speak(prompt);
      if (!this.running) {
        await transcriptPromise;
        return;
      }

      // Wait for yes/no response
      for (let attempt = 0; attempt < 3 && this.running; attempt++) {
        const transcript =
          attempt === 0 ? await transcriptPromise : await this.listen();
        if (!this.running) {
          return;
        }

        if (!transcript) {
          await this.speak(this.message("final_review_retry"));
          if (!this.running) {
            return;
          }
          continue;
        }

        // ISSUE 1 FIX: Check for reset/quit commands before yes/no interpretation
        // User might say "Please reset the form" instead of "yes" or "no"
        const allVisibleFields = this.fields.filter((field) =>
          this.isFieldVisible(field),
        );
        const routingResponse = await this.router.routeAnswer({
          userInput: transcript,
          pendingFields: allVisibleFields,
          completedFields: [],
          language: this.language.code,
        });
        if (!this.running) {
          return;
        }

        // Check if user wants to reset or quit
        if (
          routingResponse.specialCommand &&
          routingResponse.specialCommand.confidence >= 0.7
        ) {
          await this.handleSpecialCommandInEditFlow(
            routingResponse.specialCommand,
          );
          // If reset was performed, exit finalReview and restart from main loop
          if (this.formWasReset) {
            this.formWasReset = false; // Reset flag
            return; // Exit finalReview, main loop will handle filling
          }
          return; // Exit for quit/finish commands
        }

        const decision = this.interpretConfirmation(transcript);

        // User wants to finish (said no)
        if (decision === "stay") {
          // CRITICAL: Check for manual resets right before finishing
          // User might have reset the form while we were listening
          this.detectManualResets();

          // Check if there are any unanswered fields after reset detection
          if (!this.allFieldsCompleted()) {
            if (this.debug.logExtractedFields) {
              console.log(
                "[VoiceForm] Manual reset detected during final review - restarting fill loop",
              );
            }
            return; // Exit final review, let main loop fill remaining fields
          }

          await this.speak(this.message("final_review_no_edits"));
          if (this.running) {
            this.emitStatus({ message: this.message("status_form_completed") });
          }
          // Clear UI state before finishing
          this.emitPrompt({ text: "", fieldId: undefined });
          this.emitTranscript({ text: "", isFinal: true });
          this.emitSpeech({ text: "" });
          await this.finishFlowAsConfirmedQuit({ announceStop: false });
          return;
        }

        // User wants to stop
        if (decision === "stop") {
          await this.finishFlowAsConfirmedQuit({ announceStop: true });
          return;
        }

        // User wants to edit (said yes)
        if (decision === "advance") {
          // First edit - use "which field" prompt
          const editResult = await this.handleFinalReviewEdit();
          if (!this.running) {
            return;
          }

          // ISSUE 2 FIX: Check if reset was performed during edit
          if (this.formWasReset) {
            this.formWasReset = false; // Reset flag
            return; // Exit finalReview, main loop will restart from beginning
          }

          // After first edit, enter continuous edit mode
          while (this.running) {
            // ISSUE 3 FIX: Check for manual resets and exit edit loop if detected
            const fieldCountBefore = this.fields.filter(
              (f) => this.fieldState.get(f.id)?.value,
            ).length;
            this.detectManualResets();
            const fieldCountAfter = this.fields.filter(
              (f) => this.fieldState.get(f.id)?.value,
            ).length;

            // If form was manually reset (all fields cleared), exit edit loop
            if (fieldCountBefore > 0 && fieldCountAfter === 0) {
              if (this.debug.logExtractedFields) {
                console.log(
                  "[VoiceForm] Manual reset detected in continuous edit loop - exiting to main loop",
                );
              }
              return; // Exit finalReview, let main loop restart
            }

            // After editing, recheck empty dropdowns in case they now have options
            this.recheckEmptyDropdowns();

            // Get the "before" state that was captured before the edit was applied
            const unfilledVisibleFieldsBefore = (this as any)
              .__unfilledVisibleFieldsBefore as string[] | undefined;

            // Track visible unfilled fields AFTER the edit
            const unfilledVisibleFieldsAfter = this.fields
              .filter(
                (f) =>
                  this.isFieldVisible(f) && !this.fieldState.get(f.id)?.value,
              )
              .map((f) => f.id);

            // Find fields that are newly visible (not in before set but in after set)
            const newlyVisibleFieldIds = unfilledVisibleFieldsBefore
              ? unfilledVisibleFieldsAfter.filter(
                  (id) => !unfilledVisibleFieldsBefore.includes(id),
                )
              : [];

            // Check if new fields became visible and need filling
            if (this.running && newlyVisibleFieldIds.length > 0) {
              // Check if this is due to a reset (all fields empty)
              const hasAnyValues = this.fields.some(
                (f) => this.fieldState.get(f.id)?.value,
              );
              if (!hasAnyValues) {
                // Form was reset, exit to main loop without "new fields" message
                if (this.debug.logExtractedFields) {
                  console.log(
                    "[VoiceForm] Form reset detected - exiting edit mode to restart",
                  );
                }
                return;
              }

              await this.speak(this.message("final_review_new_fields"));
              if (!this.running) {
                return;
              }

              // Fill only the newly visible fields
              for (const fieldId of newlyVisibleFieldIds) {
                if (!this.running) break;

                const field = this.fields.find((f) => f.id === fieldId);
                if (!field) continue;

                // Check if field is still unfilled and visible
                if (
                  this.isFieldVisible(field) &&
                  !this.fieldState.get(field.id)?.value
                ) {
                  await this.collectAnswerForField(field, 1);
                }
              }
            }

            // Ask if user wants to continue editing
            const continuePrompt = this.message("final_edit_continue_prompt");
            this.emitPrompt({ text: continuePrompt });
            const continueTranscriptPromise = this.listen({
              allowConcurrentSpeech: true,
            });
            await this.speak(continuePrompt);
            if (!this.running) {
              await continueTranscriptPromise;
              return;
            }

            // Wait for user response
            let continuousEditHandled = false;
            for (
              let retryAttempt = 0;
              retryAttempt < 3 && this.running;
              retryAttempt++
            ) {
              const continueTranscript =
                retryAttempt === 0
                  ? await continueTranscriptPromise
                  : await this.listen();
              if (!this.running) {
                return;
              }

              if (!continueTranscript) {
                await this.speak(this.message("final_edit_retry"));
                if (!this.running) {
                  return;
                }
                continue;
              }

              // Check if user wants to finish (said no)
              const continueDecision =
                this.interpretConfirmation(continueTranscript);
              if (continueDecision === "stay" || continueDecision === "stop") {
                await this.speak(this.message("final_edit_no_change"));
                if (this.running) {
                  this.emitStatus({
                    message: this.message("status_form_completed"),
                  });
                }
                await this.finishFlowAsConfirmedQuit({ announceStop: false });
                return;
              }

              // User is providing a field edit directly (not yes/no)
              // Track visible unfilled fields BEFORE applying the edit
              const unfilledVisibleFieldsBefore = this.fields
                .filter(
                  (f) =>
                    this.isFieldVisible(f) && !this.fieldState.get(f.id)?.value,
                )
                .map((f) => f.id);

              // Try to apply it as an edit
              const allVisibleFields = this.fields.filter((field) =>
                this.isFieldVisible(field),
              );

              const routingResponse = await this.router.routeAnswer({
                userInput: continueTranscript,
                pendingFields: allVisibleFields,
                completedFields: [],
                language: this.language.code,
                isEditMode: true,
              });
              if (!this.running) {
                return;
              }

              // Check for special commands (reset/quit/finish) during continuous edit
              if (
                routingResponse.specialCommand &&
                routingResponse.specialCommand.confidence >= 0.7
              ) {
                await this.handleSpecialCommandInEditFlow(
                  routingResponse.specialCommand,
                );
                // If reset was performed, exit edit loop
                if (this.formWasReset) {
                  this.formWasReset = false; // Reset flag
                  return; // Exit finalReview, main loop will restart
                }
                return;
              }

              if (!routingResponse.assignments.length) {
                await this.speak(this.message("final_edit_retry"));
                if (!this.running) {
                  return;
                }
                continue;
              }

              const { applied, issues, appliedFields } =
                await this.applyAssignments(routingResponse.assignments);
              if (!this.running) {
                return;
              }

              // Get issues description message
              const issuesText = this.describeIssues(issues);

              if (!applied && !issues.length) {
                await this.speak(this.message("final_edit_retry"));
                if (!this.running) {
                  return;
                }
                continue;
              }

              if (applied && appliedFields.length) {
                const labels = appliedFields
                  .map((item) => item.label)
                  .join(", ");
                const updateMessage = this.message("final_edit_updated", {
                  labels,
                });

                // Combine issues with update message
                const fullMessage = issuesText
                  ? `${issuesText} ${updateMessage}`
                  : updateMessage;

                await this.speak(fullMessage);
                if (!this.running) {
                  return;
                }

                // Close any dropdowns after successful edit
                for (const field of appliedFields) {
                  if (isCustomDropdownElement(field.element)) {
                    await this.ensureCustomDropdownClosed(field.element);
                  }
                }
              } else if (issuesText) {
                // Only issues, no successful updates
                await this.speak(issuesText);
                if (!this.running) {
                  return;
                }
              }

              // Only speak followUp if no assignments were applied
              // If assignments were successful, don't speak confirmation requests from LLM
              if (routingResponse.followUp && !appliedFields.length) {
                await this.speak(routingResponse.followUp);
              }

              // Store the "before" state for the outer loop to check for newly visible fields
              (this as any).__unfilledVisibleFieldsBefore =
                unfilledVisibleFieldsBefore;

              continuousEditHandled = true;
              break; // Break from retry loop to ask again
            }

            if (!continuousEditHandled) {
              // Exhausted retries in "continue editing?" loop — close the form.
              if (this.running) {
                await this.speak(this.message("no_response_closing"));
                if (this.running) {
                  this.emitStatus({
                    message: this.message("no_response_closing"),
                  });
                }
                this.hooks.onQuit?.({ confirmed: true, reason: "no-response" });
                this.stop();
              }
              return;
            }
          }

          // Exit final review
          return;
        }

        // Unknown response, clarify
        await this.speak(this.message("final_review_retry"));
        if (!this.running) {
          return;
        }
      }

      // Exhausted all 3 attempts with no legible yes/no response — close the form.
      if (this.running) {
        await this.speak(this.message("no_response_closing"));
        if (this.running) {
          this.emitStatus({ message: this.message("no_response_closing") });
        }
        this.hooks.onQuit?.({ confirmed: true, reason: "no-response" });
        this.stop();
      }
      return;
    }
  }

  private async handleFinalReviewEdit(): Promise<void> {
    if (!this.running) {
      return;
    }

    // Ask which field to edit
    const question = this.message("final_review_which_field");
    // Update UI to show we're asking which field to edit
    this.emitPrompt({ text: question });
    const transcriptPromise = this.listen({ allowConcurrentSpeech: true });
    await this.speak(question);
    if (!this.running) {
      await transcriptPromise;
      return;
    }

    const transcript = await transcriptPromise;
    if (!this.running) {
      return;
    }

    if (!transcript) {
      await this.speak(this.message("prompt_retry"));
      if (!this.running) {
        return;
      }
      return;
    }

    // Track visible unfilled fields BEFORE applying the edit
    const unfilledVisibleFieldsBefore = this.fields
      .filter(
        (f) => this.isFieldVisible(f) && !this.fieldState.get(f.id)?.value,
      )
      .map((f) => f.id);

    // Get all visible fields (both answered and unanswered) for editing
    const allVisibleFields = this.fields.filter((field) =>
      this.isFieldVisible(field),
    );

    // Use the router to map the edit request
    const routingResponse = await this.router.routeAnswer({
      userInput: transcript,
      pendingFields: allVisibleFields,
      completedFields: [],
      language: this.language.code,
      isEditMode: true,
    });
    if (!this.running) {
      return;
    }

    // Check for special commands (reset/quit/finish)
    if (
      routingResponse.specialCommand &&
      routingResponse.specialCommand.confidence >= 0.7
    ) {
      await this.handleSpecialCommandInEditFlow(routingResponse.specialCommand);
      return;
    }

    if (!routingResponse.assignments.length) {
      await this.speak(this.message("mapping_failure"));
      return;
    }

    const { applied, issues, appliedFields } = await this.applyAssignments(
      routingResponse.assignments,
    );
    if (!this.running) {
      return;
    }

    // Get issues description message
    const issuesText = this.describeIssues(issues);

    if (!applied && !issues.length) {
      await this.speak(this.message("apply_failure"));
      return;
    }

    if (applied && appliedFields.length) {
      const labels = appliedFields.map((item) => item.label).join(", ");
      const updateMessage = this.message("final_review_updated", { labels });

      // Combine issues with update message
      const fullMessage = issuesText
        ? `${issuesText} ${updateMessage}`
        : updateMessage;

      await this.speak(fullMessage);
      if (!this.running) {
        return;
      }

      // Close any dropdowns after successful edit
      for (const field of appliedFields) {
        if (isCustomDropdownElement(field.element)) {
          await this.ensureCustomDropdownClosed(field.element);
        }
      }
    } else if (issuesText) {
      // Only issues, no successful updates
      await this.speak(issuesText);
      if (!this.running) {
        return;
      }
    }

    // Only speak followUp if no assignments were applied
    // If assignments were successful, don't speak confirmation requests from LLM
    if (routingResponse.followUp && !appliedFields.length) {
      await this.speak(routingResponse.followUp);
    }

    // Store the "before" state for the continuous edit loop to check for newly visible fields
    (this as any).__unfilledVisibleFieldsBefore = unfilledVisibleFieldsBefore;
  }

  private async announceStepEntry(
    step: StepInfo | undefined,
    options?: { isInitial?: boolean },
  ): Promise<void> {
    if (!this.running || !step) {
      return;
    }

    const index = this.steps.findIndex((item) => item.id === step.id);
    if (index !== -1) {
      this.currentStepIndex = index;
    }

    this.emitStepChange(step);
    this.emitStatus({
      message: this.message("status_now_on", { label: step.label }),
    });

    const phrase = options?.isInitial
      ? this.message("step_begin", { current: step.label })
      : this.message("step_move", { current: step.label });
    await this.speak(phrase);
  }

  private emitStepChange(step: StepInfo): void {
    const index = this.steps.findIndex((item) => item.id === step.id);
    this.hooks.onStepChange?.({
      stepId: step.id,
      label: step.label,
      index: index === -1 ? 0 : index,
      fieldIds: [...step.fieldIds],
    });
  }

  /**
   * Bhashini-specific methods
   */

  private async ensureBhashiniRecognizer(): Promise<BhashiniASRClient> {
    if (this.bhashiniClient && this.bhashiniSpeechService?.connected) {
      return this.bhashiniClient;
    }

    if (!this.bhashiniSpeechService) {
      throw new Error("Bhashini speech service not initialized");
    }

    // Create Bhashini client with response handler
    this.bhashiniClient = await this.bhashiniSpeechService.createClient(
      (response: any, streamingStatus: any) => {
        this.handleBhashiniResponse(response, streamingStatus);
      },
      true, // autoStart
    );

    // Setup audio processing
    await this.startBhashiniAudioCapture();

    return this.bhashiniClient;
  }

  private async startBhashiniAudioCapture(): Promise<void> {
    if (!this.bhashiniSpeechService || !this.bhashiniClient) {
      throw new Error("Bhashini service or client not initialized");
    }

    // Get microphone stream (16kHz, mono)
    this.bhashiniMediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // Create audio context for processing
    this.bhashiniAudioContext = new AudioContext({ sampleRate: 16000 });
    const source = this.bhashiniAudioContext.createMediaStreamSource(
      this.bhashiniMediaStream,
    );
    this.bhashiniScriptProcessor =
      this.bhashiniAudioContext.createScriptProcessor(4096, 1, 1);

    const audioBuffers: Float32Array[] = [];
    let totalLength = 0;

    this.bhashiniScriptProcessor.onaudioprocess = (e: AudioProcessingEvent) => {
      if (!this.listeningActive) return;
      const inputData = e.inputBuffer.getChannelData(0);
      audioBuffers.push(new Float32Array(inputData));
      totalLength += inputData.length;
    };

    source.connect(this.bhashiniScriptProcessor);
    this.bhashiniScriptProcessor.connect(this.bhashiniAudioContext.destination);

    // Send audio chunks every 1 second
    this.bhashiniSendInterval = setInterval(() => {
      if (audioBuffers.length === 0) return;

      // Merge buffers
      const merged = new Float32Array(totalLength);
      let offset = 0;
      for (const buf of audioBuffers) {
        merged.set(buf, offset);
        offset += buf.length;
      }

      // Convert Float32 to Int16 (PCM format)
      const pcmData = new Int16Array(merged.length);
      for (let i = 0; i < merged.length; i++) {
        const s = Math.max(-1, Math.min(1, merged[i]));
        pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      // Send to Bhashini
      if (this.bhashiniSpeechService && this.bhashiniClient) {
        this.bhashiniSpeechService.sendAudioData(this.bhashiniClient, pcmData);
      }

      // Clear buffers
      audioBuffers.length = 0;
      totalLength = 0;
    }, 1000);

    this.listeningActive = true;
  }

  private handleBhashiniResponse(response: any, streamingStatus: any): void {
    if (!this.running) {
      return;
    }

    // Extract transcription
    const text =
      response?.pipelineResponse?.[0]?.output?.[0]?.source?.trim() || "";

    if (!text) {
      return;
    }

    const isIntermediate = streamingStatus?.isIntermediateResult === true;
    const now = Date.now();

    // Update speech activity tracking
    if (!this.userSpeaking) {
      this.userSpeaking = true;
      this.speechOngoingSince = now;
    }
    this.lastUserSpeechAt = now;
    this.lastSilenceAt = 0;

    // Stop any ongoing TTS
    this.invalidatePendingSpeech();
    if (this.speaking || this.pendingSpeakResolve) {
      void this.stopSpeaking({ force: true });
    }
    this.scheduleSilenceCheck();

    const context = this.listenContext;
    if (!context) {
      return;
    }

    context.heardSpeech = true;

    if (isIntermediate) {
      // Intermediate result: REPLACE buffer (don't append)
      context.partial = text;
      context.segments = []; // Clear segments for intermediate
      updateBufferedFromSegments(context);
      this.emitTranscript({ text: context.buffered, isFinal: false });
      this.scheduleFinalize(context);
    } else {
      // Final result: REPLACE buffer (don't append)
      context.segments = [text];
      context.partial = "";
      updateBufferedFromSegments(context);
      this.emitTranscript({ text: context.buffered, isFinal: true });
      this.scheduleFinalize(context);
    }
  }

  /**
   * CRITICAL: Restart Bhashini session to prevent text accumulation
   * Call this after processing each command
   */
  restartBhashiniSession(): void {
    if (
      this.speechProvider === "bhashini" &&
      this.bhashiniSpeechService &&
      this.bhashiniClient
    ) {
      if (this.debug.logExtractedFields) {
        console.log("[VoiceForm] Restarting Bhashini session");
      }
      this.bhashiniSpeechService.restartSession(this.bhashiniClient);
    }
  }

  private cleanupBhashiniResources(): void {
    if (this.debug.logExtractedFields) {
      console.log("[VoiceForm] Cleaning up Bhashini resources");
    }

    if (this.bhashiniScriptProcessor) {
      this.bhashiniScriptProcessor.disconnect();
      this.bhashiniScriptProcessor.onaudioprocess = null;
      this.bhashiniScriptProcessor = null;
    }

    if (this.bhashiniSendInterval) {
      clearInterval(this.bhashiniSendInterval);
      this.bhashiniSendInterval = null;
    }

    if (this.bhashiniSpeechService && this.bhashiniClient) {
      this.bhashiniSpeechService.disconnect();
      this.bhashiniClient = null;
    }

    if (this.bhashiniMediaStream) {
      this.bhashiniMediaStream.getTracks().forEach((track) => track.stop());
      this.bhashiniMediaStream = null;
    }

    if (this.bhashiniAudioContext) {
      this.bhashiniAudioContext.close();
      this.bhashiniAudioContext = null;
    }

    this.listeningActive = false;
  }

  /**
   * Sarvam-specific methods
   */

  private async ensureSarvamRecognizer(): Promise<any> {
    if (this.sarvamSTTClient) {
      return this.sarvamSTTClient;
    }

    if (!this.sarvamSpeechService) {
      throw new Error("Sarvam speech service not initialized");
    }

    // Create Sarvam STT client with response handler
    this.sarvamSTTClient = await this.sarvamSpeechService.createSTTClient(
      (message: SarvamSTTMessage) => {
        this.handleSarvamResponse(message);
      },
    );

    // Setup audio processing
    await this.startSarvamAudioCapture();

    return this.sarvamSTTClient;
  }

  private async startSarvamAudioCapture(): Promise<void> {
    if (!this.sarvamSpeechService || !this.sarvamSTTClient) {
      throw new Error("Sarvam service or client not initialized");
    }

    // Get microphone stream (16kHz, mono)
    this.sarvamMediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // Create audio context for processing
    this.sarvamAudioContext = new AudioContext({ sampleRate: 16000 });
    const source = this.sarvamAudioContext.createMediaStreamSource(
      this.sarvamMediaStream,
    );
    this.sarvamScriptProcessor = this.sarvamAudioContext.createScriptProcessor(
      4096,
      1,
      1,
    );

    const audioBuffers: Float32Array[] = [];
    let totalLength = 0;

    this.sarvamScriptProcessor.onaudioprocess = (e: AudioProcessingEvent) => {
      if (!this.listeningActive) return;
      const inputData = e.inputBuffer.getChannelData(0);
      audioBuffers.push(new Float32Array(inputData));
      totalLength += inputData.length;
    };

    source.connect(this.sarvamScriptProcessor);
    this.sarvamScriptProcessor.connect(this.sarvamAudioContext.destination);

    // Send audio chunks every 1 second
    this.sarvamSendInterval = setInterval(() => {
      if (audioBuffers.length === 0) return;

      // Merge buffers
      const merged = new Float32Array(totalLength);
      let offset = 0;
      for (const buf of audioBuffers) {
        merged.set(buf, offset);
        offset += buf.length;
      }

      // Convert Float32 to Int16 (PCM format)
      const pcmData = new Int16Array(merged.length);
      for (let i = 0; i < merged.length; i++) {
        const s = Math.max(-1, Math.min(1, merged[i]));
        pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      // Send to Sarvam
      if (this.sarvamSpeechService && this.sarvamSTTClient) {
        this.sarvamSpeechService.sendAudioToSTT(pcmData);
      }

      // Clear buffers
      audioBuffers.length = 0;
      totalLength = 0;
    }, 1000);

    this.listeningActive = true;
  }

  private handleSarvamResponse(message: SarvamSTTMessage): void {
    if (!this.running) {
      return;
    }

    // Extract transcription from message data
    const text = message.data?.transcript?.trim() || "";

    if (!text) {
      return;
    }

    // Sarvam messages are treated as final transcriptions
    // (can be refined if Sarvam provides intermediate results via message.type)
    const isIntermediate =
      message.type === "partial" || message.type === "intermediate";
    const now = Date.now();

    // Update speech activity tracking
    if (!this.userSpeaking) {
      this.userSpeaking = true;
      this.speechOngoingSince = now;
    }
    this.lastUserSpeechAt = now;
    this.lastSilenceAt = 0;

    // Stop any ongoing TTS
    this.invalidatePendingSpeech();
    if (this.speaking || this.pendingSpeakResolve) {
      void this.stopSpeaking({ force: true });
    }
    this.scheduleSilenceCheck();

    const context = this.listenContext;
    if (!context) {
      return;
    }

    context.heardSpeech = true;

    if (isIntermediate) {
      // Intermediate result: REPLACE buffer (don't append)
      context.partial = text;
      context.segments = []; // Clear segments for intermediate
      updateBufferedFromSegments(context);
      this.emitTranscript({ text: context.buffered, isFinal: false });
      this.scheduleFinalize(context);
    } else {
      // Final result: REPLACE buffer (don't append)
      context.segments = [text];
      context.partial = "";
      updateBufferedFromSegments(context);
      this.emitTranscript({ text: context.buffered, isFinal: true });
      this.scheduleFinalize(context);
    }
  }

  private cleanupSarvamResources(): void {
    if (this.debug.logExtractedFields) {
      console.log("[VoiceForm] Cleaning up Sarvam resources");
    }

    if (this.sarvamScriptProcessor) {
      this.sarvamScriptProcessor.disconnect();
      this.sarvamScriptProcessor.onaudioprocess = null;
      this.sarvamScriptProcessor = null;
    }

    if (this.sarvamSendInterval) {
      clearInterval(this.sarvamSendInterval);
      this.sarvamSendInterval = null;
    }

    if (this.sarvamSTTClient) {
      // Close handled by library's disconnect
      this.sarvamSTTClient = null;
    }

    if (this.sarvamMediaStream) {
      this.sarvamMediaStream.getTracks().forEach((track) => track.stop());
      this.sarvamMediaStream = null;
    }

    if (this.sarvamAudioContext) {
      this.sarvamAudioContext.close();
      this.sarvamAudioContext = null;
    }

    this.listeningActive = false;
  }

  private async speakWithSarvam(text: string, guard: number): Promise<void> {
    if (!this.sarvamSpeechService) {
      if (this.debug.logExtractedFields) {
        console.warn("[VoiceForm] Sarvam TTS not available, skipping speech");
      }
      return;
    }

    const token = ++this.speakToken;
    this.speaking = true;

    const completion = new Promise<void>((resolve, reject) => {
      let finished = false;

      const finalize = (error?: Error) => {
        if (finished) {
          return;
        }
        finished = true;
        if (this.pendingSpeakResolve === finalize) {
          this.pendingSpeakResolve = null;
        }
        if (this.speakToken === token) {
          this.speaking = false;
        }
        const activeContext = this.listenContext;
        if (
          activeContext &&
          !activeContext.completed &&
          activeContext.allowConcurrentSpeech
        ) {
          this.scheduleFinalize(activeContext);
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      this.pendingSpeakResolve = finalize;

      // Synthesize speech with Sarvam
      this.sarvamSpeechService!.synthesizeSpeech(text)
        .then((audioContent) => {
          if (guard !== this.speechGuard || this.speakToken !== token) {
            finalize();
            return;
          }

          // Play the audio
          return this.playSarvamAudio(audioContent, token, guard);
        })
        .then(() => {
          finalize();
        })
        .catch((error) => {
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          this.emitError(normalized);
          finalize(normalized);
        });
    });

    this.speakingPromise = completion;
    try {
      await completion;
    } finally {
      if (this.speakingPromise === completion) {
        this.speakingPromise = null;
      }
    }
  }

  /**
   * Play Sarvam base64-encoded audio using Web Audio API
   * This handles any format (MP3, PCM, WAV, etc.) more reliably
   */
  private async playSarvamAudio(
    audioContent: string,
    token: number,
    guard: number,
  ): Promise<void> {
    if (this.speechGuard !== guard || this.speakToken !== token) {
      return;
    }

    if (this.debug.logExtractedFields) {
      console.log(
        `[VoiceForm] Playing Sarvam audio, base64 length: ${audioContent.length}`,
      );
    }

    try {
      // Clean and normalize base64 string
      // Remove whitespace, newlines, and normalize URL-safe base64
      let cleanedBase64 = audioContent
        .replace(/\s/g, "") // Remove all whitespace
        .replace(/-/g, "+") // Convert URL-safe chars
        .replace(/_/g, "/");

      // Add padding if needed
      const paddingNeeded = (4 - (cleanedBase64.length % 4)) % 4;
      if (paddingNeeded > 0) {
        cleanedBase64 += "=".repeat(paddingNeeded);
      }

      if (this.debug.logExtractedFields) {
        console.log(
          `[VoiceForm] Cleaned base64 length: ${cleanedBase64.length}, padding added: ${paddingNeeded}`,
        );
      }

      // Decode base64 to binary
      const binaryString = atob(cleanedBase64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      if (this.debug.logExtractedFields) {
        console.log(
          `[VoiceForm] Audio buffer size: ${bytes.length} bytes, first bytes: ${Array.from(
            bytes.slice(0, 16),
          )
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(" ")}`,
        );
      }

      // Create or reuse AudioContext
      if (!this.audioContext) {
        this.audioContext = new (
          window.AudioContext || (window as any).webkitAudioContext
        )();
      }

      // Decode audio data (handles MP3, WAV, PCM, etc.)
      const audioBuffer = await this.audioContext.decodeAudioData(bytes.buffer);

      if (this.speechGuard !== guard || this.speakToken !== token) {
        return;
      }

      if (this.debug.logExtractedFields) {
        console.log(
          `[VoiceForm] Audio decoded: ${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.sampleRate}Hz, ${audioBuffer.numberOfChannels}ch`,
        );
      }

      // Create audio source
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContext.destination);

      // Handle completion
      const cleanup = () => {
        if (this.audioPlaybackTeardown === teardown) {
          this.audioPlaybackTeardown = null;
        }
      };

      const teardown = (error?: Error) => {
        cleanup();
        try {
          source.stop();
        } catch (_err) {
          // Already stopped
        }
        if (error) {
          throw error;
        }
      };

      source.onended = () => {
        if (this.debug.logExtractedFields) {
          console.log("[VoiceForm] Sarvam audio playback completed");
        }
        if (this.speechGuard === guard && this.speakToken === token) {
          cleanup();
        }
      };

      this.audioPlaybackTeardown = teardown;

      // Start playback
      source.start(0);
      if (this.debug.logExtractedFields) {
        console.log("[VoiceForm] Sarvam audio playing via Web Audio API");
      }
    } catch (error) {
      if (this.debug.logExtractedFields) {
        console.error("[VoiceForm] Sarvam audio processing failed:", error);
      }
      throw new Error(
        `Audio playback failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
function updateBufferedFromSegments(context: ListenContext): void {
  const pieces = [...context.segments, context.partial]
    .map(normalizeTranscriptPiece)
    .filter(Boolean);
  context.buffered = pieces.join(" ").trim();
}

function pushTranscriptSegment(segments: string[], segment: string): void {
  const normalized = normalizeTranscriptPiece(segment);
  if (!normalized) {
    return;
  }
  const lastIndex = segments.length - 1;
  if (lastIndex >= 0) {
    const existing = segments[lastIndex];
    const existingNormalized = normalizeTranscriptPiece(existing);
    if (transcriptPiecesEqual(existingNormalized, normalized)) {
      segments[lastIndex] = normalized;
      return;
    }
    const existingLower = existingNormalized.toLowerCase();
    const normalizedLower = normalized.toLowerCase();
    if (normalizedLower.startsWith(existingLower)) {
      segments[lastIndex] = normalized;
      return;
    }
    if (existingLower.startsWith(normalizedLower)) {
      // The new segment is shorter than the existing final chunk; keep the longer one.
      return;
    }
  }
  segments.push(normalized);
}

function normalizeTranscriptPiece(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function transcriptPiecesEqual(a: string, b: string): boolean {
  return (
    normalizeTranscriptPiece(a).toLowerCase() ===
    normalizeTranscriptPiece(b).toLowerCase()
  );
}

function splitValues(value: string | string[]): string[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value
    .split(/[;,]| and /i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sanitizeTranscriptValue(value: string): string {
  return value
    .trim()
    .replace(/[\u0964.!?;:]+$/g, "")
    .trim();
}

function isLikelyNumericField(
  field: Pick<
    ExtractedFormField,
    "type" | "label" | "id" | "name" | "constraints"
  >,
): boolean {
  if (field.type === "number" || field.type === "tel") {
    return true;
  }

  if (
    field.constraints.min !== undefined ||
    field.constraints.max !== undefined ||
    field.constraints.step !== undefined
  ) {
    return true;
  }

  const pattern = field.constraints.pattern ?? "";
  if (pattern && /\\d|0-9/.test(pattern)) {
    return true;
  }

  const fieldText = `${field.label} ${field.id} ${field.name}`.toLowerCase();
  return /\b(income|amount|salary|stipend|fee|cost|price|pin|pincode|postal|postcode|zip|mobile|phone|aadhaar|aadhar|age|year|marks|percentage|percent|quantity|count)\b/.test(
    fieldText,
  );
}

function getStrictDigitCodeRule(
  field: Pick<
    ExtractedFormField,
    "type" | "label" | "id" | "name" | "constraints"
  >,
): { exactLength?: number } | null {
  if (field.type === "number") {
    return null;
  }

  const fieldText = `${field.label} ${field.id} ${field.name}`
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ");
  const normalizedFieldText = fieldText.replace(/\s+/g, " ").trim();

  const hasNumericCodeKeyword =
    /\b(pin|pincode|postal\s*code|post\s*code|zip\s*code|zip|otp|aadhaar|aadhar|uid)\b/.test(
      normalizedFieldText,
    );
  const pattern = field.constraints.pattern ?? "";
  const hasDigitOnlyPattern = isDigitOnlyPattern(pattern);

  if (!hasNumericCodeKeyword && !hasDigitOnlyPattern) {
    return null;
  }

  const exactLengthFromPattern = parseExactDigitLengthFromPattern(pattern);
  const exactLengthFromConstraints =
    field.constraints.minLength !== undefined &&
    field.constraints.maxLength !== undefined &&
    field.constraints.minLength === field.constraints.maxLength
      ? field.constraints.maxLength
      : undefined;
  const exactLengthFromMaxOnly =
    field.constraints.minLength === undefined &&
    field.constraints.maxLength !== undefined &&
    field.constraints.maxLength <= 12
      ? field.constraints.maxLength
      : undefined;

  return {
    exactLength:
      exactLengthFromPattern ??
      exactLengthFromConstraints ??
      exactLengthFromMaxOnly,
  };
}

function isDigitOnlyPattern(pattern: string): boolean {
  if (!pattern || !/(\\d|\[0-9\])/.test(pattern)) {
    return false;
  }
  const withoutDigitTokens = pattern
    .replace(/\\d/g, "")
    .replace(/\[0-9\]/g, "");
  return !/[A-Za-z]/.test(withoutDigitTokens);
}

function parseExactDigitLengthFromPattern(pattern: string): number | undefined {
  if (!pattern) {
    return undefined;
  }

  const direct = pattern.match(/(?:\\d|\[0-9\])\{(\d+)\}/);
  if (direct?.[1]) {
    return Number(direct[1]);
  }

  const fixedSingles = pattern.match(/(?:\\d|\[0-9\])(?!\{)/g);
  if (fixedSingles?.length) {
    const quantified = pattern
      .match(/(?:\\d|\[0-9\])\{(\d+)\}/g)
      ?.reduce((sum, token) => {
        const m = token.match(/\{(\d+)\}/);
        return sum + (m?.[1] ? Number(m[1]) : 0);
      }, 0);
    return fixedSingles.length + (quantified ?? 0);
  }

  return undefined;
}

function isNumericLikeSpokenValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || !/\d/.test(trimmed)) {
    return false;
  }

  // Numeric speech transcripts typically contain only digits, commas, dots, spaces, and optional leading minus.
  return /^-?[\d\s,.]+$/.test(trimmed);
}

function sanitizeNumericAssignmentValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (!/\d/.test(trimmed)) {
    return trimmed.replace(/[!?;:]+$/g, "");
  }

  // Remove common currency terms before numeric extraction
  const currencyPattern = /\b(rupees?|rs\.?|inr|₹|dollars?|usd|\$)\b/gi;
  const withoutCurrency = trimmed.replace(currencyPattern, " ");

  const compact = withoutCurrency
    .replace(/,/g, "")
    .replace(/\s+/g, "")
    .replace(/[!?;:]+$/g, "");

  const numericToken = compact.match(/-?\d+(?:\.\d+)?/);
  if (numericToken?.[0]) {
    return numericToken[0];
  }

  return compact.replace(/\.$/, "");
}

function normalizeDigitCodeValue(value: string): string {
  return value.replace(/\D/g, "");
}

function countDecimalPlaces(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const valueString = value.toString().toLowerCase();
  if (valueString.includes("e-")) {
    const [base, exponent] = valueString.split("e-");
    const decimalsInBase = base.includes(".") ? base.split(".")[1].length : 0;
    return Number(exponent) + decimalsInBase;
  }

  if (valueString.includes(".")) {
    return valueString.split(".")[1].length;
  }

  return 0;
}
