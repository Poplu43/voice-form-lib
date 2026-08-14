import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  BedrockRouter,
  BedrockRoutingRequest,
  BedrockRoutingResponse,
  FieldAssignment,
  VoiceFormFieldDescriptor,
} from "./types";

export interface AwsBedrockRouterOptions {
  client: BedrockRuntimeClient;
  modelId: string;
  temperature?: number;
  maxTokens?: number;
  debug?: boolean;
}

type OptionMatch = {
  option: { value: string; label: string };
  score: number;
  exact: boolean;
  phoneticExact?: boolean;
};

type FieldOption = { value: string; label: string };

/**
 * Known Indian government category short codes → official long-form expansion.
 * Used to (a) enrich bare option labels sent to the LLM and (b) provide extra
 * words for the generic word-level fuzzy matcher.
 */
const CATEGORY_CODE_EXPANSIONS: Record<string, string> = {
  SC: "Scheduled Caste",
  ST: "Scheduled Tribe",
  OBC: "Other Backward Class",
  GEN: "General",
  GENERAL: "General",
  EWS: "Economically Weaker Section",
  SEBC: "Socially and Educationally Backward Class",
  VJ: "Vimukta Jati",
  NT: "Nomadic Tribe",
  SBC: "Special Backward Class",
  OPEN: "Open / General",
  PWD: "Person with Disability",
  PH: "Physically Handicapped",
};

/**
 * When the option label is just the bare code (e.g. label === value === "ST"),
 * append the known long-form so the LLM has textual anchors to reason from.
 */
function enrichOptionLabel(option: FieldOption): FieldOption {
  const valueUpper = option.value.trim().toUpperCase();
  const expansion = CATEGORY_CODE_EXPANSIONS[valueUpper];
  if (expansion && option.label.trim().toUpperCase() === valueUpper) {
    return { value: option.value, label: `${option.value} (${expansion})` };
  }
  return option;
}

type AmbiguousAssignmentCandidate = {
  assignmentFieldId: string;
  assignmentValue: string;
  fieldLabel: string;
  proposedOption: FieldOption;
  options: FieldOption[];
};

type AssignmentVerificationResult = {
  approved: Array<{
    fieldId: string;
    value: string;
    confidence?: number;
    evidenceType?: string;
    evidenceText?: string;
  }>;
  rejected: Array<{ fieldId: string; value?: string; reason?: string }>;
  followUp?: string;
};

const DEFAULT_MAX_TOKENS = 600;

export class AwsBedrockRouter implements BedrockRouter {
  private readonly client: BedrockRuntimeClient;
  private readonly modelId: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly debug: boolean;

  constructor(options: AwsBedrockRouterOptions) {
    this.client = options.client;
    this.modelId = options.modelId;
    this.temperature = options.temperature ?? 0;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.debug = options.debug ?? false;
  }

  async routeAnswer(
    input: BedrockRoutingRequest,
  ): Promise<BedrockRoutingResponse> {
    const localFastRoute = tryRouteLocally(input);
    if (localFastRoute) {
      if (this.debug) {
        console.log(
          "[BedrockRouter] Local fast route used, skipping Bedrock call",
        );
      }
      const correctedLocal = correctAssignmentValuesFast(
        localFastRoute,
        input.pendingFields,
      );
      if (!hasLowEvidenceSelectableAssignments(correctedLocal, input)) {
        return correctedLocal;
      }
      if (this.debug) {
        console.log(
          "[BedrockRouter] Local fast route contained low-evidence select mapping; falling back to Bedrock verification",
        );
      }
    }

    const payload = buildAnthropicPayloadLite({
      input,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
    });

    const command = new InvokeModelCommand({
      modelId: this.modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload),
    });

    const response = await this.client.send(command);
    const decoder = new TextDecoder("utf-8");
    const body = decoder.decode(response.body ?? new Uint8Array());

    try {
      const parsed = JSON.parse(body) as {
        completion?: string;
        output?: string;
        content?: Array<{ type: string; text?: string }>;
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
        const preview = raw.length > 350 ? `${raw.slice(0, 350)}...` : raw;
        console.log("[BedrockRouter] Raw LLM response preview:", preview);
      }

      const routed = parseAssignmentsFast(raw);
      const corrected = correctAssignmentValuesFast(
        routed,
        input.pendingFields,
        input.completedFields,
      );
      const normalized = normalizeSelectableAssignments(corrected, input);
      const verified = await verifyAmbiguousAssignmentsWithLlm({
        client: this.client,
        modelId: this.modelId,
        temperature: this.temperature,
        input,
        response: normalized,
        debug: this.debug,
      });
      // Fill any fields the LLM missed (or the verification pass rejected)
      // using deterministic local evidence. These additions skip LLM verification
      // intentionally — the local evidence check is the gate.
      const gapFilled = fillMissedFieldsLocally(verified, input);

      if (this.debug) {
        console.log("[BedrockRouter] Routed assignments:", gapFilled);
      }

      return gapFilled;
    } catch (error) {
      throw new Error(
        `Failed to parse Bedrock response: ${(error as Error).message}`,
      );
    }
  }
}

