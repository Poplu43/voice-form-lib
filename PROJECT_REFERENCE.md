# Project Reference — `@myscheme/voice-form-filling`

> A complete, file-by-file developer reference for the Voice Form Filling library.
> Reading this document end-to-end should give you full understanding of the
> codebase: what every file is for, the functions it contains, what they do, what
> they use, and how the pieces fit together.
>
> **Scope note:** The library also ships a Bhashini speech provider in v1
> (`src/v1/bhashiniSpeech.ts`). Per the documentation request, Bhashini is **out
> of scope** and is intentionally not documented here. Where v1 code references
> Bhashini it is mentioned only in passing.

---

## 1. What this project is

`@myscheme/voice-form-filling` is a **browser library** that overlays a
conversational voice assistant onto an existing HTML `<form>`. Given a CSS
selector for a form, it:

1. **Extracts** the form's fields from the DOM (including custom Angular/widget
   dropdowns), grouping them into steps/tabs.
2. **Speaks** a prompt for each field (Text-To-Speech).
3. **Listens** to the user's spoken answer (Speech-To-Text).
4. **Routes** the transcript through an LLM on **Amazon Bedrock (Claude)** to map
   the answer to the correct field(s) and produce clean values.
5. **Validates** the value against the field's constraints and **writes** it back
   into the DOM.
6. Handles **voice commands** (reset / quit / finish), **multi-field answers**,
   **manual-entry detection**, **multi-step navigation**, and a **final
   review/edit** phase.

### Two API generations

The library ships **two generations** behind one package:

| | **v1** (legacy) | **v2** (new) |
|---|---|---|
| Speech (STT/TTS) | Azure Cognitive Services (also Bhashini, Sarvam) | **Sarvam AI** (live STT + streaming TTS) |
| Answer routing | Amazon Bedrock (`AwsBedrockRouter`) | Amazon Bedrock (`V2BedrockRouter` or proxy) |
| Translation | — | Amazon Bedrock translator (label/option translation into Indian languages) |
| Languages | `en-US`, `hi-IN` | 11 Indian languages (`en-IN`, `hi-IN`, `bn-IN`, …) |
| Source dir | `src/v1/` | `src/v2/` |

`src/index.ts` is a thin **top-level router** that dispatches to v1 or v2 based on
the config the caller supplies, and also exposes both under `v1` / `v2`
namespaces.

### Tech stack

- **TypeScript**, compiled with `tsc` to `dist/` (ESM).
- **Vite** for the local demos / dev server.
- Runtime deps: `@aws-sdk/client-bedrock-runtime` (Bedrock), `sarvamai` (v2
  speech), `wavtools` (mic capture), `microsoft-cognitiveservices-speech-sdk`
  (v1 Azure), `@ricky0123/vad-web`, `socket.io-client`.

---

## 2. Top-level directory map

```text
voice-form-filling/
├─ src/
│  ├─ index.ts            # Top-level router: picks v1 or v2 from config
│  ├─ vite-env.d.ts       # Root Vite env typing (VITE_SARVAM_API_KEY)
│  ├─ v1/                 # Legacy Azure-based generation
│  │  ├─ index.ts             # v1 public entry: initializeVoiceForm + controller
│  │  ├─ VoiceFormService.ts  # ⭐ v1 core engine (~7,255 lines)
│  │  ├─ bedrockRouter.ts     # ⭐ v1 LLM answer router (~2,844 lines)
│  │  ├─ formExtractor.ts     # ⭐ DOM scraper / field extractor (~1,652 lines, shared with v2)
│  │  ├─ sarvamSpeech.ts      # v1 Sarvam STT/TTS provider
│  │  ├─ bhashiniSpeech.ts    # Bhashini provider (OUT OF SCOPE)
│  │  ├─ types.ts             # v1 shared types
│  │  ├─ debugState.ts        # Module-level extracted-fields cache
│  │  ├─ environment.d.ts     # Global VITE_* env typing
│  │  └─ vite-env.d.ts        # Vite client + env typing
│  └─ v2/                 # New Sarvam-based generation
│     ├─ index.ts             # v2 public entry: initializeVoiceForm + controller
│     ├─ voiceFormService.ts  # ⭐ v2 core engine / orchestrator (~1,519 lines)
│     ├─ sarvamSpeech.ts      # v2 direct Sarvam STT/TTS provider
│     ├─ v2BedrockRouter.ts   # v2 LLM answer router (direct)
│     ├─ bedrockTranslator.ts # v2 LLM label/option translator (direct)
│     ├─ proxyRouters.ts      # HTTP-proxy router + translator (server-side creds)
│     └─ types.ts             # v2 shared types
├─ demo/                  # Vite demo: National Scholarship Portal (v1)
├─ demo-umang-second/     # Vite demo: Chhattisgarh e-District (v1)
├─ example/               # Copy-paste integration snippets (v2)
├─ scripts/               # Node/JSDOM debug tools for the extractor
├─ nsp.html               # Real Angular form fixture used by scripts
├─ vite.config.ts         # Vite dev/build config
├─ tsconfig.json          # Library build config (emits dist/)
├─ tsconfig.app.json      # Demo/app typecheck config
├─ Dockerfile-dev         # Dev container
├─ .env.example           # Env template (v1 Azure path)
├─ package.json
└─ *.md                   # README + BRD + Sarvam integration notes
```

### How the pieces connect

- **`formExtractor.ts`** produces `ExtractedFormField[]` / `VoiceFormFieldDescriptor`
  objects. Both v1 and v2 services consume these.
- The **service** (`VoiceFormService` v1 / `V2VoiceFormService` v2) is the
  orchestrator that owns the conversational loop.
- The **router** (`bedrockRouter.ts` v1 / `v2BedrockRouter.ts` / proxy) turns a
  transcript + field descriptors into `FieldAssignment[]`.
- The **speech provider** (Azure / Sarvam) handles TTS + STT audio.
- The host app interacts through **UI hooks** (`UiHooks` / `V2UiHooks`) and the
  returned **controller** (`start`/`stop`/`setLanguage`/…).

---

## 3. Top-level source

### `src/index.ts` — version-dispatch router

The public package entry. It does **not** contain business logic; it routes to the
right generation.

- Re-exports both generations as namespaces: `export * as v1`, `export * as v2`.
- `type AnyVoiceFormController = V1Controller | V2VoiceFormController`.
- **`initializeVoiceForm(options): Promise<AnyVoiceFormController>`** — if the
  caller passes `options.sarvamSpeech.apiKey` or `options.sarvamProxy.provider`,
  it delegates to **v2** (`initializeV2`); otherwise it delegates to **v1**
  (`initializeV1`). This is how a single import transparently supports both APIs.

