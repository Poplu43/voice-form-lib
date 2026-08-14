import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  BedrockRouter,
  BedrockRoutingRequest,
  BedrockRoutingResponse,
  FieldAssignment,
  LLMCallEvent,
  VoiceFormFieldDescriptor,
} from "./types";

// v2-specific Bedrock router. Unlike v1's AwsBedrockRouter, this class does
// NOT short-circuit to a local heuristic. Every call hits Claude so the LLM
// can clean conversational prefixes from text answers ("My name. Name is
// Rahul Thakur" -> "Rahul Thakur") and route multi-field utterances ("I am
// Hindu, income 50000, unmarried") to all relevant fields in one round.

export interface V2BedrockRouterOptions {
  client: BedrockRuntimeClient;
  modelId: string;
  temperature?: number;
  maxTokens?: number;
  debug?: boolean;
  sessionId?: string;
  onLLMCall?: (event: LLMCallEvent) => void | Promise<void>;
}

const SYSTEM_PROMPT = [
  "You are the semantic extraction engine for a rural India voice form assistant.",
  "Users may speak naturally, indirectly, with accents, mixed Hindi-English, incomplete grammar, STT mistakes, and multiple answers in one utterance.",
  "Return ONLY valid JSON. No markdown fences. No prose.",
  'Schema: {"assignments":[{"fieldId":"string","value":"string|string[]","skip":true|false,"confidence":0.0}],"followUp":"string","specialCommand":{"type":"reset|quit|finish","confidence":0.0}}',
  "",
  "CORE ROUTING CONTRACT:",
  "1) currentFieldId is the field currently being asked. Prefer it for short unlabeled answers, but NEVER force the whole utterance into currentFieldId when the meaning belongs to other pending fields.",
  "2) Scan the ENTIRE utterance and return every field assignment the user gave. One utterance may answer currentFieldId, previous fields, and later pending fields together.",
  "3) Use only field IDs present in pendingFields. Do not invent field IDs, questions, options, or follow-up topics outside this form.",
  "4) If the user says they do not have, cannot provide, do not know, want to leave blank, 'nahi hai', 'mat bharo', not applicable, or similar, return skip=true for that field only if it is optional. If required, do not skip; use followUp explaining it is required.",
  "5) If the user gives other useful values while skipping currentFieldId, return those assignments too. Example: current middle_name, utterance 'My full name is Tom Sawyer and I do not have a middle name' -> first_name='Tom', last_name='Sawyer', middle_name skip=true if optional.",
  "",
  "VALUE EXTRACTION:",
  "6) Extract clean values, not raw speech. Remove field labels, conversational prefixes, filler, self-corrections, and trailing commentary. Keep only the actual answer data. Exception: for numeric/digit fields, never remove or collapse digits — preserve ALL spoken digits in their exact spoken order.",
  "7) Text/name fields: infer names intelligently. If current field is middle name and the user says a two-part full name like 'Tom Sawyer', assign first-name and last-name fields if available, and leave middle name unanswered unless a middle name is clearly spoken. If three-part name is spoken, map first/middle/last when fields exist.",
  "8) Email fields: normalize spoken email words: 'at/add/ad' -> '@', 'dot' -> '.', remove spaces. Do not route 'male/mail' to Email unless the current/pending field is actually email and the utterance contains an email-like address.",
  "9) Dates: output DD/MM/YYYY. Convert natural dates, ordinals, Hindi/English month names, and spoken dates.",
  "10) Numeric/digit fields: output only digits unless the field clearly expects decimal/text. Understand Hindi/English number words, spaced digits, dots between digits. Repetition shorthand applies only to a SINGLE repeated number word: 'double five'='55', 'triple 5'='555', 'paanch paanch'='55'. For long sequences of individually spoken digits (4 or more), output ALL digits in exact spoken order without removing any — do not collapse or drop digits that appear to recur. Example: '1 2 3 4 5 6 7 8 1 2 3 4' must output '123456781234' (12 digits, not 8). Do not invent missing digits.",
  "11) Address-like fields: preserve the address text and digits, but still remove conversational words.",
  "11b) AMOUNT / MONEY / SALARY / INCOME fields: expand Indian and English magnitude words into the full integer and output ALL digits with no separators, commas, currency symbols, or decimals. lakh/lac/laakh = x100000, crore = x10000000, thousand/hazaar/hajaar = x1000, hundred/sau = x100. Combine parts: '3 lakh'->'300000'; 'three lakh fifty six thousand two hundred forty one'->'356241'; 'tin lakh'->'300000'; '50 thousand'->'50000'. If the user speaks a bare number like '356241' or '3,56,241', output '356241'. Never truncate to the leading digit and never drop the magnitude.",
  "",
  "OPTIONS:",
  "12) For select/radio/checkbox fields, return exactly one allowed option.value from that field. Match by meaning, phonetics, transliteration, common STT mistakes, numeric words, and Hindi/English labels. If the user says a synonym or translated phrase, choose the semantically matching available option.value rather than echoing the spoken phrase. Examples: 'mail' while asking Gender -> Male option if present; 'class two' -> Class-2 option, not Class-1; 'son of/sun off' -> Son of option if present; 'family by name' -> the option whose label means Pariwar/Parivar by Name if present; 'miss/missed/mist' -> Ms. option if present (common STT mishearing of the honorific); 'misses/mrs' -> Mrs. option if present; 'shree/shri' -> Mr. option if present; 'my religion is hinduism' -> the Hindu option; 'I am from general category' -> the General option; 'OBC / other backward' -> the OBC option. Always prefer the option whose meaning matches over surface spelling.",
  "13) For checkbox multi-select, return a string[] of exact option.value values when multiple options are clearly selected.",
  "",
  "SPECIAL COMMANDS:",
  "14) Recognize reset/quit/finish/stop/start over only when the utterance is truly a command to the assistant, not a normal field value.",
  "15) If confidence is low, return assignments=[] and a short followUp asking only for the current/pending form information.",
].join("\n");

