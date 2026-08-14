import {
  extractFormFields,
  waitForCustomDropdownRender,
  isCustomDropdownElement,
  isDropdownExpanded,
  ensureCustomDropdownOptions,
  openDropdownElement,
  closeDropdownElement,
  getDropdownOptionContainers,
  readDropdownOptionMetadata,
  type ExtractedFormField,
} from "../v1/formExtractor";
import { storeExtractedFields } from "../v1/debugState";
import { SarvamSpeechService } from "./sarvamSpeech";
import { SarvamHttpProxyProvider } from "./sarvamProxyProvider";
import { BhashiniSpeechService } from "./bhashiniSpeech";
import { BedrockTranslator } from "./bedrockTranslator";
import { BedrockProxyRouter, BedrockProxyTranslator } from "./proxyRouters";
import { formatTextForTts } from "./ttsText";
import { V2BedrockRouter } from "./v2BedrockRouter";
import {
  TranslationError,
  type AudioRecordingPair,
  type BedrockRouter,
  type BedrockRoutingRequest,
  type BedrockRoutingResponse,
  type FieldAssignment,
  type ObservabilityHooks,
  type SarvamSpeechProvider,
  type TranslatedOptionMapping,
  type V2SupportedLanguage,
  type V2UiHooks,
  type V2VoiceFormInitOptions,
  type VoiceFormFieldDescriptor,
} from "./types";