### `src/vite-env.d.ts` — root env typing

Triple-slash references `vite/client` and `./v1/vite-env.d.ts`, and declares the
v2-specific env var `VITE_SARVAM_API_KEY?` on `ImportMetaEnv`.

---

## 4. v1 — Azure-based generation (`src/v1/`)

### 4.1 `src/v1/index.ts` — v1 public entry point

The package's v1 API surface. Constructs and delegates to `VoiceFormService`.

- **`interface VoiceFormController`** — the runtime handle returned to callers:
  - `start()` / `stop()` — begin / end the voice loop.
  - `announceAndStop(message)` — speak a final message, then stop.
  - `setLanguage(language: SupportedLanguage)` — switch language at runtime.
  - `getExtractedFields()` — current scanned fields.
  - `restartBhashiniSession?()` — optional; Bhashini-only (out of scope).
  - `debug?: VoiceFormDebugApi` — debug surface.
- **`async initializeVoiceForm(options): Promise<VoiceFormController>`** —
  1. Optional debug logging.
  2. Merges options, defaulting `autoStart` to `true`.
  3. `new VoiceFormService(mergedOptions)` then `await service.initialize()`.
  4. Assembles the controller (each method delegates 1:1 to the service).
  5. If `autoStart`, fires `service.start()` **without awaiting** (errors routed to
     `uiHooks.onError`), so the caller gets the handle immediately.
- Re-exports `AwsBedrockRouter`, `getLatestExtractedFields`, and the public types.

### 4.2 `src/v1/VoiceFormService.ts` — ⭐ v1 core engine (~7,255 lines)

The heart of v1. Given a DOM form and a speech provider, it drives the entire
conversation: extract fields → ask → listen → route → validate → write, with
multi-step navigation, special commands, final review, and barge-in handling.
Supports `en-US`/`hi-IN` with a built-in localized message table
(`LOCALE_MESSAGES`).

**Key state:** `speechProvider` (azure/bhashini/sarvam), provider clients,
`fields: ExtractedFormField[]`, `router: BedrockRouter`,
`fieldState: Map<fieldId, FieldStateEntry>`, `steps: StepInfo[]` +
`currentStepIndex`, lifecycle flags (`initialized`/`running`/`formWasReset`),
turn-taking counters (`speakToken`/`speechGuard` for barge-in), listening session
state (`listenContext`), and manual-intervention tracking.

**Constructor & localization**
- `constructor(options)` — picks the speech provider (priority bhashini → sarvam →
  azure) and instantiates the matching service; throws if none configured.
- `get locale()` — `"hi"` if Hindi else `"en"`.
- `message(key, replacements)` — central i18n lookup with `{token}` substitution.
- `reportExtractedFields()` — stores + optionally logs + fires `onFieldsExtracted`.

**Lifecycle**
- `initialize()` — verifies secure context + mic; finds the form; waits for custom
  dropdowns; `extractFormFields`; builds `steps` (`detectAllTabs` → `buildStepMap`);
  resolves router + language; configures the speech provider; syncs DOM state.
- `start()` — ensures init, sets up manual-intervention detection, forces step 0,
  announces the first step, runs `runFormFlow()`.
- `stop()` — invalidates speech, stops the recognizer per provider, releases the
  mic, disposes the synthesizer, clears UI, awaits the in-flight flow.
- `announceAndStop(message)` — speak a closing message then `stop()`.

**Configuration helpers** — `resolveRouter()` (use injected router or build
`AwsBedrockRouter`), `resolveDefaultLanguage()`, `applyLanguageToConfig()`,
`setLanguage()` (recreate recognizer / restart provider).

**Main flow**
- `runFormFlow()` — the master loop: per pass, detect manual resets, find the next
  field for the current step; if none, `handleStepCompletion()`; otherwise
  `collectAnswerForField()`. When all steps complete, run `finalReview()`.
- `allFieldsCompleted()` / `allStepsCompleted()` / `isCurrentStepCompleted()` /
  `isFieldAnswered()` — completion predicates (skipped counts as answered; a value
  with a DOM validation error counts as unanswered).
- `findNextFieldForCurrentStep()`, `handleStepCompletion()` (returns
  `advance`/`stay`/`halt`), `getPendingFieldsForCurrentStep()`.
- Visibility/state helpers: `isFieldVisible`, `isFieldDisabledOrReadonly`,
  `isDropdownField`, `hasDropdownOptions`, `isEmptyDropdown` (empty dropdowns are
  treated as dependent fields and skipped).

**Field collection (the core conversation)**
- `collectAnswerForField(field, attemptNumber)` — for one field: handle pre-filled
  values + DOM validation, prepare/announce options, build & speak the question,
  start listening concurrently, preprocess numeric transcripts, retry on silence
  (auto-quit after 3 empty), call `router.routeAnswer(...)`, handle special
  commands, apply assignments, verify the value was written to the DOM (with
  retries for custom dropdowns), and speak follow-ups. Snapshots option lists to
  survive MutationObserver re-extraction.
- `buildQuestion(field)` — options question vs base question.
- `prepareFieldOptions(field)` — ensures custom dropdown options are loaded.

**Assignment application & validation**
- `applyAssignments(assignments, snapshots)` → `{applied, issues, appliedFields}` —
  resolves fields, handles skips/required, lazily loads options, validates,
  `setFieldValue`, then re-reads the DOM to confirm the write.
- `markFieldSkipped(field)`.
- `validateAssignment(field, value, snapshotOptions)` — multi-select splitting,
  numeric normalization, strict digit-code length rules, minLength/maxLength/
  pattern, number min/max/step, and select/radio matching (exact value → exact
  label → fuzzy via `findBestOptionMatch` ≥ 0.72), required enforcement.
- `findBestOptionMatch(input, options)` — a **private** phonetic/Levenshtein fuzzy
  matcher (distinct from the imported `findBestOptionMatch` from `bedrockRouter`).

**DOM read/write** — `setFieldValue` / `setFieldValueInternal` (native select /
textarea / radio-checkbox / custom dropdown / single input; uses the native value
setter to bypass Angular interception; guards programmatic writes from the
manual-intervention detector), `readFieldValue` (handles ng-select selected items,
data-value, labels, mobile drawers), `checkFieldForDomValidationErrors`
(`ng-invalid`, `aria-invalid`, native validity, `mat-error`).

**Custom dropdown selection** — `selectCustomDropdownValue`,
`findCustomDropdownOptionWithFallback` (direct → type into combobox → scroll),
`findCustomDropdownOptionByTyping`, `findCustomDropdownOptionByScrolling`,
`getDropdownScrollTargets`, `findCustomDropdownOption`, `clickDropdownOption`,
`ensureCustomDropdownClosed`.

