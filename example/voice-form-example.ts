/**
 * Voice Form Filling — TypeScript integration example (v2 / Sarvam AI).
 *
 * Copy this file into your project and adapt the CONFIG and HTML sections to
 * your own application. The code imports from the installed library package,
 * NOT from the library's source tree, so it is safe to ship as-is.
 *
 * Install:
 *
 *   npm install @myscheme/voice-form-filling @aws-sdk/client-bedrock-runtime
 *
 * Expected HTML scaffold on the page where this script runs (ids are
 * referenced below — feel free to rename, but keep them in sync):
 *
 *   <form id="my-form">
 *     <label>Name <input id="name" name="name" required /></label>
 *     <label>Age  <input id="age" name="age" type="number" min="0" /></label>
 *     <label>City <input id="city" name="city" required /></label>
 *     <button type="submit">Submit</button>
 *   </form>
 *
 *   <section class="voice-controls">
 *     <button id="vf-start" type="button">Start Voice</button>
 *     <button id="vf-stop"  type="button">Stop Voice</button>
 *     <label>Language
 *       <select id="vf-language">
 *         <option value="en-IN">English</option>
 *         <option value="hi-IN">हिन्दी (Hindi)</option>
 *         <option value="bn-IN">বাংলা (Bengali)</option>
 *         <option value="ta-IN">தமிழ் (Tamil)</option>
 *         <option value="te-IN">తెలుగు (Telugu)</option>
 *         <option value="kn-IN">ಕನ್ನಡ (Kannada)</option>
 *         <option value="ml-IN">മലയാളം (Malayalam)</option>
 *         <option value="mr-IN">मराठी (Marathi)</option>
 *         <option value="gu-IN">ગુજરાતી (Gujarati)</option>
 *         <option value="pa-IN">ਪੰਜਾਬੀ (Punjabi)</option>
 *         <option value="od-IN">ଓଡ଼ିଆ (Odia)</option>
 *       </select>
 *     </label>
 *   </section>
 *
 *   <section class="voice-feedback">
 *     <p id="vf-prompt">Click "Start Voice" to begin.</p>
 *     <p id="vf-transcript"></p>
 *     <p id="vf-status"></p>
 *   </section>
 */

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { v2 } from "@myscheme/voice-form-filling";

// ---------------------------------------------------------------------------
// 1. CONFIG — replace the placeholders with your own values.
//    In production, prefer the proxy variant at the bottom of this file so
//    secret keys never reach the browser.
// ---------------------------------------------------------------------------

const SARVAM_API_KEY = "YOUR_SARVAM_API_KEY";
const BEDROCK_MODEL_ID = "anthropic.claude-3-haiku-20240307";
const AWS_REGION = "us-east-1";
const AWS_ACCESS_KEY_ID = "YOUR_AWS_ACCESS_KEY_ID";
const AWS_SECRET_ACCESS_KEY = "YOUR_AWS_SECRET_ACCESS_KEY";

const INITIAL_LANGUAGE: v2.V2SupportedLanguage = "en-IN";

// ---------------------------------------------------------------------------
// 2. DOM REFERENCES — must exist when this script runs.
// ---------------------------------------------------------------------------

const formEl = document.getElementById("my-form") as HTMLFormElement | null;
const startBtn = document.getElementById("vf-start") as HTMLButtonElement | null;
const stopBtn = document.getElementById("vf-stop") as HTMLButtonElement | null;
const langSelect = document.getElementById(
  "vf-language",
) as HTMLSelectElement | null;
const promptEl = document.getElementById("vf-prompt");
const transcriptEl = document.getElementById("vf-transcript");
const statusEl = document.getElementById("vf-status");

if (!formEl || !startBtn || !stopBtn || !langSelect || !promptEl ||
    !transcriptEl || !statusEl) {
  throw new Error(
    "voice-form-example: required DOM elements missing. Confirm the HTML scaffold matches the comment at the top of this file.",
  );
}

// ---------------------------------------------------------------------------
// 3. UI HOOKS — bridge library lifecycle events into your DOM.
//    Every hook is optional; implement only the ones you need.
// ---------------------------------------------------------------------------

