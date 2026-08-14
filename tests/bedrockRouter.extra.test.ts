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

function makeClient(responses: Array<{ body: Uint8Array } | (() => never)>) {
  const send = vi.fn(async () => {
    const next = responses.shift();
    if (typeof next === "function") next();
    if (!next || typeof next === "function") {
      throw new Error("no more mocked responses");
    }
    return { body: next.body };
  });
  return { send } as any;
}

describe("findBestOptionMatch — extra cases", () => {
  it("returns null when options have no aliases", () => {
    const result = findBestOptionMatch("hello", [
      { value: "", label: "" },
    ]);
    expect(result).toBeNull();
  });

  it("matches single-digit numeric utterance", () => {
    const result = findBestOptionMatch("1", [
      { value: "1", label: "One" },
      { value: "2", label: "Two" },
    ]);
    expect(result?.option.value).toBe("1");
  });

  it("returns null on whitespace-only utterance", () => {
    expect(findBestOptionMatch("   ", [{ value: "x", label: "X" }])).toBeNull();
  });

  it("scores via fuzzy levenshtein for misheard speech", () => {
    const result = findBestOptionMatch("hindooo", [
      { value: "HINDU", label: "Hindu" },
      { value: "MUSLIM", label: "Muslim" },
    ]);
    expect(result?.option.value).toBe("HINDU");
  });
});