**Speech (TTS)** — `speak(text)` (barge-in guard + silence wait + provider
dispatch), `speakWithAzure` / `speakWithSarvam` (+ Bhashini, OOS),
`playSynthesizedAudio` (Azure), `playSarvamAudio` (base64 → Web Audio decode),
`stopSpeaking`, `stopAudioPlayback`, `invalidatePendingSpeech`, `ensureSynthesizer`
/ `disposeSynthesizer`.

**Listening (STT) & silence** — `listen({allowConcurrentSpeech})`,
`ensureActiveRecognizer` (Azure: `SpeechRecognizer` + `PhraseListGrammar` seeded
with domain terms), `attachRecognizerHandlers` + handlers
(`handleSpeechStartDetected`/`handleRecognizing`/`handleRecognized`/`handleCanceled`/
`handleSessionStopped`, with barge-in), `scheduleFinalize` (the turn-end
silence detector), `finishListening`, `waitForSilence`, `stopActiveRecognizer`
(releases mic tracks), `createNoiseSuppressionAudioConfig`,
`revokeMicrophoneAccess`.

**UI hook emitters** — `emitPrompt` / `emitSpeech` / `emitTranscript` /
`emitAssignment` / `emitStatus` / `emitError` / `emitStepChange`.

**Steps / tabs** — `navigateToTab` (clicks `mat-tab`, re-extracts fields preserving
options), `setupTabChangeObserver` (MutationObserver re-extraction),
`syncFieldStateFromDom`, `detectManualResets`, `detectAllTabs`, `buildStepMap`,
`resetCurrentStepIndex`, `announceStepEntry`.

**Step confirmation & review** — `requestStepAdvance`, `interpretConfirmation`
(bilingual yes/no/stop), `reviewStep`, `describeIssues`.

**Special commands** — `confirmReset`, `confirmQuit`,
`handleSpecialCommandInEditFlow`, `finishFlowAsConfirmedQuit`.

**Final review / edit** — `recheckEmptyDropdowns`, `finalReview` (post-completion
edit phase), `handleFinalReviewEdit`.

**Manual-intervention** — `setupManualInterventionDetection` (capturing
input/change listeners), `handleManualIntervention` (stops the assistant if the
user types), `cleanupManualInterventionDetection`.

**Provider STT/TTS resource management** — `updatePhraseListForField` (Azure
context hints), and Sarvam/Bhashini capture pipelines (16 kHz mono mic →
ScriptProcessor → Int16 PCM → send every ~1 s).

**Module-level helpers (bottom of file)** — transcript normalization
(`updateBufferedFromSegments`, `pushTranscriptSegment`, `normalizeTranscriptPiece`,
`splitValues`, `sanitizeTranscriptValue`), numeric/field helpers
(`isLikelyNumericField`, `getStrictDigitCodeRule`, `isDigitOnlyPattern`,
`parseExactDigitLengthFromPattern`, `isNumericLikeSpokenValue`,
`sanitizeNumericAssignmentValue`, `normalizeDigitCodeValue`, `countDecimalPlaces`).

> **Design themes:** barge-in via `speakToken`/`speechGuard`; obsessive option-list
> preservation around async ops; defensive DOM-verification after every write;
> graceful yielding to manual typing.

### 4.3 `src/v1/bedrockRouter.ts` — ⭐ v1 LLM answer router (~2,844 lines)

The "answer-routing brain": given a spoken utterance + pending/completed field
descriptors, decides which field(s) it refers to and what value to assign.
Implements `BedrockRouter` via **`AwsBedrockRouter`**, calling Claude on AWS
Bedrock. It is a **hybrid local-deterministic + LLM pipeline** with several safety
gates, tuned heavily for **Indian government form vocabulary** (caste/category
codes), **speech-recognition error tolerance**, and **Hindi/Devanagari** input.

**Exports:** `AwsBedrockRouterOptions`, `AwsBedrockRouter`, and the reusable
`findBestOptionMatch`.

**`AwsBedrockRouter`**
- `constructor(options)` — stores `client`, `modelId`, `temperature` (0),
  `maxTokens` (600), `debug`.
- `routeAnswer(input)` — the orchestrator:
  1. `tryRouteLocally(input)` — handle unambiguous single-field utterances with no
     network call; if found and not low-evidence, return immediately.
  2. Else build the prompt (`buildAnthropicPayloadLite`) and call Bedrock
     (`InvokeModelCommand`), decoding multiple Anthropic/Bedrock response shapes.
  3. Pipeline: `parseAssignmentsFast` → `correctAssignmentValuesFast` →
     `normalizeSelectableAssignments` → `verifyAmbiguousAssignmentsWithLlm`
     (second LLM pass) → `fillMissedFieldsLocally`.

**Prompt engineering**
- `buildAnthropicPayloadLite` — builds the Bedrock Anthropic-Messages payload.
  Two completely different system prompts chosen by `isEditMode`:
  - **Edit-mode prompt** — parse the named field + new value from the utterance.
  - **Normal-mode prompt** — 23 numbered rules: special-command detection,
    edit-intent detection, field-name matching, multi-field extraction, the EXACT
    VALUE RULE (selectable values must equal an `option.value`), skip handling,
    date/number/code formatting, clean value extraction, identity assertions,
    short-code exact-match-first (so `ST` never matches `ST-PVGT`), multilingual
    translation, phonetic matching, weak-evidence guards, aliasing, Roman numerals,
    and negation. Includes worked examples and a Hindi `languageInstruction`.
- `summarizeField` / `enrichOptionLabel` — compact field summaries; first field
  gets all options, others capped; category codes (SC/ST/OBC/…) enriched with their
  official long forms via `CATEGORY_CODE_EXPANSIONS`.

**Special-command & local fast routing** — `detectSpecialCommand` (English +
Hindi reset/quit/finish phrases with confidence), `isLikelyCommand`,
`tryRouteLocally` (deterministic single-field router: special command → skip →
local edit → selectable exact/fuzzy → number/date/email/tel/text), helpers
`isSkipIntent`/`isEditIntent`, `looksLikeMultiFieldUtterance`,
`countMentionedFields`, `findMentionedField`, `extractEditValueCandidate`.

**LLM response parsing** — `parseAssignmentsFast` (tries whole/fenced/balanced JSON
candidates), `extractBalancedJsonObjects` (string-aware brace scanner),
`coerceRoutingResponse` / `coerceAssignment` (defensive validation),
`fallbackParseAssignments` (regex last resort).

**Value correction & normalization** — `correctAssignmentValuesFast` (snap select
values to exact `option.value`), `normalizeSelectableAssignments` (collapse arrays
for single-select), `buildUnableToMatchFollowUp`.

