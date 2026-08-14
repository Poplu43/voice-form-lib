import { describe, it, expect, vi, beforeEach } from "vitest";
import { AwsBedrockRouter, findBestOptionMatch } from "../src/bedrockRouter";
import type {
  BedrockRoutingRequest,
  VoiceFormFieldDescriptor,
} from "../src/types";

// Mock @aws-sdk/client-bedrock-runtime so InvokeModelCommand & the
// client.send() result are deterministic and controllable per test.
vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  return {
    InvokeModelCommand: vi.fn().mockImplementation((args: unknown) => ({
      input: args,
    })),
  };
});

const encoder = new TextEncoder();

function encodeBody(payload: Record<string, unknown>): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

function field(
  partial: Partial<VoiceFormFieldDescriptor> & Pick<VoiceFormFieldDescriptor, "id">,
): VoiceFormFieldDescriptor {
  return {
    name: partial.name ?? partial.id,
    label: partial.label ?? partial.id,
    type: partial.type ?? "text",
    constraints: partial.constraints ?? { required: false },
    options: partial.options,
    allowMultiple: partial.allowMultiple,
    groupId: partial.groupId,
    groupLabel: partial.groupLabel,
    groupIndex: partial.groupIndex,
    ...partial,
  };
}

function makeClient(responses: Array<{ body: Uint8Array }>) {
  const send = vi.fn(async () => {
    const next = responses.shift();
    if (!next) {
      throw new Error("no more mocked responses");
    }
    return { body: next.body };
  });
  return { send } as unknown as ConstructorParameters<typeof AwsBedrockRouter>[0]["client"];
}

