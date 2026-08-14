# Business Requirements Document (BRD)

**Project Name:** Voice Form Filling Library (`@myscheme/voice-form-filling`)
**Current Version:** 0.1.11
**Document Version:** 1.0
**Date:** 2026-05-27
**Document Owner:** Daffodil — myScheme Project

---

## 1. Document Purpose

This Business Requirements Document defines the complete set of business and functional requirements for the **Voice Form Filling Library**. It captures *what* the product must do (from a business and user-experience perspective) so that engineering, QA, product, and integration partners share a single, granular reference.

This BRD is intentionally **implementation-aware but technology-bounded**: voice (speech-to-text and text-to-speech) is restricted to **Microsoft Azure Cognitive Services Speech SDK** only. Any prior or alternative voice provider integrations (e.g., Sarvam, Bhashini) are explicitly **out of scope** for this document and the product version it describes.

---

## 2. Executive Summary

The Voice Form Filling Library is an embeddable TypeScript library that turns any standard HTML form on a web page into a **voice-driven, conversational experience**. A user clicks "Start", the library:

1. Reads the form's structure (fields, labels, options, validations) from the DOM.
2. Asks each question aloud using Azure Text-to-Speech.
3. Listens to the user via Azure Speech-to-Text.
4. Sends the spoken answer plus the field context to **Amazon Bedrock (Anthropic Claude)** to intelligently map the answer to the correct field(s).
5. Writes the chosen value back to the DOM, validates it, and moves on.

The library is **framework-agnostic** (works with Angular, React, Vue, vanilla JS), supports **English and Hindi**, and is designed to be integrated into citizen-facing portals (such as scheme application forms) where users may prefer or require voice input.

---

## 3. Business Objectives

| ID    | Objective                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------ |
| BO-01 | Reduce form-filling friction for users with low literacy, visual impairment, or mobility constraints.                    |
| BO-02 | Increase form-completion rates on long, multi-step government / scheme application forms.                                |
| BO-03 | Provide a bilingual (English + Hindi) voice interface aligned with Indian citizen-service portals.                       |
| BO-04 | Deliver the capability as a drop-in library, requiring minimal changes to existing host application code.                |
| BO-05 | Ensure intelligent, fault-tolerant answer-to-field mapping so users can speak naturally rather than memorize exact terms. |
| BO-06 | Support a secure production deployment model (proxy-based AWS credential handling).                                      |

---

## 4. Stakeholders

| Stakeholder              | Interest                                                          |
| ------------------------ | ----------------------------------------------------------------- |
| End User (citizen)       | Easy, accurate voice form filling in their preferred language.    |
| Host Application Team    | Simple integration API; predictable hooks; no UI lock-in.         |
| myScheme Product Team    | Improved conversion and accessibility metrics.                    |
| QA Team                  | Clear, testable acceptance criteria per feature.                  |
| DevOps / Security        | Safe handling of Azure and AWS credentials; no secrets in client. |
| Internal Library Authors | A clean public API surface and maintainable contract.             |

---

## 5. Glossary

| Term                       | Definition                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| **STT**                    | Speech-to-Text. Converting spoken audio into a text transcript (provided by Azure).                     |
| **TTS**                    | Text-to-Speech. Converting text into spoken audio (provided by Azure).                                  |
| **Bedrock**                | Amazon Bedrock, the AWS service hosting Anthropic Claude LLMs used for answer routing.                  |
| **Field Routing**          | The act of the LLM deciding *which* form field a free-text answer belongs to.                           |
| **Multi-Step Form**        | A form split across visual tabs or sections, completed in stages.                                       |
| **Special Command**        | A spoken control phrase (e.g., "reset", "quit", "finish") that controls the flow rather than answering. |
| **UI Hook**                | A user-supplied callback the library invokes at key lifecycle events.                                   |
| **Controller**             | The object returned by `initializeVoiceForm()` exposing `start`, `stop`, etc.                           |
| **Field Descriptor**       | The library's internal structured representation of a single form input.                                |
| **Manual Entry Detection** | The library noticing that the user typed or clicked a value while voice flow was active.                |

---

## 6. Scope

### 6.1 In Scope

- A TypeScript / JavaScript embeddable library distributed via npm and `.tgz`.
- Voice STT and TTS exclusively via **Microsoft Azure Cognitive Services Speech SDK**.
- LLM-powered answer routing exclusively via **Amazon Bedrock (Anthropic Claude 3 family — Haiku / Sonnet / Opus)**.
- Two languages: **English (en-US)** and **Hindi (hi-IN)**.
- Standard HTML form elements plus selected custom dropdown components used in myScheme forms.
- Multi-step / tabbed forms.
- A self-contained demo page for evaluation and QA.