function buildAnthropicPayloadLite(args: {
  input: BedrockRoutingRequest;
  temperature: number;
  maxTokens: number;
}) {
  const { input, temperature, maxTokens } = args;

  const pendingSummary = input.pendingFields.map((field, index) =>
    summarizeField(field, index === 0),
  );

  const completedSummary = input.completedFields.map((field) => ({
    id: field.id,
    name: field.name,
    label: field.label,
    type: field.type,
  }));

  const languageInstruction =
    input.language === "hi-IN"
      ? "If followUp is needed, write followUp in Hindi. When matching Hindi utterances to category options, handle common phonetic variations: 'अनारक्षित'/'anarakshit'/'general' → GENERAL, 'ओबीसी'/'OBC'/'पिछड़ा वर्ग' → OBC, 'एसटी'/'ST'/'अनुसूचित जनजाति' → ST, 'एससी'/'SC'/'अनुसूचित जाति' → SC. Match tolerantly to Devanagari script, romanized Hindi, and English translations."
      : "If followUp is needed, write followUp in English.";

  const systemPrompt = input.isEditMode
    ? [
        // EDIT MODE: Completely different prompt
        "You route edit requests to the correct form field.",
        "The form is already filled. User was asked which field to edit and what the new value should be.",
        "Return ONLY valid JSON. No markdown. No explanations.",
        "Output schema:",
        '{"assignments":[{"fieldId":"string","value":"string | string[]","skip":false}],"followUp":"string"}',
        "",
        "EDIT MODE RULES:",
        "1) Parse the utterance to identify which FIELD NAME is mentioned",
        "2) Common field names: 'Annual family income', 'Community', 'Religion', 'Marital Status', 'Gender', 'Date of Birth', 'Occupation', 'Address', etc.",
        "3) Match the field name to a field in pendingFields by comparing tokens (case-insensitive, partial match OK)",
        "4) Extract the VALUE from the remaining words in the utterance - ignore filler words, noise, and extra text",
        "5) For numeric fields (income, salary, amount), extract only digits and remove text/punctuation",
        "6) For select fields, match to exact option.value from the field's options array",
        "7) Create assignment ONLY for the explicitly named field - DO NOT assign to any other field",
        "8) If you successfully identify a field and extract a value, return the assignment WITHOUT followUp - extra words/noise should be ignored silently",
        "9) ONLY use followUp if you cannot identify ANY field name in the utterance at all",
        "",
        "EXAMPLE PARSING:",
        "Utterance: 'Annual family income. A 4,18,000. Pankaj'",
        "→ Field name: 'Annual family income' (ignore filler words 'A', noise 'Pankaj')",
        "→ Value: '418000' (extract digits)",
        "→ Find field with label matching 'annual family income'",
        "→ Result: {assignments:[{fieldId:'found_field_id',value:'418000'}]} (NO followUp - extra words ignored)",
        "",
        "Utterance: 'Lincoln annual family income 9,00,000'",
        "→ Field name: 'Annual family income' (ignore noise 'Lincoln')",
        "→ Value: '900000' (extract digits)",
        "→ Result: {assignments:[{fieldId:'found_field_id',value:'900000'}]} (NO followUp - extra words ignored)",
        "",
        "Utterance: 'Community General'",
        "→ Field name: 'Community'",
        "→ Value: 'General'",
        "→ Find field with label 'Community', match 'General' to option.value (e.g., 'GENERAL')",
        "→ Result: {assignments:[{fieldId:'community_field_id',value:'GENERAL'}]} (NO followUp)",
        "",
        languageInstruction,
      ].join("\n")
    : [
        // NORMAL MODE: Original prompt
        "You map one spoken utterance to form assignments.",
        "Return ONLY valid JSON. No markdown. No explanations.",
        "Output schema:",
        '{"assignments":[{"fieldId":"string","value":"string | string[]","skip":true|false}],"followUp":"string","specialCommand":{"type":"reset|quit|finish","confidence":0.0}}',
        "Rules:",
        "1) First detect special command (reset/quit/finish).",
        "2) Detect edit intent (change/edit/update/modify/correct/fix). If user edits a named field, prioritize that field even if not current.",
        "3) If not edit intent, first pending field is current question.",
        "4) FIELD NAME MATCHING RULE: When the user explicitly mentions a field name in the utterance (e.g., 'my income is X', 'community is Y', 'update religion to Z'), you MUST match that mentioned field name to the actual field label/name in the pendingFields array. Do NOT assign values to the wrong field. Parse the utterance carefully to identify WHICH value goes with WHICH field name. Examples: User says 'My annual family income is 300000 and update my community to general' → MUST assign '300000' to the income field (matches 'annual family income') and 'general' to the community field (matches 'community'). User says 'I am hindu and my income is 500000' → assign 'hindu' to religion field and '500000' to income field. DO NOT mix up the field-value pairs.",
        "5) Extract ALL recognizable answers from the utterance across every pending field shown — not just the current field. If the user provides information for multiple fields in one utterance, include an assignment for EACH of them. Do NOT stop scanning after finding one field's answer. Do NOT stop scanning because one intermediate field cannot be confidently mapped — skip that field and continue to the remaining pending fields. Produce a followUp only for fields you genuinely could not map; all others must appear in assignments.",
        "6) EXACT VALUE RULE: For select/radio/checkbox fields, you MUST return the EXACT option.value string from the provided options array. Your assignment value must be a CHARACTER-FOR-CHARACTER match (case-insensitive) to one of the option.value strings. NEVER invent, modify, or approximate values. Examples: If options include 'Un Married', return 'Un Married' (with space), NOT 'Unmarried'. If options include 'Cine Worker', return 'Cine Worker', NOT 'Cine Workers'. When matching user utterance to options, be tolerant to spacing ('unmarried' → 'Un Married'), phonetics ('cene' → 'Cine'), punctuation, and transcription errors, but your FINAL returned value MUST be the exact option.value string from the list.",
        "7) Match tolerant to case, spacing, punctuation, and minor transcription errors when interpreting user input.",
        "8) Use skip=true ONLY when the user explicitly asks to skip/leave blank/don't know AND the field has constraints.required=false. NEVER use skip=true for required fields (constraints.required=true); instead return assignments:[] and set followUp explaining the field is mandatory and cannot be skipped.",
        "9) For date fields return DD/MM/YYYY.",
        "10) For numeric fields remove commas and trailing punctuation.",
        "11) Respect field constraints (minLength/maxLength/pattern/min/max/step) while assigning values.",
        "12) For identifier/code-like fields (for example pin/postal/zip/otp/aadhaar), return clean digit strings that satisfy constraints.",
        "13) EXTRACT CLEAN VALUES: For text/textarea/address fields, extract ONLY the meaningful data from conversational utterances. Remove conversational prefixes like 'My X is', 'It is', 'The X is', 'I live in', 'My address is', etc. Extract just the relevant value. Examples: User says 'My house is B128. It is in street number 3' → extract 'B128, Street number 3' or 'B128, Street 3'. User says 'I live in Mumbai Maharashtra' → extract 'Mumbai, Maharashtra'. User says 'The name is John Smith' → extract 'John Smith'. Clean up filler words but preserve meaningful punctuation and structure. For multi-part addresses, intelligently combine the parts.",
        "14) NUMERIC FIELD VALUE EXTRACTION: For pure number/numeric fields (type='number' OR fields with names like 'income', 'salary', 'amount', 'price', 'cost', 'fee', 'age', 'year', 'count', 'quantity'), extract ONLY the numeric digits from the utterance. EXCEPTION: For address-related fields (names containing 'house', 'street', 'flat', 'door', 'building', 'plot', 'block', 'room', 'unit', 'address'), preserve the FULL address context as a text value - do NOT extract only numbers. Examples: NUMERIC EXTRACTION: User says 'Annual family income is ₹3,00,000' → extract '300000' (remove ₹, commas, prefix). User says 'My age is 25 years' → extract '25'. ADDRESS PRESERVATION: User says 'My house number is 123 and street number is 3' for a 'House Number' field → extract '123, Street number 3' (preserve full address). User says 'House is B-128 in sector 3' → extract 'B-128, Sector 3'. For pure numeric fields, remove ALL text; for address fields, preserve meaningful address components.",
        "15) IDENTITY ASSERTION RULE: When the user says 'I am X', 'I am a X', 'mine is X', or 'I belong to X' and X exactly matches (case-insensitive) an option value OR the expansion shown in parentheses in an option label — map it directly to that option. This takes priority over treating X as a normal English word. Example: 'I am General' where options include 'GENERAL (General)' → assign GENERAL. Example: 'I am unmarried' where options include 'Unmarried' → assign Unmarried.",
        "16) SHORT-CODE EXACT-MATCH-FIRST RULE: For short codes (2-3 letter options), extract code from user utterance by removing punctuation/spaces ('S.T.' → 'ST', 'St.' → 'ST'). Then search options for EXACT WHOLE-STRING match to option.value. CRITICAL: 'ST' only matches option.value='ST', NEVER 'ST-PVGT' or any option containing 'ST' as substring. Example: user says 'St.', options=['ST','ST-PVGT','GENERAL'] → normalize to 'ST' → find EXACT match 'ST' → assign 'ST'. If user says 'ST-PVGT', then assign 'ST-PVGT'. Only if NO exact match exists, try expansions like 'Scheduled Tribe'→ST. For phonetic expansion matches use confidence ≥0.85.",
        "17) MULTILINGUAL TRANSLATION RULE: When user input is in Hindi, Devanagari script, or any non-English language, use your built-in translation and language understanding to check if it translates to or means ANY of the available option.value or option.label strings for that field. For EACH field with select/radio/checkbox options, examine ALL provided options and determine if the user's input (when translated to English or interpreted semantically) matches any option. Apply this AUTOMATICALLY to ALL fields - you have multilingual knowledge, so use it! Examples: User says 'जनरल' (Devanagari script meaning 'general') and options include 'GENERAL' → assign GENERAL. User says 'अनारक्षित' (Hindi word meaning 'unreserved'/'general category') and options include 'GENERAL' → assign GENERAL. User says 'ओबीसी' (Devanagari for 'OBC') and options include 'OBC' → assign OBC. User says 'अविवाहित' (Hindi for 'unmarried') and options include 'Un Married' or 'Unmarried' → assign that option. This applies to ALL languages and ALL fields - use your language knowledge to match input to available options. Confidence ≥0.85 for translation matches.",
        "18) PHONETIC MATCHING RULE: For English speech recognition errors, match phonetically and tolerate spacing. Examples: 'cene'/'sene' sounds like 'cine' → 'Cine Worker'; 'unmarried'/'un married' → 'Un Married' or 'Unmarried'; 'limestone'/'lime stone' → 'Limestone & Dolomite Mine (LSDM) Workers'. Use confidence ≥0.85 for phonetic matches.",
        "19) Do NOT guess when evidence is weak. If uncertain about a field, omit it from assignments and mention it in followUp — but still include all other fields you could map.",
        "20) If transcript looks unrelated/noisy/gibberish for a field, do not force-map it.",
        "21) Treat option label/value as aliases. Map short form <-> long form when the expansion appears in the option label (e.g. 'GENERAL (General)').",
        "22) Treat Roman numerals and their Arabic/ordinal equivalents as interchangeable (XII = 12 = 12th).",
        "23) Handle negation for binary/boolean fields: 'not a hosteler', 'I am not married', 'no hostel' → map to the No/N/false/negative option for that field.",
        languageInstruction,
      ].join("\n");

  const userContext = {
    language: input.language,
    userInput: input.userInput,
    currentField: pendingSummary[0] ?? null,
    pendingFields: pendingSummary,
    completedFields: completedSummary,
  };

  return {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    temperature,
    system: [
      {
        type: "text",
        text: systemPrompt,
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify(userContext),
          },
        ],
      },
    ],
  };
}

function summarizeField(
  field: VoiceFormFieldDescriptor,
  includeAllOptions: boolean,
) {
  const options = field.options ?? [];
  const optionLimit = includeAllOptions ? options.length : 8;

  return {
    id: field.id,
    name: field.name,
    label: field.label,
    type: field.type,
    allowMultiple: field.allowMultiple,
    constraints: field.constraints,
    optionsCount: options.length,
    options: options.slice(0, optionLimit).map(enrichOptionLabel),
  };
}

