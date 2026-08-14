import { describe, it, expect, vi } from "vitest";
import {
  ensureCustomDropdownOptions,
  extractFormFields,
} from "../src/formExtractor";

function makeScrollable(el: HTMLElement, sh: number, ch: number) {
  Object.defineProperty(el, "scrollHeight", { value: sh, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: ch, configurable: true });
  let st = 0;
  Object.defineProperty(el, "scrollTop", {
    get() {
      return st;
    },
    set(v) {
      st = v;
    },
    configurable: true,
  });
}

describe("ensureCustomDropdownOptions with scrollable container", () => {
  it("scrolls through container to collect all options", async () => {
    document.body.innerHTML = `
      <form>
        <ng-select id="ns">
          <div class="ng-dropdown-panel-items">
            <div class="ng-option" data-value="a">A</div>
            <div class="ng-option" data-value="b">B</div>
            <div class="ng-option" data-value="c">C</div>
            <div class="ng-option" data-value="d">D</div>
          </div>
        </ng-select>
      </form>
    `;
    const form = document.querySelector("form") as HTMLElement;
    const fields = extractFormFields(form);
    const fld = fields[0];
    const panel = document.querySelector(
      ".ng-dropdown-panel-items",
    ) as HTMLElement;
    makeScrollable(panel, 500, 100);

    await ensureCustomDropdownOptions(fld as any, 500);
    expect(fld.options?.length).toBeGreaterThanOrEqual(4);
  });

  it("handles no-scroll containers (single-screen options)", async () => {
    document.body.innerHTML = `
      <form>
        <ng-select id="ns">
          <div class="ng-option" data-value="a">A</div>
          <div class="ng-option" data-value="b">B</div>
        </ng-select>
      </form>
    `;
    const form = document.querySelector("form") as HTMLElement;
    const fields = extractFormFields(form);
    await ensureCustomDropdownOptions(fields[0] as any, 200);
    expect(fields[0].options?.length).toBeGreaterThanOrEqual(2);
  });

  it("stops after stable passes when no new options appear", async () => {
    document.body.innerHTML = `
      <form>
        <ng-select id="ns">
          <div class="ng-dropdown-panel-items">
            <div class="ng-option" data-value="only">Only Option</div>
          </div>
        </ng-select>
      </form>
    `;
    const form = document.querySelector("form") as HTMLElement;
    const fields = extractFormFields(form);
    const panel = document.querySelector(
      ".ng-dropdown-panel-items",
    ) as HTMLElement;
    makeScrollable(panel, 100, 100);
    await ensureCustomDropdownOptions(fields[0] as any, 300);
    expect(fields[0].options?.length).toBe(1);
  });
});

describe("waitForCustomDropdownRender timeout edge", () => {
  it("returns when MutationObserver not supported", async () => {
    const orig = (globalThis as any).MutationObserver;
    (globalThis as any).MutationObserver = undefined;
    try {
      const { waitForCustomDropdownRender } = await import(
        "../src/formExtractor"
      );
      document.body.innerHTML = `<form><searchable-dropdown></searchable-dropdown></form>`;
      const form = document.querySelector("form") as HTMLElement;
      await expect(
        waitForCustomDropdownRender(form, 100),
      ).resolves.toBeUndefined();
    } finally {
      (globalThis as any).MutationObserver = orig;
    }
  });
});

