import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  TranslationError,
  type LLMCallEvent,
  type TranslatedOptionMapping,
  type V2SupportedLanguage,
} from "./types";

export interface BedrockTranslatorOptions {
  client: BedrockRuntimeClient;
  modelId: string;
  temperature?: number;
  maxTokens?: number;
  cache?: Map<string, unknown>;
  debug?: boolean;
  sessionId?: string;
  onLLMCall?: (event: LLMCallEvent) => void | Promise<void>;
}

const LANGUAGE_NAMES: Record<V2SupportedLanguage, string> = {
  "en-IN": "Indian English",
  "hi-IN": "Hindi (हिन्दी)",
  "bn-IN": "Bengali (বাংলা)",
  "ta-IN": "Tamil (தமிழ்)",
  "te-IN": "Telugu (తెలుగు)",
  "kn-IN": "Kannada (ಕನ್ನಡ)",
  "ml-IN": "Malayalam (മലയാളം)",
  "mr-IN": "Marathi (मराठी)",
  "gu-IN": "Gujarati (ગુજરાતી)",
  "pa-IN": "Punjabi (ਪੰਜਾਬੀ)",
  "od-IN": "Odia (ଓଡ଼ିଆ)",
};

const PROMPT_SYSTEM = [
  "You are a precise translator for voice prompts in a form-filling assistant.",
  "Translate the given English text into the target language for natural spoken delivery.",
  "Rules:",
  "1) Return ONLY the translated text. No prefixes, no quotes, no explanations.",
  "2) Preserve numbers, codes, dates, email addresses, URLs, and proper nouns exactly as given.",
  "3) Keep the translation concise and natural to speak aloud.",
  "4) If the input is already in the target language, return it unchanged.",
].join("\n");

const OPTIONS_SYSTEM = [
  "You are a precise translator for selectable form option labels.",
  "Given a JSON array of option labels in English, return a JSON array of translated labels in the target language.",
  "Rules:",
  "1) Return ONLY a JSON array of strings. Same length, same order as input. No keys, no wrapper object.",
  "2) Preserve short codes (SC, ST, OBC, GENERAL, etc.) — do not translate or expand them.",
  "3) Translate ordinary descriptive labels into the target language for natural spoken delivery.",
  "4) Do not add quotes, punctuation, or commentary beyond the JSON array itself.",
].join("\n");

export class BedrockTranslator {
  private readonly client: BedrockRuntimeClient;
  private readonly modelId: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly cache: Map<string, unknown>;
  private readonly debug: boolean;
  private readonly sessionId: string;
  private readonly onLLMCall?: (event: LLMCallEvent) => void | Promise<void>;

  constructor(opts: BedrockTranslatorOptions) {
    this.client = opts.client;
    this.modelId = opts.modelId;
    this.temperature = opts.temperature ?? 0;
    this.maxTokens = opts.maxTokens ?? 800;
    this.cache = opts.cache ?? new Map();
    this.debug = opts.debug ?? false;
    this.sessionId = opts.sessionId ?? "";
    this.onLLMCall = opts.onLLMCall;
  }

  clearCache(): void {
    this.cache.clear();
  }

  async translatePrompt(
    text: string,
    targetLanguage: V2SupportedLanguage,
  ): Promise<string> {
    if (!text.trim()) return text;
    if (targetLanguage === "en-IN") return text;

    const cacheKey = `prompt|${targetLanguage}|${text}`;
    const cached = this.cache.get(cacheKey);
    if (typeof cached === "string") return cached;

    const userPrompt = [
      `Target language: ${LANGUAGE_NAMES[targetLanguage] ?? targetLanguage}`,
      `Text to translate:`,
      text,
    ].join("\n");

    const startMs = Date.now();
    try {
      const { text: raw, usage } = await this.invokeClaude(
        PROMPT_SYSTEM,
        userPrompt,
      );
      const translated = raw.trim();
      this.cache.set(cacheKey, translated);
      this.onLLMCall?.({
        type: "translate-prompt",
        modelId: this.modelId,
        sessionId: this.sessionId,
        language: targetLanguage,
        input: { text, targetLanguage },
        output: translated,
        usage: usage
          ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
          : undefined,
        durationMs: Date.now() - startMs,
      });
      return translated;
    } catch (err) {
      throw new TranslationError(
        `Failed to translate prompt to ${targetLanguage}`,
        err,
      );
    }
  }