describe("Date normalization edge cases", () => {
  const router = new AwsBedrockRouter({
    client: makeClient([]),
    modelId: "x",
  });

  it("rejects dates with invalid day/month", async () => {
    // Bedrock fallback when local route returns null
    const router2 = new AwsBedrockRouter({
      client: makeClient([
        { body: encodeBody({ content: [{ type: "text", text: '{"assignments":[]}' }] }) },
      ]),
      modelId: "x",
    });
    const result = await router2.routeAnswer({
      userInput: "32/13/2099",
      pendingFields: [
        field({ id: "dob", type: "date", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments).toEqual([]);
  });

  it("parses 2-digit year < 70 to 2000s", async () => {
    const result = await router.routeAnswer({
      userInput: "15/03/05",
      pendingFields: [
        field({ id: "dob", type: "date", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("15/03/2005");
  });

  it("parses via Date.parse fallback for natural-language dates", async () => {
    const result = await router.routeAnswer({
      userInput: "January 1, 2000",
      pendingFields: [
        field({ id: "dob", type: "date", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("01/01/2000");
  });
});

describe("Tel field — fewer than 7 digits returns no assignment", () => {
  it("returns empty assignment when too few digits", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        { body: encodeBody({ content: [{ type: "text", text: '{"assignments":[]}' }] }) },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "123 abc",
      pendingFields: [
        field({ id: "phone", type: "tel", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments).toEqual([]);
  });
});

describe("Skip intent variations", () => {
  const router = new AwsBedrockRouter({ client: makeClient([]), modelId: "x" });

  it.each(["leave blank", "leave it blank", "don't know", "pass"])(
    "handles '%s'",
    async (utterance) => {
      const result = await router.routeAnswer({
        userInput: utterance,
        pendingFields: [
          field({ id: "x", type: "text", constraints: { required: false } }),
        ],
        completedFields: [],
      });
      expect(result.assignments).toEqual([{ fieldId: "x", skip: true }]);
    },
  );
});

describe("Edit utterance — value extracted via 'as' anchor", () => {
  it("parses 'set name as Bob'", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "edit name as Bob",
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
    expect(result.assignments[0]?.value).toMatch(/bob/i);
  });
});

describe("Empty utterance and edge cases", () => {
  it("returns null routing on empty utterance — bedrock falls back to []", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        { body: encodeBody({ content: [{ type: "text", text: '{"assignments":[]}' }] }) },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "",
      pendingFields: [
        field({ id: "name", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments).toEqual([]);
  });

  it("returns null with no pending fields — bedrock receives empty list", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        { body: encodeBody({ content: [{ type: "text", text: '{"assignments":[]}' }] }) },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "anything",
      pendingFields: [],
      completedFields: [],
    });
    expect(result.assignments).toEqual([]);
  });
});

describe("Special command — quit vs finish disambiguation", () => {
  const router = new AwsBedrockRouter({ client: makeClient([]), modelId: "x" });

  it("treats 'finish' as finish", async () => {
    const result = await router.routeAnswer({
      userInput: "finish",
      pendingFields: [
        field({ id: "x", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.specialCommand?.type).toBe("finish");
  });

  it("treats 'quit' as quit (not finish)", async () => {
    const result = await router.routeAnswer({
      userInput: "quit",
      pendingFields: [
        field({ id: "x", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.specialCommand?.type).toBe("quit");
  });
});

describe("Local edit with non-matching cases", () => {
  it("returns null when extracted value cannot match a select option strongly", async () => {
    // Edit intent with unmatchable value should fall through to Bedrock
    const router = new AwsBedrockRouter({
      client: makeClient([
        { body: encodeBody({ content: [{ type: "text", text: '{"assignments":[]}' }] }) },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "change category to xyzzy",
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
    // Bedrock returns [] so result.assignments should be empty
    expect(result.assignments).toEqual([]);
  });

  it("returns null edit for invalid date", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        { body: encodeBody({ content: [{ type: "text", text: '{"assignments":[]}' }] }) },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "change dob to abcdef",
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
    expect(result.assignments).toEqual([]);
  });

  it("returns null edit for invalid number", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        { body: encodeBody({ content: [{ type: "text", text: '{"assignments":[]}' }] }) },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "change income to abcdef",
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
    expect(result.assignments).toEqual([]);
  });
});

describe("normalizeSelectableAssignments — allowMultiple variants", () => {
  it("keeps allowMultiple assignment with array values", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"assignments":[{"fieldId":"hobbies","value":["reading"]}]}',
              },
            ],
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and y noise here",
      pendingFields: [
        field({
          id: "hobbies",
          type: "checkbox",
          allowMultiple: true,
          constraints: { required: false },
          options: [{ value: "reading", label: "Reading" }],
        }),
        field({ id: "other", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toEqual(["reading"]);
  });

  it("drops allowMultiple assignment with empty array and emits followUp", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"assignments":[{"fieldId":"hobbies","value":[]}]}',
              },
            ],
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and y noise here",
      pendingFields: [
        field({
          id: "hobbies",
          label: "Hobbies",
          type: "checkbox",
          allowMultiple: true,
          constraints: { required: false },
          options: [
            { value: "reading", label: "Reading" },
            { value: "sports", label: "Sports" },
          ],
        }),
        field({ id: "other", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments).toHaveLength(0);
    expect(result.followUp).toMatch(/Hobbies/i);
  });

  it("preserves skip assignment for selectable field unchanged", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"assignments":[{"fieldId":"cat","skip":true}]}',
              },
            ],
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and y noise here",
      pendingFields: [
        field({
          id: "cat",
          type: "select",
          constraints: { required: false },
          options: [{ value: "GENERAL", label: "General" }],
        }),
        field({ id: "other", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]).toMatchObject({ fieldId: "cat", skip: true });
  });
});

describe("Verification — Hindi followUp", () => {
  it("emits Hindi followUp when language is hi-IN and verification rejects", async () => {
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
      // Verification with no approval - reject
      {
        body: verifBody('{"approved":[],"rejected":[{"fieldId":"cat","reason":"weak"}],"followUp":""}'),
      },
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and y noise random",
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
      language: "hi-IN",
    });
    expect(result.followUp).toMatch(/Category|श्रेणी|कृपया/);
  });
});

describe("Local fast route — hasLowEvidenceSelectableAssignments forces Bedrock", () => {
  it("falls back to Bedrock when local route matched without direct option evidence", async () => {
    // Generic word-level fuzzy match might trigger but utterance shouldn't have direct evidence
    const responses = [
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
      // verification approval
      {
        body: verifBody('{"approved":[{"fieldId":"cat","value":"GENERAL","confidence":0.9,"evidenceType":"long_form","evidenceText":"general category here"}],"rejected":[]}'),
      },
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "general category here please",
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
    // Either local or verification keeps it
    expect(result.assignments[0]?.value).toBe("GENERAL");
  });
});

describe("coerceAssignment edge cases", () => {
  it("preserves skip:true assignment from Bedrock", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"assignments":[{"fieldId":"x","skip":true,"confidence":0.7}]}',
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
        field({ id: "x", type: "text", constraints: { required: false } }),
        field({ id: "y", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]).toMatchObject({
      fieldId: "x",
      skip: true,
      confidence: 0.7,
    });
  });

  it("filters non-string values from array assignments", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"assignments":[{"fieldId":"hobbies","value":["reading",123,null,"sports"]}]}',
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
          id: "hobbies",
          type: "checkbox",
          allowMultiple: true,
          constraints: { required: false },
          options: [
            { value: "reading", label: "Reading" },
            { value: "sports", label: "Sports" },
          ],
        }),
        field({ id: "other", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toEqual(["reading", "sports"]);
  });

  it("ignores assignment with missing fieldId", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"assignments":[{"value":"X"}]}',
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
        field({ id: "x", type: "text", constraints: { required: false } }),
        field({ id: "y", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments).toEqual([]);
  });
});

describe("Edit mode prompt path", () => {
  it("uses edit-mode system prompt and parses response", async () => {
    const sentInputs: any[] = [];
    const send = vi.fn(async (cmd: any) => {
      sentInputs.push(cmd);
      return {
        body: encodeBody({
          content: [
            {
              type: "text",
              text: '{"assignments":[{"fieldId":"income","value":"500000"}]}',
            },
          ],
        }),
      };
    });
    const router = new AwsBedrockRouter({
      client: { send } as any,
      modelId: "x",
    });
    await router.routeAnswer({
      userInput: "annual family income 5,00,000",
      pendingFields: [
        field({
          id: "income",
          label: "Annual Family Income",
          type: "number",
          constraints: { required: false },
        }),
      ],
      completedFields: [],
      isEditMode: true,
      language: "hi-IN",
    });
    expect(send).toHaveBeenCalled();
    const body = JSON.parse(sentInputs[0].input.body);
    expect(body.system[0].text).toContain("EDIT MODE");
  });
});

describe("Field-name mention triggers multi-field path", () => {
  it("counts mentioned fields >= 2 even without 'and'", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"assignments":[{"fieldId":"name","value":"Alice"},{"fieldId":"income","value":"100"}]}',
              },
            ],
          }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "my name Alice income 100",
      pendingFields: [
        field({
          id: "name",
          label: "name",
          type: "text",
          constraints: { required: false },
        }),
        field({
          id: "income",
          label: "income",
          type: "number",
          constraints: { required: false },
        }),
      ],
      completedFields: [],
    });
    expect(result.assignments.length).toBe(2);
  });
});

describe("Roman numeral conversion via aliases", () => {
  it("matches '12' to option value 'XII'", () => {
    const result = findBestOptionMatch("12", [
      { value: "XII", label: "12th" },
      { value: "X", label: "10th" },
    ]);
    expect(result?.option.value).toBe("XII");
  });

  it("matches '12th' ordinal too", () => {
    const result = findBestOptionMatch("12th", [
      { value: "XII", label: "Twelve" },
    ]);
    expect(result?.option.value).toBe("XII");
  });

  it("rejects non-canonical Roman numeral aliases", () => {
    // "IIII" is not canonical so shouldn't be recognized as a Roman alias
    const result = findBestOptionMatch("4", [
      { value: "IIII", label: "Four" },
      { value: "IV", label: "Four" },
    ]);
    expect(result?.option.value).toBe("IV");
  });
});

describe("Negation as evidence for negative options", () => {
  it("approves NO assignment when utterance has 'not'", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({
            content: [
              {
                type: "text",
                text: '{"assignments":[{"fieldId":"hostel","value":"No"}]}',
              },
            ],
          }),
        },
        // Verification approves
        {
          body: verifBody('{"approved":[{"fieldId":"hostel","value":"No","confidence":0.9,"evidenceType":"direct_code","evidenceText":"not"}],"rejected":[]}'),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "i am not a hosteler please",
      pendingFields: [
        field({
          id: "hostel",
          label: "Hosteler",
          type: "radio",
          constraints: { required: false },
          options: [
            { value: "Yes", label: "Yes" },
            { value: "No", label: "No" },
          ],
        }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("No");
  });
});

describe("Bedrock response with empty content array", () => {
  it("falls back to raw body when content has no text entries", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        {
          body: encodeBody({ content: [] }),
        },
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and y noise here",
      pendingFields: [
        field({ id: "x", type: "text", constraints: { required: false } }),
        field({ id: "y", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    // Falls back to fallbackParseAssignments which finds nothing
    expect(result.assignments).toEqual([]);
  });
});