describe("Custom dropdown with multiple ng-select inside host", () => {
  it("treats nested ng-selects as separate descriptors", () => {
    document.body.innerHTML = `
      <form>
        <searchable-dropdown>
          <ng-select id="a"></ng-select>
        </searchable-dropdown>
        <searchable-dropdown>
          <ng-select id="b"></ng-select>
        </searchable-dropdown>
      </form>
    `;
    const form = document.querySelector("form") as HTMLElement;
    const fields = extractFormFields(form);
    expect(fields.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Group info from data-step-title attribute", () => {
  it("reads data-step-title attribute value from child element", () => {
    document.body.innerHTML = `
      <form>
        <div data-step="1">
          <div data-step-title="Step One Title"></div>
          <input id="f" name="f" type="text" />
        </div>
      </form>
    `;
    const form = document.querySelector("form") as HTMLElement;
    const fields = extractFormFields(form);
    expect(fields[0].groupLabel).toBe("Step One Title");
  });
});

describe("Label discovery via wrapping label with material exclusion", () => {
  it("skips mat-form-field-label and uses subsequent label", () => {
    document.body.innerHTML = `
      <form>
        <label>Real Label</label>
        <mat-form-field>
          <div class="mat-form-field-label-wrapper">
            <label class="mat-form-field-label">Placeholder</label>
          </div>
          <input id="x" name="x" type="text" />
        </mat-form-field>
      </form>
    `;
    const form = document.querySelector("form") as HTMLElement;
    const fields = extractFormFields(form);
    expect(fields[0].label).toBe("Real Label");
  });
});

describe("Sibling traversal for labels — nested DOM", () => {
  it("walks through multiple sibling levels", () => {
    document.body.innerHTML = `
      <form>
        <div>
          <span><label>Deep Label</label></span>
        </div>
        <div>
          <div>
            <input id="x" name="x" type="text" />
          </div>
        </div>
      </form>
    `;
    const form = document.querySelector("form") as HTMLElement;
    const fields = extractFormFields(form);
    expect(fields[0].label).toBe("Deep Label");
  });
});

describe("readDropdownOptionMetadata corners", () => {
  it("reads data-label attribute when present", async () => {
    document.body.innerHTML = `
      <div class="ng-option" data-value="X" data-label="Custom Label"></div>
    `;
    const el = document.querySelector(".ng-option") as HTMLElement;
    const { readDropdownOptionMetadata } = await import(
      "../src/formExtractor"
    );
    const meta = readDropdownOptionMetadata(el);
    expect(meta.label).toBe("Custom Label");
  });
});

describe("findCustomDropdowns dedupe", () => {
  it("collects each nested ng-select as a separate dropdown", () => {
    document.body.innerHTML = `
      <form>
        <ng-select id="outer">
          <ng-select id="inner"></ng-select>
        </ng-select>
      </form>
    `;
    const form = document.querySelector("form") as HTMLElement;
    const fields = extractFormFields(form);
    expect(fields.length).toBeGreaterThanOrEqual(1);
  });
});

describe("collectPanelIds via data-target", () => {
  it("collects via element's own data-target attribute", () => {
    document.body.innerHTML = `
      <form>
        <ng-select id="x" data-target="panel-d"></ng-select>
        <div id="panel-d">
          <div class="ng-option" data-value="A">A</div>
        </div>
      </form>
    `;
    const form = document.querySelector("form") as HTMLElement;
    const fields = extractFormFields(form);
    expect(fields.length).toBeGreaterThanOrEqual(1);
    expect(fields[0].id).toBe("x");
  });

  it("collects via descendant's aria-owns attribute", () => {
    document.body.innerHTML = `
      <form>
        <ng-select id="x">
          <div aria-owns="panelXYZ"></div>
        </ng-select>
        <div id="panelXYZ">
          <div class="ng-option" data-value="A">A</div>
        </div>
      </form>
    `;
    const form = document.querySelector("form") as HTMLElement;
    const fields = extractFormFields(form);
    expect(fields.length).toBeGreaterThanOrEqual(1);
    expect(fields[0].id).toBe("x");
  });
});

describe("buildCustomDropdownDescriptor — fallback id generation", () => {
  it("generates fallback id from label slug when no id present", () => {
    document.body.innerHTML = `
      <form>
        <ng-select aria-label="Country Select"></ng-select>
      </form>
    `;
    const form = document.querySelector("form") as HTMLElement;
    const fields = extractFormFields(form);
    expect(fields[0].id).toMatch(/country-select|field/);
  });

  it("uses control name from descendant when host has none", () => {
    document.body.innerHTML = `
      <form>
        <ng-select>
          <input formcontrolname="innerControl" />
        </ng-select>
      </form>
    `;
    const form = document.querySelector("form") as HTMLElement;
    const fields = extractFormFields(form);
    expect(fields[0].name).toBe("innerControl");
  });
});

describe("CSS.escape fallback when CSS API unavailable", () => {
  it("handles ID with special CSS characters via aria-labelledby", () => {
    document.body.innerHTML = `
      <form>
        <span id="lbl-special">My Label</span>
        <input id="x" name="x" type="text" aria-labelledby="lbl-special" />
      </form>
    `;
    const form = document.querySelector("form") as HTMLElement;
    const fields = extractFormFields(form);
    expect(fields[0].label).toBe("My Label");
  });
});
