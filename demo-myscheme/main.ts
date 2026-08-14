/// <reference types="vite/client" />
/// <reference path="../src/vite-env.d.ts" />

import Langfuse from "langfuse";
import { EvaluationLogger, initializeVoiceForm } from "../src/v2";
import { GatedSpeechProvider } from "../src/v2/gatedSpeechProvider";
import { voiceProfileFromCentroid } from "../src/v2/voiceform";
import voiceProfileJson from "./voice_profile.json";
import type {
  LLMCallEvent,
  V2SupportedLanguage,
  V2UiHooks,
  V2VoiceFormController,
  VoiceFormFieldDescriptor,
} from "../src/v2";

interface DemoConfig {
  sarvam: { apiKey: string };
  bedrock: {
    modelId: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  langfuse: { publicKey: string; secretKey: string; baseUrl: string };
}

const config: DemoConfig = {
  sarvam: {
    apiKey: (import.meta.env.VITE_SARVAM_API_KEY || "").trim(),
  },
  bedrock: {
    modelId: (import.meta.env.VITE_BEDROCK_MODEL_ID || "").trim(),
    region: (import.meta.env.VITE_BEDROCK_REGION || "").trim(),
    accessKeyId: (import.meta.env.VITE_AWS_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: (import.meta.env.VITE_AWS_SECRET_ACCESS_KEY || "").trim(),
    sessionToken:
      (import.meta.env.VITE_AWS_SESSION_TOKEN || "").trim() || undefined,
  },
  langfuse: {
    publicKey: (import.meta.env.VITE_LANGFUSE_PUBLIC_KEY || "").trim(),
    secretKey: (import.meta.env.VITE_LANGFUSE_SECRET_KEY || "").trim(),
    baseUrl: (import.meta.env.VITE_LANGFUSE_BASE_URL || "").trim(),
  },
};

// ── Voice Profile Helper ────────────────────────────────────────────────────

function loadProfile() {
  const saved = localStorage.getItem("enrolled_voice_profile");
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch (e) {
      console.warn("[demo] Failed to parse saved voice profile, falling back to JSON.", e);
    }
  }
  return voiceProfileFromCentroid(
    voiceProfileJson.centroid,
    voiceProfileJson.phrase,
  );
}

// ── Observability setup ─────────────────────────────────────────────────────

const evalLogger = new EvaluationLogger();

const langfuse =
  config.langfuse.publicKey && config.langfuse.secretKey
    ? new Langfuse({
        publicKey: config.langfuse.publicKey,
        secretKey: config.langfuse.secretKey,
        ...(config.langfuse.baseUrl ? { baseUrl: config.langfuse.baseUrl } : {}),
      })
    : null;

if (!langfuse) {
  console.warn("[demo] VITE_LANGFUSE_PUBLIC_KEY not set — Langfuse tracing disabled.");
}

function onSessionStart(sessionId: string, fields: VoiceFormFieldDescriptor[]): void {
  langfuse?.trace({
    id: sessionId,
    name: "voice-form-session",
    metadata: {
      fieldCount: fields.length,
      language: elements.languageSelect.value,
    },
  });
}

function onLLMCall(event: LLMCallEvent): void {
  evalLogger.record(event);
  if (elements.downloadEval) elements.downloadEval.disabled = false;

  langfuse?.generation({
    traceId: event.sessionId,
    name: event.type,
    model: event.modelId,
    input: event.input,
    output: event.output,
    usage: event.usage
      ? { input: event.usage.inputTokens, output: event.usage.outputTokens }
      : undefined,
    metadata: {
      fieldId: event.fieldId,
      language: event.language,
      durationMs: event.durationMs,
      ...(event.error ? { error: event.error.message } : {}),
    },
  });
}

function onSessionEnd(sessionId: string, reason?: string): void {
  langfuse?.trace({ id: sessionId, output: { reason } });
  void langfuse?.flushAsync();

  if (evalLogger.getSamples().length > 0) {
    if (elements.downloadEval) elements.downloadEval.disabled = false;
  }
  const usage = evalLogger.totalUsage();
  console.info(
    `[Langfuse] Session ended (${reason ?? "unknown"}). ` +
    `Total tokens so far — in: ${usage.inputTokens}, out: ${usage.outputTokens}`,
  );
}

// ── DOM elements ────────────────────────────────────────────────────────────

const elements = {
  start: document.getElementById("start-button") as HTMLButtonElement,
  stop: document.getElementById("stop-button") as HTMLButtonElement,
  enroll: document.getElementById("enroll-button") as HTMLButtonElement | null,
  downloadEval: document.getElementById("download-eval-button") as HTMLButtonElement | null,
  form: document.getElementById("demo-form") as HTMLFormElement,
  languageSelect: document.getElementById("language-select") as HTMLSelectElement,
  noiseSuppressionSelect: document.getElementById(
    "noise-suppression-select",
  ) as HTMLSelectElement,
  recordAudioCheckbox: document.getElementById(
    "record-audio-checkbox",
  ) as HTMLInputElement,
  recordingsPanel: document.getElementById("recordings-panel") as HTMLElement,
  rawRecordingAudio: document.getElementById(
    "raw-recording-audio",
  ) as HTMLAudioElement,
  rawRecordingDownload: document.getElementById(
    "raw-recording-download",
  ) as HTMLAnchorElement,
  processedRecordingAudio: document.getElementById(
    "processed-recording-audio",
  ) as HTMLAudioElement,
  processedRecordingDownload: document.getElementById(
    "processed-recording-download",
  ) as HTMLAnchorElement,
  statusBubble: document.getElementById("status-bubble") as HTMLDivElement,
  promptBubble: document.getElementById("prompt-bubble") as HTMLDivElement,
  transcriptBubble: document.getElementById("transcript-bubble") as HTMLDivElement,
  saveButton: document.querySelector(".action-button--save") as HTMLButtonElement,
};

const LANGUAGE_LABELS: Record<V2SupportedLanguage, string> = {
  "en-IN": "English",
  "hi-IN": "Hindi (हिंदी)",
  "bn-IN": "Bengali (বাংলা)",
  "ta-IN": "Tamil (தமிழ்)",
  "te-IN": "Telugu (తెలుగు)",
  "kn-IN": "Kannada (ಕನ್ನಡ)",
  "ml-IN": "Malayalam (മലയാളം)",
  "mr-IN": "Marathi (मराठी)",
  "gu-IN": "Gujarati (ગુજરાતી)",
  "pa-IN": "Punjabi (ਪੰਜਾਬੀ)",
  "od-IN": "Odia (ଓଡ଼ိଆ)",
};

let controller: V2VoiceFormController | null = null;
let activeFieldId: string | null = null;

const hooks: V2UiHooks = {
  onPrompt: ({ text, fieldId }) => {
    elements.promptBubble.textContent = `Assistant: ${text}`;
    elements.transcriptBubble.textContent = "";
    if (fieldId) {
      highlightField(fieldId);
    }
  },
  onTranscript: ({ text }) => {
    elements.transcriptBubble.textContent = text ? `You said: ${text}` : "";
  },
  onAssignment: () => {
    updateSaveButtonState();
  },
  onStatus: ({ message }) => {
    elements.statusBubble.textContent = message;
  },
  onError: ({ error }) => {
    elements.statusBubble.textContent = `Error: ${error.message}`;
  },
  onQuit: ({ reason }) => {
    clearFieldHighlight();
    if (controller) showRecordingsIfAvailable(controller);
    controller = null;
    setControlsRunning(false);
    if (reason === "completed") {
      elements.statusBubble.textContent =
        "All fields filled. Press Start Voice Input to begin a new session.";
    } else if (reason === "no-response") {
      elements.statusBubble.textContent =
        "Voice assistant stopped — no response heard. Press Start Voice Input to retry.";
    } else {
      elements.statusBubble.textContent =
        "Voice assistant stopped. Press Start Voice Input to begin again.";
    }
  },
  onResetRequested: () => {
    elements.form.reset();
    clearFieldHighlight();
  },
};

const initialMissing = collectMissingConfig();
if (initialMissing.length) {
  elements.start.disabled = true;
  elements.statusBubble.textContent = `Configuration missing: ${initialMissing.join(", ")}. Update your .env and reload.`;
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  elements.statusBubble.textContent =
    "Form submitted. (demo only — no backend call wired up.)";
});

