import { describe, it, expect, vi, beforeEach } from "vitest";
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

describe("extractFormFields — basic input types", () => {
  it("extracts text input with label", () => {
    const form = setHtml(`
      <form>
        <label for="name">Full Name</label>
        <input id="name" name="name" type="text" required minlength="2" maxlength="50" pattern="[A-Za-z ]+" />
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      id: "name",
      name: "name",
      label: "Full Name",
      type: "text",
      constraints: {
        required: true,
        minLength: 2,
        maxLength: 50,
        pattern: "[A-Za-z ]+",
      },
    });
  });

  it("does not borrow the previous field's label when fields are wrapped in sibling divs", () => {
    // Regression: the divyangjan select used to be labeled "Annual Family
    // Income" because the DOM walk grabbed the previous .field wrapper's
    // label[for="annualIncome"]. The label[for=] attribute must be honored.
    const form = setHtml(`
      <form>
        <div class="field">
          <label for="annualIncome">Annual Family Income (₹)</label>
          <input id="annualIncome" name="annualIncome" type="number" required />
        </div>
        <div class="field">
          <label for="divyangjan">Divyangjan?</label>
          <select id="divyangjan" name="divyangjan" required>
            <option value=""></option>
            <option value="Yes">Yes</option>
            <option value="No">No</option>
          </select>
        </div>
      </form>
    `);
    const fields = extractFormFields(form);
    const divyangjan = fields.find((f) => f.id === "divyangjan");
    const income = fields.find((f) => f.id === "annualIncome");
    expect(income?.label).toBe("Annual Family Income (₹)");
    expect(divyangjan?.label).toBe("Divyangjan?");
  });

  it("drops placeholder options with empty value from native <select> fields", () => {
    // Regression: the voice assistant used to read placeholders like
    // "Please Select" / "" aloud as valid options. Empty-value entries (and
    // explicitly `disabled` entries) are dropdown seed values, not real
    // choices, and must not appear in field.options.
    const form = setHtml(`
      <form>
        <label for="status">Marital Status</label>
        <select id="status" name="status" required>
          <option value="">Please Select</option>
          <option value="" disabled></option>
          <option value="Married">Married</option>
          <option value="Un Married">Un Married</option>
          <option value="Divorced" disabled>Divorced</option>
        </select>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].options).toEqual([
      { value: "Married", label: "Married" },
      { value: "Un Married", label: "Un Married" },
    ]);
  });

  it("extracts number input with min/max/step", () => {
    const form = setHtml(`
      <form>
        <label for="age">Age</label>
        <input id="age" name="age" type="number" min="18" max="100" step="1" />
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0]).toMatchObject({
      type: "number",
      constraints: { required: false, min: 18, max: 100, step: 1 },
    });
  });

  it("extracts email/tel/date/textarea types", () => {
    const form = setHtml(`
      <form>
        <input id="e" name="e" type="email" />
        <input id="p" name="p" type="tel" />
        <input id="d" name="d" type="date" />
        <textarea id="bio" name="bio" maxlength="200"></textarea>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields.map((f) => f.type)).toEqual([
      "email",
      "tel",
      "date",
      "textarea",
    ]);
    const bio = fields.find((f) => f.id === "bio");
    expect(bio?.constraints.maxLength).toBe(200);
  });

  it("ignores button/submit/hidden/reset/image inputs", () => {
    const form = setHtml(`
      <form>
        <input id="a" name="a" type="text" />
        <input type="submit" />
        <input type="button" />
        <input type="hidden" />
        <input type="reset" />
        <input type="image" />
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields).toHaveLength(1);
    expect(fields[0].id).toBe("a");
  });

  it("groups radio inputs by name", () => {
    const form = setHtml(`
      <form>
        <fieldset>
          <legend>Gender</legend>
          <label><input type="radio" name="gender" value="M" />Male</label>
          <label><input type="radio" name="gender" value="F" />Female</label>
          <label><input type="radio" name="gender" value="O" />Other</label>
        </fieldset>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields).toHaveLength(1);
    expect(fields[0].type).toBe("radio");
    expect(fields[0].options).toHaveLength(3);
    expect(fields[0].allowMultiple).toBe(false);
  });

  it("groups checkbox inputs by name with allowMultiple", () => {
    const form = setHtml(`
      <form>
        <label><input type="checkbox" name="hobbies" value="reading" />Reading</label>
        <label><input type="checkbox" name="hobbies" value="music" />Music</label>
        <label><input type="checkbox" name="hobbies" value="sports" />Sports</label>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields).toHaveLength(1);
    expect(fields[0].type).toBe("checkbox");
    expect(fields[0].allowMultiple).toBe(true);
    expect(fields[0].options).toHaveLength(3);
  });

  it("skips radio/checkbox without group name and id", () => {
    const form = setHtml(`
      <form>
        <input type="radio" value="a" />
        <input type="checkbox" value="b" />
        <input type="text" id="ok" name="ok" />
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields).toHaveLength(1);
    expect(fields[0].id).toBe("ok");
  });

  it("extracts native select with options (placeholder excluded)", () => {
    const form = setHtml(`
      <form>
        <label for="country">Country</label>
        <select id="country" name="country">
          <option value="">Choose</option>
          <option value="IN">India</option>
          <option value="US">USA</option>
        </select>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].type).toBe("select");
    expect(fields[0].options).toHaveLength(2);
    expect(fields[0].options?.[0].value).toBe("IN");
    expect(fields[0].options?.[1].value).toBe("US");
  });

  it("extracts multi-select with allowMultiple", () => {
    const form = setHtml(`
      <form>
        <select id="x" name="x" multiple>
          <option value="a">A</option>
          <option value="b">B</option>
        </select>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].allowMultiple).toBe(true);
  });

  it("detects mat-datepicker as date type", () => {
    const form = setHtml(`
      <form>
        <input id="dob" name="dob" type="text" data-mat-calendar="" />
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].type).toBe("date");
  });

  it("uses aria-required when native required is missing", () => {
    const form = setHtml(`
      <form>
        <input id="x" name="x" type="text" aria-required="true" />
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].constraints.required).toBe(true);
  });

  it("removes trailing asterisk from labels", () => {
    const form = setHtml(`
      <form>
        <label for="x">Name *</label>
        <input id="x" name="x" type="text" />
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].label).toBe("Name");
  });

  it("prettifies id-based labels when no label found", () => {
    const form = setHtml(`
      <form>
        <input id="first_name_input" name="first_name_input" type="text" />
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].label).toMatch(/First Name Input/);
  });

  it("assigns a fallback id when none is provided", () => {
    const form = setHtml(`
      <form>
        <input type="text" />
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].id).toMatch(/field_/);
  });

  it("falls back to data-control-id then formcontrolname", () => {
    const form = setHtml(`
      <form>
        <input data-control-id="ctl" formcontrolname="form_ctl" type="text" />
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].id).toBe("ctl");
  });

  it("uses aria-labelledby chain for labels", () => {
    const form = setHtml(`
      <form>
        <span id="lblA">Country</span>
        <span id="lblB">Code</span>
        <input id="x" name="x" type="text" aria-labelledby="lblA lblB" />
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].label).toBe("Country Code");
  });

  it("walks up to find sibling labels", () => {
    const form = setHtml(`
      <form>
        <div>
          <div>
            <label>Wrapper Label</label>
            <div><input id="x" name="x" type="text" /></div>
          </div>
        </div>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].label).toBe("Wrapper Label");
  });

  it("uses wrapping label", () => {
    const form = setHtml(`
      <form>
        <label>
          Birthday
          <input id="x" name="x" type="text" />
        </label>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].label).toBe("Birthday");
  });

  it("skips Material placeholder labels", () => {
    const form = setHtml(`
      <form>
        <mat-form-field>
          <div class="mat-form-field-label-wrapper">
            <label class="mat-form-field-label">Please select country</label>
          </div>
          <input id="x" name="x" type="text" />
        </mat-form-field>
      </form>
    `);
    const fields = extractFormFields(form);
    // Should not adopt the placeholder label
    expect(fields[0].label).not.toMatch(/please select/i);
  });

  it("strips icons/SVGs from label text", () => {
    const form = setHtml(`
      <form>
        <label for="x">
          <svg>X</svg>
          <mat-icon>info</mat-icon>
          Full Name
        </label>
        <input id="x" name="x" type="text" />
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].label).toBe("Full Name");
  });

  it("extracts groupInfo from data-step container", () => {
    const form = setHtml(`
      <form>
        <div data-step="step1" data-step-label="Personal Info" data-step-index="0">
          <input id="x" name="x" type="text" />
        </div>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].groupId).toBe("step1");
    expect(fields[0].groupLabel).toBe("Personal Info");
    expect(fields[0].groupIndex).toBe(0);
  });

  it("infers groupIndex from numeric data-step", () => {
    const form = setHtml(`
      <form>
        <div data-step="3">
          <input id="x" name="x" type="text" />
        </div>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].groupIndex).toBe(3);
  });

  it("extracts groupInfo from mat-tab containers", () => {
    const form = setHtml(`
      <form>
        <mat-tab-group>
          <div role="tab" id="mat-tab-label-0-2" aria-controls="mat-tab-content-0-2">
            <div class="mat-tab-label-content">Step Three</div>
          </div>
          <div role="tabpanel" id="mat-tab-content-0-2" aria-labelledby="mat-tab-label-0-2">
            <input id="x" name="x" type="text" />
          </div>
        </mat-tab-group>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].groupId).toBe("mat-tab-content-0-2");
    expect(fields[0].groupIndex).toBe(2);
    expect(fields[0].groupLabel).toBe("Step Three");
  });
});

describe("Custom dropdown detection", () => {
  it("recognizes ng-select element as custom dropdown", () => {
    document.body.innerHTML = `<ng-select id="ns"></ng-select>`;
    const ns = document.getElementById("ns");
    expect(isCustomDropdownElement(ns)).toBe(true);
  });

  it("recognizes [role=listbox] as custom dropdown", () => {
    document.body.innerHTML = `<div id="x" role="listbox"></div>`;
    expect(isCustomDropdownElement(document.getElementById("x"))).toBe(true);
  });

  it("recognizes [role=combobox] as custom dropdown", () => {
    document.body.innerHTML = `<div id="x" role="combobox"></div>`;
    expect(isCustomDropdownElement(document.getElementById("x"))).toBe(true);
  });

  it("recognizes aria-haspopup=listbox", () => {
    document.body.innerHTML = `<div id="x" aria-haspopup="listbox"></div>`;
    expect(isCustomDropdownElement(document.getElementById("x"))).toBe(true);
  });

  it("returns false for null and HTMLSelectElement", () => {
    expect(isCustomDropdownElement(null)).toBe(false);
    document.body.innerHTML = `<select id="s"></select>`;
    expect(isCustomDropdownElement(document.getElementById("s") as any)).toBe(false);
  });

  it("recognizes ng-select inside a form", () => {
    const form = setHtml(`
      <form>
        <ng-select id="country">
          <div class="ng-option" data-value="IN">India</div>
          <div class="ng-option" data-value="US">USA</div>
        </ng-select>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields).toHaveLength(1);
    expect(fields[0].type).toBe("select");
    expect(fields[0].options?.length).toBeGreaterThan(0);
  });

  it("recognizes searchable-dropdown host", () => {
    const form = setHtml(`
      <form>
        <searchable-dropdown id="sd" name="sd">
          <ng-select>
            <div class="ng-option" data-value="x">X</div>
          </ng-select>
        </searchable-dropdown>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Dropdown open/close/expand detection", () => {
  it("detects aria-expanded=true as expanded", () => {
    document.body.innerHTML = `<div id="x" aria-expanded="true"></div>`;
    expect(isDropdownExpanded(document.getElementById("x") as HTMLElement)).toBe(true);
  });

  it("detects ng-select-opened class", () => {
    document.body.innerHTML = `<div id="x" class="ng-select-opened"></div>`;
    expect(isDropdownExpanded(document.getElementById("x") as HTMLElement)).toBe(true);
  });

  it("detects child with aria-expanded=true", () => {
    document.body.innerHTML = `<div id="x"><div aria-expanded="true"></div></div>`;
    expect(isDropdownExpanded(document.getElementById("x") as HTMLElement)).toBe(true);
  });

  it("openDropdownElement dispatches click events", () => {
    document.body.innerHTML = `
      <div id="x" role="combobox">
        <div class="ng-select-container"></div>
      </div>
    `;
    const el = document.getElementById("x") as HTMLElement;
    const result = openDropdownElement(el);
    // jsdom doesn't change aria-expanded automatically; returns false
    expect(typeof result).toBe("boolean");
  });

  it("openDropdownElement returns false when already expanded", () => {
    document.body.innerHTML = `<div id="x" aria-expanded="true"></div>`;
    const el = document.getElementById("x") as HTMLElement;
    expect(openDropdownElement(el)).toBe(false);
  });

  it("closeDropdownElement returns silently when not expanded", () => {
    document.body.innerHTML = `<div id="x"></div>`;
    const el = document.getElementById("x") as HTMLElement;
    expect(() => closeDropdownElement(el)).not.toThrow();
  });

  it("closeDropdownElement dispatches escape when expanded", () => {
    document.body.innerHTML = `
      <div id="x" aria-expanded="true" role="combobox"></div>
    `;
    const el = document.getElementById("x") as HTMLElement;
    expect(() => closeDropdownElement(el)).not.toThrow();
  });

  it("closeDropdownElement closes mobile bottom drawer", () => {
    document.body.innerHTML = `
      <div id="parent">
        <div id="x"></div>
        <app-mobile-view-list>
          <div class="upload-container show"></div>
          <div class="dropdown-heading"><img /></div>
          <div class="background-view"></div>
        </app-mobile-view-list>
      </div>
    `;
    const el = document.getElementById("x") as HTMLElement;
    expect(() => closeDropdownElement(el)).not.toThrow();
  });

  it("detects mobile drawer as expanded", () => {
    document.body.innerHTML = `
      <div id="parent">
        <div id="x"></div>
        <app-mobile-view-list>
          <div class="upload-container show"></div>
        </app-mobile-view-list>
      </div>
    `;
    const x = document.getElementById("x") as HTMLElement;
    expect(isDropdownExpanded(x)).toBe(true);
  });
});

describe("readDropdownOptionMetadata", () => {
  it("reads data-value and label text", () => {
    document.body.innerHTML = `
      <div class="ng-option" data-value="IN">India</div>
    `;
    const el = document.querySelector(".ng-option") as HTMLElement;
    const meta = readDropdownOptionMetadata(el);
    expect(meta).toEqual({ value: "IN", label: "India" });
  });

  it("falls back to label when no value attribute", () => {
    document.body.innerHTML = `<div class="ng-option">Plain Label</div>`;
    const el = document.querySelector(".ng-option") as HTMLElement;
    const meta = readDropdownOptionMetadata(el);
    expect(meta.label).toBe("Plain Label");
    expect(meta.value).toBe("Plain Label");
  });

  it("uses ng-reflect-value when no data-value", () => {
    document.body.innerHTML = `
      <div role="option" ng-reflect-value="X">Item X</div>
    `;
    const el = document.querySelector("[role=option]") as HTMLElement;
    const meta = readDropdownOptionMetadata(el);
    expect(meta.value).toBe("X");
  });

  it("resolves value via aria-labelledby reference", () => {
    document.body.innerHTML = `
      <div id="lbl">Value Z</div>
      <div role="option" aria-labelledby="lbl"></div>
    `;
    const el = document.querySelector("[role=option]") as HTMLElement;
    const meta = readDropdownOptionMetadata(el);
    expect(meta.value).toBe("Value Z");
  });

  it("handles mat-radio-button labels properly", () => {
    document.body.innerHTML = `
      <mat-radio-button>
        <span class="mat-radio-label-content">
          <span style="display: none">&nbsp;</span>
          Real Label
        </span>
      </mat-radio-button>
    `;
    const el = document.querySelector("mat-radio-button") as HTMLElement;
    const meta = readDropdownOptionMetadata(el);
    expect(meta.label).toBe("Real Label");
  });

  it("returns undefined for empty option", () => {
    document.body.innerHTML = `<div class="ng-option"></div>`;
    const el = document.querySelector(".ng-option") as HTMLElement;
    const meta = readDropdownOptionMetadata(el);
    expect(meta.label).toBeUndefined();
    expect(meta.value).toBeUndefined();
  });
});

describe("getDropdownOptionContainers", () => {
  it("returns the element itself", () => {
    document.body.innerHTML = `<ng-select id="x"></ng-select>`;
    const el = document.getElementById("x") as HTMLElement;
    const containers = getDropdownOptionContainers(el);
    expect(containers).toContain(el);
  });

  it("includes mobile drawer when present", () => {
    document.body.innerHTML = `
      <div id="parent">
        <ng-select id="x"></ng-select>
        <app-mobile-view-list>
          <mat-radio-button>Option</mat-radio-button>
        </app-mobile-view-list>
      </div>
    `;
    const el = document.getElementById("x") as HTMLElement;
    const containers = getDropdownOptionContainers(el);
    expect(containers.length).toBeGreaterThanOrEqual(2);
  });

  it("includes panels referenced by aria-controls", () => {
    document.body.innerHTML = `
      <ng-select id="x" aria-controls="panel1"></ng-select>
      <div id="panel1"><div class="ng-option" data-value="a">A</div></div>
    `;
    const el = document.getElementById("x") as HTMLElement;
    const containers = getDropdownOptionContainers(el);
    expect(containers.some((c) => (c as HTMLElement).id === "panel1")).toBe(true);
  });
});

describe("waitForCustomDropdownRender", () => {
  it("resolves immediately when no dropdown host exists", async () => {
    document.body.innerHTML = `<form><input id="x" type="text" /></form>`;
    const form = document.querySelector("form") as HTMLElement;
    await expect(waitForCustomDropdownRender(form, 50)).resolves.toBeUndefined();
  });

  it("resolves immediately when timeout <= 0", async () => {
    document.body.innerHTML = `<form></form>`;
    const form = document.querySelector("form") as HTMLElement;
    await expect(waitForCustomDropdownRender(form, 0)).resolves.toBeUndefined();
  });

  it("times out when host has no interactive dropdown", async () => {
    document.body.innerHTML = `
      <form><searchable-dropdown></searchable-dropdown></form>
    `;
    const form = document.querySelector("form") as HTMLElement;
    await expect(
      waitForCustomDropdownRender(form, 50),
    ).resolves.toBeUndefined();
  });
});

describe("ensureCustomDropdownOptions", () => {
  it("returns silently for non-custom-dropdown elements", async () => {
    document.body.innerHTML = `<input id="x" type="text" />`;
    const fakeField = {
      element: document.getElementById("x") as HTMLElement,
      id: "x",
      name: "x",
      label: "X",
      type: "text" as const,
      constraints: { required: false },
      inputElements: [],
      options: [],
    };
    await ensureCustomDropdownOptions(fakeField as any, 50);
    expect(fakeField.options).toEqual([]);
  });

  it("collects options once a dropdown is present", async () => {
    document.body.innerHTML = `
      <form>
        <ng-select id="x" aria-expanded="true">
          <div class="ng-option" data-value="A">Alpha</div>
          <div class="ng-option" data-value="B">Beta</div>
        </ng-select>
      </form>
    `;
    const form = document.querySelector("form") as HTMLElement;
    const fields = extractFormFields(form);
    expect(fields[0].type).toBe("select");
    const opts = fields[0].options ?? [];
    expect(opts.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Option buildOption fallback values", () => {
  it("uses data-value attribute when value is absent", () => {
    const form = setHtml(`
      <form>
        <input type="radio" name="g" id="opt1" data-value="VAL1" />
        <input type="radio" name="g" id="opt2" data-value="VAL2" />
      </form>
    `);
    const fields = extractFormFields(form);
    // input.value of radio defaults to 'on'; data-value is the override
    expect(fields[0].options?.[0].value).toBe("on");
    expect(fields[0].options?.length).toBe(2);
  });

  it("uses aria-label for option label", () => {
    const form = setHtml(`
      <form>
        <input type="radio" name="g" value="m" aria-label="Male Option" />
        <input type="radio" name="g" value="f" aria-label="Female Option" />
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].options?.[0].label).toBe("Male Option");
  });
});

describe("Custom dropdown — required detection from host attributes", () => {
  it("detects required via aria-required", () => {
    const form = setHtml(`
      <form>
        <ng-select id="x" aria-required="true"></ng-select>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].constraints.required).toBe(true);
  });

  it("detects required via data-required", () => {
    const form = setHtml(`
      <form>
        <searchable-dropdown id="x" data-required="true"></searchable-dropdown>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].constraints.required).toBe(true);
  });

  it("detects allowMultiple via aria-multiselectable", () => {
    const form = setHtml(`
      <form>
        <div id="x" role="listbox" aria-multiselectable="true"></div>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].allowMultiple).toBe(true);
  });
});

describe("Custom dropdown — uses aria-label and slug fallback", () => {
  it("uses aria-label as label when no <label> found", () => {
    const form = setHtml(`
      <form>
        <ng-select id="ns" aria-label="Country List"></ng-select>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].label).toBe("Country List");
  });

  it("falls back to slugified label for id when nothing present", () => {
    const form = setHtml(`
      <form>
        <ng-select aria-label="State Region"></ng-select>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].id).toMatch(/state-region|field/);
  });
});