describe("AwsBedrockRouter constructor defaults", () => {
  it("uses default temperature, max tokens, and debug flag", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [{ type: "text", text: '{"assignments":[]}' }],
          }),
        },
      ]),
      modelId: "anthropic.claude-3",
    });

    // sanity check: utterance that forces Bedrock (multi-field heuristic via "and")
    const result = await router.routeAnswer({
      userInput: "random gibberish and more gibberish",
      pendingFields: [
        field({
          id: "address",
          type: "textarea",
          constraints: { required: false },
        }),
      ],
      completedFields: [],
    });
    expect(result.assignments).toEqual([]);
  });

  it("debug flag enables console output but doesn't throw", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            completion: '{"assignments":[]}',
          }),
        },
      ]),
      modelId: "anthropic.claude-3",
      debug: true,
      temperature: 0.5,
      maxTokens: 800,
    });

    await router.routeAnswer({
      userInput: "noise without a clear answer and stuff",
      pendingFields: [
        field({ id: "name", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe("Local fast routing — special commands", () => {
  it.each([
    ["reset", "reset"],
    ["start over", "reset"],
    ["restart", "reset"],
    ["clear all", "reset"],
    ["रीसेट", "reset"],
    ["quit", "quit"],
    ["exit", "quit"],
    ["stop", "quit"],
    ["finish", "finish"],
    ["done", "finish"],
    ["complete", "finish"],
    ["submit", "finish"],
  ])("detects '%s' as %s", async (utterance, expectedType) => {
    const router = new AwsBedrockRouter({
      client: makeClient([]),
      modelId: "anthropic.claude-3",
    });

    const result = await router.routeAnswer({
      userInput: utterance,
      pendingFields: [
        field({ id: "anything", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });

    expect(result.specialCommand?.type).toBe(expectedType);
    expect(result.assignments).toEqual([]);
  });
});

describe("Local fast routing — skip intent", () => {
  it("handles skip phrases", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([]),
      modelId: "anthropic.claude-3",
    });

    const result = await router.routeAnswer({
      userInput: "skip this",
      pendingFields: [
        field({ id: "middle_name", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });

    expect(result.assignments).toEqual([
      { fieldId: "middle_name", skip: true },
    ]);
  });
});

describe("Local fast routing — typed fields", () => {
  const router = new AwsBedrockRouter({
    client: makeClient([]),
    modelId: "anthropic.claude-3",
  });

  it("extracts numbers from utterance for number fields", async () => {
    const result = await router.routeAnswer({
      userInput: "My age is 25 years",
      pendingFields: [
        field({ id: "age", type: "number", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments).toEqual([{ fieldId: "age", value: "25" }]);
  });

  it("normalizes numeric values with commas and currency", async () => {
    const result = await router.routeAnswer({
      userInput: "₹3,00,000",
      pendingFields: [
        field({
          id: "income",
          type: "number",
          constraints: { required: false },
        }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("300000");
  });

  it("parses DD/MM/YYYY for date fields", async () => {
    const result = await router.routeAnswer({
      userInput: "15/03/1990",
      pendingFields: [
        field({ id: "dob", type: "date", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("15/03/1990");
  });

  it("parses ISO-style dates", async () => {
    const result = await router.routeAnswer({
      userInput: "1990-03-15",
      pendingFields: [
        field({ id: "dob", type: "date", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("15/03/1990");
  });

  it("parses month-name dates", async () => {
    const result = await router.routeAnswer({
      userInput: "15th March 1990",
      pendingFields: [
        field({ id: "dob", type: "date", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("15/03/1990");
  });

  it("parses month-first format", async () => {
    const result = await router.routeAnswer({
      userInput: "March 15, 1990",
      pendingFields: [
        field({ id: "dob", type: "date", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("15/03/1990");
  });

  it("normalizes 2-digit year >= 70 to 1900s", async () => {
    const result = await router.routeAnswer({
      userInput: "15/03/85",
      pendingFields: [
        field({ id: "dob", type: "date", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("15/03/1985");
  });

  it("extracts email addresses", async () => {
    const result = await router.routeAnswer({
      userInput: "my email is John.Doe@example.com",
      pendingFields: [
        field({ id: "email", type: "email", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("John.Doe@example.com");
  });

  it("returns no email assignment when none found", async () => {
    const responses = [
      { body: encodeBody({ completion: '{"assignments":[]}' }) },
    ];
    const router2 = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router2.routeAnswer({
      userInput: "no email here",
      pendingFields: [
        field({ id: "email", type: "email", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments).toEqual([]);
  });

  it("extracts phone numbers", async () => {
    const result = await router.routeAnswer({
      userInput: "Call me at +91-987-654-3210",
      pendingFields: [
        field({ id: "phone", type: "tel", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("919876543210");
  });

  it("cleans up text answers", async () => {
    const result = await router.routeAnswer({
      userInput: "My name is John Smith.",
      pendingFields: [
        field({
          id: "name",
          label: "name",
          type: "text",
          constraints: { required: false },
        }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("John Smith");
  });
});

describe("Local fast routing — selectable fields", () => {
  const router = new AwsBedrockRouter({
    client: makeClient([]),
    modelId: "anthropic.claude-3",
  });

  it("matches exact option value", async () => {
    const result = await router.routeAnswer({
      userInput: "ST",
      pendingFields: [
        field({
          id: "category",
          type: "select",
          constraints: { required: true },
          options: [
            { value: "ST", label: "Scheduled Tribe" },
            { value: "ST-PVGT", label: "ST PVGT" },
            { value: "GENERAL", label: "General" },
          ],
        }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("ST");
  });

  it("returns null and falls back to Bedrock when no strong match", async () => {
    const router2 = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [{ type: "text", text: '{"assignments":[]}' }],
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router2.routeAnswer({
      userInput: "completely unrelated phrase xyz",
      pendingFields: [
        field({
          id: "category",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "ST", label: "Scheduled Tribe" },
            { value: "OBC", label: "Other Backward Class" },
          ],
        }),
      ],
      completedFields: [],
    });
    expect(result.assignments).toEqual([]);
  });

  it("matches via word-level fuzzy for speech mishearings", async () => {
    const result = await router.routeAnswer({
      userInput: "scheduled drive",
      pendingFields: [
        field({
          id: "category",
          type: "select",
          constraints: { required: true },
          options: [
            { value: "ST", label: "Scheduled Tribe" },
            { value: "OBC", label: "Other Backward Class" },
          ],
        }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("ST");
  });
});

describe("Local fast routing — multi-field utterances bypass local path", () => {
  it("falls back to Bedrock when utterance covers multiple fields", async () => {
    const responses = [
      {
        body: encodeBody({
          content: [
            {
              type: "text",
              text: '{"assignments":[{"fieldId":"income","value":"500000"},{"fieldId":"religion","value":"hindu"}]}',
            },
          ],
        }),
      },
    ];
    const router2 = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router2.routeAnswer({
      userInput: "income is 500000 and religion is hindu",
      pendingFields: [
        field({
          id: "income",
          label: "Annual Family Income",
          type: "number",
          constraints: { required: false },
        }),
        field({
          id: "religion",
          label: "Religion",
          type: "text",
          constraints: { required: false },
        }),
      ],
      completedFields: [],
    });
    expect(result.assignments).toHaveLength(2);
  });
});

describe("Edit mode — never uses local fast path", () => {
  it("always invokes Bedrock when isEditMode", async () => {
    const send = vi.fn(async () => ({
      body: encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"income","value":"100"}]}',
          },
        ],
      }),
    }));
    const router = new AwsBedrockRouter({
      client: { send } as any,
      modelId: "x",
    });
    await router.routeAnswer({
      userInput: "change income to 100",
      pendingFields: [
        field({
          id: "income",
          label: "Income",
          type: "number",
          constraints: { required: false },
        }),
      ],
      completedFields: [],
      isEditMode: true,
    });
    expect(send).toHaveBeenCalled();
  });
});

describe("Bedrock response parsing", () => {
  it("parses anthropic content array response", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"assignments":[{"fieldId":"name","value":"Alice"}]}',
              },
            ],
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and y noise",
      pendingFields: [
        field({
          id: "name",
          type: "text",
          constraints: { required: false },
        }),
        field({
          id: "other",
          type: "text",
          constraints: { required: false },
        }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]).toMatchObject({ fieldId: "name", value: "Alice" });
  });

  it("parses 'completion' field response", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            completion: '{"assignments":[{"fieldId":"name","value":"Bob"}]}',
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and y noise",
      pendingFields: [
        field({ id: "name", type: "text", constraints: { required: false } }),
        field({ id: "address", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("Bob");
  });

  it("parses 'output' field response", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            output: '{"assignments":[{"fieldId":"name","value":"Eve"}]}',
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and y noise",
      pendingFields: [
        field({ id: "name", type: "text", constraints: { required: false } }),
        field({ id: "address", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("Eve");
  });

  it("strips JSON from markdown fences", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '```json\n{"assignments":[{"fieldId":"name","value":"Mark"}]}\n```',
              },
            ],
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and y noise",
      pendingFields: [
        field({ id: "name", type: "text", constraints: { required: false } }),
        field({ id: "address", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("Mark");
  });

  it("handles followUp in response", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"assignments":[],"followUp":"Please clarify"}',
              },
            ],
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and y noise",
      pendingFields: [
        field({ id: "name", type: "text", constraints: { required: false } }),
        field({ id: "address", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.followUp).toBe("Please clarify");
  });

  it("handles specialCommand in Bedrock response", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"assignments":[],"specialCommand":{"type":"reset","confidence":0.9}}',
              },
            ],
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and y noise",
      pendingFields: [
        field({ id: "name", type: "text", constraints: { required: false } }),
        field({ id: "address", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.specialCommand).toEqual({ type: "reset", confidence: 0.9 });
  });

  it("defaults specialCommand confidence to 0.8 when missing", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"assignments":[],"specialCommand":{"type":"quit"}}',
              },
            ],
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and y noise",
      pendingFields: [
        field({ id: "name", type: "text", constraints: { required: false } }),
        field({ id: "address", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.specialCommand).toEqual({ type: "quit", confidence: 0.8 });
  });

  it("rejects invalid specialCommand type", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"assignments":[],"specialCommand":{"type":"unknown","confidence":1}}',
              },
            ],
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and y noise",
      pendingFields: [
        field({ id: "name", type: "text", constraints: { required: false } }),
        field({ id: "address", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.specialCommand).toBeUndefined();
  });

  it("falls back to raw body when no completion/output/content", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            assignments: [{ fieldId: "name", value: "FromRoot" }],
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "name and address xxxxx",
      pendingFields: [
        field({ id: "name", label: "name", type: "text", constraints: { required: false } }),
        field({ id: "address", label: "address", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("FromRoot");
  });

  it("parses nested data wrapper", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"data":{"assignments":[{"fieldId":"name","value":"Wrapped"}]}}',
              },
            ],
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "name and address xxxxx",
      pendingFields: [
        field({ id: "name", label: "name", type: "text", constraints: { required: false } }),
        field({ id: "address", label: "address", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("Wrapped");
  });

  it("falls back to regex parse when JSON is malformed", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: 'garbage prefix {"fieldId":"name","value":"R"} garbage suffix',
              },
            ],
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "name and address xxxxx",
      pendingFields: [
        field({ id: "name", label: "name", type: "text", constraints: { required: false } }),
        field({ id: "address", label: "address", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("R");
  });

  it("throws when client.send throws", async () => {
    const router = new AwsBedrockRouter({
      client: {
        send: vi.fn(async () => {
          throw new Error("network down");
        }),
      } as any,
      modelId: "x",
    });
    await expect(
      router.routeAnswer({
        userInput: "x and y noise",
        pendingFields: [
          field({ id: "name", type: "text", constraints: { required: false } }),
          field({ id: "address", type: "text", constraints: { required: false } }),
        ],
        completedFields: [],
      }),
    ).rejects.toThrow();
  });
});

describe("Assignment correction (value normalization)", () => {
  it("corrects assignment value to the canonical option.value", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"assignments":[{"fieldId":"cat","value":"general"}]}',
              },
            ],
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "I am general general general",
      pendingFields: [
        field({
          id: "cat",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "GENERAL", label: "General" },
            { value: "OBC", label: "OBC" },
          ],
        }),
        field({ id: "other", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("GENERAL");
  });

  it("normalizes array values for multi-select", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"assignments":[{"fieldId":"hobbies","value":["reading","music"]}]}',
              },
            ],
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "noise noise blah",
      pendingFields: [
        field({
          id: "hobbies",
          type: "checkbox",
          constraints: { required: false },
          allowMultiple: true,
          options: [
            { value: "reading", label: "Reading" },
            { value: "music", label: "Music" },
            { value: "sports", label: "Sports" },
          ],
        }),
        field({ id: "other", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toEqual(["reading", "music"]);
  });

  it("drops array assignments to single-select with empty/multi values and emits followUp", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"assignments":[{"fieldId":"cat","value":["GENERAL","OBC"]}]}',
              },
            ],
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "ambiguous noise",
      pendingFields: [
        field({
          id: "cat",
          label: "Category",
          type: "select",
          allowMultiple: false,
          constraints: { required: false },
          options: [
            { value: "GENERAL", label: "General" },
            { value: "OBC", label: "OBC" },
          ],
        }),
        field({ id: "other", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments).toHaveLength(0);
    expect(result.followUp).toMatch(/Category/i);
  });
});

describe("findBestOptionMatch (exported helper)", () => {
  it("returns null on empty utterance", () => {
    expect(findBestOptionMatch("", [{ value: "x", label: "X" }])).toBeNull();
  });

  it("prefers exact match over fuzzy match", () => {
    const result = findBestOptionMatch("st", [
      { value: "ST", label: "Scheduled Tribe" },
      { value: "ST-PVGT", label: "ST PVGT" },
    ]);
    expect(result?.option.value).toBe("ST");
    expect(result?.exact).toBe(true);
  });

  it("matches by acronym for multi-word labels", () => {
    const result = findBestOptionMatch("Other Backward Class", [
      { value: "OBC", label: "Other Backward Class" },
      { value: "GEN", label: "General" },
    ]);
    expect(result?.option.value).toBe("OBC");
  });

  it("matches via phonetic key", () => {
    const result = findBestOptionMatch("sikh", [
      { value: "sick", label: "Sikh" },
      { value: "hindu", label: "Hindu" },
    ]);
    expect(result?.option.value).toBe("sick");
  });

  it("matches roman numerals to arabic equivalents", () => {
    const result = findBestOptionMatch("12th", [
      { value: "XII", label: "XII" },
      { value: "X", label: "X" },
    ]);
    expect(result?.option.value).toBe("XII");
  });
});

describe("Local edit assignments", () => {
  it("matches edit utterance to a mentioned text field and extracts new value", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([]),
      modelId: "x",
    });

    const result = await router.routeAnswer({
      userInput: "update my name to Sara",
      pendingFields: [
        field({
          id: "name",
          label: "Name",
          type: "text",
          constraints: { required: false },
        }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.fieldId).toBe("name");
    expect(result.assignments[0]?.value).toMatch(/sara/i);
  });

  it("matches edit utterance to a number field and extracts digits", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "change income to 500000",
      pendingFields: [
        field({
          id: "income",
          label: "Income",
          type: "number",
          constraints: { required: false },
        }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]).toMatchObject({
      fieldId: "income",
      value: "500000",
    });
  });

  it("matches edit utterance to a date field and normalizes value", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "update dob to 15/03/1990",
      pendingFields: [
        field({
          id: "dob",
          label: "DOB",
          type: "date",
          constraints: { required: false },
        }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("15/03/1990");
  });

  it("matches edit utterance to a select field via option", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "change category to GENERAL",
      pendingFields: [
        field({
          id: "category",
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
});

describe("Verification of ambiguous selectable assignments", () => {
  it("approves when verification confirms the mapping", async () => {
    const responses = [
      // Initial LLM call - returns assignment to GENERAL
      {
        body: encodeBody({
          content: [
            {
              type: "text",
              text: '{"assignments":[{"fieldId":"cat","value":"GENERAL"}]}',
            },
          ],
        }),
      },
      // Verification call - approves with evidence
      {
        body: encodeBody({
          content: [
            {
              type: "text",
              text: '{"approved":[{"fieldId":"cat","value":"GENERAL","confidence":0.95,"evidenceType":"direct_code","evidenceText":"general"}],"rejected":[]}',
            },
          ],
        }),
      },
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });

    const result = await router.routeAnswer({
      userInput: "I am general here general general",
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
        field({ id: "other", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });

    expect(result.assignments[0]?.fieldId).toBe("cat");
    expect(result.assignments[0]?.value).toBe("GENERAL");
  });

  it("rejects ambiguous assignment when verification parse fails", async () => {
    const responses = [
      {
        body: encodeBody({
          content: [
            {
              type: "text",
              text: '{"assignments":[{"fieldId":"cat","value":"OBC"}]}',
            },
          ],
        }),
      },
      // garbage verification
      { body: encodeBody({ content: [{ type: "text", text: "not json" }] }) },
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });

    const result = await router.routeAnswer({
      userInput: "ambiguous noise here",
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
        field({ id: "other", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments.find((a) => a.fieldId === "cat")).toBeUndefined();
    expect(result.followUp).toBeTruthy();
  });

  it("falls back gracefully when verification request throws", async () => {
    let callCount = 0;
    const send = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"assignments":[{"fieldId":"cat","value":"OBC"}]}',
              },
            ],
          }),
        };
      }
      throw new Error("verification network failure");
    });

    const router = new AwsBedrockRouter({
      client: { send } as any,
      modelId: "x",
      debug: true,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await router.routeAnswer({
      userInput: "ambiguous noise unrelated content",
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
        field({ id: "other", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });

    expect(result.assignments.find((a) => a.fieldId === "cat")).toBeUndefined();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });
});

describe("Gap-fill: fill missing fields locally after LLM response", () => {
  it("fills a missed selectable field when utterance has direct option evidence", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"assignments":[{"fieldId":"income","value":"500000"}]}',
              },
            ],
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "income 500000 and general category",
      pendingFields: [
        field({
          id: "income",
          label: "Income",
          type: "number",
          constraints: { required: false },
        }),
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
    // Gap-fill should add the category assignment
    const catAssignment = result.assignments.find((a) => a.fieldId === "cat");
    expect(catAssignment?.value).toBe("GENERAL");
  });
});