**Second-pass verification** — `verifyAmbiguousAssignmentsWithLlm` (re-check risky
selectable mappings, esp. short codes, with evidence requirements; fail-safe
rejects on error), `collectAmbiguousAssignmentCandidates`,
`buildAssignmentVerificationPayload`, `parseAssignmentVerificationResult`,
`hasVerifiedShortCodeEvidence`, `hasStrongPhoneticOrSimilarityEvidence`,
`findMatchingVerificationApproval`, `utteranceContainsEvidenceText`,
`rejectAmbiguousAssignments`.

**Gap filling & evidence** — `fillMissedFieldsLocally` (fill skipped selectable
fields from local evidence only), `hasLowEvidenceSelectableAssignments`,
`hasDirectOptionEvidence`.

**Option-matching engine** — `findBestOptionMatch` (exact-match-first, then fuzzy +
phonetic boosts), `isStrongOptionMatch` / `requiredMatchThreshold`, `scoreMatch`,
`buildCandidateStrings`, `buildOptionAliasSet`, `utteranceFuzzyMatchesOptionLabel`,
and string utilities `normalizeForCompare`, `toPhoneticKey` (Soundex-like),
`levenshteinDistance`, `splitUtteranceWords`, `extractAliasWords`, `buildAcronym`.

**Value extractors** — `extractNumericValue`, `cleanupTextAnswer`,
`normalizeDateValue` (→ `DD/MM/YYYY`), `normalizeYear`, and Roman-numeral utilities
(`arabicToRoman`, `romanToArabic`, `toOrdinalString`).

**External deps:** `@aws-sdk/client-bedrock-runtime` (`InvokeModelCommand`),
`./types`. (No proxy router lives here; v1 callers inject a custom `router` via
`BedrockRouterConfig.router` instead.)

### 4.4 `src/v1/formExtractor.ts` — ⭐ DOM scraper / field extractor (~1,652 lines)

The browser-side DOM scraper. Walks a form `HTMLElement` and produces ordered
`ExtractedFormField[]`. Handles native controls **and** custom Angular/widget
dropdowns (ng-select, `[role=listbox]`, `[role=combobox]`, `searchable-dropdown`,
Material). **Shared by both v1 and v2.**

**Exports:** `ExtractedFormField` (extends `VoiceFormFieldDescriptor` with live DOM
refs), `extractFormFields`, `waitForCustomDropdownRender`,
`ensureCustomDropdownOptions`, `isCustomDropdownElement`,
`getDropdownOptionContainers`, `readDropdownOptionMetadata`, `isDropdownExpanded`,
`openDropdownElement`, `closeDropdownElement`.

**Main extraction**
- `extractFormFields(form)` — finds custom dropdowns, excludes their inner inputs
  from native collection, merges everything, **sorts by DOM position**, then builds
  descriptors. Radio groups → one `radio` field; checkbox groups → one `checkbox`
  field (`allowMultiple`); native `<select>` honors `multiple`; Material datepicker
  text inputs (`data-mat-calendar`) coerced to `date`.
- `mapInputType(inputType)` — native type → `VoiceFormFieldType`.

**Descriptor & metadata** — `buildDescriptor` (native),
`buildCustomDropdownDescriptor` (custom dropdown → `select`-type),
`collectConstraints` (required incl. `aria-required`, min/max length, pattern,
number min/max/step), `buildOption`, id/name pickers (`pickControlId`,
`pickControlName`, `pickFromAttributes`, `readAttribute`, `generateFallbackId`).

**Label resolution** — `findLabel` (priority-ordered, designed around Angular
Material placeholder quirks: dynamic-label siblings → `aria-labelledby` → wrapping
`<label>` → DOM walk → `label[for]`), `extractLabelText`, and string helpers
`cleanLabel`, `prettifyLabel`, `slugifyLabel`.

**Tab/step grouping** — `extractGroupInfo` (Angular Material `mat-tab` detection;
fallback to `[data-step]`) → `{id, label, index}` per field.

**Custom dropdown support** — `findCustomDropdowns`, `resolveCustomDropdownElement`,
`isCustomDropdownElement`, `getDropdownOptionContainers` (element + mobile bottom
drawer + body-level overlay panels), `readDropdownOptionMetadata`
(mat-radio-button special-casing, value/label extraction), `isDropdownExpanded`,
`openDropdownElement`, `closeDropdownElement`.

**Option extraction & live updates** — `registerCustomDropdown` (WeakMap registry +
MutationObservers), `scheduleOptionsUpdate` (debounced), `ensurePanelObservers`
(observe lazy body overlays), `collectCustomDropdownOptions` /
`mergeVisibleDropdownOptions`, `ensureCustomDropdownOptions` (open + poll + collect
on demand), `collectAllDropdownOptions` (scroll through virtualized lists),
`getScrollableContainers`, `waitForCustomDropdownRender`, `collectPanelIds`.

**External deps:** `./types` only; otherwise pure browser DOM APIs with SSR-safe
guards (`HAS_WINDOW`, `HAS_MUTATION_OBSERVER`).

### 4.5 `src/v1/sarvamSpeech.ts` — v1 Sarvam STT/TTS provider

Wraps the `sarvamai` SDK to give v1 a Sarvam speech backend: streaming STT over a
WebSocket (PCM 16-bit in, transcript callbacks out) and streaming TTS (returns one
concatenated base64 audio blob).

**Exports:** `SarvamSpeechConfig` (richer than the one in `types.ts` — adds
`model`, `mode`, `sampleRate`, `debug`), `SarvamSTTMessage`, `SarvamTTSMessage`,
`SarvamSTTCallback`, and `class SarvamSpeechService`.

**`SarvamSpeechService`**
- `constructor(config)` — builds a fully-defaulted config (language normalized via
  `mapLanguageCodeToSarvam`, default speaker via `getDefaultSpeaker`,
  pace/pitch/loudness = 1.0, sampleRate 16000).
- `ensureClient()` — lazy dynamic `import("sarvamai")` + `new SarvamAIClient`.
- `mapLanguageCodeToSarvam(code)` — normalize any code to Sarvam `*-IN` (e.g.
  `en-US` → `en-IN`), fallback `hi-IN`.
- `getDefaultSpeaker(lang)` — per-language default voice (hi→meera, en→arvind, …).
- `updateLanguage(language)` — re-normalize + reset speaker.
- `createSTTClient(callback)` — `speechToTextStreaming.connect(...)` with
  `pcm_s16le`, VAD + flush signals; wires message/error/open/close handlers.
- `sendAudioToSTT(int16)` — base64-encode PCM and `transcribe(...)`.
- `flushSTT()` / `closeSTT()` — force-process / teardown.
- `synthesizeSpeech(text)` — TTS via `textToSpeechStreaming.connect` (bulbul:v3);
  accumulates base64 chunks; resolves via the `final` event, the `close` event with
  buffered audio, or a 10 s safety timeout.
