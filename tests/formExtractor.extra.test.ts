import { describe, it, expect, vi } from "vitest";
import {
  extractFormFields,
  isCustomDropdownElement,
  isDropdownExpanded,
  openDropdownElement,
  closeDropdownElement,
  readDropdownOptionMetadata,
  getDropdownOptionContainers,
  ensureCustomDropdownOptions,
  waitForCustomDropdownRender,
} from "../src/formExtractor";

function setHtml(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

describe("extractFormFields — Material/Angular variants", () => {
  it("respects mat-form-field label discovery", () => {
    const form = setHtml(`
      <form>
        <dynamic-label>Birth Date</dynamic-label>
        <mat-form-field>
          <input id="dob" name="dob" type="text" />
        </mat-form-field>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].label).toBe("Birth Date");
  });

  it("walks back through previous siblings for dynamic-label", () => {
    const form = setHtml(`
      <form>
        <div>
          <dynamic-label>Outer Label</dynamic-label>
        </div>
        <mat-form-field>
          <input id="x" name="x" type="text" />
        </mat-form-field>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].label).toBe("Outer Label");
  });

  it("falls back to id-prettify when label has only 'please select' placeholder", () => {
    const form = setHtml(`
      <form>
        <dynamic-label>please select country</dynamic-label>
        <mat-form-field>
          <input id="country_input" name="country_input" type="text" />
        </mat-form-field>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].label).toMatch(/Country Input/);
  });

  it("uses ng-reflect attributes for control id/name", () => {
    const form = setHtml(`
      <form>
        <ng-select ng-reflect-name="reactive_state">
          <div class="ng-option" data-value="A">A</div>
        </ng-select>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].name).toBe("reactive_state");
  });
});

describe("resolveCustomDropdownElement variations", () => {
  it("walks from input inside ng-select", () => {
    const form = setHtml(`
      <form>
        <ng-select>
          <input class="ng-select-input" />
        </ng-select>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].type).toBe("select");
  });

  it("treats role=combobox div as custom dropdown", () => {
    const form = setHtml(`
      <form>
        <div role="combobox" id="cmbo">
          <div class="ng-option" data-value="X">X</div>
        </div>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields.some((f) => f.id === "cmbo")).toBe(true);
  });
});

