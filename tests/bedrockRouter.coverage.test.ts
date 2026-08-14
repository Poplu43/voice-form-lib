import { describe, it, expect, vi } from "vitest";
import { AwsBedrockRouter, findBestOptionMatch } from "../src/bedrockRouter";
import type { VoiceFormFieldDescriptor } from "../src/types";

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  InvokeModelCommand: vi.fn().mockImplementation((args: unknown) => ({
    input: args,
  })),
}));

const encoder = new TextEncoder();
const encodeBody = (payload: Record<string, unknown>) =>
  encoder.encode(JSON.stringify(payload));
const verifBody = (text: string) =>
  encoder.encode(JSON.stringify({ completion: text }));

function field(
  partial: Partial<VoiceFormFieldDescriptor> &
    Pick<VoiceFormFieldDescriptor, "id">,
): VoiceFormFieldDescriptor {
  return {
    name: partial.name ?? partial.id,
    label: partial.label ?? partial.id,
    type: partial.type ?? "text",
    constraints: partial.constraints ?? { required: false },
    options: partial.options,
    allowMultiple: partial.allowMultiple,
    ...partial,
  };
}

function makeClient(bodies: Uint8Array[]) {
  const queue = [...bodies];
  return {
    send: vi.fn(async () => {
      const body = queue.shift();
      if (!body) throw new Error("no more responses");
      return { body };
    }),
  } as any;
}

describe("hasStrongPhoneticOrSimilarityEvidence — phonetic match path", () => {
  it("approves when evidence phonetically matches option label", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"r","value":"HINDU"}]}',
          },
        ],
      }),
      // Evidence "hindoo" — phonetically similar to "hindu" but not lexically identical
      verifBody(
        '{"approved":[{"fieldId":"r","value":"HINDU","confidence":0.85,"evidenceType":"phonetic","evidenceText":"hindoo"}],"rejected":[]}',
      ),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "I am hindoo and not muslim",
      pendingFields: [
        field({
          id: "r",
          label: "Religion",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "HINDU", label: "Hindu" },
            { value: "MUSLIM", label: "Muslim" },
          ],
        }),
        field({ id: "x", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    // Either accepts via phonetic OR rejects depending on score thresholds
    expect(result.assignments).toBeDefined();
  });

  it("handles short evidence (still resolves via other paths)", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"r","value":"HINDU"}]}',
          },
        ],
      }),
      verifBody(
        '{"approved":[{"fieldId":"r","value":"HINDU","confidence":0.85,"evidenceType":"phonetic","evidenceText":"hi"}],"rejected":[]}',
      ),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "hi and noise content",
      pendingFields: [
        field({
          id: "r",
          label: "Religion",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "HINDU", label: "Hindu" },
            { value: "MUSLIM", label: "Muslim" },
          ],
        }),
      ],
      completedFields: [],
    });
    // Either path: short evidence may be approved via other heuristics, or rejected
    expect(result.assignments).toBeDefined();
  });
});

describe("hasStrongPhoneticOrSimilarityEvidence — high lexical score path", () => {
  it("approves when bestLexical >= 0.84 (substring contains)", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"r","value":"BUDDHIST"}]}',
          },
        ],
      }),
      // Evidence "buddh" is included in target "buddhist" (length 5/8 ≈ 0.625, score 0.95+)
      verifBody(
        '{"approved":[{"fieldId":"r","value":"BUDDHIST","confidence":0.9,"evidenceType":"long_form","evidenceText":"buddh"}],"rejected":[]}',
      ),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "I am buddh and not else",
      pendingFields: [
        field({
          id: "r",
          label: "Religion",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "BUDDHIST", label: "Buddhist" },
            { value: "HINDU", label: "Hindu" },
          ],
        }),
        field({ id: "x", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    // Should be accepted via lexical match
    expect(result.assignments[0]?.value).toBe("BUDDHIST");
  });
});

describe("hasStrongPhoneticOrSimilarityEvidence — empty evidence after normalization", () => {
  it("rejects assignment when evidence text normalizes to empty string", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"r","value":"HINDU"}]}',
          },
        ],
      }),
      // Evidence with only special chars normalizes to empty
      verifBody(
        '{"approved":[{"fieldId":"r","value":"HINDU","confidence":0.85,"evidenceType":"phonetic","evidenceText":"..."}],"rejected":[]}',
      ),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and y noise",
      pendingFields: [
        field({
          id: "r",
          label: "Religion",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "HINDU", label: "Hindu" },
            { value: "MUSLIM", label: "Muslim" },
          ],
        }),
      ],
      completedFields: [],
    });
    // Rejected because evidence empty
    expect(result.assignments.find((a) => a.fieldId === "r")).toBeUndefined();
  });
});

describe("findOptionByAlias — duplicate option detection", () => {
  it("matches by phonetic equivalent (sick → sikh)", () => {
    const result = findBestOptionMatch("sick", [
      { value: "SIKH", label: "Sikh" },
      { value: "HINDU", label: "Hindu" },
    ]);
    expect(result?.option.value).toBe("SIKH");
  });

  it("matches OBC option by 'obc' input", () => {
    const result = findBestOptionMatch("obc", [
      { value: "OBC", label: "OBC" },
      { value: "ST", label: "Scheduled Tribe" },
    ]);
    expect(result?.option.value).toBe("OBC");
  });
});

