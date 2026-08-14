import type { BedrockRoutingRequest, BedrockRoutingResponse } from "./types";

export interface EvaluationSample {
  sessionId: string;
  timestamp: string;
  fieldId: string;
  fieldLabel: string;
  fieldType: string;
  language: string;
  /** Full STT transcript spoken by the user — may contain answers to multiple fields. */
  userUtterance: string;
  /** The TTS prompt that was spoken to the user just before this utterance. */
  ttsPrompt?: string;
  llmInput: BedrockRoutingRequest;
  llmOutput: BedrockRoutingResponse;
  /** The value the LLM assigned to this field (undefined if skipped). */
  assignedValue: string | string[] | undefined;
  confidence: number | undefined;
  durationMs: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}

/**
 * Collects LLM routing call data during a voice-form session and exports it
 * as JSONL for offline evaluation with tools like Ragas.
 *
 * Usage — wire into `observability.onLLMCall`:
 *
 *   const logger = new EvaluationLogger();
 *   initializeVoiceForm({
 *     ...opts,
 *     observability: {
 *       onLLMCall: (event) => logger.record(event),
 *     },
 *   });
 *   // Later: logger.download() in browser, or logger.toJsonl() in Node.
 */
export class EvaluationLogger {
  private readonly samples: EvaluationSample[] = [];
  /** Last TTS prompt spoken per field — set by recordPrompt(), consumed by record(). */
  private readonly lastPromptByField = new Map<string, string>();
  /** Last final STT transcript — set by recordTranscript(), consumed by record(). */
  private lastTranscript = "";

  /**
   * Call from the `onPrompt` UI hook: stores the TTS question so it can be
   * attached to the next routing event for the same field.
   */
  recordPrompt(fieldId: string, text: string): void {
    this.lastPromptByField.set(fieldId, text);
  }

  /**
   * Call from the `onTranscript` UI hook (final transcripts only): stores the
   * last STT transcript so it can be attached to the next routing event.
   */
  recordTranscript(transcript: string): void {
    if (transcript.trim()) {
      this.lastTranscript = transcript;
    }
  }

  /**
   * Record a routing LLM call event. Pass this directly to `onLLMCall` or
   * call it inside a filter (e.g. `if (event.type === "routing") ...`).
   * Automatically attaches any TTS prompt / STT transcript stored via
   * recordPrompt() / recordTranscript().
   */
  record(event: {
    type: string;
    sessionId: string;
    fieldId?: string;
    language?: string;
    input: unknown;
    output: unknown;
    usage?: { inputTokens: number; outputTokens: number };
    durationMs: number;
  }): void {
    if (event.type !== "routing") return;

    const input = event.input as BedrockRoutingRequest;
    const output = event.output as BedrockRoutingResponse;
    const fieldId = event.fieldId ?? input?.currentFieldId ?? "";

    const currentField =
      input?.pendingFields?.find((f) => f.id === fieldId) ??
      input?.pendingFields?.[0];

    const assignment = output?.assignments?.find((a) => a.fieldId === fieldId);

    this.samples.push({
      sessionId: event.sessionId,
      timestamp: new Date().toISOString(),
      fieldId,
      fieldLabel: currentField?.label ?? fieldId,
      fieldType: currentField?.type ?? "text",
      language: event.language ?? input?.language ?? "en-IN",
      userUtterance: input?.userInput ?? "",
      ttsPrompt: this.lastPromptByField.get(fieldId) ?? undefined,
      llmInput: input,
      llmOutput: output,
      assignedValue: assignment?.value,
      confidence: assignment?.confidence,
      durationMs: event.durationMs,
      inputTokens: event.usage?.inputTokens,
      outputTokens: event.usage?.outputTokens,
    });
  }

  /** All collected samples. */
  getSamples(): readonly EvaluationSample[] {
    return this.samples;
  }

  /** Total token usage across all recorded routing calls. */
  totalUsage(): { inputTokens: number; outputTokens: number } {
    return this.samples.reduce(
      (acc, s) => ({
        inputTokens: acc.inputTokens + (s.inputTokens ?? 0),
        outputTokens: acc.outputTokens + (s.outputTokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0 },
    );
  }

  /** Serialise all samples to JSONL (one JSON object per line). */
  toJsonl(): string {
    return this.samples.map((s) => JSON.stringify(s)).join("\n");
  }

  /**
   * Browser: triggers a file download of the JSONL.
   * Node/server: throws — use `toJsonl()` and write to disk yourself.
   */
  download(filename = "eval_data.jsonl"): void {
    if (typeof document === "undefined") {
      throw new Error(
        "EvaluationLogger.download() only works in a browser. Use toJsonl() instead.",
      );
    }
    const blob = new Blob([this.toJsonl()], { type: "application/jsonl" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Reset collected samples. */
  clear(): void {
    this.samples.length = 0;
  }
}