async function verifyAmbiguousAssignmentsWithLlm(args: {
  client: BedrockRuntimeClient;
  modelId: string;
  temperature: number;
  input: BedrockRoutingRequest;
  response: BedrockRoutingResponse;
  debug: boolean;
}): Promise<BedrockRoutingResponse> {
  const candidates = collectAmbiguousAssignmentCandidates(
    args.input,
    args.response,
  );
  if (!candidates.length) {
    return args.response;
  }
  const candidateKeys = new Set<string>(
    candidates.map(
      (candidate) =>
        `${candidate.assignmentFieldId}\u0000${normalizeForCompare(candidate.assignmentValue)}`,
    ),
  );

  const payload = buildAssignmentVerificationPayload({
    input: args.input,
    candidates,
    temperature: Math.min(args.temperature, 0.1),
    maxTokens: Math.max(DEFAULT_MAX_TOKENS, 180),
  });

  try {
    const command = new InvokeModelCommand({
      modelId: args.modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload),
    });

    const verificationResponse = await args.client.send(command);
    const decoder = new TextDecoder("utf-8");
    const rawBody = decoder.decode(
      verificationResponse.body ?? new Uint8Array(),
    );

    let raw = rawBody;
    try {
      const parsed = JSON.parse(rawBody) as {
        completion?: string;
        output?: string;
        content?: Array<{ type: string; text?: string }>;
      };
      raw = parsed.completion ?? parsed.output ?? raw;
      if (!raw && Array.isArray(parsed.content)) {
        const textBlock = parsed.content.find(
          (item) => item.type === "text" && item.text,
        );
        raw = textBlock?.text ?? rawBody;
      }
    } catch {
      // Keep raw body if wrapper is not parseable.
    }

    const parsedVerification = parseAssignmentVerificationResult(raw);
    if (!parsedVerification) {
      if (args.debug) {
        console.warn(
          "[BedrockRouter] Verification response parse failed; rejecting ambiguous assignments",
        );
      }
      return rejectAmbiguousAssignments({
        response: args.response,
        candidateKeys,
        candidates,
        language: args.input.language,
        debug: args.debug,
        reason: "verification_parse_failed",
      });
    }

    const verificationKeys = candidateKeys;
    const candidateByKey = new Map<string, AmbiguousAssignmentCandidate>(
      candidates.map((candidate) => [
        `${candidate.assignmentFieldId}\u0000${normalizeForCompare(candidate.assignmentValue)}`,
        candidate,
      ]),
    );
    const approvedByKey = new Map<
      string,
      {
        fieldId: string;
        value: string;
        confidence?: number;
        evidenceType?: string;
        evidenceText?: string;
      }
    >(
      parsedVerification.approved.map(
        (item) =>
          [
            `${item.fieldId}\u0000${normalizeForCompare(item.value)}`,
            item,
          ] as const,
      ),
    );
    const approvalsByField = new Map<
      string,
      Array<{
        fieldId: string;
        value: string;
        confidence?: number;
        evidenceType?: string;
        evidenceText?: string;
      }>
    >();
    for (const approval of parsedVerification.approved) {
      const existing = approvalsByField.get(approval.fieldId);
      if (existing) {
        existing.push(approval);
      } else {
        approvalsByField.set(approval.fieldId, [approval]);
      }
    }

    let rejectedCount = 0;
    const filteredAssignments = args.response.assignments.filter(
      (assignment) => {
        if (
          assignment.skip ||
          assignment.value === undefined ||
          Array.isArray(assignment.value)
        ) {
          return true;
        }

        const key = `${assignment.fieldId}\u0000${normalizeForCompare(assignment.value)}`;
        if (!verificationKeys.has(key)) {
          return true;
        }

        const candidate = candidateByKey.get(key);
        const approval =
          approvedByKey.get(key) ??
          (candidate
            ? findMatchingVerificationApproval(
                candidate,
                approvalsByField.get(candidate.assignmentFieldId),
              )
            : undefined);
        if (
          candidate &&
          approval &&
          hasVerifiedShortCodeEvidence(
            args.input.userInput,
            candidate,
            approval,
          )
        ) {
          return true;
        }

        rejectedCount += 1;
        return false;
      },
    );

    if (!rejectedCount) {
      return args.response;
    }

    const primaryCandidate = candidates[0];
    const followUp =
      parsedVerification.followUp?.trim() ||
      (primaryCandidate
        ? buildAssignmentVerificationFollowUp(
            primaryCandidate,
            args.input.language,
          )
        : args.response.followUp?.trim() || "");

    if (args.debug) {
      console.log("[BedrockRouter] Rejected ambiguous assignments:", {
        rejectedCount,
        followUp,
      });
    }

    return {
      ...args.response,
      assignments: filteredAssignments,
      followUp,
    };
  } catch (error) {
    if (args.debug) {
      console.warn(
        "[BedrockRouter] Verification pass failed; rejecting ambiguous assignments:",
        (error as Error).message,
      );
    }
    return rejectAmbiguousAssignments({
      response: args.response,
      candidateKeys,
      candidates,
      language: args.input.language,
      debug: args.debug,
      reason: "verification_call_failed",
    });
  }
}

/**
 * After the LLM has returned its assignments, scan every pending selectable
 * field that was NOT assigned and try to fill it using local evidence only.
 *
 * This catches cases where the LLM skipped a field because the option word is
 * also a common English word (e.g. "general") or a speech-recognition variant
 * (e.g. "un married" → "Unmarried"). The local route uses the same alias +
 * fuzzy machinery as the fast path, which is purely deterministic.
 */
function fillMissedFieldsLocally(
  response: BedrockRoutingResponse,
  input: BedrockRoutingRequest,
): BedrockRoutingResponse {
  const assignedFieldIds = new Set(response.assignments.map((a) => a.fieldId));

  const extraAssignments: FieldAssignment[] = [];

  for (const field of input.pendingFields) {
    if (!isSelectableField(field) || !field.options?.length) {
      continue;
    }
    // Already handled by LLM
    if (
      assignedFieldIds.has(field.id) ||
      assignedFieldIds.has(field.name) ||
      assignedFieldIds.has(field.label)
    ) {
      continue;
    }

    // Try exact/alias/phonetic match first
    const match = findBestOptionMatch(input.userInput, field.options);
    if (match && isStrongOptionMatch(match)) {
      extraAssignments.push({ fieldId: field.id, value: match.option.value });
      continue;
    }

    // Try direct evidence across all aliases (handles word-in-label matches
    // like "general" inside "GENERAL (General)")
    const evidenceMatch = field.options.find((opt) =>
      hasDirectOptionEvidence(input.userInput, opt),
    );
    if (evidenceMatch) {
      extraAssignments.push({ fieldId: field.id, value: evidenceMatch.value });
      continue;
    }

    // Try word-level fuzzy for speech-recognition mishearings
    const fuzzyMatches = field.options.filter((opt) =>
      utteranceFuzzyMatchesOptionLabel(input.userInput, opt),
    );
    if (fuzzyMatches.length === 1) {
      extraAssignments.push({
        fieldId: field.id,
        value: fuzzyMatches[0].value,
      });
    }
  }

  if (!extraAssignments.length) {
    return response;
  }

  return {
    ...response,
    assignments: [...response.assignments, ...extraAssignments],
  };
}

function hasLowEvidenceSelectableAssignments(
  response: BedrockRoutingResponse,
  input: BedrockRoutingRequest,
): boolean {
  if (!response.assignments.length) {
    return false;
  }

  const allFields = dedupeFieldsById([
    ...input.pendingFields,
    ...input.completedFields,
  ]);

  for (const assignment of response.assignments) {
    if (
      assignment.skip ||
      assignment.value === undefined ||
      Array.isArray(assignment.value)
    ) {
      continue;
    }

    const field = allFields.find(
      (candidate) =>
        candidate.id === assignment.fieldId ||
        candidate.name === assignment.fieldId ||
        candidate.label === assignment.fieldId,
    );
    if (!field || !isSelectableField(field) || !field.options?.length) {
      continue;
    }

    const option =
      findExactOptionByValueOrLabel(assignment.value, field.options) ??
      findOptionByAlias(assignment.value, field.options);
    if (!option) {
      continue;
    }

    if (!hasDirectOptionEvidence(input.userInput, option)) {
      return true;
    }
  }

  return false;
}

function normalizeSelectableAssignments(
  response: BedrockRoutingResponse,
  input: BedrockRoutingRequest,
): BedrockRoutingResponse {
  if (!response.assignments.length) {
    return response;
  }

  const allFields = dedupeFieldsById([
    ...input.pendingFields,
    ...input.completedFields,
  ]);
  const normalizedAssignments: FieldAssignment[] = [];
  let droppedCount = 0;
  let firstDroppedField: VoiceFormFieldDescriptor | null = null;

  for (const assignment of response.assignments) {
    const field = allFields.find(
      (candidate) =>
        candidate.id === assignment.fieldId ||
        candidate.name === assignment.fieldId ||
        candidate.label === assignment.fieldId,
    );
    if (!field || !isSelectableField(field)) {
      normalizedAssignments.push(assignment);
      continue;
    }

    if (assignment.skip || assignment.value === undefined) {
      normalizedAssignments.push(assignment);
      continue;
    }

    if (!Array.isArray(assignment.value)) {
      normalizedAssignments.push(assignment);
      continue;
    }

    const cleanedValues = assignment.value
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);

    if (field.allowMultiple) {
      if (cleanedValues.length > 0) {
        normalizedAssignments.push({
          ...assignment,
          value: Array.from(new Set(cleanedValues)),
        });
      } else {
        droppedCount += 1;
        if (!firstDroppedField) {
          firstDroppedField = field;
        }
      }
      continue;
    }

    if (cleanedValues.length === 1) {
      normalizedAssignments.push({
        ...assignment,
        value: cleanedValues[0],
      });
      continue;
    }

    droppedCount += 1;
    if (!firstDroppedField) {
      firstDroppedField = field;
    }
  }

  if (!droppedCount) {
    return {
      ...response,
      assignments: normalizedAssignments,
    };
  }

  const followUp =
    buildUnableToMatchFollowUp(firstDroppedField, input.language) ||
    response.followUp;

  return {
    ...response,
    assignments: normalizedAssignments,
    followUp,
  };
}

function buildUnableToMatchFollowUp(
  field: VoiceFormFieldDescriptor | null,
  language?: string,
): string {
  if (!field) {
    return language === "hi-IN"
      ? "मैं आपके उत्तर को विकल्पों से नहीं मिला पाया। कृपया वही प्रश्न फिर से बताइए।"
      : "I was unable to match that response. Please answer the question again.";
  }

  const optionsPreview = (field.options ?? [])
    .slice(0, 6)
    .map((option) => option.label || option.value)
    .filter(Boolean)
    .join(", ");

  if (language === "hi-IN") {
    return optionsPreview
      ? `मैं ${field.label} के लिए आपके उत्तर को विकल्पों से नहीं मिला पाया। कृपया फिर से बताइए। उदाहरण: ${optionsPreview}।`
      : `मैं ${field.label} के लिए आपके उत्तर को विकल्पों से नहीं मिला पाया। कृपया फिर से बताइए।`;
  }

  return optionsPreview
    ? `I was unable to match your response for ${field.label}. Please answer again. Example options: ${optionsPreview}.`
    : `I was unable to match your response for ${field.label}. Please answer again.`;
}

