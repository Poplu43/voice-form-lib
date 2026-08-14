import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JSDOM } from "jsdom";
import {
    extractFormFields,
    ensureCustomDropdownOptions,
    waitForCustomDropdownRender,
} from "../dist/formExtractor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
    const htmlPath = resolve(__dirname, "../nsp.html");
    const html = readFileSync(htmlPath, "utf8");
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
        console.error("Form not found");
        process.exit(1);
    }

    await waitForCustomDropdownRender(form, 1000);
    const fields = extractFormFields(form);

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
            optionsCount: field.options?.length ?? 0,
        })),
    );
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
