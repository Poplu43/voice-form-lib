import { beforeEach, describe, expect, it, vi } from "vitest";
import { V2VoiceFormService } from "../src/v2/voiceFormService";
import type { SarvamSpeechProvider } from "../src/v2/types";

function makeSpeechProvider(): SarvamSpeechProvider {
  return {
    setLanguage: vi.fn(),
    startListening: vi.fn(async () => undefined),
    stopListening: vi.fn(async () => undefined),
    speak: vi.fn(async () => undefined),
    stopSpeaking: vi.fn(),
    dispose: vi.fn(),
  };
}

async function makeService(html: string) {
  document.body.innerHTML = html;
  const service = new V2VoiceFormService({
    formSelector: "#form",
    language: "en-IN",
    bhashiniProxy: {
      provider: makeSpeechProvider(),
      language: "en-IN",
    },
    bedrock: {
      proxy: {
        routerUrl: "/bedrock-route",
        translatorUrl: "/bedrock-translate",
      },
    },
  });
  await service.initialize();
  return service;
}

beforeEach(() => {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
});

describe("V2VoiceFormService — file upload routing", () => {
  it("keeps manual upload fields out of LLM multi-answer routing", async () => {
    const service = await makeService(`
      <form id="form">
        <label for="firstName">First Name</label>
        <input id="firstName" name="firstName" type="text" />

        <digi-upload-input
          ng-reflect-control-name="applicantimage"
          ng-reflect-required="true"
          ng-reflect-label-name="Applicant Image"
        >
          <h3 class="input-label">Upload Applicant Image<span class="astrick-text">*</span></h3>
          <label><input type="file" hidden /></label>
        </digi-upload-input>

        <label for="lastName">Last Name</label>
        <input id="lastName" name="lastName" type="text" />
      </form>
    `);
    const router = {
      routeAnswer: vi.fn(async () => ({ assignments: [] })),
    };
    (service as any).router = router;

    const firstNameField = (service as any).fields.find(
      (field: any) => field.id === "firstName",
    );

    await (service as any).routeAnswer(firstNameField, "First name is Aniket and last name is Kumar");

    const request = router.routeAnswer.mock.calls[0][0];
    expect(request.pendingFields.map((field: any) => field.id)).toEqual([
      "firstName",
      "lastName",
    ]);
    expect(
      request.pendingFields.find((field: any) => field.id === "applicantimage"),
    ).toBeUndefined();
  });

  it("ignores accidental assignments to manual upload fields", async () => {
    const service = await makeService(`
      <form id="form">
        <digi-upload-input
          ng-reflect-control-name="applicantimage"
          ng-reflect-required="true"
          ng-reflect-label-name="Applicant Image"
        >
          <h3 class="input-label">Upload Applicant Image<span class="astrick-text">*</span></h3>
          <label><input type="file" hidden /></label>
        </digi-upload-input>
        <label for="lastName">Last Name</label>
        <input id="lastName" name="lastName" type="text" />
      </form>
    `);

    const applied = await (service as any).applyAssignments([
      { fieldId: "applicantimage", value: "photo.jpg" },
      { fieldId: "lastName", value: "Kumar" },
    ]);

    expect(applied).toBe(1);
    expect((document.getElementById("lastName") as HTMLInputElement).value).toBe(
      "Kumar",
    );
  });

  it("does not create an assignment failure for upload-only assignments", async () => {
    const service = await makeService(`
      <form id="form">
        <digi-upload-input
          ng-reflect-control-name="applicantimage"
          ng-reflect-required="true"
          ng-reflect-label-name="Applicant Image"
        >
          <h3 class="input-label">Upload Applicant Image<span class="astrick-text">*</span></h3>
          <label><input type="file" hidden /></label>
        </digi-upload-input>
      </form>
    `);

    const applied = await (service as any).applyAssignments([
      { fieldId: "applicantimage", value: "photo.jpg" },
    ]);

    expect(applied).toBe(0);
    expect((service as any).lastAssignmentFailure).toBeNull();
  });
});