function rejectAmbiguousAssignments(args: {
  response: BedrockRoutingResponse;
  candidateKeys: Set<string>;
  candidates: AmbiguousAssignmentCandidate[];
  language?: string;
  debug: boolean;
  reason: string;
  followUp?: string;
}): BedrockRoutingResponse {
  let removedCount = 0;
  const filteredAssignments = args.response.assignments.filter((assignment) => {
    if (
      assignment.skip ||
      assignment.value === undefined ||
      Array.isArray(assignment.value)
    ) {
      return true;
    }

    const key = `${assignment.fieldId}\u0000${normalizeForCompare(assignment.value)}`;
    if (!args.candidateKeys.has(key)) {
      return true;
    }

    removedCount += 1;
    return false;
  });

  if (!removedCount) {
    return args.response;
  }

  const primaryCandidate = args.candidates[0];
  const followUp =
    args.followUp?.trim() ||
    (primaryCandidate
      ? buildAssignmentVerificationFollowUp(primaryCandidate, args.language)
      : args.response.followUp?.trim() || "");

  if (args.debug) {
    console.warn("[BedrockRouter] Rejected ambiguous assignments (fail-safe)", {
      reason: args.reason,
      removedCount,
    });
  }

  return {
    ...args.response,
    assignments: filteredAssignments,
    followUp,
  };
}