- `concatenateBase64Chunks(chunks)` — correctly decode-concat-reencode (not naive
  string concat).
- `disconnect()`, `int16ArrayToBase64(int16)`.

**External deps:** `sarvamai` (lazy), browser base64/typed-array APIs.

### 4.6 `src/v1/types.ts` — v1 shared types

No runtime code. Defines:
- `SupportedLanguage = "en-US" | "hi-IN"`.
- `LanguageMetadata` — `{code, speechName, ttsVoice, displayLabel}`.
- `UiHooks` — optional callbacks: `onPrompt`, `onSpeechSynthesis`, `onTranscript`
  (`isFinal?`), `onAssignment`, `onStatus`, `onError`, `onStepChange`,
  `onFieldsExtracted`, `onQuit` (`reason: no-response|completed|user-stop|cancelled`),
  `onResetRequested` (async-capable — host clears the form).
- `VoiceFormDebugOptions` (`logExtractedFields?`), `VoiceFormDebugApi`.
- `SpeechProvider = "azure" | "bhashini" | "sarvam"`.
- `BhashiniSpeechConfig` (OOS), `SarvamSpeechConfig` (public/init: `apiKey`,
  `language`, `speaker`, `pitch`, `pace`, `loudness`).
- `VoiceFormInitOptions` — `formSelector`, one of `azureSpeech`/`bhashiniSpeech`/
  `sarvamSpeech`, `bedrock`, `uiHooks?`, `autoStart?`, `language?`,
  `defaultLanguage?`, `debug?`.
- `BedrockRouterConfig` — `{modelId, client?, router?}`.
- `BedrockRouter` — `{ routeAnswer(input): Promise<BedrockRoutingResponse> }`.
- `BedrockRoutingRequest` — `{userInput, pendingFields, completedFields, language?,
  isEditMode?}`.
- `BedrockRoutingResponse` — `{assignments, followUp?, specialCommand?}`.
- `FieldAssignment` — `{fieldId, value?, confidence?, skip?}`.
- `VoiceFormFieldType` — the 9-type union.
- `ConstraintSet` — `{required, minLength?, maxLength?, pattern?, min?, max?, step?}`.
- `VoiceFormFieldDescriptor` — `{id, name, label, type, options?, allowMultiple?,
  constraints, groupId?, groupLabel?, groupIndex?}`.

### 4.7 `src/v1/debugState.ts` — extracted-fields cache

A tiny module-scoped singleton holding the last-extracted fields, decoupled from
any live service instance.
- `storeExtractedFields(fields)` — overwrite the cache (called by the service).
- `getLatestExtractedFields()` — read the cache (re-exported via `index.ts`).

### 4.8 `src/v1/environment.d.ts` & `src/v1/vite-env.d.ts` — env typing

Ambient declarations typing `import.meta.env.VITE_*`. Both declare the Azure +
Bedrock + AWS vars (`VITE_AZURE_SPEECH_KEY`, `VITE_AZURE_SPEECH_REGION`,
`VITE_BEDROCK_MODEL_ID`, `VITE_BEDROCK_REGION`, `VITE_AWS_ACCESS_KEY_ID`,
`VITE_AWS_SECRET_ACCESS_KEY`, `VITE_AWS_SESSION_TOKEN`). `environment.d.ts` uses
`declare global { … }` + `export {}`; `vite-env.d.ts` adds the
`/// <reference types="vite/client" />` and declares them at top level. (The two
overlap; they are kept consistent.)

### 4.9 `src/v1/bhashiniSpeech.ts` — Bhashini provider — **OUT OF SCOPE**

Not documented per request. It provides the Bhashini STT/TTS backend referenced by
`VoiceFormService` and `types.ts`.

---

## 5. v2 — Sarvam-based generation (`src/v2/`)

v2 uses **Sarvam AI** for live STT + streaming TTS and **Amazon Bedrock (Claude)**
for two jobs: routing answers and translating prompts/options into the user's
language. Both Bedrock jobs run either **directly** (in-browser AWS SDK) or via an
HTTP **proxy** (server-side credentials).

### 5.1 `src/v2/index.ts` — v2 public entry point

- **`initializeVoiceForm(options): Promise<V2VoiceFormController>`** — constructs a
  `V2VoiceFormService`, `await`s `initialize()`, builds the controller (thin
  delegations), and optionally fires `start()` without awaiting (errors → `onError`).
- Re-exports: `SarvamSpeechService`, `BedrockTranslator`, `V2BedrockRouter`,
  `BedrockProxyRouter`, `BedrockProxyTranslator`, `V2VoiceFormService`, and
  `export * from "./types"`.

### 5.2 `src/v2/types.ts` — v2 shared types

Re-exports v1 types (`BedrockRouter`, `BedrockRoutingRequest/Response`,
`FieldAssignment`, `ConstraintSet`, `VoiceFormFieldType`, `VoiceFormFieldDescriptor`,
debug types) so v2 consumers import only from v2. Adds:
- `V2SupportedLanguage` — 11 codes (`en-IN`, `hi-IN`, `bn-IN`, `ta-IN`, `te-IN`,
  `kn-IN`, `ml-IN`, `mr-IN`, `gu-IN`, `pa-IN`, `od-IN`).
- `SarvamSpeechConfig` — `apiKey`, `language`, `speaker?`, `pace?`, `pitch?`,
  `loudness?`, `sttModel?`, `ttsModel?`, `outputAudioCodec?`.
- `SarvamSTTHandlers` — `onSpeechStart?`, `onSpeechEnd?`, `onPartial?`, **`onFinal`**,
  `onError?`.
- `SarvamSpeechProvider` — the provider contract: `setLanguage`, `startListening`,
  `stopListening`, `speak`, `stopSpeaking`, `dispose`.
- `SarvamProxyConfig` — host-supplied provider.
- `BedrockProxyConfig` — `{routerUrl, translatorUrl?, fetchInit?}`.
- `BedrockDirectConfig` — `{modelId, client}`.
- `V2BedrockConfig` — discriminated union of `{direct}` or `{proxy}`.
- `TranslatedOptionMapping` — `{value, originalLabel, translatedLabel, language}`.
- `TranslatedFieldPrompt`.
- `V2UiHooks` — like v1 plus `onTranslation` (`{prompt?, options?}`); `onQuit.reason`
  ∈ `completed|user-stop|no-response`.
- `V2VoiceFormInitOptions` — `formSelector`, `language`, `defaultLanguage?`,
  `autoStart?`, `sarvamSpeech?` | `sarvamProxy?`, `bedrock`, `uiHooks?`, `debug?`.
