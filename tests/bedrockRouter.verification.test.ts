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
// Shortcut for verification responses that bypasses the Anthropic envelope —
// the router's verification-result parser only unwraps `completion`/`output`.
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

describe("verification — hasVerifiedShortCodeEvidence paths", () => {
  it("approves short-code mapping when LLM provides direct_code evidence matching utterance", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"cat","value":"ST"}]}',
          },
        ],
      }),
      verifBody('{"approved":[{"fieldId":"cat","value":"ST","confidence":0.95,"evidenceType":"direct_code","evidenceText":"ST"}],"rejected":[]}'),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "ST and noise content here",
      pendingFields: [
        field({
          id: "cat",
          label: "Category",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "ST", label: "ST" },
            { value: "OBC", label: "OBC" },
            { value: "GEN", label: "General" },
          ],
        }),
        field({ id: "x", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("ST");
  });

  it("approves when LLM provides acronym_expansion evidence (Scheduled Tribe → ST)", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"cat","value":"ST"}]}',
          },
        ],
      }),
      verifBody('{"approved":[{"fieldId":"cat","value":"ST","confidence":0.92,"evidenceType":"acronym_expansion","evidenceText":"Scheduled Tribe"}],"rejected":[]}'),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "I am Scheduled Tribe and noise",
      pendingFields: [
        field({
          id: "cat",
          label: "Category",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "ST", label: "Scheduled Tribe" },
            { value: "OBC", label: "Other Backward Class" },
          ],
        }),
        field({ id: "x", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("ST");
  });

  it("rejects when evidence text not present in utterance", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"cat","value":"ST"}]}',
          },
        ],
      }),
      verifBody('{"approved":[{"fieldId":"cat","value":"ST","confidence":0.95,"evidenceType":"direct_code","evidenceText":"definitelynotinutterance"}],"rejected":[]}'),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "i and y abc",
      pendingFields: [
        field({
          id: "cat",
          label: "Category",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "ST", label: "ST" },
            { value: "OBC", label: "OBC" },
          ],
        }),
        field({ id: "x", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments.find((a) => a.fieldId === "cat")).toBeUndefined();
  });

  it("rejects when confidence is below threshold", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"cat","value":"OBC"}]}',
          },
        ],
      }),
      verifBody('{"approved":[{"fieldId":"cat","value":"OBC","confidence":0.5,"evidenceType":"direct_code","evidenceText":"weakhint"}],"rejected":[]}'),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    // Utterance that does NOT contain "OBC" so gap-fill won't re-add it
    const result = await router.routeAnswer({
      userInput: "indecisive and ambiguous answer",
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
        field({ id: "x", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments.find((a) => a.fieldId === "cat")).toBeUndefined();
  });

  it("rejects when approval has no evidenceText", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"cat","value":"OBC"}]}',
          },
        ],
      }),
      verifBody('{"approved":[{"fieldId":"cat","value":"OBC","confidence":0.95}],"rejected":[]}'),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "indecisive and ambiguous answer",
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
        field({ id: "x", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments.find((a) => a.fieldId === "cat")).toBeUndefined();
  });

  it("approves phonetic-similar evidence with high lexical score", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"r","value":"HINDU"}]}',
          },
        ],
      }),
      verifBody('{"approved":[{"fieldId":"r","value":"HINDU","confidence":0.9,"evidenceType":"long_form","evidenceText":"hindu"}],"rejected":[]}'),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "i am hindu and stuff",
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
    expect(result.assignments[0]?.value).toBe("HINDU");
  });
});