function collectAmbiguousAssignmentCandidates(
  input: BedrockRoutingRequest,
  response: BedrockRoutingResponse,
): AmbiguousAssignmentCandidate[] {
  const allFields = dedupeFieldsById([
    ...input.pendingFields,
    ...input.completedFields,
  ]);
  const candidates: AmbiguousAssignmentCandidate[] = [];
  const seen = new Set<string>();

  for (const assignment of response.assignments) {
    if (
      assignment.skip ||
      assignment.value === undefined ||
      Array.isArray(assignment.value)
    ) {
      continue;
    }

    const field = allFields.find(
      (candidate) =>
        candidate.id === assignment.fieldId ||
        candidate.name === assignment.fieldId ||
        candidate.label === assignment.fieldId,
    );
    if (!field || !isSelectableField(field) || !field.options?.length) {
      continue;
    }

    const matchedOption =
      findExactOptionByValueOrLabel(assignment.value, field.options) ??
      findOptionByAlias(assignment.value, field.options);
    if (!matchedOption) {
      continue;
    }

    const normalizedValue = normalizeForCompare(matchedOption.value);
    if (!normalizedValue) {
      continue;
    }

    const key = `${assignment.fieldId}\u0000${normalizedValue}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    candidates.push({
      assignmentFieldId: assignment.fieldId,
      assignmentValue: matchedOption.value,
      fieldLabel: field.label,
      proposedOption: {
        value: matchedOption.value,
        label: matchedOption.label,
      },
      options: field.options.map((option) => ({
        value: option.value,
        label: option.label,
      })),
    });
  }

  return candidates;
}

function buildAssignmentVerificationPayload(args: {
  input: BedrockRoutingRequest;
  candidates: AmbiguousAssignmentCandidate[];
  temperature: number;
  maxTokens: number;
}) {
  const { input, candidates, temperature, maxTokens } = args;

  const languageInstruction =
    input.language === "hi-IN"
      ? "If followUp is needed, write followUp in Hindi. When matching Hindi utterances to category options, handle common phonetic variations: 'अनारक्षित'/'anarakshit'/'general' → GENERAL, 'ओबीसी'/'OBC'/'पिछड़ा वर्ग' → OBC, 'एसटी'/'ST'/'अनुसूचित जनजाति' → ST, 'एससी'/'SC'/'अनुसूचित जाति' → SC. Match tolerantly to Devanagari script, romanized Hindi, and English translations."
      : "If followUp is needed, write followUp in English.";

  const systemPrompt = [
    "You verify option assignments for form filling.",
    "Return ONLY valid JSON. No markdown. No explanations.",
    "Schema:",
    '{"approved":[{"fieldId":"string","value":"string","confidence":0.0,"evidenceType":"direct_code|direct_label|acronym_expansion|long_form|other","evidenceText":"string"}],"rejected":[{"fieldId":"string","value":"string","reason":"string"}],"followUp":"string"}',
    "Rules:",
    "1) Approve only when utterance strongly supports the proposed option.",
    "2) For short code options (1-3 chars, like SC/ST/OBC), approve only if user explicitly said the code OR clearly said an unambiguous long-form/acronym expansion.",
    "3) Do not guess from unrelated/noisy/gibberish utterances.",
    "4) Every approved item MUST include confidence (0-1), evidenceType, and evidenceText.",
    "5) evidenceText must be an exact short quote from utterance that justifies mapping.",
    "6) If evidenceText has no lexical/phonetic relation to proposed option value/label, reject.",
    "7) If uncertain, reject and provide a concise followUp.",
    languageInstruction,
  ].join("\n");

  const userContext = {
    language: input.language,
    utterance: input.userInput,
    candidates: candidates.map((candidate) => ({
      fieldId: candidate.assignmentFieldId,
      fieldLabel: candidate.fieldLabel,
      proposed: candidate.proposedOption,
      options: candidate.options,
    })),
  };

  return {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    temperature,
    system: [
      {
        type: "text",
        text: systemPrompt,
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify(userContext),
          },
        ],
      },
    ],
  };
}

function parseAssignmentVerificationResult(
  raw: string,
): AssignmentVerificationResult | null {
  const trimmed = raw.trim();
  const candidates: string[] = [];

  if (trimmed) {
    candidates.push(trimmed);
  }

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch?.[1]) {
    candidates.push(codeBlockMatch[1].trim());
  }

  const jsonObjects = extractBalancedJsonObjects(trimmed);
  for (const objectText of jsonObjects) {
    if (/"approved"|"rejected"|"followUp"/i.test(objectText)) {
      candidates.push(objectText);
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const coerced = coerceAssignmentVerificationResult(parsed);
      if (coerced) {
        return coerced;
      }
    } catch {
      // Try next candidate
    }
  }

  return null;
}

function coerceAssignmentVerificationResult(
  value: unknown,
): AssignmentVerificationResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const approvedRaw = Array.isArray(record.approved) ? record.approved : [];
  const rejectedRaw = Array.isArray(record.rejected) ? record.rejected : [];
  const followUp =
    typeof record.followUp === "string" ? record.followUp.trim() : undefined;

  const approved: Array<{
    fieldId: string;
    value: string;
    confidence?: number;
    evidenceType?: string;
    evidenceText?: string;
  }> = [];
  for (const item of approvedRaw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const itemRecord = item as Record<string, unknown>;
    if (
      typeof itemRecord.fieldId !== "string" ||
      !itemRecord.fieldId ||
      typeof itemRecord.value !== "string"
    ) {
      continue;
    }

    const approvedItem: {
      fieldId: string;
      value: string;
      confidence?: number;
      evidenceType?: string;
      evidenceText?: string;
    } = {
      fieldId: itemRecord.fieldId,
      value: itemRecord.value.trim(),
    };
    if (typeof itemRecord.confidence === "number") {
      approvedItem.confidence = itemRecord.confidence;
    }
    if (typeof itemRecord.evidenceType === "string") {
      approvedItem.evidenceType = itemRecord.evidenceType.trim();
    }
    if (typeof itemRecord.evidenceText === "string") {
      approvedItem.evidenceText = itemRecord.evidenceText.trim();
    }
    if (approvedItem.value) {
      approved.push(approvedItem);
    }
  }

  const rejected: Array<{ fieldId: string; value?: string; reason?: string }> =
    [];
  for (const item of rejectedRaw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const itemRecord = item as Record<string, unknown>;
    if (typeof itemRecord.fieldId !== "string" || !itemRecord.fieldId) {
      continue;
    }

    const rejectedItem: { fieldId: string; value?: string; reason?: string } = {
      fieldId: itemRecord.fieldId,
    };
    if (typeof itemRecord.value === "string") {
      rejectedItem.value = itemRecord.value.trim();
    }
    if (typeof itemRecord.reason === "string") {
      rejectedItem.reason = itemRecord.reason.trim();
    }
    rejected.push(rejectedItem);
  }

  if (!approved.length && !rejected.length && !followUp) {
    return null;
  }

  return {
    approved,
    rejected,
    followUp,
  };
}

function buildAssignmentVerificationFollowUp(
  candidate: AmbiguousAssignmentCandidate,
  language?: string,
): string {
  const optionsPreview = candidate.options
    .slice(0, 6)
    .map((option) => option.label || option.value)
    .filter(Boolean)
    .join(", ");

  if (language === "hi-IN") {
    return `${candidate.fieldLabel} के लिए सही विकल्प स्पष्ट नहीं हुआ। कृपया उपलब्ध विकल्पों में से एक विकल्प ठीक-ठीक बोलें, जैसे ${optionsPreview}।`;
  }

  return `I couldn't confidently map ${candidate.fieldLabel}. Please say one exact option, for example ${optionsPreview}.`;
}

function hasVerifiedShortCodeEvidence(
  utterance: string,
  candidate: AmbiguousAssignmentCandidate,
  approval: {
    fieldId: string;
    value: string;
    confidence?: number;
    evidenceType?: string;
    evidenceText?: string;
  },
): boolean {
  const confidence = approval.confidence ?? 0;
  if (confidence < 0.8) {
    return false;
  }

  const evidenceText = approval.evidenceText?.trim();
  if (!evidenceText) {
    return false;
  }

  if (!utteranceContainsEvidenceText(utterance, evidenceText)) {
    return false;
  }

  const optionValueNorm = normalizeForCompare(candidate.proposedOption.value);
  const optionLabelNorm = normalizeForCompare(candidate.proposedOption.label);
  const evidenceNorm = normalizeForCompare(evidenceText);
  if (!evidenceNorm) {
    return false;
  }

  const optionAliases = buildOptionAliasSet(candidate.proposedOption);
  if (optionAliases.has(evidenceNorm)) {
    return true;
  }

  if (evidenceNorm === optionValueNorm || evidenceNorm === optionLabelNorm) {
    return true;
  }

  const evidenceAcronym = buildAcronym(extractAliasWords(evidenceText));
  if (
    evidenceAcronym &&
    (optionValueNorm.includes(evidenceAcronym) ||
      optionLabelNorm.includes(evidenceAcronym) ||
      evidenceAcronym.includes(optionValueNorm) ||
      evidenceAcronym.includes(optionLabelNorm))
  ) {
    return true;
  }

  if ((approval.evidenceType ?? "").toLowerCase() === "direct_code") {
    return evidenceNorm === optionValueNorm || evidenceNorm === optionLabelNorm;
  }

  return hasStrongPhoneticOrSimilarityEvidence(
    evidenceNorm,
    candidate.proposedOption,
  );
}

function findMatchingVerificationApproval(
  candidate: AmbiguousAssignmentCandidate,
  approvals?: Array<{
    fieldId: string;
    value: string;
    confidence?: number;
    evidenceType?: string;
    evidenceText?: string;
  }>,
):
  | {
      fieldId: string;
      value: string;
      confidence?: number;
      evidenceType?: string;
      evidenceText?: string;
    }
  | undefined {
  if (!approvals?.length) {
    return undefined;
  }

  const optionAliases = buildOptionAliasSet(candidate.proposedOption);
  const optionValueNorm = normalizeForCompare(candidate.proposedOption.value);
  const optionLabelNorm = normalizeForCompare(candidate.proposedOption.label);

  for (const approval of approvals) {
    const valueNorm = normalizeForCompare(approval.value);
    if (!valueNorm) {
      continue;
    }

    if (
      valueNorm === optionValueNorm ||
      valueNorm === optionLabelNorm ||
      optionAliases.has(valueNorm)
    ) {
      return approval;
    }
  }

  return undefined;
}

function utteranceContainsEvidenceText(
  utterance: string,
  evidenceText: string,
): boolean {
  if (!evidenceText.trim()) {
    return false;
  }

  const utteranceNorm = normalizeForCompare(utterance);
  const evidenceNorm = normalizeForCompare(evidenceText);
  if (!utteranceNorm || !evidenceNorm) {
    return false;
  }

  return utteranceNorm.includes(evidenceNorm);
}

function hasStrongPhoneticOrSimilarityEvidence(
  normalizedEvidence: string,
  option: FieldOption,
): boolean {
  if (!normalizedEvidence) {
    return false;
  }

  const targets = [
    normalizeForCompare(option.value),
    normalizeForCompare(option.label),
  ].filter(Boolean);
  if (!targets.length) {
    return false;
  }

  const bestLexical = targets.reduce((best, target) => {
    const score = scoreMatch(normalizedEvidence, target);
    return score > best ? score : best;
  }, 0);
  if (bestLexical >= 0.84) {
    return true;
  }

  if (normalizedEvidence.length < 3) {
    return false;
  }

  const evidencePhonetic = toPhoneticKey(normalizedEvidence);
  if (!evidencePhonetic) {
    return false;
  }

  for (const target of targets) {
    if (target.length < 4) {
      continue;
    }
    const targetPhonetic = toPhoneticKey(target);
    if (!targetPhonetic) {
      continue;
    }

    if (evidencePhonetic === targetPhonetic && bestLexical >= 0.42) {
      return true;
    }
  }

  return false;
}

function tryRouteLocally(
  input: BedrockRoutingRequest,
): BedrockRoutingResponse | null {
  // CRITICAL: Skip local routing in edit mode - let Bedrock handle field name matching
  if (input.isEditMode) {
    return null;
  }

  const utterance = input.userInput.trim();
  if (!utterance) {
    return null;
  }

  const specialCommand = detectSpecialCommand(utterance);
  if (specialCommand) {
    return {
      assignments: [],
      specialCommand,
    };
  }

  const currentField = input.pendingFields[0];
  if (!currentField) {
    return null;
  }

  if (isSkipIntent(utterance)) {
    return {
      assignments: [
        {
          fieldId: currentField.id,
          skip: true,
        },
      ],
    };
  }

  const editAssignment = tryLocalEditAssignment(utterance, input);
  if (editAssignment) {
    return editAssignment;
  }

  const looksMultiField = looksLikeMultiFieldUtterance(
    utterance,
    input.pendingFields,
  );

  // When the utterance covers multiple fields, let the LLM handle it entirely.
  // The local route can only return a single assignment; forcing it to pick one
  // field causes all other answers in the utterance to be silently discarded.
  if (looksMultiField) {
    return null;
  }

  if (isSelectableField(currentField) && currentField.options?.length) {
    const match = findBestOptionMatch(utterance, currentField.options);
    if (match && isStrongOptionMatch(match)) {
      return {
        assignments: [
          {
            fieldId: currentField.id,
            value: match.option.value,
          },
        ],
      };
    }

    // Word-level fuzzy fallback for speech-recognition errors
    // (e.g. "Scheduled drive" ≈ "Scheduled Tribe" → ST)
    const fuzzyMatches = currentField.options.filter((opt) =>
      utteranceFuzzyMatchesOptionLabel(utterance, opt),
    );
    if (fuzzyMatches.length === 1) {
      return {
        assignments: [
          {
            fieldId: currentField.id,
            value: fuzzyMatches[0].value,
          },
        ],
      };
    }

    return null;
  }

  if (currentField.type === "number") {
    const numberValue = extractNumericValue(utterance);
    if (numberValue) {
      return {
        assignments: [
          {
            fieldId: currentField.id,
            value: numberValue,
          },
        ],
      };
    }
    return null;
  }

  if (currentField.type === "date") {
    const dateValue = normalizeDateValue(utterance);
    if (dateValue) {
      return {
        assignments: [
          {
            fieldId: currentField.id,
            value: dateValue,
          },
        ],
      };
    }
    return null;
  }

  if (currentField.type === "email") {
    const emailMatch = utterance.match(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
    );
    if (emailMatch) {
      return {
        assignments: [
          {
            fieldId: currentField.id,
            value: emailMatch[0],
          },
        ],
      };
    }
    return null;
  }

  if (currentField.type === "tel") {
    const phoneDigits = utterance.replace(/\D/g, "");
    if (phoneDigits.length >= 7) {
      return {
        assignments: [
          {
            fieldId: currentField.id,
            value: phoneDigits,
          },
        ],
      };
    }
    return null;
  }

  const cleanedText = cleanupTextAnswer(utterance, currentField.label);
  if (!cleanedText) {
    return null;
  }

  return {
    assignments: [
      {
        fieldId: currentField.id,
        value: cleanedText,
      },
    ],
  };
}

function tryLocalEditAssignment(
  utterance: string,
  input: BedrockRoutingRequest,
): BedrockRoutingResponse | null {
  if (!isEditIntent(utterance)) {
    return null;
  }

  const allFields = dedupeFieldsById([
    ...input.pendingFields,
    ...input.completedFields,
  ]);

  const targetField = findMentionedField(utterance, allFields);
  if (!targetField) {
    return null;
  }

  const extractedValue = extractEditValueCandidate(utterance, targetField);
  if (!extractedValue) {
    return null;
  }

  if (isSelectableField(targetField) && targetField.options?.length) {
    const match =
      findBestOptionMatch(extractedValue, targetField.options) ??
      findBestOptionMatch(utterance, targetField.options);

    if (!match || !isStrongOptionMatch(match)) {
      return null;
    }

    return {
      assignments: [
        {
          fieldId: targetField.id,
          value: match.option.value,
        },
      ],
    };
  }

  if (targetField.type === "number") {
    const numberValue = extractNumericValue(extractedValue);
    if (!numberValue) {
      return null;
    }

    return {
      assignments: [
        {
          fieldId: targetField.id,
          value: numberValue,
        },
      ],
    };
  }

  if (targetField.type === "date") {
    const dateValue = normalizeDateValue(extractedValue);
    if (!dateValue) {
      return null;
    }

    return {
      assignments: [
        {
          fieldId: targetField.id,
          value: dateValue,
        },
      ],
    };
  }

  const cleanedText = cleanupTextAnswer(extractedValue, targetField.label);
  if (!cleanedText) {
    return null;
  }

  return {
    assignments: [
      {
        fieldId: targetField.id,
        value: cleanedText,
      },
    ],
  };
}

function dedupeFieldsById(
  fields: VoiceFormFieldDescriptor[],
): VoiceFormFieldDescriptor[] {
  const seen = new Set<string>();
  const deduped: VoiceFormFieldDescriptor[] = [];

  for (const field of fields) {
    if (seen.has(field.id)) {
      continue;
    }
    seen.add(field.id);
    deduped.push(field);
  }

  return deduped;
}

function looksLikeMultiFieldUtterance(
  utterance: string,
  pendingFields: VoiceFormFieldDescriptor[],
): boolean {
  const mentionedFieldCount = countMentionedFields(utterance, pendingFields);
  if (mentionedFieldCount > 1) {
    return true;
  }

  return /\b(and|also|plus|aur|और|तथा)\b/i.test(utterance) &&
    /[,;]|\band\b/i.test(utterance)
    ? true
    : false;
}

function countMentionedFields(
  utterance: string,
  fields: VoiceFormFieldDescriptor[],
): number {
  const normalizedInput = normalizeForCompare(utterance);
  if (!normalizedInput) {
    return 0;
  }

  let count = 0;
  for (const field of fields) {
    const candidates = [field.label, field.name, field.id]
      .map((value) => normalizeForCompare(value))
      .filter((value) => value.length >= 4);

    if (candidates.some((candidate) => normalizedInput.includes(candidate))) {
      count += 1;
    }
  }

  return count;
}

function findMentionedField(
  utterance: string,
  fields: VoiceFormFieldDescriptor[],
): VoiceFormFieldDescriptor | null {
  const normalizedInput = normalizeForCompare(utterance);
  if (!normalizedInput) {
    return null;
  }

  let bestField: VoiceFormFieldDescriptor | null = null;
  let bestScore = 0;

  for (const field of fields) {
    const candidates = [field.label, field.name, field.id]
      .map((value) => normalizeForCompare(value))
      .filter((value) => value.length >= 3);

    for (const candidate of candidates) {
      if (!normalizedInput.includes(candidate)) {
        continue;
      }

      const score = candidate.length;
      if (score > bestScore) {
        bestScore = score;
        bestField = field;
      }
    }
  }

  return bestField;
}

function extractEditValueCandidate(
  utterance: string,
  field: VoiceFormFieldDescriptor,
): string {
  const lower = utterance.toLowerCase();

  const toPattern =
    /\b(?:to|as|=|with|को|में|की जगह)\b\s+([\s\S]+?)\s*[.!?]?\s*$/i;
  const toMatch = lower.match(toPattern);
  if (toMatch?.[1]) {
    return toMatch[1].trim();
  }

  const anchors = [field.label, field.name, field.id]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => b.length - a.length);

  for (const anchor of anchors) {
    const index = lower.indexOf(anchor.toLowerCase());
    if (index < 0) {
      continue;
    }

    const afterAnchor = utterance.slice(index + anchor.length).trim();
    const cleaned = afterAnchor.replace(
      /^(?:is|to|as|ko|ko\s+|ko\s+value\s+|value\s+|field\s+|:|=)+/i,
      "",
    );

    if (cleaned) {
      return cleaned.trim();
    }
  }

  return "";
}