- `V2VoiceFormController` — `start`, `stop`, `setLanguage`, `getExtractedFields`,
  `announceAndStop`.
- `TranslationError extends Error` — carries `cause`; lets the service degrade
  gracefully on translation failures.

### 5.3 `src/v2/sarvamSpeech.ts` — v2 direct Sarvam provider

Implements `SarvamSpeechProvider`. Live streaming STT (WebSocket via `sarvamai`,
mic captured through `wavtools` `WavRecorder`) + streaming TTS (downloads synthesized
audio, plays via `HTMLAudioElement`).

**Constants/helpers:** `DEFAULT_STT_MODEL = "saarika:v2.5"`,
`DEFAULT_TTS_MODEL = "bulbul:v3"`, `DEFAULT_OUTPUT_CODEC = "mp3"`,
`DEFAULT_SPEAKER = "manan"`, `STT_SAMPLE_RATE = 16000`, `defaultSpeakerFor`,
`writeAscii`, `createWavHeader` (44-byte RIFF/WAVE for mono 16-bit PCM),
`uint8ArrayToBase64` (chunked, stack-safe).

> Why WAV-per-frame: `MediaRecorder` emits WebM which Sarvam can't decode if
> mislabeled WAV. Instead each ~10 ms mono int16 PCM frame from `WavRecorder` is
> wrapped in its own 44-byte WAV header so every `transcribe()` call ships a
> self-contained mini-WAV.

**`SarvamSpeechService`**
- `constructor(config)` — throws without `apiKey`; applies model/codec defaults.
- `setLanguage(language)` — stores it; tears down any live STT so the next listen
  reconnects in the new language.
- `startListening(handlers)` — requires `navigator.mediaDevices`; lazy
  `ensureClient`; `speechToTextStreaming.connect({input_audio_codec:"wav", VAD…})`;
  message dispatch (`speech_start`/`speech_end`/`events`/`data`/`transcript`); mic
  capture via `WavRecorder.record(cb)` → per-frame WAV → base64 → `transcribe`.
- `stopListening()` — end recorder, stop mic tracks, flush+close socket.
- `speak(text, opts?)` — `textToSpeech.convertStream({...})` (bulbul:v3 omits
  pitch/loudness); `arrayBuffer()` → `Blob` → object URL → `Audio`; resolves on
  `onended`.
- `stopSpeaking()`, `dispose()`, and privates `ensureClient`, `cleanupAudioElement`,
  `codecToMime`.

**External deps:** `sarvamai`, `wavtools`, browser audio/mic APIs.

### 5.4 `src/v2/v2BedrockRouter.ts` — v2 answer router (direct)

Implements `BedrockRouter`. **No local short-circuit** — every utterance goes to
Claude so it can strip conversational prefixes/filler, extract clean numeric/select
values, and split multi-field utterances.

- `V2BedrockRouterOptions` — `{client, modelId, temperature?, maxTokens?, debug?}`.
- `SYSTEM_PROMPT` — JSON-only output schema + 10 rules: clean value extraction,
  numeric digits-only (expand "5 lakh"→500000), address fields keep context,
  select/radio/checkbox → exact `option.value` (≥70% similarity), multi-field →
  one assignment per field, Hindi/Devanagari mapping, dates `DD/MM/YYYY`, special
  commands (confidence ≥ 0.7), no filler in values, empty assignments + `followUp`
  if nothing maps.
- `routeAnswer(input)` — builds `userContext` (`summarizeField` for pending fields,
  reduced completed fields), `InvokeModelCommand`, decodes/parses via
  `parseLenientJson`.
- Helpers: `summarizeField`, `parseLenientJson` (strip fences, slice braces, coerce;
  never throws — returns `{assignments:[]}` on failure).

**External deps:** `@aws-sdk/client-bedrock-runtime`.

### 5.5 `src/v2/bedrockTranslator.ts` — v2 label/option translator (direct)

Uses Bedrock Claude to translate a prompt string and option labels into a target
Indian language for natural spoken delivery. In-memory cached.

- `BedrockTranslatorOptions` — `{client, modelId, temperature?, maxTokens?, cache?,
  debug?}`.
- `LANGUAGE_NAMES` — code → human name with native script.
- `PROMPT_SYSTEM` / `OPTIONS_SYSTEM` — system prompts (return ONLY translated text /
  ONLY a same-length JSON array; preserve numbers/codes/proper nouns/short codes).
- `translatePrompt(text, lang)` — no-op for blank or `en-IN`; cache key
  `prompt|lang|text`; `invokeClaude(PROMPT_SYSTEM, …)`; errors → `TranslationError`.
- `translateOptions(options, lang)` — identity mappings for `en-IN`; cache key
  `options|lang|labels`; parses via `parseStringArray` (exact-length validated);
  returns `TranslatedOptionMapping[]`.
- `clearCache()`, private `invokeClaude` (Anthropic-on-Bedrock body, resilient text
  extraction), module helper `parseStringArray`.

**External deps:** `@aws-sdk/client-bedrock-runtime`.

### 5.6 `src/v2/proxyRouters.ts` — HTTP proxy router + translator

For hosts that keep AWS creds server-side. Drop-in interchangeable with the direct
classes.

- **`BedrockProxyRouter`** (`implements BedrockRouter`) — `routeAnswer(input)` POSTs
  the raw `BedrockRoutingRequest` to `config.routerUrl`; expects the router-response
  shape back; throws on non-OK.
- Request types: `BedrockProxyTranslatorTranslatePromptRequest` (`kind:
  "translate-prompt"`), `…TranslateOptionsRequest` (`kind: "translate-options"`),
  `BedrockProxyTranslatorOptions` (`{endpoint, fetchInit?}`).
- **`BedrockProxyTranslator`** — mirrors `BedrockTranslator`'s API (`clearCache`,
  `translatePrompt` → expects `{translated}`, `translateOptions` → expects
  `{mappings}`); shared private `post<T>(body)`. The server distinguishes requests
  by the `kind` discriminator.

**External deps:** browser/Node `fetch`. No AWS SDK.

### 5.7 `src/v2/voiceFormService.ts` — ⭐ v2 core engine / orchestrator (~1,519 lines)

`V2VoiceFormService` ties together the v1 `formExtractor`, the Sarvam provider, the
Bedrock router, and the translator, and drives the full flow: extract → (optional
steps) → prompt → listen → route → validate → write → final review/edit, with voice
commands, manual-entry detection, and graceful translation degradation.

**Constants:** `MAX_EMPTY_RETRIES = 3`, `MAX_INVALID_RETRIES = 2`,
`SPEECH_END_DEBOUNCE_MS = 1800`, `MAX_LISTEN_MS = 90_000`. Internal types
`StepInfo`, `TranslatorLike`.