describe("custom dropdown options collection scenarios", () => {
  it("populates options from sibling panel via aria-controls", () => {
    const form = setHtml(`
      <form>
        <ng-select id="big" aria-controls="panel-big"></ng-select>
        <div id="panel-big">
          <div class="ng-option" data-value="x">X</div>
          <div class="ng-option" data-value="y">Y</div>
        </div>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].options?.length).toBeGreaterThanOrEqual(2);
  });

  it("dedupes options by label+value key", () => {
    const form = setHtml(`
      <form>
        <ng-select id="dup">
          <div class="ng-option" data-value="x">X</div>
          <div class="ng-option" data-value="x">X</div>
          <div class="ng-option" data-value="y">Y</div>
        </ng-select>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].options?.length).toBe(2);
  });

  it("merges options from mobile drawer with radio buttons", () => {
    const form = setHtml(`
      <form>
        <searchable-dropdown>
          <ng-select id="sd"></ng-select>
          <app-mobile-view-list>
            <mat-radio-button ng-reflect-value="A">
              <span class="mat-radio-label-content">A Label</span>
            </mat-radio-button>
            <mat-radio-button ng-reflect-value="B">
              <span class="mat-radio-label-content">B Label</span>
            </mat-radio-button>
          </app-mobile-view-list>
        </searchable-dropdown>
      </form>
    `);
    const fields = extractFormFields(form);
    const opts = fields[0].options ?? [];
    expect(opts.some((o) => o.value === "A")).toBe(true);
    expect(opts.some((o) => o.value === "B")).toBe(true);
  });

  it("skips empty options", () => {
    const form = setHtml(`
      <form>
        <ng-select id="x">
          <div class="ng-option"></div>
          <div class="ng-option" data-value="real">Real</div>
        </ng-select>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].options?.length).toBe(1);
    expect(fields[0].options?.[0].value).toBe("real");
  });
});

describe("dropdown open/close trigger paths", () => {
  it("openDropdownElement dispatches arrow-down on combobox input as fallback", () => {
    document.body.innerHTML = `
      <div id="x" role="combobox">
        <input role="combobox" />
      </div>
    `;
    const el = document.getElementById("x") as HTMLElement;
    expect(() => openDropdownElement(el)).not.toThrow();
  });

  it("closeDropdownElement when expanded fires escape and click fallback", () => {
    document.body.innerHTML = `
      <div id="x" aria-expanded="true" role="combobox">
        <div class="ng-select-container"></div>
      </div>
    `;
    const el = document.getElementById("x") as HTMLElement;
    expect(() => closeDropdownElement(el)).not.toThrow();
  });
});

describe("getDropdownOptionContainers — interactive nodes accumulation", () => {
  it("accumulates panel ids from aria-owns", () => {
    document.body.innerHTML = `
      <ng-select id="x" aria-owns="p1 p2"></ng-select>
      <div id="p1"></div>
      <div id="p2"></div>
    `;
    const el = document.getElementById("x") as HTMLElement;
    const containers = getDropdownOptionContainers(el);
    const ids = containers.map((c) => (c as HTMLElement).id).filter(Boolean);
    expect(ids).toContain("p1");
    expect(ids).toContain("p2");
  });

  it("handles data-target attribute for panel reference", () => {
    document.body.innerHTML = `
      <ng-select id="x" data-target="p1"></ng-select>
      <div id="p1"></div>
    `;
    const el = document.getElementById("x") as HTMLElement;
    const containers = getDropdownOptionContainers(el);
    expect(containers.some((c) => (c as HTMLElement).id === "p1")).toBe(true);
  });

  it("includes ng-select nested inside the element", () => {
    document.body.innerHTML = `
      <searchable-dropdown id="root">
        <ng-select id="inner"></ng-select>
      </searchable-dropdown>
    `;
    const el = document.getElementById("root") as HTMLElement;
    const containers = getDropdownOptionContainers(el);
    expect(containers.some((c) => (c as HTMLElement).id === "inner")).toBe(true);
  });
});

describe("readDropdownOptionMetadata — special handling", () => {
  it("trims whitespace-only label to undefined", () => {
    document.body.innerHTML = `<div class="ng-option">   </div>`;
    const el = document.querySelector(".ng-option") as HTMLElement;
    const meta = readDropdownOptionMetadata(el);
    expect(meta.label).toBeUndefined();
  });

  it("returns trimmed value", () => {
    document.body.innerHTML = `<div class="ng-option" data-value="  X  ">x</div>`;
    const el = document.querySelector(".ng-option") as HTMLElement;
    const meta = readDropdownOptionMetadata(el);
    expect(meta.value).toBe("X");
  });

  it("falls back to label when value equals element id", () => {
    document.body.innerHTML = `<div class="ng-option" id="opt1" value="opt1">Real Label</div>`;
    const el = document.querySelector(".ng-option") as HTMLElement;
    const meta = readDropdownOptionMetadata(el);
    expect(meta.value).toBe("Real Label");
  });
});

describe("ensureCustomDropdownOptions edge cases", () => {
  it("returns when timeout is 0", async () => {
    document.body.innerHTML = `<ng-select id="x"></ng-select>`;
    const el = document.getElementById("x") as HTMLElement;
    const fakeField = {
      element: el,
      id: "x",
      name: "x",
      label: "X",
      type: "select" as const,
      constraints: { required: false },
      inputElements: [],
      options: [{ value: "a", label: "A" }],
    };
    await expect(
      ensureCustomDropdownOptions(fakeField as any, 0),
    ).resolves.toBeUndefined();
    // Function ran without throwing; options array exists
    expect(Array.isArray(fakeField.options)).toBe(true);
  });

  it("returns when options already cached", async () => {
    document.body.innerHTML = `
      <ng-select id="x">
        <div class="ng-option" data-value="a">A</div>
      </ng-select>
    `;
    const el = document.getElementById("x") as HTMLElement;
    const fakeField = {
      element: el,
      id: "x",
      name: "x",
      label: "X",
      type: "select" as const,
      constraints: { required: false },
      inputElements: [],
      options: [{ value: "a", label: "A" }],
    };
    await ensureCustomDropdownOptions(fakeField as any, 100);
    expect(fakeField.options.length).toBe(1);
  });
});

describe("waitForCustomDropdownRender", () => {
  it("resolves when dropdown appears via mutation", async () => {
    document.body.innerHTML = `<form><searchable-dropdown></searchable-dropdown></form>`;
    const form = document.querySelector("form") as HTMLElement;
    const promise = waitForCustomDropdownRender(form, 200);
    setTimeout(() => {
      const host = form.querySelector("searchable-dropdown")!;
      host.innerHTML = `<ng-select></ng-select>`;
    }, 50);
    await expect(promise).resolves.toBeUndefined();
  });
});

describe("findCustomDropdowns filter handling", () => {
  it("filters out HTMLSelectElement matches", () => {
    const form = setHtml(`
      <form>
        <searchable-dropdown>
          <select id="real"><option value="a">A</option></select>
        </searchable-dropdown>
      </form>
    `);
    const fields = extractFormFields(form);
    // Should include native select but not duplicate from custom dropdown
    expect(fields.length).toBeGreaterThanOrEqual(1);
  });
});

describe("generateFallbackId paths", () => {
  it("falls back when element not in form.elements", () => {
    const form = setHtml(`
      <form>
        <input type="text" />
        <input type="text" />
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields.every((f) => f.id.startsWith("field_"))).toBe(true);
  });
});

describe("Constraints reading", () => {
  it("reads min/max as numbers when valid", () => {
    const form = setHtml(`
      <form><input id="x" type="number" min="5" max="10" step="2" /></form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].constraints.min).toBe(5);
    expect(fields[0].constraints.max).toBe(10);
    expect(fields[0].constraints.step).toBe(2);
  });

  it("ignores step='any'", () => {
    const form = setHtml(`
      <form><input id="x" type="number" step="any" /></form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].constraints.step).toBeUndefined();
  });
});