function detectSpecialCommand(
  utterance: string,
): BedrockRoutingResponse["specialCommand"] | undefined {
  const text = utterance
    .toLowerCase()
    .trim()
    .replace(/[.!?]+$/g, "");

  const resetPhrases = [
    "reset",
    "start over",
    "restart",
    "restart form",
    "clear all",
    "clear everything",
    "start again",
    "from beginning",
    "re set",
    "रीसेट",
    "शुरू से",
    "दोबारा शुरू",
    "सब साफ",
  ];

  const quitPhrases = [
    "quit",
    "exit",
    "stop",
    "finish",
    "done",
    "complete",
    "submit",
    "end this",
    "close",
    "बंद करो",
    "रोको",
    "खत्म",
    "पूरा हो गया",
    "समाप्त",
  ];

  if (isLikelyCommand(text, resetPhrases)) {
    return { type: "reset", confidence: 0.95 };
  }

  if (isLikelyCommand(text, quitPhrases)) {
    if (
      /\bfinish\b|\bdone\b|\bcomplete\b|\bsubmit\b|खत्म|समाप्त|पूरा/i.test(text)
    ) {
      return { type: "finish", confidence: 0.9 };
    }
    return { type: "quit", confidence: 0.9 };
  }

  return undefined;
}

function isLikelyCommand(text: string, phrases: string[]): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  const shortUtterance = words.length <= 6;

  for (const phrase of phrases) {
    if (text === phrase) {
      return true;
    }

    if (shortUtterance && text.startsWith(`${phrase} `)) {
      return true;
    }

    if (shortUtterance && text.includes(` ${phrase} `)) {
      return true;
    }
  }

  return false;
}

function isSkipIntent(utterance: string): boolean {
  return /\b(skip|skip this|leave blank|leave it blank|dont know|don't know|pass)\b/i.test(
    utterance,
  );
}

function isEditIntent(utterance: string): boolean {
  return /\b(change|edit|update|modify|correct|fix|alter|revise|बदल|अपडेट|सुधार)\b/i.test(
    utterance,
  );
}

function isSelectableField(field: VoiceFormFieldDescriptor): boolean {
  return (
    field.type === "select" ||
    field.type === "radio" ||
    field.type === "checkbox"
  );
}

function parseAssignmentsFast(raw: string): BedrockRoutingResponse {
  const trimmed = raw.trim();
  const candidates: string[] = [];

  if (trimmed) {
    candidates.push(trimmed);
  }

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch?.[1]) {
    candidates.push(codeBlockMatch[1].trim());
  }

  const jsonObjects = extractBalancedJsonObjects(trimmed);
  for (const objectText of jsonObjects) {
    if (/"assignments"|"specialCommand"|"followUp"/i.test(objectText)) {
      candidates.push(objectText);
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const coerced = coerceRoutingResponse(parsed);
      if (coerced) {
        return coerced;
      }
    } catch {
      // Try next candidate
    }
  }

  return fallbackParseAssignments(trimmed);
}

function extractBalancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function coerceRoutingResponse(value: unknown): BedrockRoutingResponse | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const valueAsRecord = value as Record<string, unknown>;

  if ("data" in valueAsRecord && valueAsRecord.data) {
    return coerceRoutingResponse(valueAsRecord.data);
  }

  const assignmentsRaw = valueAsRecord.assignments;
  const assignments = Array.isArray(assignmentsRaw)
    ? assignmentsRaw
        .map((item) => coerceAssignment(item))
        .filter((item): item is FieldAssignment => Boolean(item))
    : [];

  const response: BedrockRoutingResponse = {
    assignments,
  };

  if (typeof valueAsRecord.followUp === "string") {
    response.followUp = valueAsRecord.followUp;
  }

  const command = valueAsRecord.specialCommand;
  if (
    command &&
    typeof command === "object" &&
    command !== null &&
    (command as Record<string, unknown>).type &&
    typeof (command as Record<string, unknown>).type === "string"
  ) {
    const type = (command as Record<string, unknown>).type as string;
    if (type === "reset" || type === "quit" || type === "finish") {
      const confidenceRaw = (command as Record<string, unknown>).confidence;
      const confidence =
        typeof confidenceRaw === "number" ? confidenceRaw : 0.8;
      response.specialCommand = {
        type,
        confidence,
      };
    }
  }

  if (
    !Array.isArray(assignmentsRaw) &&
    !response.specialCommand &&
    !response.followUp
  ) {
    return null;
  }

  return response;
}

function coerceAssignment(value: unknown): FieldAssignment | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.fieldId !== "string" || !record.fieldId) {
    return null;
  }

  const assignment: FieldAssignment = {
    fieldId: record.fieldId,
  };

  if (typeof record.skip === "boolean") {
    assignment.skip = record.skip;
  }

  if (typeof record.confidence === "number") {
    assignment.confidence = record.confidence;
  }

  if (Array.isArray(record.value)) {
    assignment.value = record.value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  } else if (typeof record.value === "string") {
    assignment.value = record.value.trim();
  }

  return assignment;
}

function fallbackParseAssignments(raw: string): BedrockRoutingResponse {
  const assignments: FieldAssignment[] = [];

  const objectMatches = raw.match(/\{[^{}]*"fieldId"[^{}]*\}/g) ?? [];
  for (const objectText of objectMatches) {
    try {
      const parsed = JSON.parse(objectText) as unknown;
      const assignment = coerceAssignment(parsed);
      if (assignment) {
        assignments.push(assignment);
      }
    } catch {
      // Ignore malformed match
    }
  }

  return {
    assignments,
  };
}

function correctAssignmentValuesFast(
  response: BedrockRoutingResponse,
  pendingFields: VoiceFormFieldDescriptor[],
  completedFields: VoiceFormFieldDescriptor[] = [],
): BedrockRoutingResponse {
  if (!response.assignments.length) {
    return response;
  }

  const allFields = dedupeFieldsById([...pendingFields, ...completedFields]);

  const corrected = response.assignments.map((assignment) => {
    if (assignment.skip || assignment.value === undefined) {
      return assignment;
    }

    const field = allFields.find(
      (candidate) =>
        candidate.id === assignment.fieldId ||
        candidate.name === assignment.fieldId ||
        candidate.label === assignment.fieldId,
    );

    if (!field || !field.options?.length) {
      return assignment;
    }

    if (Array.isArray(assignment.value)) {
      const correctedValues = assignment.value
        .map((value) => {
          const exact = findExactOptionByValueOrLabel(value, field.options!);
          if (exact) {
            return exact.value;
          }

          const aliasMatch = findOptionByAlias(value, field.options!);
          if (aliasMatch) {
            return aliasMatch.value;
          }

          const best = findBestOptionMatch(value, field.options!);
          if (!best || !isStrongOptionMatch(best)) {
            return value;
          }

          return best.option.value;
        })
        .filter(Boolean);

      return {
        ...assignment,
        value: Array.from(new Set(correctedValues)),
      };
    }

    const currentValue = assignment.value;
    const exact = findExactOptionByValueOrLabel(currentValue, field.options);
    if (exact) {
      return {
        ...assignment,
        value: exact.value,
      };
    }

    const aliasMatch = findOptionByAlias(currentValue, field.options);
    if (aliasMatch) {
      return {
        ...assignment,
        value: aliasMatch.value,
      };
    }

    const best = findBestOptionMatch(currentValue, field.options);
    if (!best || !isStrongOptionMatch(best)) {
      return assignment;
    }

    return {
      ...assignment,
      value: best.option.value,
    };
  });

  return {
    ...response,
    assignments: corrected,
  };
}