### 6.2 Out of Scope (Explicit Exclusions)

- **Sarvam AI** voice provider — explicitly excluded by stakeholder direction. Any existing `sarvamSpeech.ts` artifact, references in `types.ts`, sample code, or supporting documentation files (`SARVAM_*.md`) must be excluded from this product release. (See [FR-CFG-005](#fr-cfg-005-azure-only-speech-provider).)
- **Bhashini** voice provider — excluded for the same reason. Any existing `bhashiniSpeech.ts` artifact and references must be excluded.
- Languages other than English and Hindi.
- Server-side rendering of form-filling sessions.
- Offline / on-device speech recognition.
- Form *submission* (the library fills fields; the host application submits).
- Authentication, authorization, or user identity (host application owns these).
- Persistence of filled answers between sessions.

---

## 7. Assumptions

| ID    | Assumption                                                                                                |
| ----- | --------------------------------------------------------------------------------------------------------- |
| AS-01 | The host page is served over **HTTPS** (or `localhost`) so the browser will grant microphone permission.  |
| AS-02 | The host application provides a valid Azure Speech subscription key + region.                             |
| AS-03 | The host application either provides AWS credentials in-browser (dev) or a backend proxy (prod).          |
| AS-04 | The host page contains a valid HTML form reachable via a CSS selector.                                    |
| AS-05 | The user is on a modern browser (Chrome, Edge, Safari, Firefox) with microphone hardware.                 |
| AS-06 | The user speaks one of the supported languages (English or Hindi) during the session.                     |
| AS-07 | The host application implements `onResetRequested` if it wants the voice "reset" command to work.         |
| AS-08 | Custom dropdown components used by the host follow one of the supported patterns (see [FR-FE-002](#fr-fe-002-custom-dropdown-extraction)). |

---

## 8. Functional Requirements

Functional requirements are grouped by domain. Each requirement is uniquely numbered (`FR-<DOMAIN>-NNN`) so it can be referenced individually in user stories, test cases, and traceability matrices.

Domain codes:

- **VRC** — Voice Recognition (STT)
- **TTS** — Text-to-Speech
- **FE** — Form Extraction
- **AI** — AI Routing / LLM
- **LANG** — Language & Localization
- **CMD** — Voice Commands
- **FLOW** — Form Flow
- **VAL** — Validation
- **MAN** — Manual Entry Handling
- **STEP** — Multi-Step Navigation
- **UI** — UI Hooks
- **CFG** — Configuration / Public API
- **ERR** — Error Handling & Retry
- **DBG** — Debugging & Observability

---

### 8.1 Voice Recognition (Azure STT)

#### FR-VRC-001: Azure Speech SDK as Sole STT Provider

The library **must** perform speech recognition exclusively via the official Microsoft `microsoft-cognitiveservices-speech-sdk` package. No alternative STT provider may be enabled in this release.

#### FR-VRC-002: Subscription-Key Configuration

The library **must** accept `subscriptionKey` and `region` via `VoiceFormInitOptions.azureSpeech`. Both are required when voice features are used.

#### FR-VRC-003: Microphone Permission Handling

When `start()` is called, the library **must** request microphone access through the standard `navigator.mediaDevices` interface. If permission is denied, it **must** emit `onError` with a descriptive `Error` object and stop the flow gracefully.

#### FR-VRC-004: Secure Context Validation

Before initialization, the library **must** validate that the page is a secure context (HTTPS or `localhost`). If not, it **must** emit `onError` explaining microphone access requires HTTPS.

#### FR-VRC-005: Phrase List Grammar Injection

Before listening for a specific field, the library **must** inject field-specific hints (option labels, expected codes) into Azure's phrase-list grammar to improve recognition accuracy for that field.

#### FR-VRC-006: Dictation Mode

The Azure recognizer **must** be configured in dictation mode to reduce automatic numeric/date formatting that would otherwise corrupt extracted values.

#### FR-VRC-007: Partial Transcript Streaming

While the user is speaking, the library **must** emit interim transcripts to the host via `onTranscript({ text, isFinal: false })`.

#### FR-VRC-008: Final Transcript Emission

When the user stops speaking (silence threshold reached), the library **must** emit `onTranscript({ text, isFinal: true })` with the final recognized text.

#### FR-VRC-009: Inter-Word Silence Timeout

The library **must** treat **2.5 seconds** (configurable internally as `SILENCE_TIMEOUT_MS`) of silence after the first word as end-of-utterance.

#### FR-VRC-010: Initial Silence Timeout

The library **must** allow up to **8 seconds** of initial silence (before any word is spoken) before treating it as a no-response event.

#### FR-VRC-011: Microphone Release on Stop

When the flow is stopped (via `stop()`, "quit", "finish", or completion), the library **must** explicitly release the microphone resource.

#### FR-VRC-012: Concurrent Speech Tolerance

If a user begins speaking while the assistant is still announcing a prompt, the library **must not** crash; either it ignores the input until announcement finishes or queues it appropriately.

---

### 8.2 Text-to-Speech (Azure TTS)

#### FR-TTS-001: Azure TTS Voice Selection per Language

The library **must** select an appropriate Azure neural voice for each supported language (English voice for `en-US`, Hindi voice for `hi-IN`).

#### FR-TTS-002: Audio Playback Lifecycle

Synthesized audio **must** be played back, and the underlying audio element and blob URL **must** be cleaned up after playback to prevent memory leaks.

#### FR-TTS-003: Force-Stop on New Prompt

When a new prompt needs to be spoken, any in-progress TTS playback **must** be force-stopped before the new audio begins, preventing overlap.

#### FR-TTS-004: Pre-Speech Event Emission

Before speech audio begins playing, the library **must** emit `onSpeechSynthesis({ text })` so the host UI can display the upcoming prompt text immediately (not waiting for audio completion).

#### FR-TTS-005: Speak-and-Stop Utility

The library **must** expose `controller.announceAndStop(message)` which speaks a final message and then stops the flow (used for graceful exit scenarios).

---

### 8.3 Form Extraction

#### FR-FE-001: Standard HTML Element Support

The extractor **must** detect and produce field descriptors for all of:

- `<input type="text">`
- `<input type="number">`
- `<input type="email">`
- `<input type="tel">`
- `<input type="date">`
- `<input type="radio">` (grouped by name)
- `<input type="checkbox">` (single or grouped)
- `<select>`
- `<textarea>`

#### FR-FE-002: Custom Dropdown Extraction

The extractor **must** support the following non-native dropdown patterns commonly used in the host application:

- `ng-select` (Angular)
- `searchable-dropdown`
- `dynamic-dropdown-input`
- `dynamic-select`
- `dynamic-select-input`
- Elements with ARIA `role="combobox"` or `role="listbox"`
- Mobile bottom-drawer pattern (`app-mobile-view-list`)

For each, all available options **must** be extracted along with their value and visible label.

#### FR-FE-003: Label Resolution Priority

The extractor **must** discover a field's user-facing label by trying, in order:

1. `aria-label`
2. `data-label`
3. The closest `<label>` element (including `for`/`id` association)
4. `aria-labelledby` reference
5. A `<dynamic-label>` component
6. A prettified version of the `name` attribute as fallback

#### FR-FE-004: Constraint Capture

The extractor **must** capture, where present:

- `required`
- `minLength` / `maxLength`
- `pattern` (regex)
- `min` / `max` (numeric)
- `step` (numeric)

#### FR-FE-005: Disabled Field Detection

Fields **must** be excluded from the voice flow if they are visibly disabled — including elements with the `disabled` attribute, `ng-select-disabled` class, `aria-disabled="true"`, or disabled combobox state. `readonly` alone **must not** mark a field as disabled.

#### FR-FE-006: Hidden Field Skipping

Fields that are not visible (`display:none`, `visibility:hidden`, `hidden` attribute, zero dimensions) **must** be skipped, and the extractor **must** re-evaluate visibility as the form mutates.

#### FR-FE-007: Empty-Options Dropdown Handling

If a dropdown currently has zero options (typically because it depends on another field that has not been answered yet), the library **must** gracefully skip it rather than asking an unanswerable question.

#### FR-FE-008: Angular Material Datepicker Recognition

A text input bound to an Angular Material `mat-calendar` **must** be re-classified as a `date` field, not `text`.

#### FR-FE-009: DOM Order Preservation

Extracted fields **must** be ordered by visual DOM position (via `compareDocumentPosition`) so the voice flow proceeds top-to-bottom on screen.

#### FR-FE-010: Dropdown Loading Wait

When opening a custom dropdown, the library **must** wait up to **4 seconds** for asynchronously loaded options to appear before extracting them.

#### FR-FE-011: Field Grouping Metadata

For radio groups, checkbox groups, or grouped custom controls, each descriptor **must** carry `groupId`, `groupLabel`, and `groupIndex` so the host can present them coherently.

---

### 8.4 AI Routing (Amazon Bedrock)

#### FR-AI-001: Bedrock as Sole Routing LLM

Answer routing **must** be performed via Amazon Bedrock invoking an Anthropic Claude 3 model (Haiku, Sonnet, or Opus). The configured `modelId` defaults to `anthropic.claude-3-haiku-20240307`.

#### FR-AI-002: Direct Client or Proxy Router

The library **must** accept either:

- A `BedrockRuntimeClient` instance (for development / trusted environments), or
- A custom `BedrockRouter` implementation pointing at a backend proxy (recommended for production).

#### FR-AI-003: Multi-Field Extraction in One Utterance

If the user provides answers to multiple fields in a single sentence (e.g., "I am Hindu, income 50000, unmarried"), the LLM **must** be able to assign values to each respective field in one call.

#### FR-AI-004: Special Command Detection with Confidence

The LLM **must** detect "reset", "quit", and "finish" commands and return them as `specialCommand` with a numeric `confidence` value. The library **must** act on the command only when confidence is **≥ 0.7**.

#### FR-AI-005: Phonetic Matching

The LLM prompt **must** include rules for handling common phonetic confusions caused by STT misrecognition — for example, "General" vs "Journal", "Sikh" vs "Sick".

#### FR-AI-006: Indian Category Code Expansion

The LLM **must** treat short category codes (SC, ST, OBC, ST-PVGT, etc.) and their long-form equivalents ("Scheduled Caste", "Other Backward Class", etc.) as equivalent when matching dropdown options.

#### FR-AI-007: Hindi-to-English Option Mapping

When the user answers in Hindi or Devanagari script (e.g., "अनारक्षित", "अविवाहित"), the LLM **must** translate semantically and choose the correct English-labelled option value.

#### FR-AI-008: Fuzzy Matching for Dropdown Options

Dropdown answers **must** be matched against options using **70%+ string similarity** so noisy or imperfect speech still resolves correctly.

#### FR-AI-009: Exact-Value Output for Selects

For select-type fields, the LLM **must** return a character-for-character match to the option's `value`, so the value can be successfully assigned by the DOM.

#### FR-AI-010: Short-Code Exact Match Priority

For 2–3 letter option codes (e.g., "ST"), exact whole-string match **must** be attempted before any longer-code expansion (e.g., must not collapse "ST" into "ST-PVGT").

#### FR-AI-011: Confidence Scoring on Assignments

Each `FieldAssignment` returned **must** include a `confidence` (0.0–1.0). Phonetic and translation-based matches **must** be ≥ 0.85.

#### FR-AI-012: Text Normalization

The LLM **must** strip conversational prefixes ("My name is…", "I live in…"), filler words, and trailing punctuation before assigning a value — except for fields where punctuation is meaningful (addresses, etc.).

#### FR-AI-013: Numeric Field Handling

For numeric-type fields, the LLM **must** extract only digits and strip stray formatting introduced by STT (e.g., turning "1,000." into "1000").

#### FR-AI-014: Address Field Preservation

For address-related fields (house, street, flat, door, building, plot, block), special characters and slashes (e.g., "4/23") **must** be preserved.

#### FR-AI-015: Date Normalization

Date answers **must** be normalized to `DD/MM/YYYY` format before assignment.

#### FR-AI-016: Two-Tier Validation Pass

Initial LLM assignments **must** undergo a verification pass for ambiguous or low-confidence select mappings before being applied.

#### FR-AI-017: Deterministic Gap-Fill

After the LLM responds, a local deterministic matcher **must** fill in any fields the LLM skipped if high-confidence local evidence (exact word match) is available.

#### FR-AI-018: Local Fast-Route Bypass

For simple, high-confidence local cases (a pure numeric answer for a number field, a clear email for an email field, a parseable date for a date field), the library **must** be permitted to bypass the LLM call entirely for performance.

#### FR-AI-019: Edit Mode Prompt

When the user is editing an already-completed field, the LLM **must** be called with a distinct edit-mode prompt that focuses on "which field" + "new value" extraction.

#### FR-AI-020: Contextual Follow-Up

When the LLM cannot map a user input confidently, it **may** return a `followUp` string that the library speaks to the user to clarify (e.g., "Sorry, did you mean General or Journal?").

---

### 8.5 Language & Localization

#### FR-LANG-001: Supported Languages

The library **must** support exactly two languages: **English (`en-US`)** and **Hindi (`hi-IN`)**. No other language is in scope.

#### FR-LANG-002: Initial Language Selection

The active language **must** be selectable via `VoiceFormInitOptions.language`, with `en-US` as the default if not specified.

#### FR-LANG-003: Default-Language Fallback

A `defaultLanguage` option **must** be accepted so the host can specify a fallback used if the primary language is unavailable.

#### FR-LANG-004: Runtime Language Switching

The library **must** expose `controller.setLanguage(language)` to switch language without requiring re-initialization.

#### FR-LANG-005: Fully Localized System Messages

All user-facing system messages (prompts, errors, confirmations, status updates) **must** be available in both supported languages.

#### FR-LANG-006: Devanagari Script Recognition

Hindi input written or transcribed in Devanagari script **must** be accepted and routed correctly to English-labelled options when applicable.

---

### 8.6 Voice Commands

#### FR-CMD-001: Reset Command

The user **must** be able to say "reset", "reset the form", or "start over" to request a form reset.

#### FR-CMD-002: Reset Voice Confirmation

Upon detecting a reset command, the library **must** ask via voice "Are you sure you want to reset the entire form?" and wait for an affirmative response before proceeding.

#### FR-CMD-003: Reset Delegation via Hook

The library **must not** reset DOM fields directly. After voice confirmation, it **must** invoke the `onResetRequested` UI hook, delegating the actual reset to the host application.

#### FR-CMD-004: Post-Reset Flow Restart

After a confirmed reset, the library **must** restart the voice flow from the first field of the first step and announce "Form has been reset. All fields have been cleared. Let's start from the beginning."

#### FR-CMD-005: Quit / Finish Commands

The user **must** be able to say "quit", "stop", "finish", or "I want to quit" to end the voice flow.

#### FR-CMD-006: Quit Voice Confirmation

Upon detecting a quit/finish command, the library **must** ask "Are you sure you want to quit?" and wait for affirmative response.

#### FR-CMD-007: Quit Outcome Hook

After quit confirmation (positive or negative), the library **must** emit `onQuit({ confirmed, reason })` to the host so it can navigate, persist, or display state as needed.

#### FR-CMD-008: Yes/No Confirmation Vocabulary

Affirmative responses **must** include at least: "yes", "yeah", "continue", "haan" (Hindi). Negative responses **must** include at least: "no", "nope", "stop", "nahi" (Hindi).

#### FR-CMD-009: Command Recognition Threshold

A special command **must** only be triggered when LLM confidence is ≥ 0.7; below that threshold, the input **must** be treated as a regular field answer.

---

### 8.7 Form Flow

#### FR-FLOW-001: Initialization

`initializeVoiceForm()` **must** extract all fields and prepare the speech and routing layers before returning a `VoiceFormController`.

#### FR-FLOW-002: Auto-Start Option

If `autoStart` is `true` (the default), the library **must** call `start()` automatically after initialization. If `false`, the host must explicitly call `controller.start()`.

#### FR-FLOW-003: Sequential Field Asking

By default, the library **must** ask one question per unanswered, visible, enabled field in DOM order.

#### FR-FLOW-004: All Options Read for Dropdowns

For dropdown / select fields, the library **must** read **all** available options aloud, not a truncated subset.

#### FR-FLOW-005: Already-Filled Field Detection

If a field already has a valid value when the flow reaches it, the library **must** automatically accept that value and move on. If the existing value is invalid, the library **must** clear it and re-ask.

#### FR-FLOW-006: Field Skip on Manual Entry

See [FR-MAN-001](#fr-man-001-detect-manual-changes).

#### FR-FLOW-007: Move-to-Next Announcements

After successfully filling a field, the library **must** emit a status message of the form "Moving to {next field}" via `onStatus`.

#### FR-FLOW-008: Completion Behavior

When all fields are filled, the library **must** emit "All fields completed successfully!" and offer a final review pass.

#### FR-FLOW-009: Final Review / Edit Pass

After completion, the user **must** be able to say which field to change and what the new value should be; the library **must** route that utterance via the edit-mode LLM prompt and update the field accordingly.

#### FR-FLOW-010: Restart After Stop

After `stop()` or a confirmed quit, the user **must** be able to call `start()` again on the same controller to resume the flow.

---

### 8.8 Validation

#### FR-VAL-001: Required Field Enforcement

A field marked `required` **must not** be skipped; if the user provides no value, the library **must** announce "This field is required" and re-ask.

#### FR-VAL-002: Min / Max Length Validation

If a value violates `minLength` or `maxLength`, the library **must** announce e.g., "Should be at least N characters" / "Should be no more than M characters" and re-ask.

#### FR-VAL-003: Pattern Validation

If a value violates `pattern` (regex), the library **must** announce "Does not match expected format" and re-ask.

#### FR-VAL-004: Numeric Range Validation

For number fields, `min`, `max`, and `step` **must** be enforced; violations **must** be announced with a corrective message.

#### FR-VAL-005: Type Validation

The library **must** verify the value matches the declared field type (`number`, `email`, `tel`, `date`) and re-ask on mismatch with a type-specific message ("must be a valid email", etc.).

#### FR-VAL-006: Exact-Digit-Count Validation

For fields whose pattern enforces an exact digit count (e.g., OTP, Aadhaar), the library **must** announce "Should be exactly N digits" on violation.

#### FR-VAL-007: DOM Validation Error Surfacing

If the host application's validation logic (CSS error classes, error message nodes) flags an error after assignment, the library **must** announce the error and re-ask the field.

---

### 8.9 Manual Entry Handling

#### FR-MAN-001: Detect Manual Changes

The library **must** observe form mutations and detect when the user types or selects a value manually while voice flow is active.

#### FR-MAN-002: Skip Manually Filled Field

If the user manually fills the *currently active* field while the assistant is asking about it, the library **must** skip the question and proceed to the next field.

#### FR-MAN-003: Allow Concurrent Manual Entry

The user **must** be able to manually fill other (non-active) fields without interrupting the voice flow; those fields **must** then be detected and skipped when their turn arrives.

---

### 8.10 Multi-Step Navigation

#### FR-STEP-001: Tab / Section Detection

The library **must** auto-detect that a form is divided into tabs or sections and treat each as a navigable step.

#### FR-STEP-002: Step Change Notification

When the active step changes, the library **must** emit `onStepChange({ stepId, label, index, fieldIds })`.

#### FR-STEP-003: Step Completion Confirmation

After completing all fields in a step, the library **must** ask "Move to the next section?" and wait for yes/no.

#### FR-STEP-004: Step-Aware Field Discovery

Field extraction **must** be redone (or refreshed) after a tab change, since new tabs frequently introduce new fields into the DOM.

---

### 8.11 UI Hooks

The library **must** invoke the following callbacks (when provided by the host) at the appropriate lifecycle moments. All hooks are optional except where noted.

| Hook                  | Trigger                                                                                |
| --------------------- | -------------------------------------------------------------------------------------- |
| `onPrompt`            | Library is about to ask a question; payload includes the prompt text and `fieldId`.    |
| `onSpeechSynthesis`   | The assistant is about to speak any text (questions, status, confirmations).           |
| `onTranscript`        | The library has interim or final transcribed text from the user.                       |
| `onAssignment`        | A field has been successfully assigned a value.                                        |
| `onStatus`            | A status message (e.g., "Skipped {field}", "Moving to {field}", started/stopped).      |
| `onError`             | Any error condition (permission denied, network failure, etc.).                        |
| `onStepChange`        | The active form step has changed.                                                      |
| `onFieldsExtracted`   | Initial (or post-step-change) field extraction has completed.                          |
| `onQuit`              | User confirmed (or cancelled) a quit/finish command, including auto-quit on no-response. |
| `onResetRequested`    | **Critical** — User confirmed a reset; host must perform the actual DOM reset.         |

#### FR-UI-001: Hook Reliability

All hooks **must** be invoked synchronously when possible and at predictable points so the host UI stays in sync.

#### FR-UI-002: Reset Hook is Critical

The library **must not** perform DOM-level form reset itself. Hosts that do not implement `onResetRequested` will experience a no-op reset; the library **must** still announce success/failure honestly.

#### FR-UI-003: Async Hook Support

`onResetRequested` **must** accept both sync and async (Promise-returning) implementations; the library waits for the promise before resuming.

#### FR-UI-004: No Visual Dialogs Required

The library **must not** render any DOM elements of its own. All visible UI is the host's responsibility, driven by hooks.

---

### 8.12 Configuration & Public API

#### FR-CFG-001: `initializeVoiceForm` Entry Point

The single public initialization function **must** be `initializeVoiceForm(options): Promise<VoiceFormController>`.

#### FR-CFG-002: VoiceFormController Surface

The returned controller **must** expose:

- `start(): Promise<void>`
- `stop(): Promise<void>`
- `announceAndStop(message: string): Promise<void>`
- `setLanguage(language): Promise<void>`
- `getExtractedFields(): VoiceFormFieldDescriptor[]`
- `debug` API for diagnostic field inspection

#### FR-CFG-003: Required Configuration

`formSelector`, `azureSpeech` (with `subscriptionKey` and `region`), and `bedrock` (with at least `modelId` and either `client` or `router`) **must** be required.

#### FR-CFG-004: Optional Configuration

`uiHooks`, `autoStart`, `language`, `defaultLanguage`, and `debug` **must** be optional with sensible defaults.

#### FR-CFG-005: Azure-Only Speech Provider

The library, as configured in this release, **must** only accept `azureSpeech` as the speech provider. Any code paths, types, or examples referencing non-Azure speech providers (e.g., Sarvam, Bhashini) **must be removed** from:

- `src/types.ts` (the `SpeechProvider` type and `bhashiniSpeech`/`sarvamSpeech` config fields)
- `src/index.ts` (re-exports of non-Azure config types)
- `src/VoiceFormService.ts` (any branching logic that delegates to a non-Azure provider)
- Project root markdown (`SARVAM_*.md` and `SARVAM_TODO.md`)
- `package.json` dependencies (`sarvamai` package)

#### FR-CFG-006: Public Type Exports

The library **must** export all public TypeScript types (`VoiceFormInitOptions`, `VoiceFormController`, `UiHooks`, `VoiceFormFieldDescriptor`, `BedrockRouter`, `BedrockRouterConfig`, `BedrockRoutingRequest`, `BedrockRoutingResponse`, `FieldAssignment`, `SupportedLanguage`) for downstream consumer typing.

---

### 8.13 Error Handling & Retry

#### FR-ERR-001: Retry on Empty Input

If the user gives no recognizable speech for a field, the library **must** retry up to **3 times** before treating it as a no-response event.

#### FR-ERR-002: Retry on Invalid Input

If validation fails on a user-provided value, the library **must** re-ask the question with a corrective message and accept a new value.

#### FR-ERR-003: Auto-Quit on No Response

After the configured retry attempts with no usable input, the library **must** announce that the session is ending and emit `onQuit({ confirmed: true, reason: "no-response" })`.

#### FR-ERR-004: LLM Failure Recovery

If the Bedrock call fails (network, throttle, etc.), the library **must** emit `onError` and either fall back to deterministic local matching or retry once with backoff.

#### FR-ERR-005: Microphone Permission Failure

A denied microphone permission **must** emit `onError` with a clear, user-actionable message and abort the flow cleanly.

#### FR-ERR-006: Initialization Failure

If `initializeVoiceForm()` fails (invalid selector, missing keys), it **must** reject the returned promise with a descriptive `Error` rather than throw silently.

---

### 8.14 Debugging & Observability

#### FR-DBG-001: Extracted Fields Inspection

The library **must** expose `controller.getExtractedFields()` and a top-level `getLatestExtractedFields()` for QA / integration debugging.

#### FR-DBG-002: Optional Verbose Logging

When `debug.logExtractedFields` is `true`, the library **must** emit detailed console logs covering extraction, LLM payloads, and assignment processing.

#### FR-DBG-003: Demo Application

A self-contained demo (under `/demo`) **must** exist that:

- Renders a sample multi-step form covering text, number, date, select, radio, checkbox, and textarea fields.
- Loads Azure and Bedrock credentials from environment variables.
- Wires all UI hooks to a visible log so each library event is observable.
- Provides Start, Stop, and Language-switch controls.

---

## 9. Non-Functional Requirements

| ID     | Requirement                                                                                                                                          |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-01 | **Performance — Silence Detection:** End-of-utterance detected within 2.5 s of user silence.                                                         |
| NFR-02 | **Performance — LLM Routing:** A typical Bedrock routing call **should** return in under 1 s for Claude 3 Haiku.                                     |
| NFR-03 | **Performance — Dropdown Loading:** Up to 4 s tolerance for asynchronously loaded custom dropdown options.                                           |
| NFR-04 | **Browser Support:** Latest stable versions of Chrome, Edge, Safari, and Firefox.                                                                    |
| NFR-05 | **Node Support (Build):** Node 18 or higher for building the library.                                                                                |
| NFR-06 | **Security — No Long-Lived AWS Secrets in Browser:** Production deployments **must** use a backend proxy router. The library must support this mode. |
| NFR-07 | **Security — HTTPS Requirement:** The library will refuse to start on non-secure origins (except `localhost`).                                       |
| NFR-08 | **Maintainability:** The library is written in TypeScript with strict type definitions for the public API.                                           |
| NFR-09 | **Framework Independence:** The library **must** function with vanilla JS, Angular, React, or Vue without framework-specific dependencies.           |
| NFR-10 | **Footprint:** Distributed as a single npm package; no runtime UI assets bundled.                                                                    |
| NFR-11 | **Accessibility:** All flows must be fully usable without ever touching the keyboard or mouse after pressing Start.                                  |
| NFR-12 | **Internationalization:** Hindi support **must** include both Devanagari and romanized input transcripts.                                            |

---

## 10. Technical & Integration Requirements

| ID    | Requirement                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| TR-01 | **Azure Speech SDK:** `microsoft-cognitiveservices-speech-sdk` version ≥ 1.47 is the supported STT/TTS dependency.                                |
| TR-02 | **AWS Bedrock SDK:** `@aws-sdk/client-bedrock-runtime` is the supported LLM transport.                                                            |
| TR-03 | **Default Model:** Default Bedrock model ID is `anthropic.claude-3-haiku-20240307`; Sonnet and Opus are also supported.                           |
| TR-04 | **Distribution:** The library is built with `tsc` and published as both a tarball (`*.tgz`) and an npm package under the `@myscheme` scope.       |
| TR-05 | **Environment Variables (Demo):** The demo reads `VITE_AZURE_SPEECH_KEY`, `VITE_AZURE_SPEECH_REGION`, `VITE_BEDROCK_MODEL_ID`, `VITE_BEDROCK_REGION`, and AWS credentials from `.env`. |
| TR-06 | **No DOM Pollution:** The library **must not** inject styles or DOM elements into the host page.                                                  |
| TR-07 | **Public API Stability:** Breaking changes to the public API **must** be reflected in a major-version bump.                                       |
| TR-08 | **Proxy Router Contract:** Hosts using a backend proxy implement `BedrockRouter.routeAnswer(input)` and pass it via `bedrock.router`.             |

---

## 11. Acceptance Criteria

The library is considered acceptance-ready when the following hold true on the demo application and any integrating host:

1. A user can start the voice flow, hear an Azure-spoken prompt, answer each field by voice, and see values applied to the correct DOM fields.
2. Both English and Hindi sessions complete successfully on the same demo form.
3. "Reset" command triggers the `onResetRequested` hook after voice confirmation; the form is cleared by the host implementation; the flow restarts.
4. "Quit" / "Finish" command exits the flow after voice confirmation and releases the microphone.
5. Multi-field utterances ("I am Hindu, income 50000, unmarried") populate all three fields in a single round.
6. Validation errors (required, min/max length, pattern, type, range) are announced clearly and re-prompted.
7. Manual entry into a non-active field is detected; that field is skipped when its turn arrives.
8. Multi-step forms advance through tabs with a yes/no prompt at each boundary.
9. The library exposes no Sarvam or Bhashini types, code paths, or documentation in the shipped artifact.
10. The library refuses to operate on a non-HTTPS, non-localhost origin and surfaces a clear `onError`.
11. Microphone-denied scenarios surface `onError` without leaving the page in an indeterminate state.
12. `getExtractedFields()` returns a complete, accurate descriptor list for the demo form's fields.
13. The README, demo, and exported types reference **only** Azure as the speech provider.

---

## 12. Open Items / Future Considerations (Informational Only)

The items below are explicitly **not** part of this BRD's required scope; they are recorded for product-team awareness only.

- Adding support for additional Indian languages beyond Hindi.
- An optional on-device fallback for STT when Azure is unreachable.
- Telemetry / analytics hooks (`onLatency`, `onUsage`) for production observability.
- Server-side rendering / hydration patterns for SPA hosts.

---

## 13. Document Revision History

| Version | Date       | Author            | Summary                                                                                       |
| ------- | ---------- | ----------------- | --------------------------------------------------------------------------------------------- |
| 1.0     | 2026-05-27 | Daffodil / Claude | Initial granular BRD. Voice scope restricted to Azure only; Sarvam and Bhashini explicitly out of scope. |