// ─── Native property setter helper ───────────────────────────────────────────
//
// React (and other VDOM frameworks) override HTMLElement property setters to
// track their own "last known value". If we just write `element.value = x`,
// React sees no change and resets the field on the next render cycle.
//
// The fix is to call the ORIGINAL prototype setter, which bypasses the
// framework override and makes the subsequent synthetic `input`/`change` event
// look like a genuine user interaction:
//
//   nativeSet(input, "value", "Pankaj");
//   input.dispatchEvent(new Event("input", { bubbles: true }));
//
// This works for React 16/17/18, Angular (no-op since Angular reads directly
// from the DOM property after the event fires), and plain HTML forms.
function nativeSet(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  prop: "value" | "checked",
  value: string | boolean,
): void {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
  if (descriptor?.set) {
    descriptor.set.call(el, value);
  } else {
    // Fallback: direct assignment (works in non-React environments)
    (el as unknown as Record<string, unknown>)[prop] = value;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_EMPTY_RETRIES = 4; // Increased for low-literacy users
const MAX_INVALID_RETRIES = 3; // Increased for low-literacy users
const SPEECH_END_DEBOUNCE_MS = 300; // Faster finalization to reduce field-to-field gap
const MAX_LISTEN_MS = 120_000; // 2 minutes - more time for users
const QUESTION_LISTEN_WARMUP_MS = 150; // Faster mic handoff for next question
const DEFAULT_TRANSCRIPT_GUARD_INTERVAL_MS = 3000;
// How quiet the transcript must be before the guard is allowed to judge it.
// Roughly one realtime-partial interval, so "still being spoken" and "stalled"
// are distinguishable.
const TRANSCRIPT_SETTLE_MS = 1200;
const MAX_TRANSCRIPT_GUARD_INTERVAL_MS = 10_000;
const SPECIAL_COMMAND_MIN_CONFIDENCE = 0.72;
const SPECIAL_COMMAND_HIGH_CONFIDENCE = 0.86;
const SPECIAL_COMMAND_REPEAT_WINDOW_MS = 3000;

// ─── Step info type ───────────────────────────────────────────────────────────

interface StepInfo {
  id: string;
  label: string;
  index: number;
  fieldIds: string[];
  tabId?: string;
  panelId?: string;
  isTab?: boolean;
}

interface AssignmentFailure {
  fieldId: string;
  label: string;
  message: string;
}

interface TranscriptGuardSettings {
  enabled: boolean;
  intervalMs: number;
}

interface IncrementalRoutingSettings {
  enabled: boolean;
  minIntervalMs: number;
  minNewWords: number;
  minConfidence: number;
}

type LocalTranscriptGuardRelevance = "relevant" | "inconclusive";
type SpecialCommandIntent = "reset" | "quit" | "finish";
type SpecialCommandDecision = "ignore" | "clarify" | "confirm";

// ─── Listening State ──────────────────────────────────────────────────────────

enum ListeningState {
  IDLE = "IDLE",
  SPEAKING = "SPEAKING",
  LISTENING_FOR_ANSWER = "LISTENING_FOR_ANSWER",
  PROCESSING = "PROCESSING",
}

// ─── Translator interface ─────────────────────────────────────────────────────

interface TranslatorLike {
  translatePrompt(text: string, lang: V2SupportedLanguage): Promise<string>;
  translateOptions(
    options: { value: string; label: string }[],
    lang: V2SupportedLanguage,
  ): Promise<TranslatedOptionMapping[]>;
  clearCache(): void;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class V2VoiceFormService {
  private readonly options: V2VoiceFormInitOptions;
  private readonly hooks: V2UiHooks;
  private readonly observability: ObservabilityHooks;
  private readonly speech: SarvamSpeechProvider;
  private readonly router: BedrockRouter;
  private readonly translator: TranslatorLike;
  private readonly debugLogs: boolean;
  private readonly sessionId: string;
  private readonly transcriptGuard: TranscriptGuardSettings;
  private readonly incrementalRouting: IncrementalRoutingSettings;
  /** Fields already filled mid-answer during THIS turn, and with what — so a
   *  re-route of the same value is skipped, and so the turn-end pass knows to
   *  re-check them against the complete sentence. */
  private incrementalApplied = new Map<string, string>();
  private incrementalRouteInFlight = false;
  private lastIncrementalRouteAt = 0;
  private incrementalRoutedWords = 0;

  private form: HTMLElement | null = null;
  private fields: ExtractedFormField[] = [];
  private language: V2SupportedLanguage;
  private running = false;
  private stopRequested = false;

  // Continuous listening state
  private listeningState: ListeningState = ListeningState.IDLE;
  private continuousListeningActive = false;
  // Set when the fire-and-forget startContinuousListening() chain kicked off
  // by askAndListen()'s warmup permanently rejects, so listenOnce() can fail
  // fast instead of waiting for MAX_LISTEN_MS.
  private continuousListeningStartFailed = false;
  private continuousTranscript = "";
  private lastSeenTranscript = ""; // Track last seen text to avoid duplicates
  private transcriptSegments: string[] = [];
  private currentTranscriptSegment = "";
  private continuousSpeechEndTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptGuardTimer: ReturnType<typeof setInterval> | null = null;
  private transcriptGuardLastCheckpoint = "";
  private transcriptGuardCheckInFlight = false;
  /** When the accumulated transcript last actually grew. */
  private transcriptGuardLastChangeAt = 0;
  private userSpeakingActive = false; // true while VAD reports active speech
  private pendingListenResolve: ((text: string) => void) | null = null;
  private questionSpeechActive = false;
  private interruptingQuestionSpeech = false;
  private currentQuestionFieldId: string | undefined;
  private pendingSpecialCommand: {
    type: SpecialCommandIntent;
    count: number;
    lastHeardAt: number;
  } | null = null;

  // Multi-step state
  private steps: StepInfo[] = [];
  private currentStepIndex = 0;

  // Manual intervention detection
  private formChangeObserver: MutationObserver | null = null;
  private manuallyFilledFields = new Set<string>();
  private programmaticallyFilledFields = new Set<string>();
  private skippedFields = new Set<string>();
  private isSettingValueProgrammatically = false;
  private lastAssignmentFailure: AssignmentFailure | null = null;

  constructor(options: V2VoiceFormInitOptions) {
    this.options = options;
    this.hooks = options.uiHooks ?? {};
    this.observability = options.observability ?? {};
    this.debugLogs = options.debug?.logExtractedFields ?? false;
    this.sessionId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.language = options.language;
    this.transcriptGuard = this.resolveTranscriptGuardConfig(
      options.transcriptGuard,
    );
    this.incrementalRouting = this.resolveIncrementalRoutingConfig(
      options.incrementalRouting,
    );
    this.speech = this.resolveSpeechProvider();
    this.router = this.resolveRouter();
    this.translator = this.resolveTranslator();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (typeof document === "undefined") {
      throw new Error(
        "[V2VoiceFormService] document is undefined — library must run in a browser.",
      );
    }
    if (typeof window !== "undefined" && !window.isSecureContext) {
      throw new Error(
        "[V2VoiceFormService] Microphone access requires a secure context (HTTPS or localhost).",
      );
    }
    const form = document.querySelector(
      this.options.formSelector,
    ) as HTMLElement | null;
    if (!form) {
      throw new Error(
        `[V2VoiceFormService] Form not found for selector: ${this.options.formSelector}`,
      );
    }
    this.form = form;

    await waitForCustomDropdownRender(form, 4000);
    this.fields = extractFormFields(form);
    storeExtractedFields(this.snapshotFields());

    // Detect multi-step structure
    this.steps = this.detectSteps(form);
    this.currentStepIndex = this.findActiveStepIndex(this.steps);

    if (this.debugLogs) {
      console.log(
        "[V2VoiceFormService] Extracted fields:",
        this.fields.length,
        "Steps:",
        this.steps.length,
      );
    }
    this.hooks.onFieldsExtracted?.({ fields: this.snapshotFields() });
    this.observability.onSessionStart?.(this.sessionId, this.snapshotFields());
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.initialize();
    this.running = true;
    this.stopRequested = false;
    this.manuallyFilledFields.clear();
    this.programmaticallyFilledFields.clear();
    this.skippedFields.clear();
    this.speech.resetAudioRecordingSession?.();

    await this.requestMicrophonePermission();

    this.setupManualInterventionDetection();

    await this.speakAndEmit(
      "Voice assistant is ready. You can start speaking.",
    );

    try {
      await this.runFlow();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.hooks.onError?.({ error });
    } finally {
      this.running = false;
      this.cleanupManualInterventionDetection();
      await this.stopContinuousListening();
      this.speech.stopSpeaking();
      this.resetInternalData();
    }
  }

  private async requestMicrophonePermission(): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      return;
    }

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } finally {
      if (stream) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.speech.stopSpeaking();
    await this.stopContinuousListening();
    this.running = false;
    this.cleanupManualInterventionDetection();
    this.emitStatus("Voice assistant stopped. You can restart anytime.");
    this.resetInternalData();
  }

  async setLanguage(language: V2SupportedLanguage): Promise<void> {
    if (this.language === language) return;
    this.language = language;
    this.speech.setLanguage(language);
    this.translator.clearCache();
  }

  async announceAndStop(message: string): Promise<void> {
    try {
      await this.speakAndEmit(message);
    } finally {
      await this.stop();
    }
  }

  getExtractedFields(): VoiceFormFieldDescriptor[] {
    return this.snapshotFields();
  }

  getAudioRecordings(): AudioRecordingPair | null {
    return this.speech.getAudioRecordings?.() ?? null;
  }

  private resetInternalData(): void {
    this.form = null;
    this.fields = [];
    this.steps = [];
    this.currentStepIndex = 0;
    this.manuallyFilledFields.clear();
    this.programmaticallyFilledFields.clear();
    this.skippedFields.clear();
    this.resetTranscriptBuffer();
    this.currentQuestionFieldId = undefined;
    this.questionSpeechActive = false;
    this.interruptingQuestionSpeech = false;
  }

  // ─── Main Flow ────────────────────────────────────────────────────────────

  private async runFlow(): Promise<void> {
    // Announce initial step if multi-step
    if (this.steps.length > 0) {
      const step = this.steps[this.currentStepIndex];
      this.emitStepChange(step);
      await this.speakAndEmit(`Let's begin with ${step.label}.`);
    }

    // Outer loop handles form reset scenarios
    while (this.running && !this.stopRequested) {
      // Fill all fields (step by step if multi-step)
      await this.fillAllFields();
      if (!this.running || this.stopRequested) return;

      // All done — final review
      if (this.allFieldsCompleted()) {
        await this.speakAndEmit("All fields completed successfully!");
        this.emitStatus("All fields completed successfully!");

        const editResult = await this.finalReviewPass();
        if (!this.running || this.stopRequested) return;

        if (editResult === "done") {
          // User said no to editing — finish
          this.hooks.onQuit?.({ confirmed: true, reason: "completed" });
          this.observability.onSessionEnd?.(this.sessionId, "completed");
          return;
        }
        // editResult === "continue" means user edited something, loop back to
        // check if all fields are still filled
        continue;
      }

      // If not all completed, the flow was interrupted
      return;
    }
  }

  private async fillAllFields(): Promise<void> {
    while (this.running && !this.stopRequested) {
      const nextField = this.findNextField();

      if (!nextField) {
        // Current step is complete
        if (this.steps.length > 0) {
          const advanced = await this.handleStepCompletion();
          if (!this.running || this.stopRequested) return;
          if (advanced) continue;
        }
        // No more fields anywhere
        return;
      }

      // Skip manually filled fields (FR-MAN-002)
      if (this.manuallyFilledFields.has(nextField.id)) {
        this.emitStatus(`${nextField.label} was filled manually, skipping.`);
        continue;
      }

      if (await this.handleUnsupportedUploadField(nextField)) {
        continue;
      }

      // Skip disabled/readonly fields (FR-FE-005)
      if (this.isFieldDisabled(nextField)) continue;

      // For custom dropdowns without options, try to load them first (FR-FE-007)
      if (this.isEmptyDropdown(nextField)) {
        if (this.debugLogs) {
          console.log(
            `[V2VoiceFormService] Attempting to load options for dropdown: ${nextField.label}`,
          );
        }
        // Try to load options for custom dropdowns
        if (isCustomDropdownElement(nextField.element)) {
          try {
            await ensureCustomDropdownOptions(nextField, 4000);
            if (this.debugLogs) {
              console.log(
                `[V2VoiceFormService] Loaded ${nextField.options?.length ?? 0} options for ${nextField.label}`,
              );
            }
          } catch (err) {
            if (this.debugLogs) {
              console.error(
                `[V2VoiceFormService] Failed to load options for ${nextField.label}:`,
                err,
              );
            }
          }
        }
        // If still empty after attempting to load, skip it
        if (this.isEmptyDropdown(nextField)) {
          if (this.debugLogs) {
            console.log(
              `[V2VoiceFormService] Skipping empty dropdown: ${nextField.label}`,
            );
          }
          continue;
        }
      }

      await this.collectAnswerForField(nextField);
      if (!this.running || this.stopRequested) return;
    }
  }

  private async collectAnswerForField(
    field: ExtractedFormField,
  ): Promise<void> {
    const { promptText, translatedOptions } =
      await this.buildPromptForField(field);

    const isSelectField = field.type === "select" || field.type === "radio";

    let emptyAttempts = 0;
    let invalidAttempts = 0;

    try {
    while (this.running && !this.stopRequested) {
      // Open dropdown before speaking so user can see options while hearing the question.
      // onBeforeListen reopens it (in case it closed during TTS) right as the mic activates.
      if (isSelectField) this.openSelectDropdown(field);
      const transcript = await this.askAndListen(
        promptText,
        field.id,
        isSelectField ? () => this.openSelectDropdown(field) : undefined,
      );
      if (this.stopRequested) return;

      // Check manual fill again after listening.
      //
      // A field this turn filled MID-ANSWER is excluded: that value came from a
      // partial sentence ("my income is two…"), and skipping the routing below
      // would keep it instead of the one the finished sentence implies
      // ("…lakh"). Falling through re-routes the complete transcript and
      // overwrites it.
      const filledMidAnswer = this.incrementalApplied.has(field.id);
      if (
        !filledMidAnswer &&
        (this.manuallyFilledFields.has(field.id) || !this.isPendingField(field))
      ) {
        this.emitStatus(`${field.label} was filled, moving on.`);
        return;
      }

      // Empty input handling (FR-ERR-001)
      if (!transcript) {
        emptyAttempts++;
        if (emptyAttempts >= MAX_EMPTY_RETRIES) {
          // Auto-quit on no response (FR-ERR-003)
          await this.speakAndEmit(
            "I could not hear your response. The voice assistant will stop now. You can restart it anytime.",
          );
          this.hooks.onQuit?.({ confirmed: true, reason: "no-response" });
          this.observability.onSessionEnd?.(this.sessionId, "no-response");
          this.stopRequested = true;
          return;
        }
        // More patient messaging for users
        if (emptyAttempts === 1) {
          await this.speakAndEmit(
            "I did not hear anything. Please speak clearly and try again.",
          );
        } else {
          await this.speakAndEmit(
            "I still cannot hear you. Please speak a little louder and closer to your device.",
          );
        }
        continue;
      }

      // Fast-path: for select/radio fields, try a local option match first.
      // When the transcript unambiguously points to one option (higher score
      // than all others), skip the LLM call entirely — this avoids the class
      // of bugs where the LLM picks a wrong option for clear utterances like
      // "by age" when options are ["by name", "by age", "by date of birth"].
      const localRoute =
        this.tryLocalCrossFieldRoute(field, transcript) ??
        this.tryLocalOptionRoute(field, transcript);

      const routingStart = Date.now();
      const routing = localRoute ?? await this.routeAnswer(field, transcript);
      if (this.debugLogs) {
        console.log(
          "[V2VoiceFormService] Routing completed",
          { field: field.label, local: !!localRoute, ms: Date.now() - routingStart },
        );
      }

      // Check for special commands (FR-CMD-*)
      if (routing.specialCommand) {
        const decision = this.decideSpecialCommand(
          routing.specialCommand.type,
          routing.specialCommand.confidence,
          transcript,
        );
        if (decision === "clarify") {
          const command = this.resolveSpecialCommandIntent(transcript);
          if (command) {
            await this.speakAndEmit(
              `If you want to ${command === "reset" ? "reset the form" : "stop this voice flow"}, please say ${
                command === "reset" ? '"reset"' : '"quit"'
              } again.`,
            );
            continue;
          }
        }
        if (decision === "confirm") {
          const command = this.resolveSpecialCommandIntent(transcript);
          if (command) {
            const handled = await this.handleSpecialCommand(
              command === "finish" ? "quit" : command,
            );
            if (handled) return;
            // If not handled (user cancelled), re-ask
            continue;
          }
        }
      }

      const routedAssignments = routing.assignments ?? [];

      // Apply assignments
      if (routedAssignments.length === 0) {
        // LLM couldn't map — use followUp or generic message
        invalidAttempts++;
        let feedbackMessage =
          field.type === "select" ||
          field.type === "radio" ||
          field.type === "checkbox"
            ? undefined
            : routing.followUp;

        if (!feedbackMessage) {
          // Create helpful feedback based on field type
          if (
            field.type === "select" &&
            field.options &&
            field.options.length > 0
          ) {
            feedbackMessage = this.buildOptionRetryMessage(field, transcript);
          } else {
            feedbackMessage = `Sorry, I did not catch that. Could you please say it again?`;
          }
        }

        await this.speakAndEmit(feedbackMessage);

        if (invalidAttempts >= MAX_INVALID_RETRIES) {
          if (!field.constraints.required) {
            await this.speakAndEmit(
              `Since ${field.label} is optional, I will skip it and move ahead.`,
            );
            this.emitStatus(`Skipped ${field.label}`);
            return;
          }
        }
        continue;
      }

      // Apply all valid LLM assignments. Validation and DOM checks remain local
      // guardrails so invalid values are not written permanently.
      const applied = await this.applyAssignments(
        routedAssignments,
        translatedOptions,
        transcript,
      );

      if (this.lastAssignmentFailure) {
        const failure = this.lastAssignmentFailure;
        await this.speakAndEmit(failure.message);
        if (failure.fieldId !== field.id) {
          return;
        }
        invalidAttempts++;
        continue;
      }

      // For custom dropdowns, wait for Angular change detection to complete
      // before checking if field is filled
      if (
        applied > 0 &&
        field.type === "select" &&
        !field.selectElement &&
        field.element &&
        isCustomDropdownElement(field.element)
      ) {
        if (this.debugLogs) {
          console.log(
            `[V2VoiceFormService] Waiting for ng-select model update for ${field.label}`,
          );
        }
        // Wait for Angular's change detection cycle
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Check if current field was filled
      if (!this.isPendingField(field)) {
        // Give positive confirmation
        if (this.debugLogs) {
          console.log(
            `[V2VoiceFormService] Field ${field.label} filled successfully`,
          );
        }
        // Optionally announce success (commenting out to avoid verbosity)
        // await this.speakAndEmit(`Thank you. ${field.label} recorded.`);
        return; // Field is filled, move on
      }

      // If assignments were applied but the current field is still pending
      if (applied > 0 && this.isPendingField(field)) {
        continue;
      }

      // If no assignments applied at all
      if (applied === 0) {
        invalidAttempts++;
        // More helpful error messages with examples
        let helpMessage = "I could not understand that answer. ";
        if (
          field.type === "select" &&
          field.options &&
          field.options.length > 0
        ) {
          const examples = field.options
            .slice(0, 2)
            .map((o) => o.label)
            .join(" or ");
          helpMessage += `Please say one of the options, like ${examples}.`;
        } else {
          helpMessage += `Please try saying your ${field.label} clearly.`;
        }

        await this.speakAndEmit(helpMessage);

        if (
          invalidAttempts >= MAX_INVALID_RETRIES &&
          !field.constraints.required
        ) {
          await this.speakAndEmit(
            `${field.label} is optional, so I will skip it and move to the next field.`,
          );
          this.emitStatus(`Skipped ${field.label}`);
          return;
        }
        continue;
      }

      return;
    }
    } finally {
      if (isSelectField) this.closeSelectDropdown(field);
    }
  }

  private openSelectDropdown(field: ExtractedFormField): void {
    try {
      if (!field.element) return;
      const el = field.element;

      // ng-select is what formExtractor stores for searchable-dropdown / ng-select wrappers.
      // Click the .ng-arrow-wrapper (the visible toggle arrow) for reliability, then fall
      // back to ArrowDown on the combobox input if the click didn't expand the panel.
      if (el.matches("ng-select, .ng-select")) {
        if (isDropdownExpanded(el)) return;
        const combobox = el.querySelector<HTMLInputElement>(
          "input[role='combobox']",
        );
        combobox?.focus();
        const toggle =
          el.querySelector<HTMLElement>(".ng-arrow-wrapper") ??
          el.querySelector<HTMLElement>(".ng-select-container") ??
          el;
        for (const type of ["mousedown", "mouseup", "click"] as const) {
          toggle.dispatchEvent(
            new MouseEvent(type, { bubbles: true, cancelable: true }),
          );
        }
        if (!isDropdownExpanded(el) && combobox) {
          combobox.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "ArrowDown",
              code: "ArrowDown",
              keyCode: 40,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
        return;
      }

      // Other custom dropdown hosts (dynamic-dropdown-input, etc.)
      if (isCustomDropdownElement(el)) {
        openDropdownElement(el);
        return;
      }

      // Angular Material mat-select: walk UP to the mat-select host, click its trigger.
      const anchor = field.selectElement ?? el;
      if (anchor) {
        const matSelect = anchor.closest<HTMLElement>("mat-select");
        if (matSelect) {
          const trigger = matSelect.querySelector<HTMLElement>(
            ".mat-select-trigger, .mat-mdc-select-trigger",
          );
          (trigger ?? matSelect).click();
          return;
        }

        // ng-select found via DOM walk when field.element is a hidden input
        const ngSelect = anchor.closest<HTMLElement>("ng-select, .ng-select");
        if (ngSelect && !isDropdownExpanded(ngSelect)) {
          const toggle =
            ngSelect.querySelector<HTMLElement>(".ng-arrow-wrapper") ??
            ngSelect.querySelector<HTMLElement>(".ng-select-container") ??
            ngSelect;
          for (const type of ["mousedown", "mouseup", "click"] as const) {
            toggle.dispatchEvent(
              new MouseEvent(type, { bubbles: true, cancelable: true }),
            );
          }
          return;
        }
      }

      // Native <select>: just focus — can't force-open cross-browser
      if (field.selectElement) field.selectElement.focus();
    } catch {
      // Non-critical — proceed without opening
    }
  }

  private closeSelectDropdown(field: ExtractedFormField): void {
    try {
      // Use the existing helper for custom dropdown elements
      if (field.element && isCustomDropdownElement(field.element)) {
        closeDropdownElement(field.element);
        return;
      }

      // For Angular Material / CDK overlays, click the backdrop to dismiss
      const backdrop = document.querySelector<HTMLElement>(
        ".cdk-overlay-backdrop",
      );
      if (backdrop) {
        backdrop.click();
        return;
      }

      // Escape key as a final fallback for any remaining overlay
      const anchor = field.selectElement ?? field.element ?? document.body;
      anchor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          keyCode: 27,
          bubbles: true,
          cancelable: true,
        }),
      );
    } catch {
      // Non-critical
    }
  }

  // ─── Multi-Step Navigation (FR-STEP-*) ────────────────────────────────────

  private detectSteps(form: HTMLElement): StepInfo[] {
    const steps: StepInfo[] = [];

    const tabSteps = this.detectTabSteps(form);
    if (tabSteps.length > 1) {
      return tabSteps;
    }

    // Pattern 1: elements with [data-step], [data-tab], common step classes, or tabpanels
    const stepElements = form.querySelectorAll<HTMLElement>(
      "[data-step], [data-tab], .wizard-step, .form-step, .tab-pane, [role='tabpanel']",
    );
    if (stepElements.length > 1) {
      stepElements.forEach((el, idx) => {
        const id =
          el.getAttribute("data-step") ??
          el.getAttribute("data-tab") ??
          el.id ??
          `step-${idx}`;
        const label = this.getPanelLabel(form, el, idx);
        const fieldIds = this.fields
          .filter((f) => el.contains(f.element))
          .map((f) => f.id);
        if (fieldIds.length > 0) {
          steps.push({
            id,
            label,
            index: idx,
            fieldIds,
            panelId: el.id || undefined,
            isTab: el.getAttribute("role") === "tabpanel",
          });
        }
      });
    }

    // Pattern 2: fieldset/legend groups
    if (steps.length === 0) {
      const fieldsets = form.querySelectorAll<HTMLFieldSetElement>("fieldset");
      if (fieldsets.length > 1) {
        fieldsets.forEach((fs, idx) => {
          const legend = fs.querySelector("legend");
          const id = fs.id || `fieldset-${idx}`;
          const label = legend?.textContent?.trim() ?? `Section ${idx + 1}`;
          const fieldIds = this.fields
            .filter((f) => fs.contains(f.element))
            .map((f) => f.id);
          if (fieldIds.length > 0) {
            steps.push({ id, label, index: idx, fieldIds });
          }
        });
      }
    }

    // Pattern 3: Use groupId from extracted fields
    if (steps.length === 0) {
      const groups = new Map<string, StepInfo>();
      for (const field of this.fields) {
        if (field.groupId) {
          const existing = groups.get(field.groupId);
          if (existing) {
            existing.fieldIds.push(field.id);
          } else {
            groups.set(field.groupId, {
              id: field.groupId,
              label: field.groupLabel ?? `Section ${groups.size + 1}`,
              index: groups.size,
              fieldIds: [field.id],
            });
          }
        }
      }
      if (groups.size > 1) {
        for (const step of groups.values()) {
          steps.push(step);
        }
      }
    }

    return steps;
  }

  private detectTabSteps(form: HTMLElement): StepInfo[] {
    const steps: StepInfo[] = [];
    const tabGroups = Array.from(
      form.querySelectorAll<HTMLElement>(
        "mat-tab-group, [role='tablist'], .mat-tab-group, .mat-mdc-tab-group",
      ),
    );

    for (const group of tabGroups) {
      const tabs = Array.from(
        group.querySelectorAll<HTMLElement>("[role='tab'][aria-controls]"),
      ).filter((tab) => tab.getAttribute("aria-disabled") !== "true");
      if (tabs.length <= 1) {
        continue;
      }

      tabs.forEach((tab, idx) => {
        const panelId = tab.getAttribute("aria-controls") || undefined;
        const panel = panelId
          ? form.ownerDocument.getElementById(panelId)
          : null;
        const label =
          this.cleanStepLabel(
            tab.querySelector<HTMLElement>(
              ".mat-tab-label-content, .mdc-tab__text-label",
            )?.textContent ||
              tab.getAttribute("aria-label") ||
              tab.textContent ||
              "",
          ) || `Section ${idx + 1}`;
        const fieldIds = panel
          ? this.fields
              .filter((f) => panel.contains(f.element))
              .map((f) => f.id)
          : [];

        steps.push({
          id: panelId || tab.id || `tab-${idx}`,
          label,
          index: idx,
          fieldIds,
          tabId: tab.id || undefined,
          panelId,
          isTab: true,
        });
      });

      if (steps.length > 1) {
        break;
      }
    }

    if (steps.length > 1) {
      return steps;
    }

    const tabPanes = Array.from(
      form.querySelectorAll<HTMLElement>(
        ".tab-pane[id], [role='tabpanel'][id], [data-tab-panel][id]",
      ),
    );
    if (tabPanes.length <= 1) {
      return [];
    }

    tabPanes.forEach((panel, idx) => {
      const tab = this.findTabForPanel(form, panel.id);
      const label = tab
        ? this.getTabText(tab, idx)
        : this.getPanelLabel(form, panel, idx);
      steps.push({
        id: panel.id || `tab-panel-${idx}`,
        label,
        index: idx,
        fieldIds: this.fields
          .filter((f) => panel.contains(f.element))
          .map((f) => f.id),
        tabId: tab?.id || undefined,
        panelId: panel.id || undefined,
        isTab: true,
      });
    });

    return steps.length > 1 ? steps : [];
  }

  private getPanelLabel(
    form: HTMLElement,
    panel: HTMLElement,
    idx: number,
  ): string {
    const labelledBy = panel.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelEl = form.ownerDocument.getElementById(labelledBy);
      const label = this.cleanStepLabel(labelEl?.textContent || "");
      if (label) return label;
    }

    const tab = panel.id ? this.findTabForPanel(form, panel.id) : null;
    if (tab) {
      return this.getTabText(tab, idx);
    }

    return (
      this.cleanStepLabel(
        panel.getAttribute("data-step-label") ||
          panel.getAttribute("aria-label") ||
          panel.getAttribute("title") ||
          "",
      ) || `Section ${idx + 1}`
    );
  }

  private findTabForPanel(
    form: HTMLElement,
    panelId: string,
  ): HTMLElement | null {
    const escapedPanelId =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(panelId)
        : panelId.replace(/[\"'\\]/g, "");
    return (
      form.querySelector<HTMLElement>(
        `[role='tab'][aria-controls="${escapedPanelId}"]`,
      ) ||
      form.querySelector<HTMLElement>(
        `[data-bs-target="#${escapedPanelId}"], [data-target="#${escapedPanelId}"], [href="#${escapedPanelId}"]`,
      )
    );
  }

  private getTabText(tab: HTMLElement, idx: number): string {
    return (
      this.cleanStepLabel(
        tab.querySelector<HTMLElement>(
          ".mat-tab-label-content, .mdc-tab__text-label",
        )?.textContent ||
          tab.getAttribute("aria-label") ||
          tab.textContent ||
          "",
      ) || `Section ${idx + 1}`
    );
  }

  private cleanStepLabel(value: string | null | undefined): string {
    return (value || "")
      .replace(/\s+/g, " ")
      .replace(/<!--.*?-->/g, "")
      .trim();
  }

  private findActiveStepIndex(steps: StepInfo[]): number {
    if (!this.form || steps.length === 0) {
      return 0;
    }

    const activeTab = this.form.querySelector<HTMLElement>(
      "[role='tab'][aria-selected='true']",
    );
    const activePanelId = activeTab?.getAttribute("aria-controls");
    const activeTabId = activeTab?.id;
    const idx = steps.findIndex(
      (step) =>
        (activePanelId && step.panelId === activePanelId) ||
        (activeTabId && step.tabId === activeTabId),
    );
    return idx >= 0 ? idx : 0;
  }

  private async handleStepCompletion(): Promise<boolean> {
    if (this.currentStepIndex >= this.steps.length - 1) {
      return false; // No more steps
    }

    const currentStep = this.steps[this.currentStepIndex];
    const nextStep = this.steps[this.currentStepIndex + 1];

    const edited = await this.reviewCurrentStepBeforeAdvance(currentStep);
    if (!this.running || this.stopRequested) return false;
    if (edited) {
      return true;
    }

    // FR-STEP-003: Ask if user wants to advance
    const prompt = `You have completed ${currentStep.label}. Would you like to move to ${nextStep.label}? Say yes to continue or no to stay.`;
    const answer = await this.listenForYesNo(prompt);
    if (!this.running || this.stopRequested) return false;

    if (answer === "yes") {
      const step = nextStep;
      await this.activateStep(step);
      const activatedStep = this.steps[this.currentStepIndex] ?? step;
      this.emitStepChange(activatedStep);

      await this.speakAndEmit(`Moving to ${activatedStep.label}.`);
      return true;
    }

    await this.speakAndEmit(
      `No problem. The voice assistant will stop so you can continue manually.`,
    );
    this.stopRequested = true;
    this.hooks.onQuit?.({ confirmed: true, reason: "user-stop" });
    this.observability.onSessionEnd?.(this.sessionId, "user-stop");
    return false;
  }

  private async reviewCurrentStepBeforeAdvance(
    step: StepInfo,
  ): Promise<boolean> {
    const answer = await this.listenForYesNo(
      `You have completed ${step.label}. Would you like to edit any value in ${step.label}? Say yes to edit or no to continue.`,
    );
    if (!this.running || this.stopRequested) return false;
    if (answer !== "yes") {
      return false;
    }

    const edited = await this.collectEditInstruction(
      `Please tell me which field in ${step.label} you would like to edit and what the new value should be.`,
    );
    return edited;
  }

  private async collectEditInstruction(prompt: string): Promise<boolean> {
    await this.speakAndEmit(prompt);

    for (let attempt = 0; attempt < 3; attempt++) {
      const transcript = await this.listenOnce();
      if (!this.running || this.stopRequested) return false;

      if (!transcript) {
        await this.speakAndEmit(
          "I did not hear you. Please say the field name and new value, or say no to continue.",
        );
        continue;
      }

      const lower = transcript.toLowerCase().trim();
      if (
        lower === "no" ||
        lower === "done" ||
        lower === "finish" ||
        lower === "nahi" ||
        lower === "nope"
      ) {
        return false;
      }

      const routing = await this.routeEditMode(transcript);
      if (routing.assignments && routing.assignments.length > 0) {
        const applied = await this.applyAssignments(
          routing.assignments,
          undefined,
          transcript,
        );
        if (applied > 0) {
          const labels = routing.assignments
            .filter((a) => a.value !== undefined && !a.skip)
            .map((a) => {
              const f = this.fields.find((fld) => fld.id === a.fieldId);
              return f?.label ?? a.fieldId;
            })
            .join(", ");
          await this.speakAndEmit(`Updated ${labels}.`);
          return true;
        }
      }

      await this.speakAndEmit(
        routing.followUp ||
          "I could not apply that update. Please try again, or say no to continue.",
      );
    }

    return false;
  }

  private async activateStep(step: StepInfo): Promise<void> {
    if (!this.form) return;

    const tab = this.findStepTabElement(step);
    if (tab) {
      const isSelected = tab.getAttribute("aria-selected") === "true";
      if (!isSelected) {
        tab.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
        );
        tab.dispatchEvent(
          new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
        );
        tab.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
        tab.click();
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 700));
    await waitForCustomDropdownRender(this.form, 4000);
    this.fields = extractFormFields(this.form);
    storeExtractedFields(this.snapshotFields());
    this.steps = this.detectSteps(this.form);

    const nextIndex = this.steps.findIndex(
      (candidate) =>
        (step.panelId && candidate.panelId === step.panelId) ||
        (step.tabId && candidate.tabId === step.tabId) ||
        candidate.label === step.label ||
        candidate.index === step.index,
    );
    this.currentStepIndex = nextIndex >= 0 ? nextIndex : step.index;
    this.hooks.onFieldsExtracted?.({ fields: this.snapshotFields() });
  }

  private findStepTabElement(step: StepInfo): HTMLElement | null {
    if (!this.form) return null;
    const doc = this.form.ownerDocument;
    if (step.tabId) {
      const byId = doc.getElementById(step.tabId);
      if (byId instanceof HTMLElement) return byId;
    }
    if (step.panelId) {
      return this.findTabForPanel(this.form, step.panelId);
    }
    return (
      Array.from(this.form.querySelectorAll<HTMLElement>("[role='tab']")).find(
        (tab) => this.getTabText(tab, step.index) === step.label,
      ) ?? null
    );
  }

  private emitStepChange(step: StepInfo): void {
    this.hooks.onStepChange?.({
      stepId: step.id,
      label: step.label,
      index: step.index,
      fieldIds: step.fieldIds,
    });
  }

  // ─── Voice Commands (FR-CMD-*) ────────────────────────────────────────────

  private decideSpecialCommand(
    routedType: "reset" | "quit" | "finish",
    confidence: number,
    transcript: string,
  ): SpecialCommandDecision {
    const local = this.resolveSpecialCommandIntent(transcript);
    if (!local) {
      this.pendingSpecialCommand = null;
      return "ignore";
    }

    const normalizedRouted = routedType === "finish" ? "quit" : routedType;
    const normalizedLocal = local === "finish" ? "quit" : local;
    if (normalizedRouted !== normalizedLocal) {
      return "ignore";
    }
    if (confidence < SPECIAL_COMMAND_MIN_CONFIDENCE) {
      return "ignore";
    }

    const count = this.bumpSpecialCommand(normalizedLocal);
    if (
      count >= 2 &&
      confidence >= SPECIAL_COMMAND_MIN_CONFIDENCE
    ) {
      this.pendingSpecialCommand = null;
      return "confirm";
    }
    if (confidence >= SPECIAL_COMMAND_HIGH_CONFIDENCE) {
      return "clarify";
    }
    return "clarify";
  }

  private bumpSpecialCommand(type: "reset" | "quit"): number {
    const now = Date.now();
    const active =
      this.pendingSpecialCommand &&
      this.pendingSpecialCommand.type === type &&
      now - this.pendingSpecialCommand.lastHeardAt <=
        SPECIAL_COMMAND_REPEAT_WINDOW_MS;

    if (active && this.pendingSpecialCommand) {
      this.pendingSpecialCommand.count += 1;
      this.pendingSpecialCommand.lastHeardAt = now;
      return this.pendingSpecialCommand.count;
    }

    this.pendingSpecialCommand = { type, count: 1, lastHeardAt: now };
    return 1;
  }

  private resolveSpecialCommandIntent(
    transcript: string,
  ): SpecialCommandIntent | null {
    const normalized = this.normalizeTranscriptText(transcript).toLowerCase();
    if (!normalized) return null;

    const phrases: Array<{ type: SpecialCommandIntent; value: string }> = [
      { type: "reset", value: "reset" },
      { type: "reset", value: "restart" },
      { type: "reset", value: "start over" },
      { type: "reset", value: "clear form" },
      { type: "quit", value: "quit" },
      { type: "quit", value: "exit" },
      { type: "quit", value: "stop" },
      { type: "quit", value: "cancel" },
      { type: "quit", value: "band karo" },
      { type: "quit", value: "rok do" },
      { type: "quit", value: "chhod do" },
      { type: "finish", value: "finish" },
      { type: "finish", value: "done" },
      { type: "finish", value: "complete" },
    ];
    for (const phrase of phrases) {
      if (this.matchesApproxPhrase(normalized, phrase.value)) {
        return phrase.type;
      }
    }

    return null;
  }

  private async handleSpecialCommand(
    type: "reset" | "quit" | "finish",
  ): Promise<boolean> {
    if (type === "reset") {
      return this.handleResetCommand();
    }
    if (type === "quit" || type === "finish") {
      return this.handleQuitCommand();
    }
    return false;
  }

  private async handleResetCommand(): Promise<boolean> {
    // FR-CMD-002: Voice confirmation
    const answer = await this.listenForYesNo(
      "Are you sure you want to reset the entire form? All entered data will be cleared. Say yes to reset or no to continue.",
    );
    if (!this.running || this.stopRequested) return true;

    if (answer === "yes") {
      // FR-CMD-003: Delegate to host
      if (this.hooks.onResetRequested) {
        await Promise.resolve(this.hooks.onResetRequested());
      }
      // FR-CMD-004: Restart flow
      this.currentStepIndex = 0;
      this.manuallyFilledFields.clear();
      this.programmaticallyFilledFields.clear();
      this.skippedFields.clear();

      // Re-extract fields after reset
      if (this.form) {
        this.fields = extractFormFields(this.form);
        storeExtractedFields(this.snapshotFields());
        this.steps = this.detectSteps(this.form);
        this.currentStepIndex = this.findActiveStepIndex(this.steps);
      }

      await this.speakAndEmit(
        "Form has been reset. All fields have been cleared. Let's start from the beginning.",
      );
      this.emitStatus("Form has been reset.");
      return true;
    }

    await this.speakAndEmit("Reset cancelled. Continuing with the form.");
    return false;
  }

  private async handleQuitCommand(): Promise<boolean> {
    // FR-CMD-006: Voice confirmation
    const answer = await this.listenForYesNo(
      "Are you sure you want to quit? Say yes to stop or no to continue.",
    );
    if (!this.running || this.stopRequested) return true;

    if (answer === "yes") {
      this.hooks.onQuit?.({ confirmed: true, reason: "user-stop" });
      this.observability.onSessionEnd?.(this.sessionId, "user-stop");
      this.stopRequested = true;
      await this.speakAndEmit(
        "Voice assistant stopped. You can restart anytime.",
      );
      return true;
    }

    await this.speakAndEmit("Continuing with the form.");
    this.hooks.onQuit?.({ confirmed: false });
    return false;
  }

  // ─── Final Review / Edit Mode (FR-FLOW-009, FR-AI-019) ────────────────────

  private async finalReviewPass(): Promise<"done" | "continue"> {
    const answer = await this.listenForYesNo(
      "All visible fields are complete. Would you like to edit any value? Say yes to edit or no to finish.",
    );
    if (!this.running || this.stopRequested) return "done";

    if (answer !== "yes") {
      await this.speakAndEmit("Thank you for completing the form!");
      return "done";
    }

    // Edit loop
    await this.speakAndEmit(
      "Please tell me which field you would like to edit and what the new value should be.",
    );

    let editAttempts = 0;
    while (this.running && !this.stopRequested && editAttempts < 5) {
      const transcript = await this.listenOnce();
      if (!this.running || this.stopRequested) return "done";

      if (!transcript) {
        editAttempts++;
        if (editAttempts >= 3) {
          await this.speakAndEmit("No response. Finishing the form.");
          return "done";
        }
        await this.speakAndEmit(
          "I did not hear you. Please say the field name and new value, or say no to finish.",
        );
        continue;
      }

      // Check if user says "no" / "done" / "finish" to exit edit mode
      const lower = transcript.toLowerCase().trim();
      if (
        lower === "no" ||
        lower === "done" ||
        lower === "finish" ||
        lower === "nahi" ||
        lower === "nope"
      ) {
        await this.speakAndEmit("Thank you for completing the form!");
        return "done";
      }

      // Route in edit mode (FR-AI-019)
      const routing = await this.routeEditMode(transcript);

      if (routing.assignments && routing.assignments.length > 0) {
        const applied = await this.applyAssignments(
          routing.assignments,
          undefined,
          transcript,
        );
        if (applied > 0) {
          const labels = routing.assignments
            .filter((a) => a.value !== undefined && !a.skip)
            .map((a) => {
              const f = this.fields.find((fld) => fld.id === a.fieldId);
              return f?.label ?? a.fieldId;
            })
            .join(", ");
          await this.speakAndEmit(`Updated ${labels}.`);
        } else {
          await this.speakAndEmit(
            "I could not apply that update. Please try again.",
          );
          continue;
        }
      } else if (routing.followUp) {
        await this.speakAndEmit(routing.followUp);
        continue;
      } else {
        await this.speakAndEmit(
          "I could not map that to any field. Please try again.",
        );
        continue;
      }

      // Ask if they want to edit more
      await this.speakAndEmit(
        "Would you like to edit any other field? Say the field name and new value, or say no to finish.",
      );
      editAttempts = 0;
    }

    return "continue";
  }

  private async routeEditMode(
    userInput: string,
  ): Promise<BedrockRoutingResponse> {
    const allFields = this.fields.map((f) => this.toDescriptor(f));
    try {
      const response = await this.router.routeAnswer({
        userInput,
        pendingFields: allFields,
        completedFields: [],
        language: this.language as any,
        isEditMode: true,
      });
      return response;
    } catch (err) {
      this.hooks.onError?.({
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return { assignments: [] };
    }
  }

  // ─── Validation (FR-VAL-*) ────────────────────────────────────────────────

  private validateFieldValue(
    field: ExtractedFormField,
    value: string | string[],
  ): string | null {
    const stringValue = Array.isArray(value) ? value[0] : value;
    const constraints = field.constraints;

    // FR-VAL-001: Required
    if (constraints.required && (!stringValue || !stringValue.trim())) {
      return `${field.label} is required and cannot be skipped.`;
    }

    if (!stringValue) return null;

    const digitFieldError = this.validateDigitFormattedField(
      field,
      stringValue,
    );
    if (digitFieldError) {
      return digitFieldError;
    }

    // FR-VAL-002: Min/max length
    if (
      constraints.minLength !== undefined &&
      stringValue.length < constraints.minLength
    ) {
      return `${field.label} should be at least ${constraints.minLength} characters.`;
    }
    if (
      constraints.maxLength !== undefined &&
      stringValue.length > constraints.maxLength
    ) {
      return `${field.label} should be no more than ${constraints.maxLength} characters.`;
    }

    // FR-VAL-003: Pattern
    if (constraints.pattern) {
      try {
        const regex = new RegExp(constraints.pattern);
        if (!regex.test(stringValue)) {
          // FR-VAL-006: Exact digit count
          const digitMatch = constraints.pattern.match(/^\^?\\d\{(\d+)\}\$?$/);
          if (digitMatch) {
            return `${field.label} should be exactly ${digitMatch[1]} digits.`;
          }
          return `${field.label} does not match the expected format.`;
        }
      } catch {
        // Invalid pattern — skip validation
      }
    }

    // FR-VAL-004: Numeric range
    if (field.type === "number") {
      const numValue = Number(stringValue);
      if (isNaN(numValue)) {
        return `${field.label} must be a number.`;
      }
      if (constraints.min !== undefined && numValue < constraints.min) {
        return `${field.label} must be at least ${constraints.min}.`;
      }
      if (constraints.max !== undefined && numValue > constraints.max) {
        return `${field.label} must be at most ${constraints.max}.`;
      }
      if (constraints.step !== undefined && constraints.step > 0) {
        const base = constraints.min ?? 0;
        if ((numValue - base) % constraints.step !== 0) {
          return `${field.label} must follow increments of ${constraints.step}.`;
        }
      }
    }

    // FR-VAL-005: Type validation
    if (field.type === "email") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(stringValue)) {
        return `${field.label} must be a valid email address.`;
      }
    }
    if (field.type === "tel") {
      if (!/^[\d\s\-+()]+$/.test(stringValue)) {
        return `${field.label} must be a valid phone number.`;
      }
    }

    return null;
  }

  private getFieldValidationError(
    field: ExtractedFormField,
    value: string | string[],
  ): string | null {
    const knownError = this.validateFieldValue(field, value);

    // Read the actual error message Angular is showing the user in the UI.
    // Prefer it over the library's internal heuristics — it is more specific
    // (e.g. "Must start with 6, 7, 8, or 9" instead of "should be 10 digits").
    const domError = this.readDomValidationError(field);
    if (domError) {
      return `${field.label} is incorrect. ${domError} Please answer ${field.label} again.`;
    }

    if (knownError) {
      return knownError;
    }

    const invalidInput = field.inputElements.find((input) =>
      this.isInputInvalid(input),
    );
    if (invalidInput) {
      return this.buildInvalidValueMessage(
        field,
        invalidInput.validationMessage,
      );
    }

    if (field.textareaElement && this.isInputInvalid(field.textareaElement)) {
      return this.buildInvalidValueMessage(
        field,
        field.textareaElement.validationMessage,
      );
    }

    if (field.selectElement && this.isInputInvalid(field.selectElement)) {
      return this.buildInvalidValueMessage(
        field,
        field.selectElement.validationMessage,
      );
    }

    const host = field.element;
    if (
      host &&
      (host.classList.contains("ng-invalid") ||
        host.getAttribute("aria-invalid") === "true" ||
        Boolean(host.closest(".mat-form-field-invalid")))
    ) {
      // For digit fields: if the digit count already matches the expected
      // count, the ng-invalid is a timing artifact — Angular hasn't settled
      // after the write yet. validateFieldValue already passed, so return null
      // rather than a misleading "should only contain digits" message.
      if (this.isDigitFormattedField(field)) {
        const currentValue = this.captureFieldValue(field);
        const digits = this.normalizeNumericSpeech(
          Array.isArray(currentValue) ? currentValue.join("") : currentValue,
        );
        const expected = this.expectedDigitCountForField(field);
        if (expected !== null && digits.length === expected) {
          return null;
        }
      }
      return this.buildInvalidValueMessage(field);
    }

    return null;
  }

  /**
   * Reads the validation error text that Angular is currently displaying in the
   * DOM for this field (e.g. inside <mat-error> or similar elements).
   * Returns null if no visible error is found.
   */
  private readDomValidationError(field: ExtractedFormField): string | null {
    const host = field.element;
    if (!host) return null;

    // Walk up to the nearest mat-form-field wrapper so we search within the
    // right scope (not the whole document).
    const root: Element = host.closest("mat-form-field") ?? host;

    const candidates = root.querySelectorAll(
      "mat-error, .mat-error, .mat-mdc-form-field-error, [class*='error-message'], .invalid-feedback",
    );
    for (const el of Array.from(candidates)) {
      const text = el.textContent?.trim();
      if (text) return text;
    }

    return null;
  }

  private isInputInvalid(
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  ): boolean {
    return (
      element.getAttribute("aria-invalid") === "true" ||
      element.classList.contains("ng-invalid") ||
      (element.validity && !element.validity.valid)
    );
  }

  private fieldSignature(field: ExtractedFormField): string {
    return `${field.id} ${field.name} ${field.label}`.toLowerCase();
  }

  private isEmailLikeField(field: ExtractedFormField): boolean {
    return (
      field.type === "email" || /\be-?mail\b/.test(this.fieldSignature(field))
    );
  }

  private isDigitFormattedField(field: ExtractedFormField): boolean {
    if (field.type === "number" || field.type === "tel") return true;
    const signature = this.fieldSignature(field);
    if (
      /\b(aadhaar|aadhar|mobile|phone|telephone|contact|pin\s*code|pincode|zip|postal|account|ifsc|pan|registration|certificate|application|serial|token|otp|id|number|no)\b/.test(
        signature,
      )
    ) {
      return true;
    }
    if (
      field.constraints.pattern &&
      /\\d|\[0-9\]|\d/.test(field.constraints.pattern)
    ) {
      return true;
    }
    return false;
  }

  private expectedDigitCountForField(field: ExtractedFormField): number | null {
    const patternCount = field.constraints.pattern?.match(/\\d\{(\d+)\}/);
    if (patternCount) {
      return Number(patternCount[1]);
    }

    if (
      field.constraints.minLength &&
      field.constraints.maxLength &&
      field.constraints.minLength === field.constraints.maxLength
    ) {
      return field.constraints.minLength;
    }

    const signature = this.fieldSignature(field);
    if (/\b(aadhaar|aadhar)\b/.test(signature)) return 12;
    if (/\b(mobile|phone|telephone|contact)\b/.test(signature)) return 10;
    if (/\b(pin\s*code|pincode|zip|postal)\b/.test(signature)) return 6;
    if (/\botp\b/.test(signature)) return field.constraints.maxLength ?? null;
    return null;
  }

  private validateDigitFormattedField(
    field: ExtractedFormField,
    value: string,
  ): string | null {
    if (!this.isDigitFormattedField(field)) {
      return null;
    }

    const digits = this.normalizeNumericSpeech(value);
    const expectedDigitCount = this.expectedDigitCountForField(field);
    if (expectedDigitCount !== null && digits.length !== expectedDigitCount) {
      return `${field.label} has ${digits.length || "no"} digits, but it should be exactly ${expectedDigitCount} digits.`;
    }

    if (
      digits.length > 0 &&
      /[a-zA-Z]/.test(value) &&
      !this.isNumericSpeechPhrase(value)
    ) {
      return `${field.label} should contain only digits.`;
    }

    return null;
  }

  private buildInvalidValueMessage(
    field: ExtractedFormField,
    nativeMessage?: string,
  ): string {
    if (nativeMessage?.trim()) {
      return `${field.label} is incorrect. ${nativeMessage.trim()} Please answer ${field.label} again.`;
    }

    const currentValue = this.captureFieldValue(field);
    if (this.isDigitFormattedField(field)) {
      const digits = this.normalizeNumericSpeech(
        Array.isArray(currentValue) ? currentValue.join("") : currentValue,
      );
      const expected = this.expectedDigitCountForField(field);
      if (expected !== null && digits.length !== expected) {
        return `${field.label} has ${digits.length || "no"} digits, but it should be exactly ${expected} digits. Please answer ${field.label} again.`;
      }
      // Digit count matches but form still invalid — don't say "only digits"
      // (the digits are already there). Fall through to the generic message.
    }

    if (this.isEmailLikeField(field)) {
      return `${field.label} must be a valid email address. Please answer ${field.label} again.`;
    }

    if (field.type === "date") {
      return `${field.label} must be a valid date. Please answer ${field.label} again.`;
    }

    if (["select", "radio", "checkbox"].includes(field.type)) {
      return `${field.label} must be one of the listed options. Please answer ${field.label} again.`;
    }

    return `${field.label} did not pass the form validation. Please answer ${field.label} again.`;
  }

  private rememberAssignmentFailure(
    field: ExtractedFormField,
    message: string,
  ): void {
    if (this.lastAssignmentFailure) {
      return;
    }
    this.lastAssignmentFailure = {
      fieldId: field.id,
      label: field.label,
      message,
    };
  }

  private captureFieldValue(
    field: ExtractedFormField,
  ): string | string[] | boolean[] {
    if (field.selectElement) {
      return field.selectElement.value;
    }
    if (field.textareaElement) {
      return field.textareaElement.value;
    }
    if (field.type === "radio" || field.type === "checkbox") {
      return field.inputElements.map((input) => input.checked);
    }
    return field.inputElements[0]?.value ?? "";
  }

  private restoreFieldValue(
    field: ExtractedFormField,
    previousValue: string | string[] | boolean[],
  ): void {
    if (field.selectElement && typeof previousValue === "string") {
      nativeSet(field.selectElement, "value", previousValue);
      field.selectElement.dispatchEvent(new Event("input", { bubbles: true }));
      field.selectElement.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (field.textareaElement && typeof previousValue === "string") {
      nativeSet(field.textareaElement, "value", previousValue);
      field.textareaElement.dispatchEvent(
        new Event("input", { bubbles: true }),
      );
      field.textareaElement.dispatchEvent(
        new Event("change", { bubbles: true }),
      );
      return;
    }
    if (
      (field.type === "radio" || field.type === "checkbox") &&
      Array.isArray(previousValue)
    ) {
      field.inputElements.forEach((input, index) => {
        const checked = Boolean(previousValue[index]);
        if (input.checked !== checked) {
          nativeSet(input, "checked", checked);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      return;
    }
    const input = field.inputElements[0];
    if (input && typeof previousValue === "string") {
      nativeSet(input, "value", previousValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  // ─── Manual Entry Detection (FR-MAN-*) ────────────────────────────────────

  private setupManualInterventionDetection(): void {
    if (!this.form || typeof MutationObserver === "undefined") return;

    this.formChangeObserver = new MutationObserver((mutations) => {
      if (this.isSettingValueProgrammatically) return;
      for (const mutation of mutations) {
        if (
          mutation.type === "attributes" &&
          (mutation.attributeName === "value" ||
            mutation.attributeName === "checked")
        ) {
          const target = mutation.target as HTMLElement;
          const field = this.findFieldForElement(target);
          if (field && !this.isPendingField(field)) {
            this.manuallyFilledFields.add(field.id);
          }
        }
      }
    });

    this.formChangeObserver.observe(this.form, {
      attributes: true,
      subtree: true,
      attributeFilter: ["value", "checked"],
    });

    // Also listen for input/change events (more reliable for typed values)
    this.form.addEventListener("input", this.onManualInput);
    this.form.addEventListener("change", this.onManualInput);
  }

  private onManualInput = (event: Event): void => {
    if (this.isSettingValueProgrammatically) return;
    const target = event.target as HTMLElement;
    const field = this.findFieldForElement(target);
    if (field) {
      this.manuallyFilledFields.add(field.id);
    }
  };

  private cleanupManualInterventionDetection(): void {
    if (this.formChangeObserver) {
      this.formChangeObserver.disconnect();
      this.formChangeObserver = null;
    }
    if (this.form) {
      this.form.removeEventListener("input", this.onManualInput);
      this.form.removeEventListener("change", this.onManualInput);
    }
  }

  private findFieldForElement(
    element: HTMLElement,
  ): ExtractedFormField | undefined {
    return this.fields.find(
      (f) =>
        f.element === element ||
        f.inputElements.some((i) => i === element) ||
        f.selectElement === element ||
        f.textareaElement === element ||
        f.element.contains(element),
    );
  }

  // ─── Yes/No Listening (FR-CMD-008) ────────────────────────────────────────

  private async listenForYesNo(
    initialPrompt?: string,
  ): Promise<"yes" | "no" | "unclear"> {
    const YES_WORDS = [
      "yes",
      "yeah",
      "yep",
      "continue",
      "sure",
      "ok",
      "okay",
      "haan",
      "ha",
      "ji",
      "ji haan",
      "haa",
    ];
    const NO_WORDS = [
      "no",
      "nope",
      "nahi",
      "nahin",
      "na",
      "stop",
      "cancel",
      "mat",
    ];

    for (let attempt = 0; attempt < 3; attempt++) {
      const transcript =
        attempt === 0 && initialPrompt
          ? await this.askAndListen(initialPrompt)
          : await this.listenOnce();
      if (!this.running || this.stopRequested) return "unclear";
      if (!transcript) {
        if (attempt < 2) {
          await this.speakAndEmit("I did not hear you. Please say yes or no.");
        }
        continue;
      }

      const lower = transcript.toLowerCase().trim();
      const words = this.optionTokens(lower);
      if (this.hasApproxWord(words, YES_WORDS)) {
        return "yes";
      }
      if (this.hasApproxWord(words, NO_WORDS)) {
        return "no";
      }

      if (attempt < 2) {
        await this.speakAndEmit(
          "I did not understand. Please clearly say yes or no.",
        );
      }
    }
    return "unclear";
  }

  // ─── Field Navigation ─────────────────────────────────────────────────────

  private findNextField(): ExtractedFormField | undefined {
    if (this.steps.length === 0) {
      // No steps — find next pending visible field
      return this.fields.find(
        (f) =>
          this.isPendingField(f) &&
          this.isFieldVisible(f) &&
          !this.isFieldDisabled(f) &&
          !this.manuallyFilledFields.has(f.id),
      );
    }

    // Multi-step: find next pending field in current step
    const currentStep = this.steps[this.currentStepIndex];
    if (!currentStep) return undefined;

    return currentStep.fieldIds
      .map((id) => this.fields.find((f) => f.id === id))
      .find(
        (f): f is ExtractedFormField =>
          f !== undefined &&
          this.isPendingField(f) &&
          this.isFieldVisible(f) &&
          !this.isFieldDisabled(f) &&
          !this.manuallyFilledFields.has(f.id),
      );
  }

  private allFieldsCompleted(): boolean {
    return this.fields
      .filter((f) => this.isFieldVisible(f) && !this.isFieldDisabled(f))
      .every((f) => !this.isPendingField(f));
  }

  // ─── Prompt Building ──────────────────────────────────────────────────────

  private async buildPromptForField(field: ExtractedFormField): Promise<{
    promptText: string;
    translatedOptions: TranslatedOptionMapping[] | undefined;
  }> {
    // Build a user-friendly prompt with examples
    let basePrompt = `Please provide ${field.label}.`;

    // Add helpful examples for common fields
    if (field.type === "select" && field.options && field.options.length > 0) {
      // For select fields, give clear options
      basePrompt = `Please tell me your ${field.label}.`;
    } else if (
      field.type === "text" &&
      field.label.toLowerCase().includes("name")
    ) {
      basePrompt = `Please tell me your ${field.label}.`;
    } else if (field.type === "email") {
      basePrompt = `Please provide your ${field.label}. For example, "rahul@gmail.com".`;
    } else if (field.type === "tel") {
      basePrompt = `Please provide your ${field.label}. For example, "9876543210".`;
    } else if (field.type === "number") {
      basePrompt = `Please provide your ${field.label}. Just say the number.`;
    }

    let translatedPromptBody: string;
    try {
      translatedPromptBody = await this.translator.translatePrompt(
        basePrompt,
        this.language,
      );
    } catch (err) {
      if (err instanceof TranslationError) {
        this.hooks.onError?.({ error: err });
        translatedPromptBody = basePrompt;
      } else {
        throw err;
      }
    }

    let translatedOptions: TranslatedOptionMapping[] | undefined;
    let optionsClause = "";

    if (
      field.options &&
      field.options.length > 0 &&
      field.options.length <= 10
    ) {
      try {
        translatedOptions = await this.translator.translateOptions(
          field.options,
          this.language,
        );

        // For user-friendliness, explicitly list options with "or"
        const optionLabels = translatedOptions.map((o) => o.translatedLabel);
        if (optionLabels.length === 2) {
          optionsClause = " " + optionLabels.join(" or ") + ".";
        } else if (optionLabels.length <= 10) {
          const allButLast = optionLabels.slice(0, -1).join(", ");
          const last = optionLabels[optionLabels.length - 1];
          optionsClause = " " + allButLast + ", or " + last + ".";
        } else {
          // Too many options, just say "Options include"
          const optionsWord = await this.translator.translatePrompt(
            "Options include:",
            this.language,
          );
          optionsClause =
            " " +
            optionsWord +
            " " +
            translatedOptions
              .slice(0, 5)
              .map((o) => o.translatedLabel)
              .join(", ") +
            "...";
        }
      } catch (err) {
        if (err instanceof TranslationError) {
          // Translation failed but we can still proceed with the original
          // English labels — don't surface this as a user-facing error.
          if (this.debugLogs) {
            console.warn(
              `[V2VoiceFormService] Option translation failed for "${field.label}", using original labels:`,
              err.message,
            );
          }
          const optionLabels = field.options.map((o) => o.label);
          if (optionLabels.length === 2) {
            optionsClause = " " + optionLabels.join(" or ") + ".";
          } else {
            optionsClause =
              " Options: " +
              optionLabels.slice(0, 5).join(", ") +
              (optionLabels.length > 5 ? "..." : ".");
          }
        } else {
          throw err;
        }
      }
    }

    this.hooks.onTranslation?.({
      prompt: {
        fieldId: field.id,
        originalLabel: field.label,
        translatedLabel: translatedPromptBody,
        language: this.language,
      },
      options: translatedOptions,
    });

    // Append skip hint at the very end (after options) for optional fields only.
    // Check both the extracted constraint AND Angular/HTML DOM markers because
    // reactive-form validators don't always reflect as aria-required attributes.
    let skipSuffix = "";
    if (this.isFieldOptional(field)) {
      const skipHint = "Say skip if you want to skip this field.";
      try {
        skipSuffix = " " + await this.translator.translatePrompt(skipHint, this.language);
      } catch {
        skipSuffix = " " + skipHint;
      }
    }

    return {
      promptText: `${translatedPromptBody}${optionsClause}${skipSuffix}`,
      translatedOptions,
    };
  }

  /**
   * Returns true only when the field is genuinely optional.
   * Checks the extracted constraint first, then falls back to DOM markers so
   * Angular reactive-form required validators (which don't always set
   * aria-required) are also detected.
   */
  private isFieldOptional(field: ExtractedFormField): boolean {
    // Explicit required flag from form extraction
    if (field.constraints?.required) return false;

    const anchor = field.selectElement ?? field.element;
    if (anchor) {
      // Angular Material mat-select adds aria-required="true" on the host
      const matSelect = anchor.closest("mat-select");
      if (matSelect?.getAttribute("aria-required") === "true") return false;

      // Angular Material mat-form-field adds .mat-form-field-required-marker span
      const matField = anchor.closest("mat-form-field, .mat-form-field");
      if (matField?.querySelector(".mat-form-field-required-marker, [aria-required='true']")) {
        return false;
      }

      // Generic aria-required on any ancestor
      if (anchor.closest("[aria-required='true']")) return false;

      // Angular ng-reflect-required on wrapper components (e.g. searchable-dropdown).
      // formExtractor resolves field.element to ng-select INSIDE the wrapper, so the
      // ng-reflect-required attribute sits on the parent and must be found by walking up.
      if (anchor.closest("[ng-reflect-required='true']")) return false;

      // Asterisk marker span in the label inside the surrounding host component.
      // This form uses <span class="asterisk-symbol">*</span> inside dynamic-dropdown-input.
      const dropdownHost = anchor.closest(
        "dynamic-dropdown-input, dynamic-field-builder, searchable-dropdown",
      );
      if (dropdownHost?.querySelector(".asterisk-symbol, [class*='asterisk']")) return false;
    }

    return true;
  }

  // ─── Listening ────────────────────────────────────────────────────────────

  private setListeningState(state: ListeningState): void {
    this.listeningState = state;

    let uiState:
      | "idle"
      | "ignored"
      | "warming-up"
      | "listening"
      | "processing" = "idle";
    let message = "Idle";

    if (state === ListeningState.SPEAKING) {
      uiState = this.questionSpeechActive ? "warming-up" : "ignored";
      message = "Speaking";
    } else if (state === ListeningState.LISTENING_FOR_ANSWER) {
      uiState = "listening";
      message = "Listening";
    } else if (state === ListeningState.PROCESSING) {
      uiState = "processing";
      message = "Processing";
    }

    this.hooks.onSpeechRecognitionStateChange?.({
      state: uiState,
      acceptsSpeech: uiState === "listening",
      fieldId: this.currentQuestionFieldId,
      message,
    });
  }

  private finalizeCurrentTranscript(): void {
    this.clearListeningStopTimers();
    this.commitCurrentTranscriptSegment();
    const transcript = this.continuousTranscript.trim();
    if (transcript) {
      this.hooks.onTranscript?.({
        text: transcript,
        isFinal: true,
      });
    } else if (this.debugLogs) {
      console.log("[V2VoiceFormService] No transcript to finalize (empty)");
    }

    if (!this.pendingListenResolve) {
      this.clearTranscriptDisplay();
      return;
    }
    const resolve = this.pendingListenResolve;
    this.pendingListenResolve = null;
    this.setListeningState(ListeningState.PROCESSING);
    void this.stopContinuousListening(true);
    this.clearTranscriptDisplay();
    resolve(transcript);
  }

  private async askAndListen(
    promptText: string,
    fieldId?: string,
    onBeforeListen?: () => void,
  ): Promise<string> {
    this.currentQuestionFieldId = fieldId;
    this.resetTranscriptBuffer();
    const ttsPromptText = formatTextForTts(promptText);

    this.hooks.onPrompt?.({ text: promptText, fieldId });
    this.hooks.onSpeechSynthesis?.({ text: ttsPromptText });

    this.questionSpeechActive = true;
    this.setListeningState(ListeningState.SPEAKING);

    let warmupTimer: ReturnType<typeof setTimeout> | null = null;
    const startWarmupTimer = () => {
      if (warmupTimer || this.stopRequested) return;
      void this.startContinuousListening().catch((listenErr) => {
        this.continuousListeningStartFailed = true;
        this.hooks.onError?.({
          error:
            listenErr instanceof Error
              ? listenErr
              : new Error(String(listenErr)),
        });
      });
      warmupTimer = setTimeout(() => {
        if (
          !this.stopRequested &&
          this.currentQuestionFieldId === fieldId &&
          this.listeningState === ListeningState.SPEAKING
        ) {
          this.resetTranscriptBuffer();
          this.clearTranscriptDisplay();
          onBeforeListen?.();
          this.setListeningState(ListeningState.LISTENING_FOR_ANSWER);
        }
      }, QUESTION_LISTEN_WARMUP_MS);
    };

    const speechPromise = this.speech
      .speak(ttsPromptText, {
        onAudioStart: startWarmupTimer,
      })
      .catch((err) => {
        if (this.interruptingQuestionSpeech) return;
        this.hooks.onError?.({
          error: err instanceof Error ? err : new Error(String(err)),
        });
        if (
          !this.stopRequested &&
          this.currentQuestionFieldId === fieldId &&
          this.listeningState === ListeningState.SPEAKING
        ) {
          void this.startContinuousListening().catch((listenErr) => {
            this.continuousListeningStartFailed = true;
            this.hooks.onError?.({
              error:
                listenErr instanceof Error
                  ? listenErr
                  : new Error(String(listenErr)),
            });
          });
          this.resetTranscriptBuffer();
          this.clearTranscriptDisplay();
          onBeforeListen?.();
          this.setListeningState(ListeningState.LISTENING_FOR_ANSWER);
        }
      })
      .finally(() => {
        this.questionSpeechActive = false;
        this.interruptingQuestionSpeech = false;
      });

    try {
      const transcript = await this.listenOnce({
        resetTranscript: false,
        activateListening: false,
      });
      this.interruptingQuestionSpeech = true;
      this.speech.stopSpeaking();
      return transcript;
    } finally {
      if (warmupTimer) {
        clearTimeout(warmupTimer);
      }
      this.questionSpeechActive = false;
      this.currentQuestionFieldId = undefined;
      void speechPromise;
    }
  }

  /**
   * Start continuous listening - mic remains open throughout the session.
   * Speech is only processed when listeningState === LISTENING_FOR_ANSWER.
   */
  private async startContinuousListening(): Promise<void> {
    if (this.continuousListeningActive) return;

    if (this.listeningState === ListeningState.IDLE) {
      this.setListeningState(ListeningState.IDLE);
    }
    this.userSpeakingActive = false; // reset in case a previous session ended mid-speech
    this.resetTranscriptBuffer();

    if (this.debugLogs) {
      console.log("[V2VoiceFormService] Starting continuous listening...");
    }

    const handlers = {
      onPartial: (text: string) => {
        // Only process when actively asking for input
        if (this.listeningState !== ListeningState.LISTENING_FOR_ANSWER) {
          return;
        }
        if (text) {
          const trimmedText = this.receiveTranscriptText(text);
          if (trimmedText) {
            if (this.debugLogs) {
              console.log(
                `[V2VoiceFormService] Updated transcript from partial: "${this.continuousTranscript}"`,
              );
            }
          }
          // Emit partial transcript for live display
          this.hooks.onTranscript?.({
            text: this.continuousTranscript || trimmedText,
            isFinal: false,
          });
        }
      },
      onFinal: (text: string) => {
        // Only process when actively asking for input
        if (this.listeningState !== ListeningState.LISTENING_FOR_ANSWER) {
          if (this.debugLogs) {
            console.log(
              `[V2VoiceFormService] Ignoring speech in state: ${this.listeningState}`,
            );
          }
          return;
        }

        if (!text) return;

        const before = this.continuousTranscript;
        const trimmedText = this.receiveTranscriptText(text);

        if (trimmedText) {
          if (this.debugLogs) {
            if (before !== this.continuousTranscript) {
              console.log(
                `[V2VoiceFormService] Accumulated transcript: "${this.continuousTranscript}"`,
              );
            } else {
              console.log(
                `[V2VoiceFormService] Skipping duplicate transcript: "${trimmedText}"`,
              );
            }
          }

          // Show accumulated transcript
          this.hooks.onTranscript?.({
            text: this.continuousTranscript,
            isFinal: false,
          });
        }
      },
      onSpeechStart: () => {
        this.userSpeakingActive = true;
        // Clear any pending speech end timer ONLY if we're early in the detection
        // Don't clear if we're close to finalizing (within last 500ms), as this
        // prevents spurious background noise from interrupting finalization
        if (this.continuousSpeechEndTimer) {
          if (this.debugLogs) {
            console.log(
              "[V2VoiceFormService] Speech detected again, clearing previous speech end timer",
            );
          }
          this.prepareForResumedSpeech();
        }

        // Only show indicator when listening for answer
        if (this.listeningState === ListeningState.LISTENING_FOR_ANSWER) {
          if (this.questionSpeechActive) {
            this.questionSpeechActive = false;
            this.interruptingQuestionSpeech = true;
            this.speech.stopSpeaking();
          }
          const display = this.continuousTranscript
            ? `${this.continuousTranscript} ...`
            : "...";
          this.hooks.onTranscript?.({ text: display, isFinal: false });
        }
      },
      onSpeechEnd: () => {
        this.userSpeakingActive = false;
        // Only process speech end when listening for answer
        if (this.listeningState !== ListeningState.LISTENING_FOR_ANSWER) {
          if (this.debugLogs) {
            console.log(
              `[V2VoiceFormService] Ignoring speech end in state: ${this.listeningState}`,
            );
          }
          return;
        }

        if (this.debugLogs) {
          console.log(
            "[V2VoiceFormService] Speech end detected, starting finalization timer",
          );
        }

        this.scheduleTranscriptFinalization();
      },
      onError: (err: Error) => {
        this.hooks.onError?.({ error: err });
      },
      shouldSendAudio: () =>
        this.listeningState === ListeningState.LISTENING_FOR_ANSWER,
    };

    try {
      await this.speech.startListening(handlers);
    } catch (err) {
      await this.speech.stopListening().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await this.speech.startListening(handlers);
    }

    this.continuousListeningActive = true;

    if (this.debugLogs) {
      console.log("[V2VoiceFormService] Continuous listening started");
    }
  }

  private async stopContinuousListening(preserveState = false): Promise<void> {
    this.continuousListeningActive = false;
    if (!preserveState) {
      this.setListeningState(ListeningState.IDLE);
    }

    this.clearListeningStopTimers();

    await this.speech.stopListening();

    if (this.debugLogs) {
      console.log("[V2VoiceFormService] Continuous listening stopped");
    }
  }

  /**
   * Listen for the next complete user utterance.
   * Now works with continuous listening - just waits for the user to finish speaking.
   */
  private async listenOnce(
    opts: { resetTranscript?: boolean; activateListening?: boolean } = {},
  ): Promise<string> {
    const { resetTranscript = true, activateListening = true } = opts;
    this.continuousListeningStartFailed = false;
    if (resetTranscript) {
      this.resetTranscriptBuffer();
    }

    if (activateListening) {
      await this.startContinuousListening();
      this.resetTranscriptBuffer();
      this.clearTranscriptDisplay();
      this.setListeningState(ListeningState.LISTENING_FOR_ANSWER);
    }

    if (this.debugLogs) {
      console.log("[V2VoiceFormService] Listening for user response...");
    }

    const transcriptGuardField = this.findTranscriptGuardField();
    this.startTranscriptGuard(transcriptGuardField);

    // Wait for speech to be finalized (indicated by onFinal being called after silence)
    return new Promise<string>((resolve) => {
      // Latches true once listening has actually come online during this
      // turn. Already true here for activateListening:true callers, since
      // startContinuousListening() was awaited synchronously above. For the
      // askAndListen() warmup path (activateListening:false), this starts
      // false and only flips once the fire-and-forget startContinuousListening()
      // chain really finishes — without this latch, "not listening yet
      // because still warming up" was indistinguishable from "was listening,
      // then stopped", which is the root cause of the cold-start race where
      // this would resolve empty before the mic pipeline ever captured audio.
      let hasBeenActive = this.continuousListeningActive;

      const maxListenTimer = setTimeout(() => {
        clearInterval(checkInterval);
        this.clearListeningStopTimers();
        this.pendingListenResolve = null;
        this.commitCurrentTranscriptSegment();
        this.setListeningState(ListeningState.PROCESSING);
        void this.stopContinuousListening(true);
        this.clearTranscriptDisplay();
        resolve(this.continuousTranscript.trim());
      }, MAX_LISTEN_MS);

      // Check periodically if we have a complete response
      const checkInterval = setInterval(() => {
        if (this.continuousListeningActive) {
          hasBeenActive = true;
        }
        const listeningStoppedAfterBeingActive =
          hasBeenActive &&
          !this.continuousListeningActive &&
          this.listeningState !== ListeningState.SPEAKING;

        if (
          this.stopRequested ||
          this.continuousListeningStartFailed ||
          listeningStoppedAfterBeingActive
        ) {
          clearInterval(checkInterval);
          clearTimeout(maxListenTimer);
          this.clearListeningStopTimers();
          this.pendingListenResolve = null;
          this.commitCurrentTranscriptSegment();
          this.setListeningState(ListeningState.PROCESSING);
          void this.stopContinuousListening(true);
          this.clearTranscriptDisplay();
          resolve(this.continuousTranscript.trim());
        }
      }, 100);

      this.pendingListenResolve = (text) => {
        clearInterval(checkInterval);
        clearTimeout(maxListenTimer);
        this.clearListeningStopTimers();
        resolve(text);
      };
    });
  }

  private clearListeningStopTimers(): void {
    if (this.continuousSpeechEndTimer) {
      clearTimeout(this.continuousSpeechEndTimer);
      this.continuousSpeechEndTimer = null;
    }
    this.clearTranscriptGuardTimer();
  }

  private resolveIncrementalRoutingConfig(
    config: V2VoiceFormInitOptions["incrementalRouting"],
  ): IncrementalRoutingSettings {
    const defaults: IncrementalRoutingSettings = {
      enabled: true,
      minIntervalMs: 700,
      minNewWords: 2,
      minConfidence: 0.8,
    };
    if (config === false) return { ...defaults, enabled: false };
    if (typeof config !== "object" || !config) return defaults;
    return {
      enabled: config.enabled ?? true,
      minIntervalMs: Math.max(250, config.minIntervalMs ?? defaults.minIntervalMs),
      minNewWords: Math.max(1, config.minNewWords ?? defaults.minNewWords),
      minConfidence: config.minConfidence ?? defaults.minConfidence,
    };
  }

  private resetIncrementalRouting(): void {
    this.incrementalApplied.clear();
    this.incrementalRouteInFlight = false;
    this.lastIncrementalRouteAt = 0;
    this.incrementalRoutedWords = 0;
  }

  private countWords(text: string): number {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  /**
   * Routes the answer-so-far and fills whatever is already unambiguous, without
   * ending the turn.
   *
   * "My community is OBC, income two lakh, district Sonipat" used to leave the
   * form untouched until the last word, then fill three fields at once. Routing
   * each clause as the next one is spoken makes the form keep pace with the
   * speaker, which is the difference between the assistant feeling like it is
   * listening and feeling like it is transcribing.
   *
   * Only assignments are applied. Skips and special commands are deliberately
   * left to the turn-end pass: "no" is an answer in the middle of a sentence and
   * a command at the end of one, and acting on the wrong reading mid-flow would
   * discard the rest of what the user is saying.
   */
  private async maybeRouteIncrementally(): Promise<void> {
    if (!this.incrementalRouting.enabled) return;
    if (this.incrementalRouteInFlight) return;
    if (!this.pendingListenResolve) return;
    if (this.listeningState !== ListeningState.LISTENING_FOR_ANSWER) return;

    const transcript = this.normalizeTranscriptText(this.continuousTranscript);
    if (!transcript) return;

    const words = this.countWords(transcript);
    if (words - this.incrementalRoutedWords < this.incrementalRouting.minNewWords) {
      return;
    }
    if (
      this.lastIncrementalRouteAt > 0 &&
      Date.now() - this.lastIncrementalRouteAt < this.incrementalRouting.minIntervalMs
    ) {
      return;
    }

    const field = this.findTranscriptGuardField();
    if (!field) return;

    this.incrementalRouteInFlight = true;
    this.lastIncrementalRouteAt = Date.now();
    this.incrementalRoutedWords = words;
    try {
      // The local matchers cost nothing and cover most dropdown answers, so the
      // common case fills with no network round-trip at all.
      const routing =
        this.tryLocalCrossFieldRoute(field, transcript) ??
        this.tryLocalOptionRoute(field, transcript) ??
        (await this.router.routeAnswer(
          this.buildRoutingRequest(field, transcript),
        ));

      // The turn may have ended while the router was thinking.
      if (
        !this.pendingListenResolve ||
        this.listeningState !== ListeningState.LISTENING_FOR_ANSWER
      ) {
        return;
      }

      const fresh = (routing.assignments ?? []).filter((assignment) => {
        if (assignment.skip) return false;
        if ((assignment.confidence ?? 0) < this.incrementalRouting.minConfidence) {
          return false;
        }
        const value = Array.isArray(assignment.value)
          ? assignment.value.join(",")
          : String(assignment.value ?? "");
        return this.incrementalApplied.get(assignment.fieldId) !== value;
      });
      if (fresh.length === 0) return;

      const applied = await this.applyAssignments(fresh, undefined, transcript);
      for (const assignment of fresh) {
        const value = Array.isArray(assignment.value)
          ? assignment.value.join(",")
          : String(assignment.value ?? "");
        this.incrementalApplied.set(assignment.fieldId, value);
      }
      if (this.debugLogs && applied > 0) {
        console.log(
          `[V2VoiceFormService] Filled ${applied} field(s) mid-answer from "${transcript}"`,
        );
      }
    } catch (err) {
      // A failed mid-answer route is not worth surfacing: the turn-end pass runs
      // over the same transcript and will report anything that truly failed.
      if (this.debugLogs) {
        console.warn("[V2VoiceFormService] Incremental routing failed:", err);
      }
    } finally {
      this.incrementalRouteInFlight = false;
    }
  }

  private clearTranscriptGuardTimer(): void {
    if (this.transcriptGuardTimer) {
      clearInterval(this.transcriptGuardTimer);
      this.transcriptGuardTimer = null;
    }
    this.transcriptGuardCheckInFlight = false;
    this.transcriptGuardLastCheckpoint = "";
    this.transcriptGuardLastChangeAt = 0;
  }

  private startTranscriptGuard(currentField: ExtractedFormField | undefined): void {
    this.clearTranscriptGuardTimer();
    if (!this.transcriptGuard.enabled) return;

    this.transcriptGuardTimer = setInterval(() => {
      void this.runTranscriptGuardCheck(currentField);
    }, this.transcriptGuard.intervalMs);
  }

  private async runTranscriptGuardCheck(
    currentField: ExtractedFormField | undefined,
  ): Promise<void> {
    if (
      this.transcriptGuardCheckInFlight ||
      !this.pendingListenResolve ||
      this.listeningState !== ListeningState.LISTENING_FOR_ANSWER
    ) {
      return;
    }

    // Don't judge an answer that is still arriving. This guard exists to rescue
    // STALLED turns, and a transcript that grew a moment ago has not stalled.
    // Judging it mid-flow truncates the longest answers: someone listing several
    // details in one breath is asked "is this relevant to Community?" after the
    // first clause, and the details that would have made it relevant have not
    // been spoken yet.
    if (
      this.transcriptGuardLastChangeAt > 0 &&
      Date.now() - this.transcriptGuardLastChangeAt < TRANSCRIPT_SETTLE_MS
    ) {
      return;
    }

    const transcript = this.normalizeTranscriptText(this.continuousTranscript);
    const normalizedTranscript = this.normalizeForTranscriptComparison(transcript);
    if (!normalizedTranscript) return;

    if (
      this.transcriptGuardLastCheckpoint &&
      normalizedTranscript === this.transcriptGuardLastCheckpoint
    ) {
      if (this.debugLogs) {
        console.log(
          `[V2VoiceFormService] Transcript guard finalizing unchanged transcript: "${transcript}"`,
        );
      }
      this.finalizeCurrentTranscript();
      return;
    }

    this.transcriptGuardLastCheckpoint = normalizedTranscript;

    if (!currentField) {
      return;
    }

    this.transcriptGuardCheckInFlight = true;
    try {
      const relevant = await this.isTranscriptGuardRelevant(
        currentField,
        transcript,
      );
      if (
        !this.pendingListenResolve ||
        this.listeningState !== ListeningState.LISTENING_FOR_ANSWER
      ) {
        return;
      }

      const latestTranscript = this.normalizeForTranscriptComparison(
        this.continuousTranscript,
      );
      if (latestTranscript !== normalizedTranscript) {
        return;
      }

      if (!relevant) {
        if (this.debugLogs) {
          console.log(
            `[V2VoiceFormService] Transcript guard finalizing irrelevant transcript: "${transcript}"`,
          );
        }
        this.finalizeCurrentTranscript();
      }
    } finally {
      this.transcriptGuardCheckInFlight = false;
    }
  }

  // Old listenOnce method replaced above
  private resetTranscriptBuffer(): void {
    this.continuousTranscript = "";
    this.lastSeenTranscript = "";
    this.transcriptSegments = [];
    this.currentTranscriptSegment = "";
    this.resetIncrementalRouting();
  }

  private clearTranscriptDisplay(): void {
    this.hooks.onTranscript?.({ text: "", isFinal: false });
  }

  private receiveTranscriptText(text: string): string {
    const trimmedText = this.normalizeTranscriptText(text);
    if (!trimmedText) return "";

    const wasWaitingToFinalize = Boolean(this.continuousSpeechEndTimer);
    if (
      wasWaitingToFinalize &&
      this.isNewStandaloneTranscriptSegment(trimmedText)
    ) {
      this.commitCurrentTranscriptSegment();
    }

    const before = this.continuousTranscript;
    this.updateCurrentTranscriptSegment(trimmedText);
    if (this.continuousTranscript !== before) {
      this.transcriptGuardLastChangeAt = Date.now();
      // Fill what is already unambiguous, while the user carries on speaking.
      void this.maybeRouteIncrementally();
    }
    // For client-side VAD providers (Bhashini): only extend the finalization
    // timer when the user is NOT actively speaking. While speaking, the VAD
    // onSpeechEnd signal is the correct trigger — driving the timer from every
    // partial would cause premature processing between Bhashini server responses.
    // For server-side VAD providers (Sarvam): transcripts always arrive after
    // the server fires speech_end, so userSpeakingActive is already false and
    // we schedule finalization the same way as before.
    if (!this.speech.usesClientVAD || !this.userSpeakingActive) {
      this.scheduleTranscriptFinalization();
    }
    return trimmedText;
  }

  private prepareForResumedSpeech(): void {
    if (!this.continuousSpeechEndTimer) return;

    clearTimeout(this.continuousSpeechEndTimer);
    this.continuousSpeechEndTimer = null;

    // For Sarvam (server VAD): a brief pause followed by resumed speech is a
    // natural segment boundary — commit so the next utterance starts fresh.
    //
    // For Bhashini (client VAD): the transcript is cumulative across pauses.
    // Committing here would cause the next Bhashini response (which repeats
    // all previous text plus new words) to appear as a duplicate segment.
    // Just clear the timer; the REPLACE logic in updateCurrentTranscriptSegment
    // will handle extensions and revisions correctly.
    if (!this.speech.usesClientVAD) {
      this.commitCurrentTranscriptSegment();
    }
  }

  private scheduleTranscriptFinalization(): void {
    if (this.continuousSpeechEndTimer) {
      clearTimeout(this.continuousSpeechEndTimer);
    }

    this.continuousSpeechEndTimer = setTimeout(() => {
      this.continuousSpeechEndTimer = null;
      if (this.debugLogs) {
        console.log(
          `[V2VoiceFormService] Finalizing transcript: "${this.continuousTranscript}"`,
        );
      }
      this.finalizeCurrentTranscript();
    }, SPEECH_END_DEBOUNCE_MS);
  }

  private normalizeTranscriptText(text: string): string {
    return this.collapseRepeatedNumericSpeech(text).replace(/\s+/g, " ").trim();
  }

  private buildTranscriptFromSegments(): string {
    return [...this.transcriptSegments, this.currentTranscriptSegment]
      .map((segment) => this.normalizeTranscriptText(segment))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private updateCurrentTranscriptSegment(text: string): void {
    const trimmedText = this.normalizeTranscriptText(text);
    if (!trimmedText) return;

    const current = this.currentTranscriptSegment;
    const lastSegmentIndex = this.transcriptSegments.length - 1;
    const lastCommittedSegment =
      lastSegmentIndex >= 0 ? this.transcriptSegments[lastSegmentIndex] : "";
    if (
      !current &&
      lastCommittedSegment &&
      this.isCumulativeText(lastCommittedSegment, trimmedText)
    ) {
      this.transcriptSegments[lastSegmentIndex] = trimmedText;
      this.lastSeenTranscript = trimmedText;
      this.continuousTranscript = this.buildTranscriptFromSegments();
      return;
    }

    const alreadyCommitted = this.transcriptSegments.some(
      (existing) =>
        this.normalizeForTranscriptComparison(existing) ===
        this.normalizeForTranscriptComparison(trimmedText),
    );
    const isDuplicate =
      alreadyCommitted ||
      trimmedText.toLowerCase() === this.lastSeenTranscript.toLowerCase() ||
      trimmedText.toLowerCase() === current.toLowerCase();

    if (!isDuplicate) {
      if (!current || this.isCumulativeText(current, trimmedText)) {
        // Cumulative update: each chunk supersedes the previous — replace.
        this.currentTranscriptSegment = trimmedText;
      } else if (this.speech.usesClientVAD) {
        // Bhashini sends FULL cumulative transcripts (not just new words). Each
        // response may REVISE earlier words rather than only extending. Detect
        // this by counting normalized common prefix words:
        //   • long shared prefix → same utterance, word(s) revised → REPLACE
        //   • short / no shared prefix → genuinely new content after a VAD
        //     break → APPEND (with seam overlap removal)
        const sharedPrefix = this.countNormalizedCommonPrefixWords(
          current,
          trimmedText,
        );
        const currentWordCount = current
          .trim()
          .split(/\s+/)
          .filter(Boolean).length;
        if (sharedPrefix >= Math.min(3, Math.ceil(currentWordCount / 2))) {
          this.currentTranscriptSegment = trimmedText;
        } else {
          this.currentTranscriptSegment = this.appendTranscriptWords(
            current,
            trimmedText,
          );
        }
      } else if (trimmedText.length > current.length) {
        // Sarvam (server VAD): original behaviour — replace only when longer.
        this.currentTranscriptSegment = trimmedText;
      }
    }

    this.lastSeenTranscript = trimmedText;
    this.continuousTranscript = this.buildTranscriptFromSegments();
  }

  // Appends `incoming` to `current`, removing any word-level overlap at the
  // seam. Used for Bhashini-style incremental updates where the ASR's rolling
  // window may repeat a few context words at the start of each new chunk.
  private appendTranscriptWords(current: string, incoming: string): string {
    if (!current) return incoming;
    const currentWords = current.trim().split(/\s+/);
    const incomingWords = incoming.trim().split(/\s+/);
    const maxOverlap = Math.min(currentWords.length, incomingWords.length);
    for (let size = maxOverlap; size >= 1; size--) {
      const tail = this.normalizeForTranscriptComparison(
        currentWords.slice(-size).join(" "),
      );
      const head = this.normalizeForTranscriptComparison(
        incomingWords.slice(0, size).join(" "),
      );
      if (tail && tail === head) {
        const newWords = incomingWords.slice(size);
        return newWords.length > 0
          ? `${current} ${newWords.join(" ")}`.trim()
          : current;
      }
    }
    return `${current} ${incoming}`.trim();
  }

  private countNormalizedCommonPrefixWords(a: string, b: string): number {
    const normWord = (w: string) =>
      w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const aWords = a.trim().split(/\s+/).map(normWord).filter(Boolean);
    const bWords = b.trim().split(/\s+/).map(normWord).filter(Boolean);
    let count = 0;
    while (
      count < aWords.length &&
      count < bWords.length &&
      aWords[count] === bWords[count]
    ) {
      count++;
    }
    return count;
  }

  private isNewStandaloneTranscriptSegment(incoming: string): boolean {
    const current = this.normalizeTranscriptText(this.currentTranscriptSegment);
    if (!current) return false;

    const normalizedIncoming = this.normalizeForTranscriptComparison(incoming);
    const normalizedCurrent = this.normalizeForTranscriptComparison(current);
    const normalizedLastSeen = this.normalizeForTranscriptComparison(
      this.lastSeenTranscript,
    );

    if (
      normalizedIncoming === normalizedCurrent ||
      normalizedIncoming === normalizedLastSeen
    ) {
      return false;
    }

    if (this.isCumulativeText(current, incoming)) {
      return false;
    }

    // Bhashini sends full cumulative transcripts that may REVISE a word near
    // the end (e.g. email address refined as more audio arrives). A long shared
    // prefix means the incoming is a revised version of the current segment,
    // not a genuinely new utterance. Committing in this case would cause the
    // old and new versions to both appear in continuousTranscript.
    if (this.speech.usesClientVAD) {
      const sharedPrefix = this.countNormalizedCommonPrefixWords(
        this.currentTranscriptSegment,
        incoming,
      );
      if (sharedPrefix >= 3) {
        return false;
      }
    }

    return !this.transcriptSegments.some(
      (existing) =>
        this.normalizeForTranscriptComparison(existing) === normalizedIncoming,
    );
  }

  private commitCurrentTranscriptSegment(): void {
    const segment = this.normalizeTranscriptText(this.currentTranscriptSegment);
    if (!segment) return;

    const normalizedSegment = this.normalizeForTranscriptComparison(segment);
    const alreadyCommitted = this.transcriptSegments.some(
      (existing) =>
        this.normalizeForTranscriptComparison(existing) === normalizedSegment,
    );

    if (!alreadyCommitted) {
      this.transcriptSegments.push(segment);
    }

    this.currentTranscriptSegment = "";
    this.lastSeenTranscript = "";
    this.continuousTranscript = this.buildTranscriptFromSegments();
  }

  private normalizeForTranscriptComparison(text: string): string {
    return this.normalizeTranscriptText(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  private collapseRepeatedNumericSpeech(text: string): string {
    const compact = text.replace(/\s+/g, " ").trim();
    if (!compact) return compact;

    const words = compact.split(" ");
    for (let size = Math.floor(words.length / 2); size >= 2; size--) {
      const first = words.slice(0, size).join(" ");
      const second = words.slice(size, size * 2).join(" ");
      if (
        words.length === size * 2 &&
        this.isNumericSpeechPhrase(first) &&
        this.normalizeNumericSpeech(first) ===
          this.normalizeNumericSpeech(second)
      ) {
        return first;
      }
    }

    return compact.replace(/\b(\d{4,})\b(?:[\s,.-]+\1\b)+/g, "$1");
  }

  private isNumericSpeechPhrase(text: string): boolean {
    const tokens = this.numericSpeechTokens(text);
    if (tokens.length === 0) return false;
    const normalized = this.normalizeNumericSpeech(text);
    return (
      normalized.length > 0 &&
      /^\d+$/.test(normalized) &&
      tokens.every(
        (token) =>
          this.repeatCountForNumericToken(token) !== null ||
          Boolean(this.numericTokenToDigits(token)),
      )
    );
  }

  private normalizeNumericSpeech(text: string): string {
    const tokens = this.numericSpeechTokens(text);
    const digits: string[] = [];

    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      const repeatCount = this.repeatCountForNumericToken(token);
      const nextDigits =
        index + 1 < tokens.length
          ? this.numericTokenToDigits(tokens[index + 1])
          : "";

      if (repeatCount !== null && nextDigits.length === 1) {
        digits.push(nextDigits.repeat(repeatCount));
        index++;
        continue;
      }

      const tokenDigits = this.numericTokenToDigits(token);
      if (tokenDigits) {
        digits.push(tokenDigits);
      }
    }

    return digits.join("");
  }

  private numericSpeechTokens(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[०-९]/g, (digit) => String("०१२३४५६७८९".indexOf(digit)))
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  private numericTokenToDigits(token: string): string {
    const normalized = this.normalizeNumberWordToken(token);
    return /^\d+$/.test(normalized) ? normalized : "";
  }

  private repeatCountForNumericToken(token: string): number | null {
    const repeatWords: Record<string, number> = {
      double: 2,
      twice: 2,
      triple: 3,
      treble: 3,
      quadruple: 4,
      चारबार: 4,
    };
    return repeatWords[token.toLowerCase()] ?? null;
  }

  /**
   * Detect if `incoming` is a cumulative transcript that already contains
   * `current`. Sarvam may send the full running transcript on each chunk
   * rather than just the new fragment.
   */
  private isCumulativeText(current: string, incoming: string): boolean {
    if (!current) return false;
    const cur = current.trim().toLowerCase();
    const inc = incoming.trim().toLowerCase();
    // If the incoming text starts with what we already have, it's cumulative.
    return inc.length > cur.length && inc.startsWith(cur);
  }

  // ─── Routing ──────────────────────────────────────────────────────────────

  private buildOptionRetryMessage(
    field: ExtractedFormField,
    attemptedValue: string | string[] | undefined,
  ): string {
    const options =
      field.options?.map((option) => option.label).filter(Boolean) ?? [];
    const optionText =
      options.length > 0
        ? options.length <= 4
          ? options.join(", ")
          : `${options.slice(0, 4).join(", ")}, or another listed option`
        : "one of the available options";
    const attempted = Array.isArray(attemptedValue)
      ? attemptedValue.join(", ")
      : attemptedValue;

    return attempted
      ? `I could not select ${attempted} for ${field.label}. Please choose ${optionText}.`
      : `I could not match your answer for ${field.label}. Please choose ${optionText}.`;
  }

  private async handleUnsupportedUploadField(
    field: ExtractedFormField,
  ): Promise<boolean> {
    if (!this.isUnsupportedUploadField(field)) {
      return false;
    }

    if (field.constraints?.required) {
      await this.speakAndEmit(
        `${field.label} is a required file upload field that must be filled manually. The voice assistant will stop now so you can complete it.`,
      );
      this.stopRequested = true;
      this.hooks.onQuit?.({ confirmed: true, reason: "user-stop" });
      this.observability.onSessionEnd?.(this.sessionId, "user-stop");
      return true;
    }

    // Optional file field — ask user: stop to fill it, or skip it
    const answer = await this.listenForYesNo(
      `${field.label} is a file upload that must be filled manually. Would you like to pause voice input now to fill it? Say yes to stop and fill it, or no to skip it.`,
    );
    if (!this.running || this.stopRequested) return true;

    if (answer === "yes") {
      await this.speakAndEmit(
        `The voice assistant will stop so you can upload ${field.label}. You can restart anytime.`,
      );
      this.stopRequested = true;
      this.hooks.onQuit?.({ confirmed: true, reason: "user-stop" });
      this.observability.onSessionEnd?.(this.sessionId, "user-stop");
    } else {
      this.skippedFields.add(field.id);
      await this.speakAndEmit(`Skipping ${field.label}.`);
    }
    return true;
  }

  private isUnsupportedUploadField(field: ExtractedFormField): boolean {
    // Fast path: formExtractor now sets type:"file" for extracted file inputs
    if (field.type === "file") return true;

    if (!field.element) {
      // Fall back to label heuristic only when there's no element to inspect
      const label = `${field.label} ${field.name} ${field.id}`.toLowerCase();
      return /\b(upload|file|attachment)\b/.test(label);
    }

    const element = field.element;
    if (element.querySelector("input[type='file']")) {
      return true;
    }
    if (
      element.matches(
        "input[type='file'], digi-upload-input, dynamic-file-input, dynamic-upload-input, file-upload, app-file-upload, app-upload",
      )
    ) {
      return true;
    }
    return Boolean(
      element.closest(
        "digi-upload-input, dynamic-file-input, dynamic-upload-input, file-upload, app-file-upload, app-upload, .upload-container, .file-upload, .upload-box",
      ),
    );
  }

  private isManualUploadField(field: ExtractedFormField): boolean {
    if (field.type === "file") {
      return true;
    }

    const element = field.element;
    if (!element) {
      return false;
    }

    if (element.querySelector("input[type='file']")) {
      return true;
    }

    return Boolean(
      element.matches(
        "input[type='file'], digi-upload-input, dynamic-file-input, dynamic-upload-input, file-upload, app-file-upload, app-upload",
      ) ||
        element.closest(
          "digi-upload-input, dynamic-file-input, dynamic-upload-input, file-upload, app-file-upload, app-upload, .upload-container, .file-upload, .upload-box",
        ),
    );
  }

  private findTranscriptGuardField(): ExtractedFormField | undefined {
    if (this.currentQuestionFieldId) {
      const current = this.fields.find(
        (field) => field.id === this.currentQuestionFieldId,
      );
      if (current) return current;
    }
    return undefined;
  }

  private async isTranscriptGuardRelevant(
    currentField: ExtractedFormField,
    transcript: string,
  ): Promise<boolean> {
    const localRelevance = this.getLocalTranscriptGuardRelevance(
      currentField,
      transcript,
    );
    if (localRelevance === "relevant") {
      return true;
    }

    try {
      const routing = await this.router.routeAnswer(
        this.buildRoutingRequest(currentField, transcript),
      );
      const assignments = routing.assignments ?? [];
      if (assignments.length > 0) {
        return true;
      }
      return Boolean(
        routing.specialCommand && routing.specialCommand.confidence >= 0.7,
      );
    } catch (err) {
      this.hooks.onError?.({
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return true;
    }
  }

  private getLocalTranscriptGuardRelevance(
    currentField: ExtractedFormField,
    transcript: string,
  ): LocalTranscriptGuardRelevance {
    if (this.hasLocalSpecialCommandIntent(transcript)) {
      return "relevant";
    }

    if (this.tryLocalOptionRoute(currentField, transcript)) {
      return "relevant";
    }

    const transcriptTokens = new Set(
      this.optionTokens(transcript).filter(
        (token) => !this.isGenericOptionToken(token),
      ),
    );
    if (transcriptTokens.size === 0) {
      return "inconclusive";
    }

    if (this.hasTokenOverlap(transcriptTokens, currentField.label)) {
      return "relevant";
    }
    if (this.hasTokenOverlap(transcriptTokens, currentField.name)) {
      return "relevant";
    }

    for (const option of currentField.options ?? []) {
      if (
        this.hasTokenOverlap(transcriptTokens, option.label) ||
        this.hasTokenOverlap(transcriptTokens, option.value)
      ) {
        return "relevant";
      }
    }

    return "inconclusive";
  }

  private hasLocalSpecialCommandIntent(transcript: string): boolean {
    return this.resolveSpecialCommandIntent(transcript) !== null;
  }

  private matchesApproxPhrase(text: string, phrase: string): boolean {
    const normalizedText = this.normalizeOptionText(text);
    const normalizedPhrase = this.normalizeOptionText(phrase);
    if (!normalizedText || !normalizedPhrase) return false;
    if (normalizedText.includes(normalizedPhrase)) return true;
    const textWords = normalizedText.split(/\s+/).filter(Boolean);
    const phraseWords = normalizedPhrase.split(/\s+/).filter(Boolean);
    if (phraseWords.length === 0 || textWords.length < phraseWords.length) {
      return false;
    }
    for (let i = 0; i <= textWords.length - phraseWords.length; i++) {
      let ok = true;
      for (let j = 0; j < phraseWords.length; j++) {
        if (!this.isApproxWord(textWords[i + j], phraseWords[j])) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }

  private hasApproxWord(words: string[], candidates: string[]): boolean {
    for (const candidate of candidates) {
      const candidateWords = this.optionTokens(candidate);
      if (candidateWords.length === 0) continue;
      if (candidateWords.length === 1) {
        if (words.some((word) => this.isApproxWord(word, candidateWords[0]))) {
          return true;
        }
        continue;
      }
      for (let i = 0; i <= words.length - candidateWords.length; i++) {
        let ok = true;
        for (let j = 0; j < candidateWords.length; j++) {
          if (!this.isApproxWord(words[i + j], candidateWords[j])) {
            ok = false;
            break;
          }
        }
        if (ok) return true;
      }
    }
    return false;
  }

  private isApproxWord(a: string, b: string): boolean {
    const left = a.replace(/[^a-z0-9\u0900-\u097F]/gi, "");
    const right = b.replace(/[^a-z0-9\u0900-\u097F]/gi, "");
    if (!left || !right) return false;
    if (left === right) return true;
    if (left.length <= 2 || right.length <= 2) return false;
    const distance = this.levenshteinDistance(left, right);
    if (Math.max(left.length, right.length) <= 4) {
      return distance <= 1;
    }
    return distance <= 2;
  }

  private hasTokenOverlap(tokens: Set<string>, value: string | undefined): boolean {
    if (!value) return false;
    return this.optionTokens(value)
      .filter((token) => !this.isGenericOptionToken(token))
      .some((token) => tokens.has(token));
  }

  private buildRoutingRequest(
    currentField: ExtractedFormField,
    userInput: string,
  ): BedrockRoutingRequest {
    const isVoiceRoutable = (field: ExtractedFormField) =>
      !this.isManualUploadField(field);
    const pendingFields = [
      this.toDescriptor(currentField),
      ...this.fields
        .filter(
          (f) =>
            f.id !== currentField.id &&
            this.isPendingField(f) &&
            isVoiceRoutable(f),
        )
        .map((f) => this.toDescriptor(f)),
    ];
    const completedFields = this.fields
      .filter(
        (f) =>
          f.id !== currentField.id &&
          !this.isPendingField(f) &&
          isVoiceRoutable(f),
      )
      .map((f) => this.toDescriptor(f));

    return {
      userInput,
      currentFieldId: currentField.id,
      pendingFields,
      completedFields,
      language: this.language as any,
      isEditMode: false,
    };
  }

  private async routeAnswer(
    currentField: ExtractedFormField,
    userInput: string,
  ): Promise<BedrockRoutingResponse> {
    try {
      const response = await this.router.routeAnswer(
        this.buildRoutingRequest(currentField, userInput),
      );
      return response;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // A router failure here means the LLM never ran, so multi-field routing
      // and semantic option matching are BOTH silently lost and the app
      // degrades to local exact-option matching only. Surface it loudly so it
      // is not mistaken for "I could not understand". Check the console/network
      // tab: common causes are invalid AWS creds, the Bedrock model not being
      // enabled in the region, a wrong modelId, or browser->Bedrock CORS.
      console.error("[V2VoiceFormService] Answer routing (LLM) failed:", error);
      this.emitStatus(
        "Answer routing is unavailable (LLM error) — only exact option words will work until this is fixed. See console.",
      );
      this.hooks.onError?.({ error });
      return { assignments: [] };
    }
  }

  // ─── Assignment Application ───────────────────────────────────────────────

  private async applyAssignments(
    assignments: FieldAssignment[],
    _translatedOptions: TranslatedOptionMapping[] | undefined,
    rawTranscript?: string,
  ): Promise<number> {
    let appliedCount = 0;
    let ignoredManualUploadAssignment = false;
    this.lastAssignmentFailure = null;
    this.isSettingValueProgrammatically = true;
    try {
      for (const assignment of assignments) {
        const field = this.fields.find((f) => f.id === assignment.fieldId);
        if (!field) {
          if (this.debugLogs) {
            console.warn(
              `[V2VoiceFormService] Field not found for assignment:`,
              assignment.fieldId,
            );
          }
          continue;
        }
        if (this.isManualUploadField(field)) {
          if (this.debugLogs) {
            console.warn(
              `[V2VoiceFormService] Ignoring assignment for manual upload field:`,
              field.label,
            );
          }
          ignoredManualUploadAssignment = true;
          continue;
        }
        if (assignment.skip) {
          if (field.constraints.required) {
            this.rememberAssignmentFailure(
              field,
              `${field.label} is required and cannot be skipped. Please answer ${field.label}.`,
            );
            continue;
          }
          this.skippedFields.add(field.id);
          this.emitStatus(`Skipped ${field.label}`);
          appliedCount++;
          continue;
        }
        if (assignment.value === undefined || assignment.value === null) {
          if (this.debugLogs) {
            console.warn(
              `[V2VoiceFormService] Assignment has no value for field:`,
              field.label,
              assignment,
            );
          }
          continue;
        }

        // Post-process: strip conversational prefixes and format values for
        // the target field before any form/native validation sees them.
        let cleanedValue = this.cleanAssignmentValue(field, assignment.value);

        // Fallback for digit fields: the LLM may collapse spoken digit sequences
        // it perceives as repetitions (e.g. "1 2 3 4 5 6 7 8 1 2 3 4" → "12345678").
        // If the AI-extracted digit count is wrong but the raw transcript produces
        // the expected count, substitute the transcript-derived digits.
        if (
          rawTranscript &&
          typeof cleanedValue === "string" &&
          this.isDigitFormattedField(field)
        ) {
          const expectedCount = this.expectedDigitCountForField(field);
          if (expectedCount !== null) {
            const aiDigitCount = this.normalizeNumericSpeech(cleanedValue).length;
            if (aiDigitCount !== expectedCount) {
              const transcriptValue = this.normalizeDigitFormattedValue(field, rawTranscript);
              if (this.normalizeNumericSpeech(transcriptValue).length === expectedCount) {
                if (this.debugLogs) {
                  console.log(
                    `[V2VoiceFormService] Digit count mismatch on ${field.label}: AI extracted ${aiDigitCount} digits, transcript has ${expectedCount} — using transcript value`,
                  );
                }
                cleanedValue = transcriptValue;
              }
            }
          }
        }

        const validationError = this.validateFieldValue(field, cleanedValue);

        if (validationError) {
          this.rememberAssignmentFailure(field, validationError);
          if (this.debugLogs) {
            console.warn(
              `[V2VoiceFormService] Rejected invalid value for ${field.label}:`,
              cleanedValue,
              validationError,
            );
          }
          continue;
        }

        if (this.debugLogs) {
          console.log(
            `[V2VoiceFormService] Applying assignment to field:`,
            field.label,
            `Original:`,
            assignment.value,
            `Cleaned:`,
            cleanedValue,
          );
        }

        const previousValue = this.captureFieldValue(field);
        const applied = await this.writeFieldValue(field, cleanedValue);
        if (applied) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          const postWriteError = this.getFieldValidationError(
            field,
            cleanedValue,
          );
          if (postWriteError) {
            this.restoreFieldValue(field, previousValue);
            this.rememberAssignmentFailure(field, postWriteError);
            if (this.debugLogs) {
              console.warn(
                `[V2VoiceFormService] Restored invalid value for ${field.label}:`,
                cleanedValue,
                postWriteError,
              );
            }
            continue;
          }

          appliedCount++;
          this.programmaticallyFilledFields.add(field.id);
          if (this.debugLogs) {
            console.log(
              `[V2VoiceFormService] Successfully applied value to ${field.label}`,
            );
          }
          this.hooks.onAssignment?.({
            fieldId: field.id,
            value: cleanedValue,
          });

          // Clear the transcript display after successful assignment
          this.hooks.onTranscript?.({ text: "", isFinal: false });
        } else {
          if (this.debugLogs) {
            console.warn(
              `[V2VoiceFormService] Failed to write value to ${field.label}`,
            );
          }
        }
      }
    } finally {
      this.isSettingValueProgrammatically = false;
    }
    if (
      appliedCount === 0 &&
      !this.lastAssignmentFailure &&
      !ignoredManualUploadAssignment
    ) {
      const firstAssignment = assignments[0];
      const field = firstAssignment
        ? this.fields.find((candidate) => candidate.id === firstAssignment.fieldId)
        : undefined;
      if (field) {
        this.rememberAssignmentFailure(
          field,
          `I could not fill ${field.label}. Please answer ${field.label} again.`,
        );
      }
    }
    return appliedCount;
  }

  /**
   * Format LLM-extracted values for browser controls without changing meaning.
   */
  private cleanAssignmentValue(
    field: ExtractedFormField,
    value: string | string[],
  ): string | string[] {
    // The LLM is the semantic cleaner. Local cleanup is limited to formatting
    // values for browser controls and validators; it must not remove words from
    // names or free text.
    if (
      field.type === "select" ||
      field.type === "radio" ||
      field.type === "checkbox"
    ) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((v) => this.normalizeCleanedAssignmentValue(field, v));
    }
    return this.normalizeCleanedAssignmentValue(field, value);
  }

  private normalizeCleanedAssignmentValue(
    field: ExtractedFormField,
    value: string,
  ): string {
    return this.normalizeStructuredFieldValue(field, value);
  }

  private normalizeStructuredFieldValue(
    field: ExtractedFormField,
    value: string,
  ): string {
    const cleaned = value.trim();

    if (this.isEmailLikeField(field)) {
      return this.normalizeEmailValue(cleaned);
    }

    if (field.type === "date") {
      const parsed = this.parseDatePartsFromText(cleaned);
      return parsed ? this.formatDateParts(parsed) : cleaned;
    }

    if (this.isDigitFormattedField(field)) {
      return this.normalizeDigitFormattedValue(field, cleaned);
    }

    if (field.type === "number" || field.type === "tel") {
      return this.normalizeDigitFormattedValue(field, cleaned);
    }

    return cleaned.replace(/\s+/g, " ");
  }

  private normalizeDigitFormattedValue(
    field: ExtractedFormField,
    value: string,
  ): string {
    const collapsed = this.collapseRepeatedNumericSpeech(value);
    const digitsFromSpeech = this.normalizeNumericSpeech(collapsed);
    const digitsFromText = collapsed
      .replace(/[०-९]/g, (digit) => String("०१२३४५६७८९".indexOf(digit)))
      .replace(/\D/g, "");
    const digits =
      digitsFromSpeech.length >= digitsFromText.length
        ? digitsFromSpeech
        : digitsFromText;

    if (field.type === "tel" && digits.length >= 5) {
      const hasLeadingPlus = /^\s*\+/.test(collapsed);
      return `${hasLeadingPlus ? "+" : ""}${digits}`;
    }

    if (digits.length > 0) {
      return digits;
    }

    return collapsed.replace(/(?<=\d)[\s.,-]+(?=\d)/g, "");
  }

  private normalizeEmailValue(value: string): string {
    return value
      .toLowerCase()
      .replace(/\s+(?:at|add|ad)\s+/gi, "@")
      .replace(/\s+(?:dot|\. )\s+/gi, ".")
      .replace(/\s*\.\s*/g, ".")
      .replace(/\s*@\s*/g, "@")
      .replace(/\s+/g, "");
  }

  // ─── DOM Write ────────────────────────────────────────────────────────────

  private async writeFieldValue(
    field: ExtractedFormField,
    value: string | string[],
  ): Promise<boolean> {
    // Handle custom dropdowns (ng-select) before native select
    if (
      field.type === "select" &&
      !field.selectElement &&
      field.element &&
      isCustomDropdownElement(field.element)
    ) {
      return await this.writeCustomDropdownValue(field, value);
    }

    if (field.selectElement) {
      const select = field.selectElement;
      const stringValue = Array.isArray(value) ? value[0] : value;

      // Try exact match first
      let matchedValue = stringValue;
      const optionExists = Array.from(select.options).some(
        (opt) => opt.value === stringValue,
      );

      // If no exact match, try fuzzy matching with available options
      if (!optionExists && field.options && field.options.length > 0) {
        const matched = this.findBestOptionMatch(stringValue, field.options);
        if (matched) {
          matchedValue = matched.value;
          if (this.debugLogs) {
            console.log(
              `[V2VoiceFormService] Fuzzy matched "${stringValue}" to "${matchedValue}" for ${field.label}`,
            );
          }
        } else {
          if (this.debugLogs) {
            console.warn(
              `[V2VoiceFormService] Could not find match for "${stringValue}" in options:`,
              field.options.map((o) => o.value),
            );
          }
          return false;
        }
      }

      nativeSet(select, "value", matchedValue);
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      select.dispatchEvent(new Event("blur", { bubbles: false }));
      return true;
    }

    if (field.textareaElement) {
      const ta = field.textareaElement;
      nativeSet(ta, "value", Array.isArray(value) ? value.join(", ") : value);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("change", { bubbles: true }));
      ta.dispatchEvent(new Event("blur", { bubbles: false }));
      return true;
    }

    if (field.type === "radio" || field.type === "checkbox") {
      const values = Array.isArray(value) ? value : [value];

      // Try fuzzy matching for radio/checkbox values
      let matchedValues = values;
      if (field.options && field.options.length > 0) {
        matchedValues = values.map((v) => {
          const match = this.findBestOptionMatch(v, field.options!);
          if (match) {
            if (this.debugLogs && match.value !== v) {
              console.log(
                `[V2VoiceFormService] Fuzzy matched "${v}" to "${match.value}" for ${field.label}`,
              );
            }
            return match.value;
          }
          return v;
        });
      }

      let anyChecked = false;
      for (const input of field.inputElements) {
        const match = matchedValues.includes(input.value);
        if (input.checked !== match) {
          nativeSet(input, "checked", match);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        if (match) anyChecked = true;
      }
      return anyChecked;
    }

    if (field.inputElements[0]) {
      const input = field.inputElements[0];
      const rawValue = Array.isArray(value) ? value[0] : value;
      nativeSet(
        input,
        "value",
        field.type === "date"
          ? this.normalizeDateForInput(rawValue, input)
          : rawValue,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      // Dispatch blur so Angular marks the control as touched; this makes
      // Angular Material expose <mat-error> in the DOM, which lets
      // readDomValidationError() relay the actual form error to the user.
      input.dispatchEvent(new Event("blur", { bubbles: false }));
      return true;
    }

    return false;
  }

  /**
   * Write value to a custom dropdown (ng-select).
   * Opens the dropdown, finds the matching option, and clicks it.
   */
  private async writeCustomDropdownValue(
    field: ExtractedFormField,
    value: string | string[],
  ): Promise<boolean> {
    if (!field.element) {
      if (this.debugLogs) {
        console.warn(
          `[V2VoiceFormService] Custom dropdown has no element:`,
          field.label,
        );
      }
      return false;
    }

    const stringValue = Array.isArray(value) ? value[0] : value;

    // Fuzzy match the value against available options. Keep both the model
    // value and visible label because many Angular dropdown panels render only
    // the label text, while the form model stores a separate key.
    let targetValue = stringValue;
    const targetAliases = new Set<string>([stringValue]);
    if (field.options && field.options.length > 0) {
      const matched = this.findBestOptionMatch(stringValue, field.options);
      if (matched) {
        targetValue = matched.value;
        targetAliases.add(matched.value);
        targetAliases.add(matched.label);
        if (this.debugLogs && matched.value !== stringValue) {
          console.log(
            `[V2VoiceFormService] Fuzzy matched "${stringValue}" to "${targetValue}" for ${field.label}`,
          );
        }
      } else {
        if (this.debugLogs) {
          console.warn(
            `[V2VoiceFormService] Could not find match for "${stringValue}" in options:`,
            field.options.map((o) => `${o.label} (${o.value})`),
          );
        }
        return false;
      }
    }

    try {
      // Open the dropdown to make options visible
      const wasOpened = openDropdownElement(field.element);
      if (this.debugLogs) {
        console.log(
          `[V2VoiceFormService] ${wasOpened ? "Opened" : "Already open"} dropdown for ${field.label}`,
        );
      }

      // Wait for options to render, then click
      return await new Promise<boolean>((resolve) => {
        setTimeout(() => {
          try {
            // Find the option element with matching value
            const containers = getDropdownOptionContainers(field.element!);
            let optionElement: HTMLElement | null = null;

            for (const container of containers) {
              const options = container.querySelectorAll<HTMLElement>(
                ".ng-option, [role='option'], mat-radio-button",
              );

              for (const option of Array.from(options)) {
                const metadata = readDropdownOptionMetadata(option);
                const optionValue = metadata.value ?? "";
                const optionLabel = metadata.label ?? optionValue;
                if (
                  Array.from(targetAliases).some((target) =>
                    this.optionMatchesTarget(optionValue, optionLabel, target),
                  )
                ) {
                  optionElement = option;
                  break;
                }
              }

              if (optionElement) break;
            }

            if (!optionElement) {
              if (this.debugLogs) {
                console.warn(
                  `[V2VoiceFormService] Could not find option element for "${targetValue}" in ${field.label}`,
                );
              }
              closeDropdownElement(field.element!);
              resolve(false);
              return;
            }

            // Click the option to select it
            if (this.debugLogs) {
              console.log(
                `[V2VoiceFormService] Clicking option: "${optionElement.textContent?.trim()}"`,
              );
            }

            optionElement.dispatchEvent(
              new MouseEvent("mousedown", { bubbles: true }),
            );
            optionElement.dispatchEvent(
              new MouseEvent("mouseup", { bubbles: true }),
            );
            optionElement.dispatchEvent(
              new MouseEvent("click", { bubbles: true }),
            );

            // Close the dropdown after selection and resolve
            setTimeout(() => {
              closeDropdownElement(field.element!);
              resolve(true);
            }, 100);
          } catch (err) {
            if (this.debugLogs) {
              console.error(
                `[V2VoiceFormService] Error selecting option in ${field.label}:`,
                err,
              );
            }
            if (field.element) {
              closeDropdownElement(field.element);
            }
            resolve(false);
          }
        }, 150);
      });
    } catch (err) {
      if (this.debugLogs) {
        console.error(
          `[V2VoiceFormService] Error writing to custom dropdown ${field.label}:`,
          err,
        );
      }
      return false;
    }
  }

  private normalizeDateForInput(
    value: string,
    input: HTMLInputElement,
  ): string {
    const parsed = this.parseDatePartsFromText(value);
    if (!parsed) {
      return value;
    }

    const formatted = this.formatDateParts(parsed);
    return input.type.toLowerCase() === "date"
      ? formatted.split("/").reverse().join("-")
      : formatted;
  }

  private formatDateParts(date: {
    day: number;
    month: number;
    year: number;
  }): string {
    const day = String(date.day).padStart(2, "0");
    const month = String(date.month).padStart(2, "0");
    const year = String(date.year).padStart(4, "0");
    return `${day}/${month}/${year}`;
  }

  private parseDatePartsFromText(
    value: string,
  ): { day: number; month: number; year: number } | null {
    const trimmed = value.trim().replace(/(\d)(st|nd|rd|th)\b/gi, "$1");
    const numeric = trimmed.match(
      /\b(\d{1,4})[\/\-. ](\d{1,2})[\/\-. ](\d{1,4})\b/,
    );
    if (numeric) {
      const parsed = this.parseNumericDateMatch(numeric);
      if (parsed) {
        return parsed;
      }
    }

    const monthPattern =
      "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
    const dayMonthYear = new RegExp(
      `\\b(\\d{1,2})\\s+${monthPattern}\\s*,?\\s*(\\d{2,4})\\b`,
      "i",
    );
    const monthDayYear = new RegExp(
      `\\b${monthPattern}\\s+(\\d{1,2})\\s*,?\\s*(\\d{2,4})\\b`,
      "i",
    );

    const dayMonthMatch = trimmed.match(dayMonthYear);
    if (dayMonthMatch) {
      return this.normalizeDateParts({
        day: Number(dayMonthMatch[1]),
        month: this.monthNameToNumber(dayMonthMatch[2]),
        year: Number(dayMonthMatch[3]),
      });
    }

    const monthDayMatch = trimmed.match(monthDayYear);
    if (monthDayMatch) {
      return this.normalizeDateParts({
        day: Number(monthDayMatch[2]),
        month: this.monthNameToNumber(monthDayMatch[1]),
        year: Number(monthDayMatch[3]),
      });
    }

    return null;
  }

  private parseNumericDateMatch(
    numeric: RegExpMatchArray,
  ): { day: number; month: number; year: number } | null {
    let first = Number(numeric[1]);
    const second = Number(numeric[2]);
    let third = Number(numeric[3]);

    if ([first, second, third].some((part) => Number.isNaN(part))) {
      return null;
    }

    let day = first;
    let month = second;
    let year = third;
    if (numeric[1].length === 4) {
      year = first;
      month = second;
      day = third;
    }

    return this.normalizeDateParts({ day, month, year });
  }

  private normalizeDateParts(date: {
    day: number;
    month: number;
    year: number;
  }): { day: number; month: number; year: number } | null {
    let { day, month, year } = date;
    if ([day, month, year].some((part) => Number.isNaN(part))) {
      return null;
    }
    if (year < 100) {
      year += year > 30 ? 1900 : 2000;
    }
    if (day < 1 || day > 31 || month < 1 || month > 12 || year < 1900) {
      return null;
    }

    return { day, month, year };
  }

  private monthNameToNumber(month: string): number {
    const key = month.toLowerCase().slice(0, 3);
    const months: Record<string, number> = {
      jan: 1,
      feb: 2,
      mar: 3,
      apr: 4,
      may: 5,
      jun: 6,
      jul: 7,
      aug: 8,
      sep: 9,
      oct: 10,
      nov: 11,
      dec: 12,
    };
    return months[key] ?? NaN;
  }

  /**
   * Local fast-path for select/radio fields: returns a synthetic routing
   * response when the transcript unambiguously matches one option WITHOUT an
   * LLM call. Returns null to fall through to the LLM router.
   *
   * An "unambiguous" match requires:
   *   • The top-scoring option has score ≥ 2
   *   • Its score is strictly greater than the second-best (no tie)
   *   • findBestOptionMatch independently agrees on the same option
   */
  private tryLocalOptionRoute(
    field: ExtractedFormField,
    transcript: string,
  ): BedrockRoutingResponse | null {
    if (!["select", "radio"].includes(field.type)) return null;
    const options = field.options;
    if (!options || options.length < 2) return null;

    const transcriptNorm = this.normalizeOptionText(transcript);
    const transcriptTokens = this.optionTokens(transcriptNorm);
    if (transcriptTokens.length === 0) return null;

    const scored = options
      .map((opt) => ({ opt, score: this.scoreOptionMatch(transcriptTokens, opt) }))
      .filter((m) => m.score >= 2)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return null;
    // Require a clear, unambiguous winner
    if (scored.length > 1 && scored[0].score === scored[1].score) return null;

    // Corroborate with findBestOptionMatch (uses different matching strategies)
    const direct = this.findBestOptionMatch(transcript, options);
    if (!direct || direct.value !== scored[0].opt.value) return null;

    // If the transcript contains meaningful tokens beyond the winning option's
    // own tokens, the user likely gave answers for multiple fields in one
    // utterance. Route to the LLM so multi-field assignments are not lost.
    const winningOpt = scored[0].opt;
    const winningTokenSet = new Set([
      ...this.optionTokens(winningOpt.value),
      ...this.optionTokens(winningOpt.label),
    ]);
    const extraTokens = transcriptTokens.filter(
      (t) => !winningTokenSet.has(t) && !this.isGenericOptionToken(t),
    );
    if (extraTokens.length > 0) {
      if (this.debugLogs) {
        console.log(
          `[V2VoiceFormService] Local option match skipped — extra tokens detected: ${extraTokens.join(", ")}. Routing to LLM.`,
        );
      }
      return null;
    }

    if (this.debugLogs) {
      console.log(
        `[V2VoiceFormService] Local option match: "${transcript}" → "${scored[0].opt.value}" (score ${scored[0].score})`,
      );
    }
    return {
      assignments: [{ fieldId: field.id, value: scored[0].opt.value, confidence: 0.95 }],
    };
  }

  /**
   * Cross-field fast-path: if the spoken value clearly matches another pending
   * select/radio field better than the currently asked field, fill that other
   * field and keep the current one pending so the flow naturally asks it again.
   *
   * Example: current question = District, user says "Haryana" -> fills State
   * now, then comes back to District next turn.
   */
  private tryLocalCrossFieldRoute(
    currentField: ExtractedFormField,
    transcript: string,
  ): BedrockRoutingResponse | null {
    const transcriptNorm = this.normalizeOptionText(transcript);
    if (!transcriptNorm) return null;

    const wordCount = transcriptNorm.split(/\s+/).filter(Boolean).length;
    if (wordCount > 6) return null;

    const transcriptTokens = this.optionTokens(transcriptNorm);
    if (transcriptTokens.length === 0) return null;

    const currentSetLike =
      currentField.type === "select" || currentField.type === "radio";
    const currentScore = currentSetLike
      ? this.bestFieldOptionScore(currentField, transcript)
      : 0;

    const candidates = this.fields
      .filter(
        (f) =>
          f.id !== currentField.id &&
          this.isPendingField(f) &&
          (f.type === "select" || f.type === "radio") &&
          this.isFieldVisible(f) &&
          !this.isFieldDisabled(f) &&
          !this.isManualUploadField(f) &&
          Array.isArray(f.options) &&
          f.options.length > 0,
      )
      .map((f) => {
        const bestMatch = this.findBestOptionMatch(transcript, f.options ?? [], {
          allowContains: false,
          allowReverseContains: false,
        });
        if (!bestMatch) return null;
        const score = this.scoreOptionMatch(transcriptTokens, bestMatch);
        if (score < 2) return null;
        return { field: f, bestMatch, score };
      })
      .filter(
        (
          item,
        ): item is {
          field: ExtractedFormField;
          bestMatch: { value: string; label: string };
          score: number;
        } => item !== null,
      )
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) return null;
    if (
      candidates.length > 1 &&
      candidates[0].score === candidates[1].score
    ) {
      return null;
    }
    const best = candidates[0];
    if (best.score < 2.5) return null;
    if (currentScore >= best.score) return null;

    if (this.debugLogs) {
      console.log(
        `[V2VoiceFormService] Cross-field local option match: "${transcript}" -> ${best.field.label}="${best.bestMatch.value}"`,
      );
    }
    return {
      assignments: [
        {
          fieldId: best.field.id,
          value: best.bestMatch.value,
          confidence: 0.94,
        },
      ],
    };
  }

  private bestFieldOptionScore(
    field: ExtractedFormField,
    transcript: string,
  ): number {
    if (
      !Array.isArray(field.options) ||
      field.options.length === 0 ||
      (field.type !== "select" && field.type !== "radio")
    ) {
      return 0;
    }
    const transcriptTokens = this.optionTokens(this.normalizeOptionText(transcript));
    const bestMatch = this.findBestOptionMatch(transcript, field.options, {
      allowContains: false,
      allowReverseContains: false,
    });
    if (!bestMatch) return 0;
    return this.scoreOptionMatch(transcriptTokens, bestMatch);
  }

  /**
   * Find the best matching option for a given value using fuzzy matching.
   * This helps handle cases where the LLM returns "Mr" but the option is "Mr./श्री"
   */
  private findBestOptionMatch(
    value: string,
    options: Array<{ value: string; label: string }>,
    config: {
      allowContains?: boolean;
      allowReverseContains?: boolean;
    } = {},
  ): { value: string; label: string } | null {
    if (!value) return null;

    const allowContains = config.allowContains ?? true;
    const allowReverseContains = config.allowReverseContains ?? true;
    const valueLower = this.normalizeOptionQuery(value, options);

    // 1. Exact match (case-insensitive)
    for (const opt of options) {
      if (this.normalizeOptionText(opt.value) === valueLower) {
        return opt;
      }
      if (this.normalizeOptionText(opt.label) === valueLower) {
        return opt;
      }
    }

    // 2. Whole-token match. This allows "Gender is Male" -> Male, but avoids
    // matching "male" inside "female". Use scoring so shared generic words
    // like "class" do not cause the first option to win over "class 2".
    const valueTokens = this.optionTokens(valueLower);
    const scoredMatches = options
      .map((opt) => ({
        opt,
        score: this.scoreOptionMatch(valueTokens, opt),
      }))
      .filter((match) => match.score >= 2)
      .sort((a, b) => b.score - a.score);
    if (
      scoredMatches.length > 0 &&
      (scoredMatches.length === 1 ||
        scoredMatches[0].score > scoredMatches[1].score)
    ) {
      return scoredMatches[0].opt;
    }

    // 3. Starts with match, but only for prefixes of 3+ chars to avoid tiny
    // accidental matches.
    if (valueLower.length >= 3) {
      for (const opt of options) {
        if (this.normalizeOptionText(opt.value).startsWith(valueLower)) {
          return opt;
        }
        if (this.normalizeOptionText(opt.label).startsWith(valueLower)) {
          return opt;
        }
      }
    }

    // 4. Contains match for longer phrases only. Very short values such as
    // "male" should never match inside "female".
    if (allowContains && valueLower.length >= 5) {
      for (const opt of options) {
        if (this.normalizeOptionText(opt.value).includes(valueLower)) {
          return opt;
        }
        if (this.normalizeOptionText(opt.label).includes(valueLower)) {
          return opt;
        }
      }
    }

    // 5. Reverse contains (search term contains the option value). Use token
    // boundaries for short option values.
    if (allowReverseContains) {
      for (const opt of options) {
        const optValueLower = this.normalizeOptionText(opt.value);
        const optLabelLower = this.normalizeOptionText(opt.label);
        if (
          optValueLower.length > 1 &&
          (valueLower.includes(optValueLower) ||
            valueTokens.includes(optValueLower))
        ) {
          return opt;
        }
        if (
          optLabelLower.length > 1 &&
          (valueLower.includes(optLabelLower) ||
            valueTokens.includes(optLabelLower))
        ) {
          return opt;
        }
      }
    }

    // 6. Word boundary match (for multi-word options like "Mr./श्री")
    const valueWords = valueLower.split(/[\s.\-\/]+/).filter(Boolean);
    for (const opt of options) {
      const optWords = this.normalizeOptionText(opt.value)
        .split(/[\s.\-\/]+/)
        .filter(Boolean);
      const labelWords = this.normalizeOptionText(opt.label)
        .split(/[\s.\-\/]+/)
        .filter(Boolean);

      for (const vWord of valueWords) {
        if (vWord.length > 1) {
          for (const oWord of optWords) {
            if (oWord === vWord || oWord.startsWith(vWord)) {
              return opt;
            }
          }
          for (const lWord of labelWords) {
            if (lWord === vWord || lWord.startsWith(vWord)) {
              return opt;
            }
          }
        }
      }
    }

    return null;
  }

  private scoreOptionMatch(
    valueTokens: string[],
    option: { value: string; label: string },
  ): number {
    const optionTokens = new Set([
      ...this.optionTokens(option.value),
      ...this.optionTokens(option.label),
    ]);
    const optionTokenList = Array.from(optionTokens);
    let score = 0;
    for (const token of valueTokens) {
      if (optionTokens.has(token)) {
        if (/^\d+$/.test(token)) {
          score += 5;
        } else if (this.isGenericOptionToken(token)) {
          score += 0.25;
        } else {
          score += 2;
        }
        continue;
      }

      const fuzzyScore = this.scoreFuzzyOptionToken(token, optionTokenList);
      score += fuzzyScore;
    }
    return score;
  }

  private scoreFuzzyOptionToken(token: string, optionTokens: string[]): number {
    if (
      token.length < 3 ||
      /^\d+$/.test(token) ||
      this.isGenericOptionToken(token)
    ) {
      return 0;
    }

    let bestScore = 0;
    const tokenKey = this.phoneticOptionKey(token);
    for (const optionToken of optionTokens) {
      if (
        optionToken.length < 3 ||
        /^\d+$/.test(optionToken) ||
        this.isGenericOptionToken(optionToken)
      ) {
        continue;
      }

      if (tokenKey && tokenKey === this.phoneticOptionKey(optionToken)) {
        bestScore = Math.max(bestScore, 2);
        continue;
      }

      const similarity = this.stringSimilarity(token, optionToken);
      if (similarity >= 0.82) {
        bestScore = Math.max(bestScore, 1.75);
      }
    }

    return bestScore;
  }

  private phoneticOptionKey(token: string): string {
    const cleaned = token
      .toLowerCase()
      .replace(/ph/g, "f")
      .replace(/ck/g, "k")
      .replace(/q/g, "k")
      .replace(/z/g, "s")
      .replace(/[^a-z0-9\u0900-\u097f]/g, "");
    if (cleaned.length < 3) return "";
    if (/[^a-z0-9]/.test(cleaned)) return cleaned;
    const first = cleaned[0];
    const tail = cleaned
      .slice(1)
      .replace(/[aeiou]/g, "")
      .replace(/(.)\1+/g, "$1");
    return `${first}${tail}`;
  }

  private stringSimilarity(a: string, b: string): number {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - this.levenshteinDistance(a, b) / maxLen;
  }

  private levenshteinDistance(a: string, b: string): number {
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    const current = Array.from({ length: b.length + 1 }, () => 0);
    for (let i = 1; i <= a.length; i++) {
      current[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        current[j] = Math.min(
          current[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + cost,
        );
      }
      for (let j = 0; j <= b.length; j++) {
        previous[j] = current[j];
      }
    }
    return previous[b.length];
  }

  // Maps common STT mis-transcriptions of honorifics to their canonical
  // abbreviation form (after normalizeOptionText). Used only when no option
  // directly matches the raw input, so "Miss" in a form that has a "Miss"
  // option still maps correctly.
  private static readonly STT_HONORIFIC_ALIASES: Record<string, string> = {
    miss: "ms",
    miz: "ms",
    mss: "ms",
    misses: "mrs",
    missus: "mrs",
    mistress: "mrs",
    mister: "mr",
    shri: "mr",
    shree: "mr",
    sri: "mr",
  };

  private normalizeOptionQuery(
    value: string,
    options: Array<{ value: string; label: string }>,
  ): string {
    const normalized = this.normalizeOptionText(value);

    // If any option directly matches the raw normalized value, no aliasing needed.
    const hasDirectMatch = options.some(
      (o) =>
        this.normalizeOptionText(o.value) === normalized ||
        this.normalizeOptionText(o.label) === normalized,
    );
    if (hasDirectMatch) return normalized;

    // Apply STT honorific alias (e.g., "miss" → "ms") only when there's a
    // matching option for the alias target but no option for the raw value.
    const alias =
      V2VoiceFormService.STT_HONORIFIC_ALIASES[normalized];
    if (alias) {
      const hasAliasOption = options.some(
        (o) =>
          this.normalizeOptionText(o.value) === alias ||
          this.normalizeOptionText(o.label) === alias,
      );
      if (hasAliasOption) return alias;
    }

    return normalized;
  }

  private normalizeOptionText(value: string): string {
    return value
      .toLowerCase()
      .replace(/[०-९]/g, (digit) => String("०१२३४५६७८९".indexOf(digit)))
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9\u0900-\u097f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private optionTokens(value: string): string[] {
    return this.normalizeOptionText(value)
      .split(/\s+/)
      .filter((token) => token.length > 1 || /^\d$/.test(token));
  }

  private normalizeNumberWordToken(token: string): string {
    const numberWords: Record<string, string> = {
      zero: "0",
      oh: "0",
      one: "1",
      first: "1",
      two: "2",
      second: "2",
      too: "2",
      three: "3",
      third: "3",
      four: "4",
      fourth: "4",
      five: "5",
      fifth: "5",
      six: "6",
      sixth: "6",
      seven: "7",
      seventh: "7",
      eight: "8",
      eighth: "8",
      nine: "9",
      ninth: "9",
      ten: "10",
      tenth: "10",
      ek: "1",
      do: "2",
      teen: "3",
      char: "4",
      chaar: "4",
      panch: "5",
      paanch: "5",
      che: "6",
      chhe: "6",
      saat: "7",
      aath: "8",
      nau: "9",
      das: "10",
    };
    return numberWords[token] ?? token;
  }

  private isGenericOptionToken(token: string): boolean {
    return new Set([
      "class",
      "क्लास",
      "वर्ग",
      "category",
      "type",
      "option",
      "select",
      "value",
      "field",
      "my",
      "is",
      "it",
      "the",
      "a",
      "an",
      "of",
      "and",
      "or",
      "for",
      "to",
      "please",
      // Prepositions that often prefix all options in a group (e.g. "by name",
      // "by age", "by date") — they add no discriminating signal
      "by",
      "via",
      "with",
      "from",
      "at",
      "in",
      "on",
      "per",
      "as",
    ]).has(token);
  }

  private optionMatchesTarget(
    optionValue: string,
    optionLabel: string,
    targetValue: string,
  ): boolean {
    const target = this.normalizeOptionQuery(targetValue, [
      { value: optionValue, label: optionLabel },
    ]);
    if (!target) return false;
    const normalizedValue = this.normalizeOptionText(optionValue);
    const normalizedLabel = this.normalizeOptionText(optionLabel);
    if (normalizedValue === target || normalizedLabel === target) {
      return true;
    }
    const targetTokens = this.optionTokens(target);
    const optionTokens = new Set([
      ...this.optionTokens(normalizedValue),
      ...this.optionTokens(normalizedLabel),
    ]);
    const numericTargetTokens = targetTokens.filter((token) =>
      /^\d+$/.test(token),
    );
    if (
      numericTargetTokens.length > 0 &&
      !numericTargetTokens.every((token) => optionTokens.has(token))
    ) {
      return false;
    }
    return (
      this.scoreOptionMatch(targetTokens, {
        value: optionValue,
        label: optionLabel,
      }) >= 2
    );
  }

  // ─── Field State Helpers ──────────────────────────────────────────────────

  private getCustomDropdownDisplayValue(field: ExtractedFormField): string {
    if (!field.element || !isCustomDropdownElement(field.element)) {
      return "";
    }

    const selected = field.element.querySelector<HTMLElement>(
      ".ng-value-label, .ng-value, .ng-select-container .ng-value-container .ng-value",
    );
    const selectedText = selected?.textContent?.replace(/\s+/g, " ").trim();
    if (selectedText) {
      return selectedText;
    }

    const ariaText =
      field.element.getAttribute("aria-valuetext") ||
      field.element.getAttribute("data-selected-label") ||
      field.element.getAttribute("data-value");
    if (ariaText?.trim()) {
      return ariaText.trim();
    }

    const checkedOption = field.element.querySelector<HTMLElement>(
      "mat-radio-button.mat-radio-checked, [aria-selected='true'], .ng-option-selected",
    );
    const checkedText = checkedOption?.textContent?.replace(/\s+/g, " ").trim();
    return checkedText ?? "";
  }

  private isPendingField(field: ExtractedFormField): boolean {
    if (this.skippedFields.has(field.id)) {
      return false;
    }

    if (field.selectElement) {
      // Library successfully wrote a value → not pending.
      if (this.programmaticallyFilledFields.has(field.id)) return false;
      // User manually chose a value during the session → not pending.
      if (this.manuallyFilledFields.has(field.id)) return false;
      const current = field.selectElement.value;
      // Explicit empty-value placeholder → pending.
      if (!current) return true;
      // If the current value is still the browser-auto-selected default (initialValue),
      // the user hasn't interacted — treat as pending so the library asks.
      return current === (field.initialValue ?? "");
    }

    if (
      field.type === "select" &&
      field.element &&
      isCustomDropdownElement(field.element)
    ) {
      return (
        !this.programmaticallyFilledFields.has(field.id) &&
        !this.getCustomDropdownDisplayValue(field)
      );
    }
    if (field.textareaElement) {
      if (this.programmaticallyFilledFields.has(field.id)) return false;
      if (this.manuallyFilledFields.has(field.id)) return false;
      return !field.textareaElement.value.trim();
    }
    if (field.type === "radio" || field.type === "checkbox") {
      return !field.inputElements.some((i) => i.checked);
    }
    const first = field.inputElements[0];
    if (!first) return true;
    if (this.programmaticallyFilledFields.has(field.id)) return false;
    if (this.manuallyFilledFields.has(field.id)) return false;
    const current = first.value.trim();
    // If the current value is the same as the initial value recorded at scan
    // time (could be a server-prefilled value), treat the field as not pending
    // — the form already has an answer we shouldn't overwrite.
    const initial = (field.initialValue ?? "").trim();
    if (current && current !== initial) return false; // user/server changed it
    return !current; // empty → pending; same as initial → pending
  }

  private isFieldVisible(field: ExtractedFormField): boolean {
    if (!field.element) return false;
    let el: HTMLElement | null = field.element;
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

  private isFieldDisabled(field: ExtractedFormField): boolean {
    if (field.inputElements.length > 0) {
      return field.inputElements.some(
        (i) => i.disabled || (i.readOnly && field.type !== "date"),
      );
    }
    if (field.selectElement) {
      return field.selectElement.disabled;
    }
    if (field.textareaElement) {
      return field.textareaElement.disabled || field.textareaElement.readOnly;
    }
    // Check custom dropdown disabled states
    if (field.element) {
      if (
        field.element.classList.contains("ng-select-disabled") ||
        field.element.hasAttribute("disabled") ||
        field.element.getAttribute("aria-disabled") === "true"
      ) {
        return true;
      }
    }
    return false;
  }

  private isEmptyDropdown(field: ExtractedFormField): boolean {
    if (field.type !== "select") return false;
    if (field.selectElement) {
      const opts = Array.from(field.selectElement.options).filter(
        (o) => o.value && o.value !== "",
      );
      return opts.length === 0;
    }
    return !field.options || field.options.length === 0;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async speakAndEmit(text: string): Promise<void> {
    const translated = await this.maybeTranslate(text);
    const ttsText = formatTextForTts(translated);
    this.emitStatus(text);
    this.hooks.onSpeechSynthesis?.({ text: ttsText });

    this.currentQuestionFieldId = undefined;
    this.setListeningState(ListeningState.SPEAKING);

    try {
      await this.speech.speak(ttsText);
    } catch (err) {
      this.hooks.onError?.({
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }

    if (
      !this.stopRequested &&
      this.listeningState === ListeningState.SPEAKING
    ) {
      this.setListeningState(ListeningState.IDLE);
    }
  }

  private toDescriptor(field: ExtractedFormField): VoiceFormFieldDescriptor {
    const {
      element: _e,
      inputElements: _i,
      selectElement: _s,
      textareaElement: _t,
      ...rest
    } = field as ExtractedFormField & { element: HTMLElement };
    return rest as VoiceFormFieldDescriptor;
  }

  private snapshotFields(): VoiceFormFieldDescriptor[] {
    return this.fields.map((f) => this.toDescriptor(f));
  }

  private emitStatus(message: string): void {
    this.hooks.onStatus?.({ message });
  }

  private async maybeTranslate(text: string): Promise<string> {
    if (this.language === "en-IN") return text;
    try {
      return await this.translator.translatePrompt(text, this.language);
    } catch {
      return text;
    }
  }

  private resolveTranscriptGuardConfig(
    config: V2VoiceFormInitOptions["transcriptGuard"],
  ): TranscriptGuardSettings {
    if (config === false) {
      return {
        enabled: false,
        intervalMs: DEFAULT_TRANSCRIPT_GUARD_INTERVAL_MS,
      };
    }

    if (typeof config === "object" && config?.enabled === false) {
      return {
        enabled: false,
        intervalMs: this.normalizeTranscriptGuardInterval(config.intervalMs),
      };
    }

    const intervalMs =
      typeof config === "object" ? config.intervalMs : undefined;
    return {
      enabled: true,
      intervalMs: this.normalizeTranscriptGuardInterval(intervalMs),
    };
  }

  private normalizeTranscriptGuardInterval(intervalMs: unknown): number {
    if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs)) {
      return DEFAULT_TRANSCRIPT_GUARD_INTERVAL_MS;
    }
    return Math.min(
      Math.max(1, Math.floor(intervalMs)),
      MAX_TRANSCRIPT_GUARD_INTERVAL_MS,
    );
  }

  // ─── Provider Resolution ──────────────────────────────────────────────────

  private resolveSpeechProvider(): SarvamSpeechProvider {
    if (this.options.sarvamProxy) {
      return new SarvamHttpProxyProvider(this.options.sarvamProxy);
    }
    if (this.options.sarvamSpeech) {
      return new SarvamSpeechService(this.options.sarvamSpeech);
    }
    if (this.options.bhashiniProxy) {
      return this.options.bhashiniProxy.provider;
    }
    if (this.options.bhashiniSpeech) {
      return new BhashiniSpeechService(this.options.bhashiniSpeech);
    }
    throw new Error(
      "[V2VoiceFormService] One of sarvamSpeech, sarvamProxy, bhashiniSpeech, or bhashiniProxy must be provided in options.",
    );
  }

  private resolveRouter(): BedrockRouter {
    if (this.options.bedrock.proxy) {
      return new BedrockProxyRouter(this.options.bedrock.proxy);
    }
    if (this.options.bedrock.direct) {
      return new V2BedrockRouter({
        client: this.options.bedrock.direct.client,
        modelId: this.options.bedrock.direct.modelId,
        debug: this.debugLogs,
        sessionId: this.sessionId,
        onLLMCall: this.observability.onLLMCall,
      });
    }
    throw new Error(
      "[V2VoiceFormService] bedrock config must include either `direct` or `proxy`.",
    );
  }

  private resolveTranslator(): TranslatorLike {
    if (this.options.bedrock.proxy) {
      return new BedrockProxyTranslator({
        endpoint:
          this.options.bedrock.proxy.translatorUrl ??
          this.options.bedrock.proxy.routerUrl,
        fetchInit: this.options.bedrock.proxy.fetchInit,
      });
    }
    if (this.options.bedrock.direct) {
      return new BedrockTranslator({
        client: this.options.bedrock.direct.client,
        modelId: this.options.bedrock.direct.modelId,
        debug: this.debugLogs,
        sessionId: this.sessionId,
        onLLMCall: this.observability.onLLMCall,
      });
    }
    throw new Error(
      "[V2VoiceFormService] bedrock config must include either `direct` or `proxy`.",
    );
  }
}

// ─── Module-level helpers ─────────────────────────────────────────────────────