elements.form.addEventListener("reset", () => {
  setTimeout(() => {
    const state = elements.form.elements.namedItem("state") as
      | HTMLInputElement
      | null;
    if (state) state.value = "HARYANA";
    updateSaveButtonState();
  }, 0);
});

elements.form.addEventListener("input", updateSaveButtonState);
elements.form.addEventListener("change", updateSaveButtonState);

// ── Enrollment Button Wiring ────────────────────────────────────────────────

// The sentence the user reads to enroll. Reading a KNOWN sentence is what lets
// enrollment reject other voices: anything that doesn't match the text is
// somebody else (or the room) and never reaches the voiceprint.
const ENROLL_PHRASES: Partial<Record<V2SupportedLanguage, string>> = {
  "en-IN": "I would like to fill this form using my voice",
  "hi-IN": "mera hindi mai baat krna chahunga",
};

if (elements.enroll) {
  elements.enroll.addEventListener("click", async () => {
    if (controller) {
      elements.statusBubble.textContent = "Please stop the active voice session before enrolling.";
      return;
    }

    const btn = elements.enroll!;
    const selectedLanguage = elements.languageSelect.value as V2SupportedLanguage;
    const phrase = ENROLL_PHRASES[selectedLanguage] ?? ENROLL_PHRASES["en-IN"]!;
    btn.disabled = true;
    btn.textContent = "Listening…";

    try {
      const profile = await GatedSpeechProvider.enrollFromMic(
        {
          models: {
            sileroVad: "/models/silero_vad.onnx",
            campplus: "/models/campplus.onnx",
          },
          // Supplying the key turns on phrase verification — each reading is
          // transcribed and checked before it counts.
          sarvamApiKey: config.sarvam.apiKey,
          sttProxyUrl: "/api/sarvam-stt",
          language: selectedLanguage,
          debug: true,
        },
        {
          phrase,
          count: 3,
          onPrompt: ({ captured, of }) => {
            elements.promptBubble.textContent = `Please read aloud: “${phrase}”`;
            elements.statusBubble.textContent =
              captured === 0
                ? `Voice enrollment: read the sentence above (${of} times).`
                : `Good — ${captured}/${of} captured. Please read it again.`;
          },
          onHeard: ({ text, score, ok }) => {
            elements.transcriptBubble.textContent = ok
              ? `Heard: ${text}`
              : `Didn't match the sentence (${score.toFixed(2)}): ${text}`;
          },
          onProgress: (n, of) => {
            btn.textContent = `Listening… ${n}/${of}`;
          },
        },
      );

      localStorage.setItem("enrolled_voice_profile", JSON.stringify(profile));
      btn.textContent = "Voice Enrolled!";
      elements.promptBubble.textContent = "";
      elements.transcriptBubble.textContent = "";
      elements.statusBubble.textContent =
        "Voice enrolled on this mic. Press Start Voice Input.";
    } catch (err) {
      console.error("[demo] Enrollment failed:", err);
      btn.textContent = "Enrollment Failed";
      elements.statusBubble.textContent = `Enrollment failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = "Enroll my voice";
      }, 3000);
    }
  });
}

elements.start.addEventListener("click", async () => {
  if (controller) {
    elements.statusBubble.textContent = "Voice flow is already running.";
    return;
  }

  const missing = collectMissingConfig();
  if (missing.length) {
    elements.statusBubble.textContent = `Cannot start: missing ${missing.join(", ")}.`;
    return;
  }

  setControlsRunning(true);
  elements.statusBubble.textContent = "Voice assistant starting…";

  try {
    const selectedLanguage = elements.languageSelect.value as V2SupportedLanguage;
    
    // 1. Initialize the Gated Provider using the selected language and loaded profile
    const gatedProvider = new GatedSpeechProvider({
      models: {
        sileroVad: "/models/silero_vad.onnx",
        campplus: "/models/campplus.onnx",
        gtcrn: "/models/gtcrn_simple.onnx",
      },
      profile: loadProfile(),
      matchThreshold: 0.45,
      rejectMargin: 0.05,
      sarvamApiKey: config.sarvam.apiKey,
      sttProxyUrl: "/api/sarvam-stt",
      sttMode: "codemix",
      tts: {
        apiKey: config.sarvam.apiKey,
        language: selectedLanguage,
        ttsUrl: `${window.location.origin}/api/sarvam-tts`,
      },
      language: selectedLanguage,
      debug: true,
    });

    // 2. Pass it into initializeVoiceForm
    controller = await initializeVoiceForm({
      formSelector: "#demo-form",
      bhashiniProxy: {
        provider: gatedProvider,
        language: selectedLanguage,
      },
      bedrock: {
        // Route through the Vite server-side proxy
        proxy: {
          routerUrl: "/api/bedrock/route",
        },
      },
      uiHooks: hooks,
      observability: { onSessionStart, onLLMCall, onSessionEnd },
      autoStart: true,
      language: selectedLanguage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.statusBubble.textContent = `Error: ${message}`;
    setControlsRunning(false);
    controller = null;
  }
});

elements.stop.addEventListener("click", async () => {
  if (!controller) {
    return;
  }

  const active = controller;
  elements.stop.disabled = true;

  try {
    await active.stop();
    elements.statusBubble.textContent = "Voice assistant stopped.";
    elements.promptBubble.textContent = "";
    elements.transcriptBubble.textContent = "";
    clearFieldHighlight();
    showRecordingsIfAvailable(active);
    controller = null;
    setControlsRunning(false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.statusBubble.textContent = `Error: ${message}`;
    elements.stop.disabled = false;
  }
});

elements.downloadEval?.addEventListener("click", () => {
  if (evalLogger.getSamples().length === 0) {
    elements.statusBubble.textContent = "No evaluation data recorded yet.";
    return;
  }
  evalLogger.download("eval_data.jsonl");
  const usage = evalLogger.totalUsage();
  elements.statusBubble.textContent =
    `Downloaded ${evalLogger.getSamples().length} samples. ` +
    `Tokens: in=${usage.inputTokens} out=${usage.outputTokens}`;
});

elements.languageSelect.addEventListener("change", async () => {
  const selection = elements.languageSelect.value as V2SupportedLanguage;
  if (!controller) {
    return;
  }
  try {
    await controller.setLanguage(selection);
    elements.statusBubble.textContent = `Switched language to ${LANGUAGE_LABELS[selection]}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.statusBubble.textContent = `Error: ${message}`;
  }
});

updateSaveButtonState();

function collectMissingConfig(): string[] {
  const missing: string[] = [];
  if (!config.sarvam.apiKey) missing.push("VITE_SARVAM_API_KEY");
  if (!config.bedrock.modelId) missing.push("VITE_BEDROCK_MODEL_ID");
  if (!config.bedrock.region) missing.push("VITE_BEDROCK_REGION");
  if (!config.bedrock.accessKeyId) missing.push("VITE_AWS_ACCESS_KEY_ID");
  if (!config.bedrock.secretAccessKey) missing.push("VITE_AWS_SECRET_ACCESS_KEY");
  return missing;
}

function setControlsRunning(running: boolean) {
  elements.start.disabled = running;
  elements.stop.disabled = !running;
  if (elements.enroll) elements.enroll.disabled = running;
}

let lastRecordingUrls: string[] = [];

function showRecordingsIfAvailable(activeController: V2VoiceFormController) {
  const recordings = activeController.getAudioRecordings();
  if (!recordings) {
    elements.recordingsPanel.hidden = true;
    return;
  }

  // Revoke the previous session's object URLs before creating new ones.
  lastRecordingUrls.forEach((url) => URL.revokeObjectURL(url));
  const rawUrl = URL.createObjectURL(recordings.raw);
  const processedUrl = URL.createObjectURL(recordings.processed);
  lastRecordingUrls = [rawUrl, processedUrl];

  elements.rawRecordingAudio.src = rawUrl;
  elements.rawRecordingDownload.href = rawUrl;
  elements.processedRecordingAudio.src = processedUrl;
  elements.processedRecordingDownload.href = processedUrl;
  elements.recordingsPanel.hidden = false;
}

function updateSaveButtonState() {
  const required =
    elements.form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "[required]",
    );
  const allFilled = Array.from(required).every((el) => {
    const value = (el as HTMLInputElement).value?.trim() ?? "";
    return value !== "";
  });
  elements.saveButton.disabled = !allFilled;
}

function highlightField(fieldId: string): void {
  if (activeFieldId === fieldId) {
    return;
  }
  clearFieldHighlight();

  const target = document.getElementById(fieldId);
  if (!target) {
    return;
  }

  const fieldWrapper = target.closest(".field");
  if (fieldWrapper) {
    fieldWrapper.classList.add("field--active");
  }

  try {
    (target as HTMLElement).focus({ preventScroll: true });
  } catch {
    // ignore — some inputs may not accept programmatic focus
  }

  (fieldWrapper ?? target).scrollIntoView({
    behavior: "smooth",
    block: "center",
  });

  activeFieldId = fieldId;
}

function clearFieldHighlight(): void {
  document
    .querySelectorAll<HTMLElement>(".field--active")
    .forEach((node) => node.classList.remove("field--active"));
  activeFieldId = null;
}