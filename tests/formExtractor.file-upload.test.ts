import { describe, expect, it } from "vitest";
import { extractFormFields } from "../src/v1/formExtractor";

function setHtml(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

describe("extractFormFields — file uploads", () => {
  it("extracts digi-upload-input fields from hidden file inputs", () => {
    const form = setHtml(`
      <form>
        <digi-upload-input
          ng-reflect-control-name="applicantimage"
          ng-reflect-required="true"
          ng-reflect-label-name="Applicant Image"
        >
          <div class="upload-parent-wrapper">
            <h3 class="input-label">
              Upload Applicant Image<span class="astrick-text">*</span>
            </h3>
            <label>
              <input type="file" hidden accept=".jpeg, .jpg" />
            </label>
          </div>
        </digi-upload-input>
      </form>
    `);

    const fields = extractFormFields(form);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      id: "applicantimage",
      name: "applicantimage",
      label: "Applicant Image",
      type: "file",
      constraints: { required: true },
    });
    expect(fields[0].element.tagName.toLowerCase()).toBe("digi-upload-input");
    expect(fields[0].inputElements[0].type).toBe("file");
  });
});