const uiHooks: v2.V2UiHooks = {
  // Assistant is about to ask a question. Show it as the active prompt.
  onPrompt: ({ text, fieldId }) => {
    promptEl.textContent = text;
    if (fieldId) {
      const target = formEl.querySelector(`#${CSS.escape(fieldId)}`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.classList.add("vf-active");
    }
  },

  // Same text as onPrompt but fired right before TTS audio plays.
  // Useful if you want a separate "speaking now" indicator.
  onSpeechSynthesis: ({ text }) => {
    promptEl.textContent = text;
  },

  // User speech. `isFinal` is true once Sarvam emits the finalized transcript.
  onTranscript: ({ text, isFinal }) => {
    transcriptEl.textContent = isFinal ? `You said: ${text}` : `Hearing: ${text}`;
  },

  // A field was successfully assigned — highlight it for the user.
  onAssignment: ({ fieldId, value }) => {
    const target = formEl.querySelector(`#${CSS.escape(fieldId)}`);
    target?.classList.remove("vf-active");
    target?.classList.add("vf-filled");
    // eslint-disable-next-line no-console
    console.log("[voice-form] assigned", fieldId, "=", value);
  },

  // Free-form status messages — "Voice assistant started", "Skipped X", etc.
  onStatus: ({ message }) => {
    statusEl.textContent = message;
  },

  // Any error during init, mic, network, etc. Surface to the user.
  onError: ({ error }) => {
    statusEl.textContent = `Error: ${error.message}`;
    // eslint-disable-next-line no-console
    console.error("[voice-form] error:", error);
  },

  // Fired once after initial extraction (and again after step changes).
  onFieldsExtracted: ({ fields }) => {
    // eslint-disable-next-line no-console
    console.log("[voice-form] extracted fields:", fields);
  },

  // Session ended — either user-initiated or after completion / no-response.
  onQuit: ({ confirmed, reason }) => {
    statusEl.textContent =
      reason === "completed"
        ? "All fields completed."
        : reason === "no-response"
          ? "Session ended due to no response."
          : "Voice session stopped.";
    isActive = false;
    updateButtons();
  },

  // IMPORTANT: implement this so the "reset" voice command actually clears
  // the form. The library handles the voice confirmation flow; you supply
  // the DOM-side reset logic.
  onResetRequested: async () => {
    formEl.reset();
    formEl
      .querySelectorAll(".vf-filled, .vf-active")
      .forEach((el) => el.classList.remove("vf-filled", "vf-active"));
  },

  // Optional. Inspect or display the per-field translation that was just
  // generated by Bedrock before TTS spoke it.
  onTranslation: ({ prompt, options }) => {
    // eslint-disable-next-line no-console
    console.debug("[voice-form] translation:", { prompt, options });
  },
};

// ---------------------------------------------------------------------------
// 4. CONTROLLER LIFECYCLE — lazily initialize on first Start click.
// ---------------------------------------------------------------------------

let controller: v2.V2VoiceFormController | null = null;
let isActive = false;

async function ensureController(): Promise<v2.V2VoiceFormController> {
  if (controller) return controller;

  const bedrockClient = new BedrockRuntimeClient({
    region: AWS_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });

  controller = await v2.initializeVoiceForm({
    formSelector: "#my-form",
    language: INITIAL_LANGUAGE,
    defaultLanguage: "en-IN",
    autoStart: false,
    sarvamSpeech: {
      apiKey: SARVAM_API_KEY,
      language: INITIAL_LANGUAGE,
      // Optional voice tuning. Defaults are sensible.
      // pace: 1.0,
      // speaker: "shubh",
    },
    bedrock: {
      direct: {
        client: bedrockClient,
        modelId: BEDROCK_MODEL_ID,
      },
    },
    uiHooks,
    debug: {
      // Set to true if you want verbose console logs from extraction / routing.
      logExtractedFields: false,
    },
  });

  return controller;
}

// ---------------------------------------------------------------------------
// 5. UI EVENT WIRING
// ---------------------------------------------------------------------------

function updateButtons(): void {
  startBtn!.disabled = isActive;
  stopBtn!.disabled = !isActive;
}

startBtn.addEventListener("click", async () => {
  if (isActive) return;
  try {
    const c = await ensureController();
    isActive = true;
    updateButtons();
    await c.start();
  } catch (err) {
    isActive = false;
    updateButtons();
    statusEl.textContent = `Failed to start: ${(err as Error).message}`;
  }
});

stopBtn.addEventListener("click", async () => {
  if (!controller || !isActive) return;
  await controller.stop();
  isActive = false;
  updateButtons();
});

langSelect.addEventListener("change", async () => {
  if (!controller) return;
  await controller.setLanguage(langSelect.value as v2.V2SupportedLanguage);
  statusEl.textContent = `Language switched to ${langSelect.value}`;
});

// Initial button state.
updateButtons();

// ---------------------------------------------------------------------------
// 6. PRODUCTION ALTERNATIVE — backend proxy (recommended).
//
// Don't ship raw AWS or Sarvam keys to the browser in production. Stand up a
// thin backend that holds the keys server-side and forwards Bedrock requests.
// Then replace the `bedrock` block above with:
//
//   bedrock: {
//     proxy: {
//       routerUrl: "/api/bedrock-proxy",          // routes user answers
//       translatorUrl: "/api/bedrock-translate",  // optional; falls back to routerUrl
//     },
//   },
//
// On the backend, accept the posted JSON and forward it to Bedrock using
// `@aws-sdk/client-bedrock-runtime` with credentials from environment vars.
// The library does not embed any provider URLs in its proxy mode — your
// backend is the only thing that ever sees Sarvam / AWS secrets.
// ---------------------------------------------------------------------------