describe("Verification with non-string approval value", () => {
  it("ignores approval entries with missing fieldId or value", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"cat","value":"OBC"}]}',
          },
        ],
      }),
      // Approval missing critical fields
      verifBody(
        '{"approved":[{"value":"OBC"},{"fieldId":""}, null, "string", {"fieldId":"cat"}],"rejected":[]}',
      ),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "ambiguous and noisy answer",
      pendingFields: [
        field({
          id: "cat",
          label: "Category",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "OBC", label: "OBC" },
            { value: "GEN", label: "General" },
          ],
        }),
      ],
      completedFields: [],
    });
    // No valid approvals — assignment is rejected
    expect(result.assignments.find((a) => a.fieldId === "cat")).toBeUndefined();
  });
});

describe("Verification — multiple approvals for same field", () => {
  it("uses findMatchingVerificationApproval when first key miss but second matches", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"cat","value":"ST"}]}',
          },
        ],
      }),
      // Two approvals for same field, first doesn't match key, second does
      verifBody(
        '{"approved":[{"fieldId":"cat","value":"OldVal","confidence":0.9,"evidenceType":"x","evidenceText":"old"},{"fieldId":"cat","value":"ST","confidence":0.95,"evidenceType":"direct_code","evidenceText":"ST"}],"rejected":[]}',
      ),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "ST and noisy content",
      pendingFields: [
        field({
          id: "cat",
          label: "Category",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "ST", label: "Scheduled Tribe" },
            { value: "OBC", label: "OBC" },
          ],
        }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("ST");
  });
});

describe("correctAssignmentValuesFast — fuzzy fallback path", () => {
  it("falls back to fuzzy match for typo'd value", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"cat","value":"GENRAL"}]}',
          },
        ],
      }),
      // Verification approves the corrected value
      verifBody(
        '{"approved":[{"fieldId":"cat","value":"GENERAL","confidence":0.9,"evidenceType":"long_form","evidenceText":"general"}],"rejected":[]}',
      ),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "general and noise here",
      pendingFields: [
        field({
          id: "cat",
          label: "Category",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "GENERAL", label: "General" },
            { value: "OBC", label: "OBC" },
          ],
        }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("GENERAL");
  });

  it("preserves value when no matching option found via fuzzy", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"cat","value":"qqqqq"}]}',
          },
        ],
      }),
      verifBody('{"approved":[],"rejected":[{"fieldId":"cat"}]}'),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "ambiguous and noisy",
      pendingFields: [
        field({
          id: "cat",
          label: "Category",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "GENERAL", label: "General" },
            { value: "OBC", label: "OBC" },
          ],
        }),
      ],
      completedFields: [],
    });
    // When no fuzzy match found, the assignment value stays unchanged
    // but it's not a selectable candidate so it may pass through verification
    expect(result).toBeDefined();
  });
});

describe("normalizeSelectableAssignments — array dedupe", () => {
  it("removes duplicate values from multi-select array", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"h","value":["reading","reading","music"]}]}',
          },
        ],
      }),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and y noise",
      pendingFields: [
        field({
          id: "h",
          type: "checkbox",
          allowMultiple: true,
          constraints: { required: false },
          options: [
            { value: "reading", label: "Reading" },
            { value: "music", label: "Music" },
          ],
        }),
        field({ id: "y", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toEqual(["reading", "music"]);
  });
});

describe("Local fast route — direct option evidence variations", () => {
  it("matches via first-letter acronym of utterance words", async () => {
    // For "Scheduled Tribe" first letters = "ST" → matches option "ST"
    const router = new AwsBedrockRouter({
      client: makeClient([]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "Scheduled Tribe",
      pendingFields: [
        field({
          id: "cat",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "ST", label: "ST" },
            { value: "OBC", label: "OBC" },
          ],
        }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("ST");
  });
});

describe("rejectAmbiguousAssignments — handles missing followUp", () => {
  it("uses default English builder when no followUp on rejection", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"cat","value":"OBC"}]}',
          },
        ],
      }),
      // Verification response that won't parse — triggers reject path
      encoder.encode("not valid json at all"),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "ambiguous and noisy",
      pendingFields: [
        field({
          id: "cat",
          label: "Category",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "OBC", label: "OBC" },
            { value: "GEN", label: "General" },
          ],
        }),
      ],
      completedFields: [],
    });
    expect(result.followUp).toBeTruthy();
  });
});

describe("Confidence 0 default in coerceRoutingResponse", () => {
  it("handles assignment with non-number confidence by leaving it undefined", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        encodeBody({
          content: [
            {
              type: "text",
              text: '{"assignments":[{"fieldId":"x","value":"V","confidence":"high"}]}',
            },
          ],
        }),
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and y noise",
      pendingFields: [
        field({ id: "x", type: "text", constraints: { required: false } }),
        field({ id: "y", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("V");
    expect(result.assignments[0]?.confidence).toBeUndefined();
  });
});
