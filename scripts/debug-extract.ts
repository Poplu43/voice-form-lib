import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
  extractFormFields,
  waitForCustomDropdownRender,
  ensureCustomDropdownOptions,
} from "../src/formExtractor";

async function main(): Promise<void> {
  const html = readFileSync(new URL("../nsp.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, {
    url: "https://example.com/",
    pretendToBeVisual: true,
  });

  const { window } = dom;
  Object.assign(globalThis, {
    window,
    document: window.document,
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    MutationObserver: window.MutationObserver,
  });

  const form = window.document.querySelector("form");
  if (!form) {
    console.error("No form found in NSP HTML");
    return;
  }

  await waitForCustomDropdownRender(form, 1000);
  const fields = extractFormFields(form as HTMLFormElement);

  for (const field of fields) {
    if (field.type === "select") {
      await ensureCustomDropdownOptions(field, 1000);
    }
  }

  console.table(
    fields.map((field) => ({
      id: field.id,
      name: field.name,
      label: field.label,
      type: field.type,
      options: field.options?.map((opt) => opt.label).join(", ") ?? "",
    })),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