function findExactOptionByValueOrLabel(
  rawValue: string,
  options: FieldOption[],
): FieldOption | null {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  const byValue = options.find((option) => option.value === trimmed);
  if (byValue) {
    return byValue;
  }

  const byLabel = options.find((option) => option.label === trimmed);
  if (byLabel) {
    return byLabel;
  }

  const normalized = normalizeForCompare(trimmed);
  if (!normalized) {
    return null;
  }

  let uniqueMatch: FieldOption | null = null;
  for (const option of options) {
    const valueNorm = normalizeForCompare(option.value);
    const labelNorm = normalizeForCompare(option.label);
    if (valueNorm !== normalized && labelNorm !== normalized) {
      continue;
    }

    if (!uniqueMatch) {
      uniqueMatch = option;
      continue;
    }

    if (uniqueMatch.value !== option.value) {
      return null;
    }
  }

  return uniqueMatch;
}

function findOptionByAlias(
  rawValue: string,
  options: FieldOption[],
): FieldOption | null {
  const normalizedInput = normalizeForCompare(rawValue);
  if (!normalizedInput) {
    return null;
  }

  let matched: FieldOption | null = null;
  for (const option of options) {
    const aliases = buildOptionAliasSet(option);
    if (!aliases.has(normalizedInput)) {
      continue;
    }

    if (!matched) {
      matched = option;
      continue;
    }

    if (matched.value !== option.value) {
      return null;
    }
  }

  return matched;
}

function buildOptionAliasSet(option: FieldOption): Set<string> {
  const aliases = new Set<string>();

  const pushAlias = (value: string): void => {
    const normalized = normalizeForCompare(value);
    if (normalized) {
      aliases.add(normalized);
    }
  };

  pushAlias(option.value);
  pushAlias(option.label);

  const labelWords = extractAliasWords(option.label);
  const valueWords = extractAliasWords(option.value);

  const labelAcronym = buildAcronym(labelWords);
  if (labelAcronym) {
    aliases.add(labelAcronym);
  }

  const valueAcronym = buildAcronym(valueWords);
  if (valueAcronym) {
    aliases.add(valueAcronym);
  }

  const parenTokens = `${option.value} ${option.label}`.match(
    /[A-Za-z0-9]{2,10}/g,
  );
  if (parenTokens) {
    for (const token of parenTokens) {
      pushAlias(token);
    }
  }

  // Add Arabic numeral aliases for options whose value or label is a valid Roman numeral.
  const romanValueNum = romanToArabic(option.value);
  if (romanValueNum !== null) {
    pushAlias(String(romanValueNum));
    pushAlias(toOrdinalString(romanValueNum));
  }
  const romanLabelNum = romanToArabic(option.label);
  if (romanLabelNum !== null && romanLabelNum !== romanValueNum) {
    pushAlias(String(romanLabelNum));
    pushAlias(toOrdinalString(romanLabelNum));
  }

  return aliases;
}

function extractAliasWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

function buildAcronym(words: string[]): string {
  const significantWords = words.filter(
    (word) =>
      word.length >= 2 &&
      ![
        "and",
        "or",
        "of",
        "the",
        "for",
        "to",
        "in",
        "on",
        "at",
        "a",
        "an",
      ].includes(word),
  );
  if (significantWords.length < 2) {
    return "";
  }

  const acronym = significantWords.map((word) => word[0]).join("");
  return acronym.length >= 2 ? normalizeForCompare(acronym) : "";
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "is",
  "am",
  "are",
  "i",
  "my",
  "me",
  "it",
  "its",
]);

/**
 * Generic word-level fuzzy match between an utterance and an option label.
 *
 * Speech recognition often produces words that are phonetically similar but
 * lexically different (e.g. "drive" for "tribe", "schedule" for "scheduled").
 * This function checks whether the content words of the utterance each have a
 * close match (edit distance \u2264 40% of word length, min 1) in the option word set.
 *
 * Guards against false positives:
 *  - At least 2 utterance content words must match.
 *  - At least 75% of utterance content words must match.
 *  - At least one matched pair involves a long word (\u2265 5 chars each).
 */
function utteranceFuzzyMatchesOptionLabel(
  utterance: string,
  option: FieldOption,
): boolean {
  const optionText = [
    option.value,
    option.label,
    CATEGORY_CODE_EXPANSIONS[option.value.trim().toUpperCase()] ?? "",
  ]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");

  const optionWords = optionText.split(/\s+/).filter((w) => w.length >= 2);
  if (!optionWords.length) {
    return false;
  }

  const utteranceWords = utterance
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));

  if (utteranceWords.length < 2) {
    return false;
  }

  let matchedCount = 0;
  let hasLongWordMatch = false;

  for (const uw of utteranceWords) {
    const maxAllowedDist = Math.max(1, Math.floor(uw.length * 0.4));
    for (const ow of optionWords) {
      const dist = levenshteinDistance(uw, ow);
      if (dist <= maxAllowedDist) {
        matchedCount++;
        if (uw.length >= 5 && ow.length >= 5) {
          hasLongWordMatch = true;
        }
        break;
      }
    }
  }

  if (matchedCount < 2) {
    return false;
  }

  return matchedCount / utteranceWords.length >= 0.75 && hasLongWordMatch;
}

function hasDirectOptionEvidence(
  utterance: string,
  option: FieldOption,
): boolean {
  const normalizedUtterance = normalizeForCompare(utterance);
  if (!normalizedUtterance) {
    return false;
  }

  const utteranceWords = new Set(splitUtteranceWords(utterance));
  const aliases = buildOptionAliasSet(option);
  for (const alias of aliases) {
    if (!alias) {
      continue;
    }

    if (alias.length <= 3) {
      if (utteranceWords.has(alias)) {
        return true;
      }
      // First-letter acronym of utterance words (e.g. "Scheduled Tribe" → "st")
      const words = splitUtteranceWords(utterance);
      if (words.length >= 2) {
        const utteranceAcronym = words.map((w) => w[0]).join("");
        if (
          utteranceAcronym === alias ||
          utteranceAcronym.startsWith(alias) ||
          alias === utteranceAcronym.slice(0, alias.length)
        ) {
          return true;
        }
      }
      continue;
    }

    if (normalizedUtterance.includes(alias)) {
      return true;
    }
  }

  // Generic word-level fuzzy match for speech-recognition mishearings
  if (utteranceFuzzyMatchesOptionLabel(utterance, option)) {
    return true;
  }

  // Negation as direct evidence for binary-negative options
  const optValueNorm = normalizeForCompare(option.value);
  const optLabelNorm = normalizeForCompare(option.label);
  const isNegativeOption =
    optValueNorm === "no" ||
    optValueNorm === "n" ||
    optValueNorm === "false" ||
    optValueNorm === "0" ||
    optLabelNorm === "no" ||
    optLabelNorm === "n" ||
    optLabelNorm === "false" ||
    optLabelNorm === "नहीं" ||
    optLabelNorm === "नही";
  if (isNegativeOption && /\b(not|no|never|without|non)\b/i.test(utterance)) {
    return true;
  }

  return false;
}

function isLikelyShortCodeOption(option: FieldOption): boolean {
  const valueNorm = normalizeForCompare(option.value);
  const labelNorm = normalizeForCompare(option.label);

  if (valueNorm.length > 0 && valueNorm.length <= 3) {
    return true;
  }

  if (labelNorm.length > 0 && labelNorm.length <= 3) {
    return true;
  }

  return /^[A-Z0-9]{2,6}$/.test(option.value.trim());
}

export function findBestOptionMatch(
  utterance: string,
  options: Array<{ value: string; label: string }>,
): OptionMatch | null {
  const candidates = buildCandidateStrings(utterance);
  if (!candidates.length) {
    return null;
  }

  // PRIORITY FIX: Check for exact matches FIRST before any fuzzy matching
  // This prevents "st" from matching "ST-PVGT" before it can match "ST"
  for (const candidate of candidates) {
    for (const option of options) {
      const optionValueNormalized = normalizeForCompare(option.value);
      const optionLabelNormalized = normalizeForCompare(option.label);

      // If candidate exactly matches option.value or option.label, return immediately
      if (
        candidate === optionValueNormalized ||
        candidate === optionLabelNormalized
      ) {
        return {
          option,
          score: 1.0,
          exact: true,
          phoneticExact: false,
        };
      }
    }
  }

  // No exact match found, proceed with fuzzy matching
  let best: OptionMatch | null = null;

  for (const option of options) {
    const targets = Array.from(buildOptionAliasSet(option));

    if (!targets.length) {
      continue;
    }

    for (const target of targets) {
      const targetPhonetic = target.length >= 4 ? toPhoneticKey(target) : "";

      for (const candidate of candidates) {
        let score = scoreMatch(candidate, target);
        const exact = candidate === target;
        let phoneticExact = false;

        if (targetPhonetic && candidate.length >= 2) {
          const candidatePhonetic = toPhoneticKey(candidate);
          if (candidatePhonetic && candidatePhonetic === targetPhonetic) {
            phoneticExact = true;
            score = Math.max(score, 0.98);
          } else if (candidatePhonetic && targetPhonetic) {
            score = Math.max(
              score,
              scoreMatch(candidatePhonetic, targetPhonetic) * 0.96,
            );
          }
        }

        if (
          !best ||
          score > best.score ||
          (score === best.score && (exact || phoneticExact))
        ) {
          best = {
            option,
            score,
            exact,
            phoneticExact,
          };
        }
      }
    }
  }

  return best;
}

