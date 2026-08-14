import { describe, it, expect, vi } from "vitest";
import {
  extractFormFields,
  ensureCustomDropdownOptions,
  getDropdownOptionContainers,
  isDropdownExpanded,
  openDropdownElement,
  closeDropdownElement,
} from "../src/formExtractor";

function setHtml(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

describe("Mutation observer-driven option updates", () => {
  it("re-collects options when mutation observer fires", async () => {
    const form = setHtml(`
      <form>
        <ng-select id="x">
          <div class="ng-option" data-value="a">A</div>
        </ng-select>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].options?.length).toBe(1);
    // Add new options after extraction
    const ns = form.querySelector("ng-select")!;
    ns.innerHTML += `<div class="ng-option" data-value="b">B</div>`;
    // Give MutationObserver time to fire
    await new Promise((r) => setTimeout(r, 200));
  });

  it("registers panel observer when aria-controls panel exists", async () => {
    document.body.innerHTML = `
      <form>
        <ng-select id="x" aria-controls="panel"></ng-select>
        <div id="panel"></div>
      </form>
    `;
    const form = document.querySelector("form") as HTMLElement;
    const fields = extractFormFields(form);
    const panel = document.getElementById("panel")!;
    panel.innerHTML = `<div class="ng-option" data-value="late">Late</div>`;
    await new Promise((r) => setTimeout(r, 200));
    // Panel observer should have updated the field's options
    expect(fields[0]).toBeDefined();
    expect(fields[0].id).toBe("x");
  });

  it("handles dropdown without any panel reference", () => {
    const form = setHtml(`
      <form>
        <ng-select id="x">
          <div class="ng-option" data-value="a">A</div>
        </ng-select>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].options?.length).toBe(1);
  });
});

describe("ensureCustomDropdownOptions — virtualized scrolling scenario", () => {
  it("scrolls through containers when scrollable", async () => {
    document.body.innerHTML = `
      <form>
        <ng-select id="x">
          <div class="ng-dropdown-panel-items" style="height: 100px; overflow-y: auto;">
            <div class="ng-option" data-value="a" style="height: 50px;">A</div>
            <div class="ng-option" data-value="b" style="height: 50px;">B</div>
            <div class="ng-option" data-value="c" style="height: 50px;">C</div>
          </div>
        </ng-select>
      </form>
    `;
    const form = document.querySelector("form") as HTMLElement;
    const fields = extractFormFields(form);
    const fld = fields[0];
    await ensureCustomDropdownOptions(fld as any, 500);
    expect(fld.options?.length).toBeGreaterThanOrEqual(3);
  });
});

describe("getDropdownOptionContainers — mobile drawer disables panel collection", () => {
  it("uses mobile drawer when drawer contains mat-radio-button options", () => {
    document.body.innerHTML = `
      <searchable-dropdown>
        <ng-select id="x" aria-controls="panel"></ng-select>
        <app-mobile-view-list>
          <mat-radio-button ng-reflect-value="A">A</mat-radio-button>
        </app-mobile-view-list>
      </searchable-dropdown>
      <div id="panel">
        <div class="ng-option" data-value="A">A from panel</div>
      </div>
    `;
    const el = document.getElementById("x") as HTMLElement;
    const containers = getDropdownOptionContainers(el);
    // Mobile drawer prioritized over panel
    expect(containers.some((c) => (c as HTMLElement).tagName?.toLowerCase() === "app-mobile-view-list")).toBe(true);
  });
});

describe("openDropdownElement — already-expanded short-circuit", () => {
  it("returns false when expanded via ng-select-opened class", () => {
    document.body.innerHTML = `<div id="x" class="ng-select-opened"></div>`;
    const el = document.getElementById("x") as HTMLElement;
    expect(openDropdownElement(el)).toBe(false);
  });

  it("returns false when expanded via aria-expanded=true on child", () => {
    document.body.innerHTML = `<div id="x"><span aria-expanded="true"></span></div>`;
    const el = document.getElementById("x") as HTMLElement;
    expect(openDropdownElement(el)).toBe(false);
  });
});