**Construction & provider resolution** — `constructor(options)` resolves three
pluggable deps: `resolveSpeechProvider()` (proxy provider or `SarvamSpeechService`),
`resolveRouter()` (`BedrockProxyRouter` or `V2BedrockRouter`), `resolveTranslator()`
(`BedrockProxyTranslator` or `BedrockTranslator`).

**Public API** — `initialize()` (find form, `waitForCustomDropdownRender`,
`extractFormFields`, `storeExtractedFields`, `detectSteps`, emit
`onFieldsExtracted`), `start()`, `stop()`, `setLanguage()` (propagate + clear
translator cache), `announceAndStop()`, `getExtractedFields()`.

**Main flow** — `runFlow()` (outer reset-aware loop wrapping `fillAllFields()` →
success → `finalReviewPass()`), `fillAllFields()` (find next field; skip
manual/disabled/empty-dropdown; `collectAnswerForField`),
`collectAnswerForField(field)` (translate prompt → speak → listen → empty-retry →
route → special command → validate → apply; optional-skip on repeated invalid).

**Multi-step** — `detectSteps(form)` (three fallbacks:
`[data-step]`/wizard selectors → `<fieldset>`/`<legend>` → field `groupId`),
`handleStepCompletion()` (ask to advance, re-extract for the new step),
`emitStepChange()`.

**Voice commands** — `handleSpecialCommand(type)`, `handleResetCommand()` (confirm →
`onResetRequested` → re-extract), `handleQuitCommand()` (confirm → `onQuit`).

**Final review/edit** — `finalReviewPass()` (`"done"` | `"continue"`),
`routeEditMode(userInput)` (all fields pending, `isEditMode: true`).

**Validation** — `validateFieldValue(field, value)` → error string or null
(required, min/max length, regex pattern with special-cased "exactly N digits",
number range/step, email, tel whitelist).

**Manual-entry detection** — `setupManualInterventionDetection()` (MutationObserver
+ input/change listeners), `onManualInput`, `cleanupManualInterventionDetection()`,
`findFieldForElement()`; `isSettingValueProgrammatically` guards the service's own
writes.

**Yes/No & navigation** — `listenForYesNo()` (bilingual yes/no with retries),
`findNextField()`, `allFieldsCompleted()`, `isPendingField()`, `isFieldVisible()`,
`isFieldDisabled()`, `isEmptyDropdown()`.

**Prompt building** — `buildPromptForField(field)` (translate label + options,
emit `onTranslation`, graceful fallback on `TranslationError`).

**Listening** — `listenOnce()` (wraps `speech.startListening`; handles cumulative
vs incremental transcripts; speech-end debounce; 90 s hard timeout;
`finish()` resolves the trimmed final transcript), `isCumulativeText()`.

**Routing & application** — `routeAnswer(currentField, userInput)` (current field
first), `applyAssignments(assignments, _translatedOptions)` (guards programmatic
writes; the translated-options arg is currently unused), `cleanAssignmentValue()`,
`stripConversationalPrefix()` (client-side safety net duplicating the LLM cleaning),
`writeFieldValue()` (dispatches bubbling `input`+`change` so frameworks observe).

**Misc** — `speakAndEmit()`, `maybeTranslate()`, `toDescriptor()`,
`snapshotFields()`, `emitStatus()`, module-level `escapeRegex()`.

**External deps:** v1 `formExtractor` + `debugState`; v2 siblings; browser DOM APIs.

---

## 6. Demos (`demo/`, `demo-umang-second/`)

Two near-identical single-page **Vite demos** using the **v1 (Azure + Bedrock)**
API. Served by `vite.config.ts` (`root: "demo"`); they import from the library
**source** (`../src`), not the published package. Both share an identical
`styles.css`.

### `demo/` — National Scholarship Portal demo
- **`index.html`** — a government-styled, multi-step "Scholarship Registration"
  form (4 `data-step` sections: Personal / Academic / Bank / Documents) exercising a
  broad mix of field types (text, number, date, tel, email, select, radio,
  checkbox) with pattern/min/max validation. Sidebar shell, language `<select>`,
  Start/Stop buttons, activity `#log`.
- **`main.ts`** — glue between the HTML, the demo's own stepper UI, and the v1
  controller:
  - `createStepper()` — the demo's local UI logic: maps each field → its
    `data-step`, toggles `.is-active`/`.is-complete`, syncs a `?step=` URL param,
    handles `popstate`. Returns `showStep`/`showStepById`/`showStepForField`/`reset`.
  - `wireStepControls(stepper)` — next/prev/indicator click handlers.
  - `createBedrockRouter()` — builds a `BedrockRuntimeClient` + `AwsBedrockRouter`;
    `buildAwsCredentials()` throws if creds missing.
  - `appendLog(kind, message, options)` — activity log with a `key` for in-place
    coalescing of interim transcripts.
  - `DemoConfig` / `collectMissingConfig()` — reads + trims `VITE_*` env vars; lists
    missing ones and disables Start if incomplete.
  - **UiHooks wiring:** `onPrompt`/`onAssignment` jump the stepper + log;
    `onTranscript` coalesces "Hearing…"/"Heard"; `onStepChange` drives `showStep`.
  - **Lifecycle:** Start → `initializeVoiceForm({formSelector:"#demo-form",
    azureSpeech, bedrock:{modelId, router}, uiHooks, autoStart:true, language})`;
    Stop → `controller.stop()`; language change → `controller.setLanguage(...)`;
    submit intercepted (draft only).
- **`styles.css`** — light government-portal theme (app shell, hero/assistant
  cards, stepper cards, two-column form grid, the `.form-step.is-active` show/hide
  rule, log lines; responsive at 1080/720 px).

### `demo-umang-second/` — Chhattisgarh e-District demo
- **`index.html`** — simpler single-step "Citizen Account Details" form (userName,
  fullName, district select, mobile, email) using the same shell.
- **`main.ts`** — essentially identical to `demo/main.ts`, but without the
  transcript-coalescing logic (every interim transcript logs a fresh line) and a
  simpler append-only `appendLog`.
- **`styles.css`** — byte-for-byte identical to `demo/styles.css`.

> Note: the active Vite `root` is `demo`, so `demo-umang-second` is only
> built/served if explicitly targeted.

---

## 7. Examples (`example/`)

Standalone, copy-paste integration references for **library consumers** using the
**v2 / Sarvam API**. Unlike the demos, these import from the published package
(`@myscheme/voice-form-filling`, `v2` namespace). The `.ts` and `.js` files are
line-for-line equivalents.