export class V2BedrockRouter implements BedrockRouter {
  private readonly client: BedrockRuntimeClient;
  private readonly modelId: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly debug: boolean;
  private readonly sessionId: string;
  private readonly onLLMCall?: (event: LLMCallEvent) => void | Promise<void>;

  constructor(opts: V2BedrockRouterOptions) {
    this.client = opts.client;
    this.modelId = opts.modelId;
    this.temperature = opts.temperature ?? 0;
    this.maxTokens = opts.maxTokens ?? 512;
    this.debug = opts.debug ?? false;
    this.sessionId = opts.sessionId ?? "";
    this.onLLMCall = opts.onLLMCall;
  }

  async routeAnswer(
    input: BedrockRoutingRequest,
  ): Promise<BedrockRoutingResponse> {
    const startMs = Date.now();
    const currentField =
      input.pendingFields.find((field) => field.id === input.currentFieldId) ??
      input.pendingFields[0];
    const userContext = {
      userInput: input.userInput,
      language: input.language ?? "en-IN",
      isEditMode: input.isEditMode ?? false,
      currentFieldId: input.currentFieldId ?? currentField?.id,
      currentField: currentField ? summarizeField(currentField) : undefined,
      pendingFields: input.pendingFields.map(summarizeField),
      completedFields: input.completedFields.map((field) => ({
        id: field.id,
        label: field.label,
        type: field.type,
      })),
    };

    const command = new InvokeModelCommand({
      modelId: this.modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        system: [{ type: "text", text: SYSTEM_PROMPT }],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: JSON.stringify(userContext) }],
          },
        ],
      }),
    });

    let raw = "";
    let usage: { input_tokens: number; output_tokens: number } | undefined;
    try {
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
      usage = parsed.usage;
      raw = parsed.completion ?? parsed.output ?? "";
      if (!raw && Array.isArray(parsed.content)) {
        const textBlock = parsed.content.find(
          (item) => item.type === "text" && item.text,
        );
        raw = textBlock?.text ?? "";
      }
    } catch (err) {
      if (this.debug) {
        console.error("[V2BedrockRouter] Bedrock invocation failed:", err);
      }
      this.onLLMCall?.({
        type: "routing",
        modelId: this.modelId,
        sessionId: this.sessionId,
        fieldId: input.currentFieldId,
        language: input.language as any,
        input,
        output: null,
        durationMs: Date.now() - startMs,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      throw err;
    }

    if (this.debug) {
      console.log(
        "[V2BedrockRouter] Raw LLM response:",
        raw.length > 400 ? `${raw.slice(0, 400)}…` : raw,
      );
    }

    const result = parseLenientJson(raw);

    this.onLLMCall?.({
      type: "routing",
      modelId: this.modelId,
      sessionId: this.sessionId,
      fieldId: input.currentFieldId,
      language: input.language as any,
      input,
      output: result,
      usage: usage
        ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
        : undefined,
      durationMs: Date.now() - startMs,
    });

    return result;
  }
}

function summarizeField(field: VoiceFormFieldDescriptor) {
  return {
    id: field.id,
    name: field.name,
    label: field.label,
    type: field.type,
    constraints: field.constraints,
    options: field.options?.map((opt) => ({
      value: opt.value,
      label: opt.label,
    })),
  };
}

function parseLenientJson(text: string): BedrockRoutingResponse {
  if (!text) return { assignments: [] };
  // Strip code-fence wrappers if Claude added them despite instructions.
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return { assignments: [] };
  }
  try {
    const obj = JSON.parse(stripped.slice(start, end + 1));
    return {
      assignments: Array.isArray(obj?.assignments)
        ? obj.assignments.map(coerceAssignment).filter(Boolean)
        : [],
      followUp: typeof obj?.followUp === "string" ? obj.followUp : undefined,
      specialCommand:
        obj?.specialCommand && typeof obj.specialCommand === "object"
          ? {
              type: obj.specialCommand.type,
              confidence: Number(obj.specialCommand.confidence) || 0,
            }
          : undefined,
    };
  } catch {
    return { assignments: [] };
  }
}

function coerceAssignment(raw: unknown): FieldAssignment | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.fieldId !== "string" || !r.fieldId) return null;

  const assignment: FieldAssignment = { fieldId: r.fieldId };

  if (typeof r.skip === "boolean") assignment.skip = r.skip;
  if (typeof r.confidence === "number") assignment.confidence = r.confidence;

  // The LLM sometimes returns numbers (e.g. 500000 for annual income).
  // Always coerce to string so downstream .trim() calls never throw.
  if (Array.isArray(r.value)) {
    assignment.value = r.value.map((v) => String(v).trim()).filter(Boolean);
  } else if (r.value !== undefined && r.value !== null) {
    const s = String(r.value).trim();
    if (s) assignment.value = s;
  }

  return assignment;
}