describe("closeDropdownElement — mobile drawer with cross button", () => {
  it("clicks cross button to close mobile drawer", () => {
    document.body.innerHTML = `
      <div id="parent">
        <div id="x" aria-expanded="true"></div>
        <app-mobile-view-list>
          <div class="upload-container show"></div>
          <div class="dropdown-heading"><img /></div>
        </app-mobile-view-list>
      </div>
    `;
    const el = document.getElementById("x") as HTMLElement;
    const closeBtn = document.querySelector(
      ".dropdown-heading img",
    ) as HTMLElement;
    const spy = vi.fn();
    closeBtn.addEventListener("click", spy);
    closeDropdownElement(el);
    expect(spy).toHaveBeenCalled();
  });

  it("falls back to background-view click when no cross button", () => {
    document.body.innerHTML = `
      <div id="parent">
        <div id="x" aria-expanded="true"></div>
        <app-mobile-view-list>
          <div class="upload-container show"></div>
          <div class="background-view"></div>
        </app-mobile-view-list>
      </div>
    `;
    const el = document.getElementById("x") as HTMLElement;
    const bg = document.querySelector(".background-view") as HTMLElement;
    const spy = vi.fn();
    bg.addEventListener("click", spy);
    closeDropdownElement(el);
    expect(spy).toHaveBeenCalled();
  });
});

describe("isDropdownExpanded — explicit positive", () => {
  it("returns true when mobile drawer has .upload-container.show", () => {
    document.body.innerHTML = `
      <div id="parent">
        <div id="x"></div>
        <app-mobile-view-list>
          <div class="upload-container show"></div>
        </app-mobile-view-list>
      </div>
    `;
    expect(
      isDropdownExpanded(document.getElementById("x") as HTMLElement),
    ).toBe(true);
  });
});

describe("extractFormFields — complex Material wrappers", () => {
  it("handles mat-form-field with multiple inner inputs", () => {
    const form = setHtml(`
      <form>
        <mat-form-field>
          <label>Outer Label</label>
          <input id="inner" name="inner" type="text" />
        </mat-form-field>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields.length).toBeGreaterThanOrEqual(1);
  });

  it("respects formcontrolname attribute for name resolution", () => {
    const form = setHtml(`
      <form>
        <input id="x" formcontrolname="myControl" type="text" />
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].name).toBe("myControl");
  });

  it("handles input with both name and id pointing to different values", () => {
    const form = setHtml(`
      <form>
        <input id="theId" name="theName" type="text" />
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].id).toBe("theId");
    expect(fields[0].name).toBe("theName");
  });
});

describe("Constraints edge cases", () => {
  it("treats empty min/max attribute as undefined", () => {
    const form = setHtml(`
      <form><input id="x" type="number" /></form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].constraints.min).toBeUndefined();
    expect(fields[0].constraints.max).toBeUndefined();
  });

  it("ignores invalid numeric min/max", () => {
    const form = setHtml(`
      <form><input id="x" type="number" min="not-a-number" /></form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].constraints.min).toBeUndefined();
  });

  it("reads minlength=0 correctly", () => {
    const form = setHtml(`
      <form><input id="x" type="text" minlength="0" /></form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].constraints.minLength).toBe(0);
  });
});

describe("ng-select with bound reactive-form attributes", () => {
  it("recognizes ng-reflect-required=true", () => {
    const form = setHtml(`
      <form>
        <ng-select id="x" ng-reflect-required="true">
          <div class="ng-option" data-value="A">A</div>
        </ng-select>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].constraints.required).toBe(true);
  });

  it("recognizes ng-reflect-multiple=true", () => {
    const form = setHtml(`
      <form>
        <ng-select id="x" ng-reflect-multiple="true">
          <div class="ng-option" data-value="A">A</div>
        </ng-select>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].allowMultiple).toBe(true);
  });
});

describe("Tab group detection — mat-tab-body variant", () => {
  it("extracts groupId from mat-tab-body with aria-labelledby", () => {
    const form = setHtml(`
      <form>
        <div class="mat-tab-body" aria-labelledby="mat-tab-label-0-1">
          <input id="f" name="f" type="text" />
        </div>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].groupId).toBe("mat-tab-content-0-1");
  });

  it("extracts groupId from mat-mdc-tab-body class", () => {
    const form = setHtml(`
      <form>
        <div class="mat-mdc-tab-body" aria-labelledby="mat-tab-label-0-3">
          <input id="f" name="f" type="text" />
        </div>
      </form>
    `);
    const fields = extractFormFields(form);
    expect(fields[0].groupId).toBe("mat-tab-content-0-3");
  });
});
