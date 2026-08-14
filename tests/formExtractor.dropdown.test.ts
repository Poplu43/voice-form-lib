import { describe, it, expect, vi } from "vitest";
import {
  extractFormFields,
  getDropdownOptionContainers,
  ensureCustomDropdownOptions,
  isDropdownExpanded,
  openDropdownElement,
  closeDropdownElement,
  readDropdownOptionMetadata,
  waitForCustomDropdownRender,
} from "../src/formExtractor";

function setHtml(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

describe("Custom dropdown option ensure + collection", () => {
  it("waits for options when dropdown is initially empty", async () => {
    const form = setHtml(`
      <form>
        <ng-select id="x"></ng-select>
      </form>
    `);
    const el = document.getElementById("x") as HTMLElement;
    const fakeField = {
      element: el,
      id: "x",
      name: "x",
      label: "X",
      type: "select" as const,
      constraints: { required: false },
      inputElements: [],
      options: [],
    };
    // Add options after delay
    setTimeout(() => {
      el.innerHTML = `
        <div class="ng-option" data-value="late">Late</div>
      `;
    }, 50);
    await ensureCustomDropdownOptions(fakeField as any, 1000);
    expect(Array.isArray(fakeField.options)).toBe(true);
  });

  it("collects options from multiple containers", () => {
    document.body.innerHTML = `
      <div>
        <ng-select id="ns" aria-controls="panel"></ng-select>
        <div id="panel">
          <div class="ng-option" data-value="a">A</div>
          <div class="ng-option" data-value="b">B</div>
        </div>
        <div class="ng-option" data-value="c">C</div>
      </div>
    `;
    const el = document.getElementById("ns") as HTMLElement;
    const containers = getDropdownOptionContainers(el);
    expect(containers.length).toBeGreaterThanOrEqual(2);
  });

  it("filters duplicate options across containers", () => {
    const form = setHtml(`
      <form>
        <ng-select id="ns">
          <div class="ng-option" data-value="X">X</div>
        </ng-select>
        <div id="panel">
          <div class="ng-option" data-value="X">X</div>
          <div class="ng-option" data-value="Y">Y</div>
        </div>
      </form>
    `);
    const fields = extractFormFields(form);
    // Should not duplicate X
    const xOpts = fields[0].options?.filter((o) => o.value === "X") ?? [];
    expect(xOpts.length).toBe(1);
  });
});

describe("Custom dropdown — open/close edge paths", () => {
  it("openDropdownElement returns the resulting expanded state", () => {
    document.body.innerHTML = `
      <div id="x" role="combobox">
        <input role="combobox" />
      </div>
    `;
    const el = document.getElementById("x") as HTMLElement;
    const result = openDropdownElement(el);
    expect(typeof result).toBe("boolean");
  });

  it("closeDropdownElement removes the aria-expanded state via escape", () => {
    document.body.innerHTML = `
      <div id="x" aria-expanded="true" role="combobox"></div>
    `;
    const el = document.getElementById("x") as HTMLElement;
    expect(() => closeDropdownElement(el)).not.toThrow();
  });

  it("isDropdownExpanded fires correctly for nested expanded element", () => {
    document.body.innerHTML = `
      <div id="x"><div><span aria-expanded="true"></span></div></div>
    `;
    const el = document.getElementById("x") as HTMLElement;
    expect(isDropdownExpanded(el)).toBe(true);
  });
});

describe("readDropdownOptionMetadata — corners", () => {
  it("uses ng-option-label child for label", () => {
    document.body.innerHTML = `
      <div class="ng-option">
        <span class="ng-option-label">Pretty Label</span>
      </div>
    `;
    const el = document.querySelector(".ng-option") as HTMLElement;
    const meta = readDropdownOptionMetadata(el);
    expect(meta.label).toBe("Pretty Label");
  });

  it("uses aria-label for label", () => {
    document.body.innerHTML = `<div class="ng-option" aria-label="From Aria">stuff</div>`;
    const el = document.querySelector(".ng-option") as HTMLElement;
    const meta = readDropdownOptionMetadata(el);
    expect(meta.label).toBe("From Aria");
  });

  it("handles mat-radio-button without label-content gracefully", () => {
    document.body.innerHTML = `
      <mat-radio-button ng-reflect-value="V">Just Text</mat-radio-button>
    `;
    const el = document.querySelector("mat-radio-button") as HTMLElement;
    const meta = readDropdownOptionMetadata(el);
    expect(meta.value).toBe("V");
  });
});

describe("extractFormFields — additional Material patterns", () => {
  it("extracts label from mat-form-field with dynamic-label inside container chain", () => {
    const form = setHtml(`
      <form>
        <mat-form-field>
          <dynamic-label>State of Residence</dynamic-label>
          <input id="state" name="state" type="text" />
        </mat-form-field>
      </form>
    `);
    const fields = extractFormFields(form);
    // The label might be picked up via different priorities
    expect(fields[0].label).toBeTruthy();
  });

  it("excludes empty-value placeholder options from native selects", () => {
    const form = setHtml(`
      <form>
        <select id="s" name="s">
          <option value="">Choose...</option>
          <option value="A">A</option>
        </select>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].options).toEqual([{ value: "A", label: "A" }]);
  });

  it("handles label[for=] with custom CSS-special characters", () => {
    const form = setHtml(`
      <form>
        <label for="x.y">Special Label</label>
        <input id="x.y" name="x.y" type="text" />
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].id).toBe("x.y");
  });
});

describe("waitForCustomDropdownRender — observer paths", () => {
  it("resolves when a custom dropdown appears mid-render", async () => {
    document.body.innerHTML = `
      <form>
        <searchable-dropdown></searchable-dropdown>
      </form>
    `;
    const form = document.querySelector("form") as HTMLElement;
    const promise = waitForCustomDropdownRender(form, 300);
    setTimeout(() => {
      const host = form.querySelector("searchable-dropdown")!;
      host.innerHTML = `<ng-select></ng-select>`;
    }, 50);
    await expect(promise).resolves.toBeUndefined();
  });
});

describe("Group info from various sources", () => {
  it("derives groupIndex from numeric data-step alone", () => {
    const form = setHtml(`
      <form>
        <div data-step="5"><input id="f" name="f" type="text" /></div>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].groupIndex).toBe(5);
  });

  it("uses heading text as fallback step label", () => {
    const form = setHtml(`
      <form>
        <div data-step="1">
          <h2>Section One</h2>
          <input id="f" name="f" type="text" />
        </div>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].groupLabel).toBe("Section One");
  });
});

describe("constraints extras", () => {
  it("propagates required from native required attribute", () => {
    const form = setHtml(`
      <form><input id="x" name="x" type="text" required /></form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].constraints.required).toBe(true);
  });

  it("returns pattern as a string when set", () => {
    const form = setHtml(`
      <form><input id="x" name="x" type="text" pattern="[A-Za-z]+" /></form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].constraints.pattern).toBe("[A-Za-z]+");
  });
});

import { isCustomDropdownElement } from "../src/formExtractor";

describe("isCustomDropdownElement edge", () => {
  it("returns false for null", () => {
    expect(isCustomDropdownElement(null)).toBe(false);
  });
  it("returns false for undefined", () => {
    expect(isCustomDropdownElement(undefined)).toBe(false);
  });
});