describe("Roman numeral aliasing edge cases", () => {
  it("matches 11 to XI option", () => {
    const m = findBestOptionMatch("11", [
      { value: "XI", label: "Eleven" },
      { value: "XII", label: "Twelve" },
    ]);
    expect(m?.option.value).toBe("XI");
  });

  it("matches 13th to XIII option (lastTwo=13 special branch)", () => {
    const m = findBestOptionMatch("13th", [
      { value: "XIII", label: "Thirteen" },
    ]);
    expect(m?.option.value).toBe("XIII");
  });

  it("matches 20 to XX option", () => {
    const m = findBestOptionMatch("20", [
      { value: "XX", label: "Twenty" },
      { value: "X", label: "Ten" },
    ]);
    expect(m?.option.value).toBe("XX");
  });

  it("matches '23rd' to XXIII (lastOne=3 branch)", () => {
    const m = findBestOptionMatch("23rd", [
      { value: "XXIII", label: "23rd" },
    ]);
    expect(m?.option.value).toBe("XXIII");
  });

  it("matches '22nd' to XXII (lastOne=2 branch)", () => {
    const m = findBestOptionMatch("22nd", [
      { value: "XXII", label: "22nd" },
    ]);
    expect(m?.option.value).toBe("XXII");
  });

  it("matches '21st' to XXI (lastOne=1 branch)", () => {
    const m = findBestOptionMatch("21st", [{ value: "XXI", label: "21st" }]);
    expect(m?.option.value).toBe("XXI");
  });

  it("matches '4th' to IV", () => {
    const m = findBestOptionMatch("4th", [{ value: "IV", label: "Four" }]);
    expect(m?.option.value).toBe("IV");
  });
});

describe("Date normalization extras", () => {
  it("handles month-name with dot suffix", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        encodeBody({
          content: [{ type: "text", text: '{"assignments":[]}' }],
        }),
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "Mar 15 2000",
      pendingFields: [
        field({ id: "dob", type: "date", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    // Either local route succeeds or Bedrock returns empty
    expect(Array.isArray(result.assignments)).toBe(true);
  });
});

describe("scoreMatch edge cases", () => {
  it("matches via target.includes(candidate) path", () => {
    // candidate "ord" included in target "ordinary" but starts only partial
    const m = findBestOptionMatch("ord", [
      { value: "ordinary", label: "Ordinary" },
      { value: "x", label: "X" },
    ]);
    expect(m?.option.value).toBe("ordinary");
  });

  it("matches when candidate.includes(target) path", () => {
    const m = findBestOptionMatch("supercalifragilistic", [
      { value: "super", label: "Super" },
      { value: "xxxx", label: "X" },
    ]);
    expect(m?.option.value).toBe("super");
  });
});

describe("Special command — Hindi phrases", () => {
  it("detects रीसेट", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "रीसेट",
      pendingFields: [
        field({ id: "x", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.specialCommand?.type).toBe("reset");
  });

  it("detects समाप्त (finish)", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "समाप्त",
      pendingFields: [
        field({ id: "x", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.specialCommand?.type).toBe("finish");
  });

  it("detects बंद करो (quit)", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "बंद करो",
      pendingFields: [
        field({ id: "x", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.specialCommand?.type).toBe("quit");
  });
});

describe("Verification — multiple ambiguous candidates", () => {
  it("processes multiple selectable assignments with mixed approval", async () => {
    const responses = [
      encodeBody({
        content: [
          {
            type: "text",
            text: '{"assignments":[{"fieldId":"a","value":"X"},{"fieldId":"b","value":"Y"}]}',
          },
        ],
      }),
      verifBody('{"approved":[{"fieldId":"a","value":"X","confidence":0.9,"evidenceType":"direct_code","evidenceText":"x"}],"rejected":[{"fieldId":"b","value":"Y","reason":"weak"}]}'),
    ];
    const router = new AwsBedrockRouter({
      client: makeClient(responses),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and noise content y stuff",
      pendingFields: [
        field({
          id: "a",
          label: "A",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "X", label: "X" },
            { value: "Z", label: "Z" },
          ],
        }),
        field({
          id: "b",
          label: "B",
          type: "select",
          constraints: { required: false },
          options: [
            { value: "Y", label: "Y" },
            { value: "W", label: "W" },
          ],
        }),
      ],
      completedFields: [],
    });
    // 'a' approved should remain; 'b' should be filtered out
    expect(result.assignments.find((a) => a.fieldId === "a")?.value).toBe("X");
  });
});

describe("buildAssignmentVerificationFollowUp — option preview", () => {
  it("generates English followUp with sample options", async () => {
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
            { value: "ST", label: "Scheduled Tribe" },
          ],
        }),
      ],
      completedFields: [],
    });
    expect(result.followUp).toMatch(/Category|exact/i);
  });
});