### `example/voice-form-example.ts` / `.js`
The canonical "how to integrate" guide. Expected HTML scaffold documented in the
header (form `#my-form`, controls `#vf-start`/`#vf-stop`/`#vf-language`, feedback
`#vf-prompt`/`#vf-transcript`/`#vf-status`). Six labeled sections:
1. **CONFIG** — `SARVAM_API_KEY`, `BEDROCK_MODEL_ID`
   (`anthropic.claude-3-haiku-20240307`), `AWS_REGION`, AWS creds,
   `INITIAL_LANGUAGE`.
2. **DOM REFERENCES** — grabs the 7 elements (throws if missing).
3. **UI HOOKS (`v2.V2UiHooks`)** — demonstrates every hook including
   `onFieldsExtracted`, `onQuit` (handles `completed`/`no-response`/user-stop),
   `onResetRequested` (host does `formEl.reset()` + strips classes), and optional
   `onTranslation`.
4. **CONTROLLER LIFECYCLE** — `ensureController()` builds a `BedrockRuntimeClient`
   and calls `v2.initializeVoiceForm({..., sarvamSpeech:{apiKey, language},
   bedrock:{direct:{client, modelId}}, autoStart:false})`.
5. **UI EVENT WIRING** — Start/Stop/language wiring + `updateButtons()`.
6. **PRODUCTION ALTERNATIVE** — the recommended backend-proxy mode: replace
   `bedrock.direct` with `bedrock:{proxy:{routerUrl, translatorUrl}}` so AWS/Sarvam
   secrets never reach the browser.

---

## 8. Scripts (`scripts/`)

Node CLI debugging utilities for the **form extractor**, run outside the browser via
JSDOM. Both load `nsp.html`, polyfill DOM globals, and print extracted fields.

- **`debug-extract.ts`** — runs against library **source** (`../src/formExtractor`).
  Builds a JSDOM, awaits `waitForCustomDropdownRender`, calls `extractFormFields`,
  awaits `ensureCustomDropdownOptions` per select, then `console.table`s
  `{id, name, label, type, options}`.
- **`debug-extract.mjs`** — same logic against the **built** output
  (`../dist/formExtractor.js`) — a post-build smoke test. Prints `optionsCount`
  instead of joined option labels.

### `nsp.html` — real-world test fixture
A captured (1,412-line) snapshot of the live Angular "National Scholarship Portal"
app: heavy inlined Angular component CSS, Material expansion panels, and `ng-select`
custom combobox dropdowns whose options render lazily/asynchronously. It is exactly
the messy, real DOM that `waitForCustomDropdownRender` + `ensureCustomDropdownOptions`
exist to handle, and what the debug scripts validate against.

---

## 9. Config & build

- **`vite.config.ts`** — `root: "demo"`, `envDir: __dirname` (reads `.env*` from
  repo root). Dev server `port: 3045`, `host: 0.0.0.0`,
  `allowedHosts: [".myscheme.in"]`. `resolveHttpsConfig()` enables TLS only when
  `DEV_SERVER_USE_HTTPS` is set (requires `DEV_SERVER_SSL_KEY`/`_CERT`, optional
  `_CA`) — HTTPS matters because mic capture needs a secure context off localhost.
  `build.outDir: "../demo-dist"`. Alias `@voice-form → src`.
- **`tsconfig.json`** — library build config: `ES2021`, `module: ESNext`,
  `moduleResolution: Bundler`, DOM libs, emits declarations + sourcemaps to `dist/`
  from `rootDir: src`, `strict: true`. Used by `npm run build` (`tsc -p
  tsconfig.json`).
- **`tsconfig.app.json`** — extends the above but `noEmit: true` (typecheck only),
  adds `vite/client` types and `@voice-form` path mappings, includes `src` + `demo`.
- **`.env.example`** — env template for the v1/Azure path: `VITE_AZURE_SPEECH_KEY`,
  `VITE_AZURE_SPEECH_REGION`, `VITE_BEDROCK_MODEL_ID`, `VITE_BEDROCK_REGION`,
  `VITE_AWS_ACCESS_KEY_ID`, `VITE_AWS_SECRET_ACCESS_KEY`, optional
  `VITE_AWS_SESSION_TOKEN`. (Exposes keys to the browser — fine for demos; use the
  proxy mode for production.)
- **`Dockerfile-dev`** — multi-stage `node:20-bullseye-slim`. `base` installs
  `libasound2` (ALSA for audio) + Corepack/Yarn; `deps` runs
  `yarn install --frozen-lockfile`; `runner` exposes `3045` and runs
  `yarn dev --host 0.0.0.0 --port 3045` (serves the NSP demo).
- **`package.json`** — name `@myscheme/voice-form-filling`, version
  `0.2.0-foundation.1`, ESM (`type: module`), entry `dist/index.js`. Scripts:
  `build` (`tsc`), `typecheck`, `dev` (`vite --port 3045`), `preview`. Runtime deps
  include `@aws-sdk/client-bedrock-runtime`, `sarvamai`, `wavtools`,
  `microsoft-cognitiveservices-speech-sdk`, `@ricky0123/vad-web`,
  `socket.io-client`.

---

## 10. Documentation files (root)

These are prose/reference docs, not code:
- **`README.md`** — extensive usage guide (written around the v1/Azure API):
  features, quick start, UI-hooks reference, reset/quit flows, integration patterns
  (vanilla JS / React / Angular / backend proxy), troubleshooting, and a key
  implementation-files summary.
- **`BRD.md`** — Business Requirements Document for the library.
- **`SARVAM_INTEGRATION.md`**, **`SARVAM_INTEGRATION_COMPLETE.md`**,
  **`SARVAM_LIBRARY_INTEGRATION.md`** — notes on integrating the `sarvamai` package
  as a speech provider (STT/TTS streaming).
- **`SARVAM_TODO.md`** — remaining/completed steps for the Sarvam integration.

> Also present: `src/v1/sarvamSpeech.ts.backup` — a stale backup of the v1 Sarvam
> provider, kept in the tree but not part of the build.

---

## 11. Quick mental model (end-to-end)

1. Host calls `initializeVoiceForm(options)` (root `src/index.ts` picks v1 or v2).
2. The **service** initializes: `formExtractor.extractFormFields(form)` →
   `ExtractedFormField[]`, grouped into steps.
3. `start()` runs the loop. For each field: build & **speak** a prompt (TTS, v2 also
   translates it), **listen** (STT), then **route** the transcript through Bedrock →
   `FieldAssignment[]`.
4. The service **validates** each assignment against `ConstraintSet`, **writes** it
   to the DOM (dispatching `input`/`change`), and re-reads to confirm.
5. Voice commands (reset/quit/finish), manual typing, multi-step tabs, and a final
   review/edit phase are handled along the way.
6. The host observes everything through **UI hooks** and controls the session via
   the returned **controller**.
