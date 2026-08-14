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

describe("verification — rejection path produces followUp", () => {
  it("rejects assignment and builds followUp with field options", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"cat","value":"ST"}]}',
          },
        ],
      }),
      // Verification: explicitly NO approvals (so rejection logic fires)
      verifBody('{"approved":[],"rejected":[{"fieldId":"cat","value":"ST","reason":"unclear"}],"followUp":"Tell me again"}'),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
      debug: true,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await router.routeAnswer({
      userInput: "noisy ambiguous answer here",
      pendingFields: [
        field({
          id: "cat",
          label: "Category",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "ST", label: "Scheduled Tribe" },
            { value: "OBC", label: "OBC" },
            { value: "GEN", label: "General" },
          ],
        }),
      ],
      completedFields: [],
    });
    expect(result.assignments.find((a) => a.fieldId === "cat")).toBeUndefined();
    expect(result.followUp).toBeTruthy();
    logSpy.mockRestore();
  });

  it("produces a non-empty followUp message on rejection", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"cat","value":"ST"}]}',
          },
        ],
      }),
      verifBody('{"approved":[],"rejected":[{"fieldId":"cat"}],"followUp":"Custom verification followUp"}'),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "ambiguous answer",
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
    expect(result.followUp).toBeTruthy();
  });

  it("falls back to default followUp builder when verification doesn't provide one", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"cat","value":"ST"}]}',
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
      userInput: "ambiguous answer",
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
    expect(result.followUp).toMatch(/Category|exact/);
  });
});

describe("verification — findMatchingVerificationApproval path", () => {
  it("matches approval by alias when value normalization differs", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"cat","value":"ST"}]}',
          },
        ],
      }),
      // Approval value is "Scheduled Tribe" (label), not the exact value "ST"
      verifBody('{"approved":[{"fieldId":"cat","value":"Scheduled Tribe","confidence":0.95,"evidenceType":"long_form","evidenceText":"Scheduled Tribe"}],"rejected":[]}'),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "Scheduled Tribe and noise content here",
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

  it("does not match when approval is for completely different field/value", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"cat","value":"ST"}]}',
          },
        ],
      }),
      // Approval is for a different field
      verifBody('{"approved":[{"fieldId":"other","value":"X","confidence":0.95,"evidenceType":"direct_code","evidenceText":"x"}],"rejected":[]}'),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "ambiguous answer",
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
    expect(result.assignments.find((a) => a.fieldId === "cat")).toBeUndefined();
  });
});

describe("verification — debug logging", () => {
  it("logs rejection details when debug=true", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"cat","value":"OBC"}]}',
          },
        ],
      }),
      verifBody('{"approved":[],"rejected":[{"fieldId":"cat","value":"OBC","reason":"unclear"}]}'),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
      debug: true,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await router.routeAnswer({
      userInput: "ambiguous answer here",
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
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe("findOptionByAlias scenarios", () => {
  it("matches when alias appears across multiple options uniquely", () => {
    // GENERAL has aliases: general, gen, GENERAL
    const m = findBestOptionMatch("gen", [
      { value: "GENERAL", label: "GEN (General)" },
      { value: "OBC", label: "OBC (Other Backward Class)" },
    ]);
    expect(m?.option.value).toBe("GENERAL");
  });
});

describe("correctAssignmentValuesFast — alias path", () => {
  it("corrects values that match by alias when input contains LLM text", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"cat","value":"general"}]}',
          },
        ],
      }),
      // Successful verification
      verifBody('{"approved":[{"fieldId":"cat","value":"GENERAL","confidence":0.95,"evidenceType":"long_form","evidenceText":"general"}],"rejected":[]}'),
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
    // Value normalized to canonical "GENERAL"
    expect(result.assignments[0]?.value).toBe("GENERAL");
  });

  it("corrects array values via alias matching", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"h","value":["reading","music"]}]}',
          },
        ],
      }),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and noise",
      pendingFields: [
        field({
          id: "h",
          label: "Hobbies",
          type: "checkbox",
          allowMultiple: true,
          constraints: { required: false },
          options: [
            { value: "READING", label: "Reading" },
            { value: "MUSIC", label: "Music" },
          ],
        }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toEqual(["READING", "MUSIC"]);
  });
});

describe("local route — completedFields awareness", () => {
  it("processes assignments referencing completed fields through verification", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"prevField","value":"NEW"}]}',
          },
        ],
      }),
      verifBody('{"approved":[],"rejected":[{"fieldId":"prevField"}]}'),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "new and y noise",
      pendingFields: [
        field({ id: "name", type: "text", constraints: { required: false } }),
      ],
      completedFields: [
        field({
          id: "prevField",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "OLD", label: "Old" },
            { value: "NEW", label: "New" },
          ],
        }),
      ],
    });
    expect(result.assignments).toBeDefined();
  });
});

describe("response parsing — extra fallback paths", () => {
  it("handles assignment with confidence number", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        encodeBody({
          content: [
            {
              type: "text",
              text: '{"assignments":[{"fieldId":"x","value":"V","confidence":0.95}]}',
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
    expect(result.assignments[0]?.confidence).toBe(0.95);
  });

  it("handles malformed individual assignment in array", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        encodeBody({
          content: [
            {
              type: "text",
              text: '{"assignments":[{"fieldId":"x","value":"V"},null,{"value":"X"},{"fieldId":"y","value":"W"}]}',
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
    // Should keep only the 2 valid ones
    expect(result.assignments.length).toBe(2);
  });
});

describe("Local fast path edge - tel field <7 digits", () => {
  it("returns null for tel field with insufficient digits", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        encodeBody({
          content: [{ type: "text", text: '{"assignments":[]}' }],
        }),
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "12345",
      pendingFields: [
        field({ id: "p", type: "tel", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments).toEqual([]);
  });
});

describe("normalizeSelectableAssignments — array with valid+empty mix", () => {
  it("keeps non-empty entries and drops empty strings", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        encodeBody({
          content: [
            {
              type: "text",
              text: '{"assignments":[{"fieldId":"h","value":["reading","","",""]}]}',
            },
          ],
        }),
      ]),
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
            { value: "sports", label: "Sports" },
          ],
        }),
        field({ id: "y", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toEqual(["reading"]);
  });

  it("converts single-element array to scalar for single-select fields", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        encodeBody({
          content: [
            {
              type: "text",
              text: '{"assignments":[{"fieldId":"cat","value":["GENERAL"]}]}',
            },
          ],
        }),
        // Verification approval to keep assignment
        verifBody('{"approved":[{"fieldId":"cat","value":"GENERAL","confidence":0.95,"evidenceType":"long_form","evidenceText":"general"}],"rejected":[]}'),
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "general and noise here",
      pendingFields: [
        field({
          id: "cat",
          type: "select",
          allowMultiple: false,
          constraints: { required: false },
          options: [
            { value: "GENERAL", label: "General" },
            { value: "OBC", label: "OBC" },
          ],
        }),
        field({ id: "y", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("GENERAL");
  });
});