function isStrongOptionMatch(match: OptionMatch): boolean {
  if (match.exact || match.phoneticExact) {
    return true;
  }

  const normalizedLength = normalizeForCompare(match.option.value).length;
  const threshold = requiredMatchThreshold(normalizedLength);
  return match.score >= threshold;
}

function requiredMatchThreshold(length: number): number {
  if (length <= 2) {
    return 1;
  }
  if (length <= 4) {
    return 0.86;
  }
  return 0.72;
}

function scoreMatch(candidate: string, target: string): number {
  if (candidate === target) {
    return 1;
  }

  if (target.length <= 2) {
    return 0;
  }

  if (candidate.includes(target) && target.length >= 3) {
    const ratio = Math.min(target.length / candidate.length, 1);
    return 0.95 + ratio * 0.04;
  }

  if (target.includes(candidate) && candidate.length >= 3) {
    const ratio = Math.min(candidate.length / target.length, 1);
    return 0.85 + ratio * 0.1;
  }

  const distance = levenshteinDistance(candidate, target);
  const maxLen = Math.max(candidate.length, target.length);
  if (maxLen === 0) {
    return 1;
  }

  return 1 - distance / maxLen;
}

function buildCandidateStrings(utterance: string): string[] {
  const normalizedWhole = normalizeForCompare(utterance);
  const words = splitUtteranceWords(utterance);
  const candidates = new Set<string>();

  if (normalizedWhole) {
    candidates.add(normalizedWhole);
  }

  for (let start = 0; start < words.length; start += 1) {
    let merged = "";
    const maxWindow = Math.min(words.length - start, 6);

    for (let offset = 0; offset < maxWindow; offset += 1) {
      merged += words[start + offset];
      if (merged.length >= 2) {
        candidates.add(merged);
      }
    }
  }

  // For each numeric/ordinal word in the utterance, also add the Roman numeral equivalent
  // so that e.g. "12th" matches an option whose value is "XII".
  for (const word of words) {
    const numMatch = word.match(/^(\d+)(?:st|nd|rd|th)?$/);
    if (numMatch) {
      const n = parseInt(numMatch[1], 10);
      const roman = arabicToRoman(n);
      if (roman) {
        candidates.add(normalizeForCompare(roman));
      }
    }
  }

  return Array.from(candidates).filter(
    // Allow length-1 digits (1–9) so single-digit options like "1" or "2" match.
    (candidate) => candidate.length >= 2 || /^\d$/.test(candidate),
  );
}

function splitUtteranceWords(utterance: string): string[] {
  const normalized = utterance
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => normalizeForCompare(part))
    .filter((part) => part.length >= 1);

  return normalized;
}

function normalizeForCompare(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function toPhoneticKey(input: string): string {
  const normalized = normalizeForCompare(input);
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
    // Common speech recognition errors for religious categories
    .replace(/sick/g, "sikh")
    .replace(/jan/g, "jain")
    .replace(/z/g, "s")
    .replace(/c/g, "k")
    .replace(/h/g, "");

  if (!transformed) {
    return "";
  }

  const first = transformed.charAt(0);
  const rest = transformed.slice(1).replace(/[aeiouy]/g, "");
  return `${first}${rest}`;
}

function levenshteinDistance(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;

  if (aLen === 0) {
    return bLen;
  }
  if (bLen === 0) {
    return aLen;
  }

  const matrix: number[][] = Array.from({ length: aLen + 1 }, () =>
    Array.from({ length: bLen + 1 }, () => 0),
  );

  for (let i = 0; i <= aLen; i += 1) {
    matrix[i][0] = i;
  }
  for (let j = 0; j <= bLen; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= aLen; i += 1) {
    for (let j = 1; j <= bLen; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[aLen][bLen];
}

function extractNumericValue(input: string): string | null {
  const matches = input.match(/-?\d[\d,\.\s]*/g);
  if (!matches || !matches.length) {
    return null;
  }

  const longest = matches.reduce((best, current) =>
    current.length > best.length ? current : best,
  );

  const cleaned = longest
    .replace(/[\s,]/g, "")
    .replace(/\.(?=\D|$)/g, "")
    .replace(/\.$/, "");

  return cleaned || null;
}

function cleanupTextAnswer(input: string, label: string): string {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const labelPattern = new RegExp(`^${escapedLabel}\\s*(?:is|:|-)?\\s*`, "i");

  return input
    .replace(/^\s*(?:i am|i'm|my|it is|its)\s+/i, "")
    .replace(labelPattern, "")
    .replace(/[\s]+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
}

function normalizeDateValue(input: string): string | null {
  const numericDateMatch = input.match(
    /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/,
  );
  if (numericDateMatch) {
    const day = Number(numericDateMatch[1]);
    const month = Number(numericDateMatch[2]);
    const year = normalizeYear(Number(numericDateMatch[3]));
    return formatDate(day, month, year);
  }

  const isoDateMatch = input.match(
    /\b(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/,
  );
  if (isoDateMatch) {
    const year = Number(isoDateMatch[1]);
    const month = Number(isoDateMatch[2]);
    const day = Number(isoDateMatch[3]);
    return formatDate(day, month, year);
  }

  const monthNames =
    "january february march april may june july august september october november december".split(
      " ",
    );

  const monthTextMatch = input.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-zA-Z]+)\s*,?\s*(\d{4})\b/i,
  );
  if (monthTextMatch) {
    const day = Number(monthTextMatch[1]);
    const monthIndex = monthNames.findIndex((month) =>
      month.startsWith(monthTextMatch[2].toLowerCase()),
    );
    if (monthIndex >= 0) {
      const month = monthIndex + 1;
      const year = Number(monthTextMatch[3]);
      return formatDate(day, month, year);
    }
  }

  const monthFirstMatch = input.match(
    /\b([a-zA-Z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})\b/i,
  );
  if (monthFirstMatch) {
    const monthIndex = monthNames.findIndex((month) =>
      month.startsWith(monthFirstMatch[1].toLowerCase()),
    );
    if (monthIndex >= 0) {
      const month = monthIndex + 1;
      const day = Number(monthFirstMatch[2]);
      const year = Number(monthFirstMatch[3]);
      return formatDate(day, month, year);
    }
  }

  const parsedDate = new Date(input);
  if (!Number.isNaN(parsedDate.getTime())) {
    return formatDate(
      parsedDate.getUTCDate(),
      parsedDate.getUTCMonth() + 1,
      parsedDate.getUTCFullYear(),
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Roman numeral ↔ Arabic numeral utilities
// ---------------------------------------------------------------------------

const ROMAN_VALUES: Array<[number, string]> = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

function arabicToRoman(num: number): string {
  if (!Number.isInteger(num) || num < 1 || num > 3999) {
    return "";
  }
  let result = "";
  let remaining = num;
  for (const [value, symbol] of ROMAN_VALUES) {
    while (remaining >= value) {
      result += symbol;
      remaining -= value;
    }
  }
  return result;
}

const ROMAN_CHAR_VALUES: Record<string, number> = {
  I: 1,
  V: 5,
  X: 10,
  L: 50,
  C: 100,
  D: 500,
  M: 1000,
};

/**
 * Parses a Roman numeral string to its Arabic value, returning null if the
 * input is not a valid canonical Roman numeral (cross-validated by converting
 * back with arabicToRoman).
 */
function romanToArabic(roman: string): number | null {
  const trimmed = roman.trim().toUpperCase();
  if (!trimmed || !/^[IVXLCDM]+$/.test(trimmed)) {
    return null;
  }
  let result = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    const curr = ROMAN_CHAR_VALUES[trimmed[i]];
    if (curr === undefined) {
      return null;
    }
    const next = ROMAN_CHAR_VALUES[trimmed[i + 1]] ?? 0;
    result += curr < next ? -curr : curr;
  }
  // Cross-validate: a canonical Roman numeral round-trips through arabicToRoman.
  if (arabicToRoman(result) !== trimmed) {
    return null;
  }
  return result;
}

function toOrdinalString(n: number): string {
  const abs = Math.abs(n);
  const lastTwo = abs % 100;
  const lastOne = abs % 10;
  if (lastTwo >= 11 && lastTwo <= 13) {
    return `${n}th`;
  }
  if (lastOne === 1) return `${n}st`;
  if (lastOne === 2) return `${n}nd`;
  if (lastOne === 3) return `${n}rd`;
  return `${n}th`;
}

// ---------------------------------------------------------------------------

function normalizeYear(year: number): number {
  if (year < 100) {
    return year >= 70 ? year + 1900 : year + 2000;
  }
  return year;
}

function formatDate(day: number, month: number, year: number): string | null {
  if (
    !Number.isFinite(day) ||
    !Number.isFinite(month) ||
    !Number.isFinite(year) ||
    day < 1 ||
    day > 31 ||
    month < 1 ||
    month > 12 ||
    year < 1900 ||
    year > 2200
  ) {
    return null;
  }

  const dd = String(day).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  const yyyy = String(year).padStart(4, "0");
  return `${dd}/${mm}/${yyyy}`;
}