  async translateOptions(
    options: { value: string; label: string }[],
    targetLanguage: V2SupportedLanguage,
  ): Promise<TranslatedOptionMapping[]> {
    if (options.length === 0) return [];
    if (targetLanguage === "en-IN") {
      return options.map((opt) => ({
        value: opt.value,
        originalLabel: opt.label,
        translatedLabel: opt.label,
        language: targetLanguage,
      }));
    }

    const cacheKey = `options|${targetLanguage}|${options
      .map((opt) => opt.label)
      .join("")}`;
    const cached = this.cache.get(cacheKey);
    if (Array.isArray(cached)) {
      return cached as TranslatedOptionMapping[];
    }

    const userPrompt = [
      `Target language: ${LANGUAGE_NAMES[targetLanguage] ?? targetLanguage}`,
      `Option labels (JSON array):`,
      JSON.stringify(options.map((opt) => opt.label)),
    ].join("\n");

    let translatedLabels: string[] = [];
    let usage: { input_tokens: number; output_tokens: number } | undefined;
    const startMs = Date.now();
    try {
      const res = await this.invokeClaude(OPTIONS_SYSTEM, userPrompt);
      translatedLabels = parseStringArray(res.text, options.length);
      usage = res.usage;
    } catch (err) {
      // Real API / network failures bubble up so the caller can inform the user.
      // LLM parse failures (wrong array length, malformed JSON) are swallowed —
      // the fallback below fills missing slots with the original English labels.
      const isApiFailure =
        err instanceof Error &&
        !err.message.startsWith("BedrockTranslator:");
      if (isApiFailure) {
        throw new TranslationError(
          `Failed to translate options to ${targetLanguage}`,
          err,
        );
      }
      if (this.debug) {
        console.warn(
          "[BedrockTranslator] Option parse failed, using original labels:",
          err,
        );
      }
    }

    // Map back; any missing or empty slot falls back to the original label.
    const result: TranslatedOptionMapping[] = options.map((opt, idx) => ({
      value: opt.value,
      originalLabel: opt.label,
      translatedLabel: translatedLabels[idx] || opt.label,
      language: targetLanguage,
    }));

    this.cache.set(cacheKey, result);
    this.onLLMCall?.({
      type: "translate-options",
      modelId: this.modelId,
      sessionId: this.sessionId,
      language: targetLanguage,
      input: { options, targetLanguage },
      output: result,
      usage: usage
        ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
        : undefined,
      durationMs: Date.now() - startMs,
    });
    return result;
  }

  private async invokeClaude(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<{ text: string; usage?: { input_tokens: number; output_tokens: number } }> {
    const command = new InvokeModelCommand({
      modelId: this.modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        system: [{ type: "text", text: systemPrompt }],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userPrompt }],
          },
        ],
      }),
    });

    const response = await this.client.send(command);
    const body = new TextDecoder("utf-8").decode(
      response.body ?? new Uint8Array(),
    );
    const parsed = JSON.parse(body) as {
      completion?: string;
      output?: string;
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };

    let raw = parsed.completion ?? parsed.output;
    if (!raw && Array.isArray(parsed.content)) {
      const textBlock = parsed.content.find(
        (item) => item.type === "text" && item.text,
      );
      raw = textBlock?.text;
    }
    if (!raw) {
      raw = body;
    }
    if (this.debug) {
      console.log("[BedrockTranslator] Raw response preview:", raw.slice(0, 200));
    }
    return { text: raw, usage: parsed.usage };
  }
}

function parseStringArray(raw: string, expectedLength: number): string[] {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `BedrockTranslator: expected JSON array in response, got: ${trimmed.slice(0, 120)}`,
    );
  }
  const slice = trimmed.slice(start, end + 1);
  const parsed = JSON.parse(slice);
  if (!Array.isArray(parsed)) {
    throw new Error("BedrockTranslator: parsed value is not an array");
  }
  // Be lenient about length mismatches: the LLM may merge bilingual labels
  // (e.g. "Class-1/वर्ग 1" → one item instead of two) or add extras.
  // Truncate to expectedLength; missing slots are left as "" so the caller
  // falls back to the original label for that position.
  const result: string[] = [];
  for (let i = 0; i < expectedLength; i++) {
    const item = parsed[i];
    result.push(item !== undefined ? String(item) : "");
  }
  return result;
}