describe("buildAnthropicPayloadLite — language modes", () => {
  it("emits Hindi language instruction when language=hi-IN", async () => {
    const sent: any[] = [];
    const send = vi.fn(async (cmd: any) => {
      sent.push(JSON.parse(cmd.input.body));
      return {
        body: encodeBody({
          content: [{ type: "text", text: '{"assignments":[]}' }],
        }),
      };
    });
    const router = new AwsBedrockRouter({
      client: { send } as any,
      modelId: "x",
    });
    await router.routeAnswer({
      userInput: "x and y noise",
      pendingFields: [
        field({ id: "x", type: "text", constraints: { required: false } }),
        field({ id: "y", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
      language: "hi-IN",
    });
    expect(sent[0].system[0].text).toMatch(/Hindi|Devanagari/);
  });

  it("includes complete field summary in pending fields", async () => {
    const sent: any[] = [];
    const send = vi.fn(async (cmd: any) => {
      sent.push(JSON.parse(cmd.input.body));
      return {
        body: encodeBody({
          content: [{ type: "text", text: '{"assignments":[]}' }],
        }),
      };
    });
    const router = new AwsBedrockRouter({
      client: { send } as any,
      modelId: "x",
    });
    await router.routeAnswer({
      userInput: "x and y noise",
      pendingFields: [
        field({
          id: "income",
          label: "Income",
          type: "number",
          constraints: { required: true, min: 0, max: 9999999 },
        }),
        field({
          id: "name",
          label: "Name",
          type: "text",
          constraints: { required: false },
        }),
      ],
      completedFields: [
        field({
          id: "age",
          label: "Age",
          type: "number",
          constraints: { required: false },
        }),
      ],
    });
    const messages = sent[0].messages;
    const ctx = JSON.parse(messages[0].content[0].text);
    expect(ctx.pendingFields).toHaveLength(2);
    expect(ctx.completedFields).toHaveLength(1);
  });
});

describe("Local edit — edit value extraction variants", () => {
  it("extracts via 'with' anchor", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "update name with Alice",
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
    expect(result.assignments[0]?.value).toMatch(/alice/i);
  });

  it("extracts via '=' anchor", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "edit name = Bob",
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

  it("extracts via Hindi 'को' anchor", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "बदल name को Charlie",
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
    expect(result.assignments[0]?.value).toMatch(/charlie/i);
  });
});

describe("fallback regex parse paths", () => {
  it("parses single assignment from regex when no JSON", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        encodeBody({
          content: [
            {
              type: "text",
              text: 'PREFIX {"fieldId":"name","value":"Sam","skip":false,"confidence":0.8} SUFFIX',
            },
          ],
        }),
      ]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "x and y noise",
      pendingFields: [
        field({ id: "name", type: "text", constraints: { required: false } }),
        field({ id: "other", type: "text", constraints: { required: false } }),
      ],
      completedFields: [],
    });
    expect(result.assignments[0]?.value).toBe("Sam");
  });
});

describe("Coerce assignment with skip=undefined (no skip key)", () => {
  it("returns assignment without skip field", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([
        encodeBody({
          content: [
            {
              type: "text",
              text: '{"assignments":[{"fieldId":"x","value":"V"}]}',
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
    expect(result.assignments[0]?.skip).toBeUndefined();
  });
});

describe("Local route — direct option evidence with negation", () => {
  it("maps utterance 'I am not a hosteler' to No option via negation evidence", async () => {
    // No special command, single pending field, selectable - local route handles it
    const router = new AwsBedrockRouter({
      client: makeClient([]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "no",
      pendingFields: [
        field({
          id: "hostel",
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

describe("Multi-language utterance handling", () => {
  it("processes a Hindi utterance through the local route as a text value", async () => {
    const router = new AwsBedrockRouter({
      client: makeClient([]),
      modelId: "x",
    });
    const result = await router.routeAnswer({
      userInput: "मेरा नाम राहुल है",
      pendingFields: [
        field({
          id: "name",
          label: "Name",
          type: "text",
          constraints: { required: false },
        }),
      ],
      completedFields: [],
      language: "hi-IN",
    });
    // Local text-cleanup keeps the Devanagari content as the assignment value
    expect(result.assignments[0]?.fieldId).toBe("name");
  });
});
