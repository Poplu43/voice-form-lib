/// <reference types="vite/client" />
/// <reference path="../src/vite-env.d.ts" />

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { AwsBedrockRouter, initializeVoiceForm } from "../src";
import type { SupportedLanguage, UiHooks, VoiceFormController } from "../src";

interface DemoConfig {
  azureSpeech: {
    key: string;
    region: string;
  };
  bedrock: {
    modelId: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

interface StepperController {
  showStep(index: number, options?: { pushHistory?: boolean }): void;
  showStepById(stepId: string, options?: { pushHistory?: boolean }): void;
  showStepForField(fieldId: string, options?: { pushHistory?: boolean }): void;
  reset(): void;
  getCurrentIndex(): number;
}

const config: DemoConfig = {
  azureSpeech: {
    key: (import.meta.env.VITE_AZURE_SPEECH_KEY || "").trim(),
    region: (import.meta.env.VITE_AZURE_SPEECH_REGION || "").trim(),
  },
  bedrock: {
    modelId: (import.meta.env.VITE_BEDROCK_MODEL_ID || "").trim(),
    region: (import.meta.env.VITE_BEDROCK_REGION || "").trim(),
    accessKeyId: (import.meta.env.VITE_AWS_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: (import.meta.env.VITE_AWS_SECRET_ACCESS_KEY || "").trim(),
    sessionToken:
      (import.meta.env.VITE_AWS_SESSION_TOKEN || "").trim() || undefined,
  },
};

const stepper = createStepper();
wireStepControls(stepper);

const elements = {
  start: document.getElementById("start-button") as HTMLButtonElement,
  stop: document.getElementById("stop-button") as HTMLButtonElement,
  log: document.getElementById("log") as HTMLDivElement,
  form: document.getElementById("demo-form") as HTMLFormElement,
  languageSelect: document.getElementById(
    "language-select",
  ) as HTMLSelectElement,
};

const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  "en-US": "English",
  "hi-IN": "Hindi (हिंदी)",
};

let controller: VoiceFormController | null = null;

const hooks: UiHooks = {
  onPrompt: ({ text, fieldId }: { text: string; fieldId?: string }) => {
    if (fieldId) {
      stepper.showStepForField(fieldId, { pushHistory: true });
    }
    appendLog("Prompt", `${text}${fieldId ? ` (field: ${fieldId})` : ""}`);
  },
  onSpeechSynthesis: ({ text }: { text: string }) => appendLog("Spoken", text),
  onTranscript: ({ text, isFinal }: { text: string; isFinal?: boolean }) =>
    appendLog(isFinal ? "Heard" : "Hearing", text),
  onAssignment: ({
    fieldId,
    value,
  }: {
    fieldId: string;
    value: string | string[];
  }) => {
    stepper.showStepForField(fieldId);
    appendLog(
      "Assign",
      `${fieldId} ← ${Array.isArray(value) ? value.join(", ") : value}`,
    );
  },
  onStatus: ({ message }: { message: string }) => appendLog("Status", message),
  onError: ({ error }: { error: Error }) => appendLog("Error", error.message),
  onStepChange: ({
    index,
  }: {
    stepId: string;
    label: string;
    index: number;
    fieldIds: string[];
  }) => stepper.showStep(index, { pushHistory: true }),
};

const initialMissing = collectMissingConfig();
if (initialMissing.length) {
  appendLog(
    "Error",
    `Missing configuration values: ${initialMissing.join(", ")}. Update your Vite environment variables and reload.`,
  );
  elements.start.disabled = true;
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  appendLog(
    "Status",
    "Registration draft captured. Review all sections before submitting on the official portal.",
  );
});

elements.start.addEventListener("click", async () => {
  if (controller) {
    appendLog("Status", "Voice flow is already running.");
    return;
  }

  const missing = collectMissingConfig();
  if (missing.length) {
    appendLog(
      "Error",
      `Cannot start voice form without configuration: ${missing.join(", ")}.`,
    );
    return;
  }

  elements.start.disabled = true;
  elements.stop.disabled = false;

  try {
    const selectedLanguage = elements?.languageSelect
      ?.value as SupportedLanguage;
    controller = await initializeVoiceForm({
      formSelector: "#demo-form",
      azureSpeech: {
        subscriptionKey: config.azureSpeech.key,
        region: config.azureSpeech.region,
      },
      bedrock: {
        modelId: config.bedrock.modelId,
        router: createBedrockRouter(),
      },
      uiHooks: hooks,
      autoStart: true,
      language: selectedLanguage,
    });
    stepper.reset();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog("Error", message);
    elements.start.disabled = false;
    elements.stop.disabled = true;
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
    appendLog("Status", "Voice flow stopped by user.");
    stepper.reset();
    controller = null;
    elements.start.disabled = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog("Error", message);
    elements.stop.disabled = false;
  }
});

elements.languageSelect.addEventListener("change", async () => {
  const selection = elements.languageSelect.value as SupportedLanguage;
  if (controller) {
    try {
      await controller.setLanguage(selection);
      appendLog(
        "Status",
        `Switched language to ${LANGUAGE_LABELS[selection]}.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLog("Error", message);
    }
  }
});

function createBedrockRouter(): AwsBedrockRouter {
  const client = new BedrockRuntimeClient({
    region: config.bedrock.region,
    credentials: buildAwsCredentials(),
  });

  return new AwsBedrockRouter({
    client,
    modelId: config.bedrock.modelId,
  });
}

function buildAwsCredentials() {
  if (!config.bedrock.accessKeyId || !config.bedrock.secretAccessKey) {
    throw new Error(
      "AWS credentials are required to initialize the Bedrock router.",
    );
  }

  if (config.bedrock.sessionToken) {
    return {
      accessKeyId: config.bedrock.accessKeyId,
      secretAccessKey: config.bedrock.secretAccessKey,
      sessionToken: config.bedrock.sessionToken,
    };
  }

  return {
    accessKeyId: config.bedrock.accessKeyId,
    secretAccessKey: config.bedrock.secretAccessKey,
  };
}

function collectMissingConfig(): string[] {
  const missing: string[] = [];
  if (!config.azureSpeech.key) {
    missing.push("VITE_AZURE_SPEECH_KEY");
  }
  if (!config.azureSpeech.region) {
    missing.push("VITE_AZURE_SPEECH_REGION");
  }
  if (!config.bedrock.modelId) {
    missing.push("VITE_BEDROCK_MODEL_ID");
  }
  if (!config.bedrock.region) {
    missing.push("VITE_BEDROCK_REGION");
  }
  if (!config.bedrock.accessKeyId) {
    missing.push("VITE_AWS_ACCESS_KEY_ID");
  }
  if (!config.bedrock.secretAccessKey) {
    missing.push("VITE_AWS_SECRET_ACCESS_KEY");
  }
  return missing;
}

function createStepper(): StepperController {
  const sections = Array.from(
    document.querySelectorAll<HTMLElement>(".form-step"),
  );
  const indicators = Array.from(
    document.querySelectorAll<HTMLElement>(".step-indicator"),
  );
  const fieldToStep = new Map<string, string>();

  sections.forEach((section, index) => {
    section
      .querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >("input, select, textarea")
      .forEach((element) => {
        const fieldId = element.id || element.getAttribute("name");
        if (!fieldId) {
          return;
        }
        if (!fieldToStep.has(fieldId)) {
          fieldToStep.set(fieldId, section.dataset.step ?? String(index + 1));
        }
      });
  });

  const updateHistory = (stepId: string, replace = false) => {
    const url = new URL(window.location.href);
    url.searchParams.set("step", stepId);
    if (replace) {
      window.history.replaceState({ step: stepId }, "", url);
    } else {
      window.history.pushState({ step: stepId }, "", url);
    }
  };

  let currentIndex = 0;
  let historyInitialized = false;

  const apply = (index: number, options?: { pushHistory?: boolean }) => {
    if (!sections.length) {
      return;
    }
    const clamped = Math.min(Math.max(index, 0), sections.length - 1);
    currentIndex = clamped;
    const stepId = sections[clamped]?.dataset.step ?? String(clamped + 1);
    const pushHistory = options?.pushHistory ?? true;

    sections.forEach((section, idx) => {
      section.classList.toggle("is-active", idx === clamped);
    });
    indicators.forEach((indicator, idx) => {
      indicator.classList.toggle("is-active", idx === clamped);
      indicator.classList.toggle("is-complete", idx < clamped);
    });

    if (pushHistory) {
      updateHistory(stepId, !historyInitialized);
      historyInitialized = true;
    } else if (!historyInitialized) {
      updateHistory(stepId, true);
      historyInitialized = true;
    }

    if (sections[clamped]) {
      sections[clamped].scrollIntoView({
        behavior: pushHistory ? "smooth" : "auto",
        block: "start",
      });
    }
  };

  const showStepById = (
    stepId: string,
    options?: { pushHistory?: boolean },
  ) => {
    const index = sections.findIndex(
      (section) => section.dataset.step === stepId,
    );
    if (index === -1) {
      return;
    }
    apply(index, options);
  };

  const url = new URL(window.location.href);
  const urlStep = url.searchParams.get("step");
  if (urlStep) {
    showStepById(urlStep, { pushHistory: false });
  } else {
    const initialIndex = sections.findIndex((section) =>
      section.classList.contains("is-active"),
    );
    apply(initialIndex === -1 ? 0 : initialIndex, { pushHistory: false });
  }

  window.addEventListener("popstate", (event) => {
    const stepId =
      (event.state && typeof event.state.step === "string"
        ? event.state.step
        : null) ?? new URL(window.location.href).searchParams.get("step");
    if (stepId) {
      showStepById(stepId, { pushHistory: false });
    }
  });

  return {
    showStep: (index: number, options?: { pushHistory?: boolean }) =>
      apply(index, options),
    showStepById,
    showStepForField: (
      fieldId: string,
      options?: { pushHistory?: boolean },
    ) => {
      const stepId = fieldToStep.get(fieldId);
      if (stepId !== undefined) {
        showStepById(stepId, options);
      }
    },
    reset: () => apply(0, { pushHistory: true }),
    getCurrentIndex: () => currentIndex,
  };
}

function wireStepControls(stepperController: StepperController): void {
  const moveToStep = (step?: string | null) => {
    if (!step) {
      return;
    }
    const numeric = Number(step);
    if (!Number.isNaN(numeric) && numeric > 0) {
      stepperController.showStep(numeric - 1, { pushHistory: true });
      return;
    }
    stepperController.showStepById(step, { pushHistory: true });
  };

  document
    .querySelectorAll<HTMLButtonElement>("[data-next-step]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        moveToStep(button.dataset.nextStep ?? null);
      });
    });

  document
    .querySelectorAll<HTMLButtonElement>("[data-prev-step]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        moveToStep(button.dataset.prevStep ?? null);
      });
    });

  document
    .querySelectorAll<HTMLElement>(".step-indicator")
    .forEach((indicator) => {
      indicator.addEventListener("click", () => {
        moveToStep(indicator.getAttribute("data-step"));
      });
    });
}

function appendLog(kind: string, message: string) {
  const line = document.createElement("div");
  line.className = "log-line";
  const timestamp = new Date().toLocaleTimeString();
  line.innerHTML = `<strong>[${timestamp}] ${kind}:</strong> <span>${message}</span>`;
  elements.log.appendChild(line);
  elements.log.scrollTop = elements.log.scrollHeight;
}
