import {
  ConstraintSet,
  VoiceFormFieldDescriptor,
  VoiceFormFieldType,
} from "./types";

const CUSTOM_DROPDOWN_BASE_SELECTORS = [
  "ng-select",
  ".ng-select",
  "[role='listbox']",
  "[aria-haspopup='listbox']",
  "[role='combobox']",
];

const CUSTOM_DROPDOWN_HOST_SELECTORS = [
  "dynamic-dropdown-input",
  "searchable-dropdown",
  "dynamic-select",
  "dynamic-select-input",
  "custom-dropdown",
];

const FILE_UPLOAD_HOST_SELECTORS = [
  "digi-upload-input",
  "dynamic-file-input",
  "dynamic-upload-input",
  "file-upload",
  "app-file-upload",
  "app-upload",
];

const CUSTOM_DROPDOWN_SELECTOR = CUSTOM_DROPDOWN_BASE_SELECTORS.join(", ");
const CUSTOM_DROPDOWN_HOST_SELECTOR = CUSTOM_DROPDOWN_HOST_SELECTORS.join(", ");
const FILE_UPLOAD_HOST_SELECTOR = FILE_UPLOAD_HOST_SELECTORS.join(", ");

const isDropdownHost = (element: Element): boolean =>
  CUSTOM_DROPDOWN_HOST_SELECTORS.some((selector) => element.matches(selector));

const isNgSelectElement = (element: Element): boolean =>
  element.tagName.toLowerCase() === "ng-select" ||
  element.classList.contains("ng-select");
const DROPDOWN_TOGGLE_SELECTOR =
  ".ng-select-container, [role='combobox'], [aria-haspopup='listbox']";
const DROPDOWN_OPTION_SELECTOR =
  ".ng-option, [role='option'], option, [data-value], mat-radio-button";

// Mobile bottom-drawer component rendered as a sibling of ng-select inside
// searchable-dropdown or similar host components.
const MOBILE_BOTTOM_DRAWER_SELECTOR = "app-mobile-view-list";
const OPTION_UPDATE_DEBOUNCE_MS = 60;
const OPTION_ENSURE_POLL_MS = 150;

const CONTROL_ID_CANDIDATES = [
  "id",
  "data-control-id",
  "data-field-id",
  "formcontrolname",
  "name",
  "ng-reflect-control-name",
  "ng-reflect-name",
  "data-control-name",
  "data-field-name",
  "data-input-name",
  "data-name",
];

const CONTROL_NAME_CANDIDATES = [
  "name",
  "formcontrolname",
  "data-control-name",
  "ng-reflect-name",
  "ng-reflect-control-name",
  "data-field-name",
  "data-field",
  "data-input-name",
  "data-name",
];

const CONTROL_DESCENDANT_SELECTOR =
  "[id], [name], [formcontrolname], [ng-reflect-name], [ng-reflect-control-name], [data-control-name], [data-field-name], [data-field], [data-input-name], [data-name]";

const HAS_WINDOW = typeof window !== "undefined";
const HAS_MUTATION_OBSERVER =
  HAS_WINDOW && typeof MutationObserver !== "undefined";

// Identify non-native dropdown widgets such as ng-select or elements using listbox semantics.
function findCustomDropdowns(form: HTMLElement): HTMLElement[] {
  const selector = CUSTOM_DROPDOWN_HOST_SELECTOR
    ? `${CUSTOM_DROPDOWN_SELECTOR}, ${CUSTOM_DROPDOWN_HOST_SELECTOR}`
    : CUSTOM_DROPDOWN_SELECTOR;
  const candidates = Array.from(form.querySelectorAll<HTMLElement>(selector));
  const resolved: HTMLElement[] = [];
  for (const candidate of candidates) {
    const dropdown = resolveCustomDropdownElement(candidate);
    if (!dropdown || dropdown instanceof HTMLSelectElement) {
      continue;
    }
    if (!form.contains(dropdown)) {
      continue;
    }
    if (!resolved.includes(dropdown)) {
      resolved.push(dropdown);
    }
  }
  return resolved;
}

function resolveCustomDropdownElement(
  element: HTMLElement,
): HTMLElement | null {
  if (element instanceof HTMLSelectElement) {
    return null;
  }
  if (element instanceof HTMLInputElement) {
    const owner = element.closest<HTMLElement>(
      "ng-select, .ng-select, [role='listbox'], [aria-haspopup='listbox']",
    );
    if (owner && !(owner instanceof HTMLSelectElement)) {
      return owner;
    }
  }
  if (element.matches("ng-select, .ng-select")) {
    return element;
  }
  const role = element.getAttribute("role");
  if (role === "listbox" || role === "combobox") {
    return element;
  }
  const ariaHasPopup = element.getAttribute("aria-haspopup");
  if (ariaHasPopup === "listbox" || ariaHasPopup === "true") {
    return element;
  }
  const inner = element.querySelector<HTMLElement>(
    "ng-select, .ng-select, [role='listbox'], [aria-haspopup='listbox']",
  );
  if (inner && !(inner instanceof HTMLSelectElement)) {
    return inner;
  }
  if (isDropdownHost(element)) {
    return element;
  }
  return null;
}

function buildCustomDropdownDescriptor(
  form: HTMLElement,
  element: HTMLElement,
  nextIndex: number,
): ExtractedFormField {
  const rawId = element.id || element.getAttribute("name");
  const controlNameAttr = pickControlName(element);
  const hostRequired =
    element.getAttribute("data-required") ||
    element.getAttribute("data-is-required");
  const label =
    element.getAttribute("aria-label") ||
    element.getAttribute("data-label") ||
    element.getAttribute("title") ||
    element.closest("label")?.textContent?.trim() ||
    findLabel(form, element) ||
    undefined;
  const baseId = generateFallbackId(form, element);
  const labelSlug = label ? slugifyLabel(label) : undefined;
  const id =
    rawId && rawId.trim()
      ? rawId.trim()
      : controlNameAttr && controlNameAttr.trim()
        ? controlNameAttr.trim()
        : `${labelSlug ?? baseId}_custom_${nextIndex}`;
  const name =
    element.getAttribute("name") ||
    controlNameAttr ||
    element.getAttribute("formcontrolname") ||
    element.id ||
    id;

  const allowMultiple =
    element.hasAttribute("multiple") ||
    element.getAttribute("aria-multiselectable") === "true" ||
    element.getAttribute("ng-reflect-multiple") === "true" ||
    element.classList.contains("ng-select-multiple") ||
    element.querySelector(".ng-select-multiple") !== null ||
    element.querySelector("[ng-reflect-multiple='true']") !== null;
  const constraints: ConstraintSet = {
    required:
      element.hasAttribute("required") ||
      element.getAttribute("aria-required") === "true" ||
      element.getAttribute("ng-reflect-required") === "true" ||
      hostRequired === "true" ||
      hostRequired === "1",
  };
  const groupInfo = extractGroupInfo(element);

  const descriptor: ExtractedFormField = {
    id,
    name,
    label: cleanLabel(label) ?? prettifyLabel(id),
    type: "select",
    constraints,
    options: [],
    allowMultiple,
    element,
    inputElements: [],
    groupId: groupInfo.id,
    groupLabel: cleanLabel(groupInfo.label),
    groupIndex: groupInfo.index,
  };

  registerCustomDropdown(descriptor, element);
  return descriptor;
}

export interface ExtractedFormField extends VoiceFormFieldDescriptor {
  element: HTMLElement;
  inputElements: HTMLInputElement[];
  selectElement?: HTMLSelectElement;
  textareaElement?: HTMLTextAreaElement;
  /** DOM value captured at extraction time; used to detect browser-auto-selected defaults. */
  initialValue?: string;
}

type CustomDropdownMeta = {
  descriptor: ExtractedFormField;
  element: HTMLElement;
  observers: MutationObserver[];
  panelObservers: Map<string, MutationObserver>;
  bodyObserver?: MutationObserver;
  pendingUpdate?: ReturnType<typeof setTimeout>;
  pendingEnsure?: ReturnType<typeof setTimeout>;
};

const customDropdownRegistry = new WeakMap<HTMLElement, CustomDropdownMeta>();

export async function waitForCustomDropdownRender(
  form: HTMLElement,
  timeoutMs: number = 3000,
): Promise<void> {
  if (!HAS_MUTATION_OBSERVER || timeoutMs <= 0) {
    return;
  }

  const deadline = Date.now() + timeoutMs;

  const hasInteractiveDropdown = () =>
    findCustomDropdowns(form).length > 0 ||
    !form.querySelector(CUSTOM_DROPDOWN_HOST_SELECTOR);

  if (hasInteractiveDropdown()) {
    return;
  }

  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      if (hasInteractiveDropdown()) {
        observer.disconnect();
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        resolve();
      }
    });

    observer.observe(form, {
      childList: true,
      subtree: true,
    });

    const remaining = Math.max(0, deadline - Date.now());
    if (remaining > 0) {
      timer = setTimeout(() => {
        observer.disconnect();
        resolve();
      }, remaining);
    } else {
      observer.disconnect();
      resolve();
    }
  });
}

export function extractFormFields(form: HTMLElement): ExtractedFormField[] {
  const fields: ExtractedFormField[] = [];
  const radioGroups = new Map<string, ExtractedFormField>();
  const checkboxGroups = new Map<string, ExtractedFormField>();
  const processedElements = new Set<Element>();

  // Find all custom dropdowns first
  const customDropdowns = findCustomDropdowns(form);
  const customDropdownElements = new Set<Element>();
  const addDropdownDescendants = (root: ParentNode): void => {
    const querySelectorAll = (
      root as ParentNode & {
        querySelectorAll?: (selectors: string) => NodeListOf<Element>;
      }
    ).querySelectorAll;
    if (typeof querySelectorAll !== "function") {
      return;
    }
    querySelectorAll
      .call(root, "input, select, textarea")
      .forEach((node) => customDropdownElements.add(node));
  };
  for (const dropdown of customDropdowns) {
    customDropdownElements.add(dropdown);
    addDropdownDescendants(dropdown);

    const containers = getDropdownOptionContainers(dropdown);
    for (const container of containers) {
      addDropdownDescendants(container);
    }
  }

  // Get all regular form elements
  const elements = Array.from(
    form.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >("input, select, textarea"),
  );

  const isWithinCustomDropdown = (node: Element): boolean =>
    customDropdowns.some(
      (dropdown) => dropdown !== node && dropdown.contains(node),
    );

  // Collect all elements (both custom dropdowns and regular inputs)
  const allElementsInOrder: Array<{
    element: HTMLElement;
    isCustomDropdown: boolean;
  }> = [];

  // Add custom dropdowns to the list
  for (const dropdown of customDropdowns) {
    allElementsInOrder.push({ element: dropdown, isCustomDropdown: true });
  }

  // Add regular form elements to the list
  for (const element of elements) {
    // Skip if it's inside a custom dropdown or is a custom dropdown element
    if (
      customDropdownElements.has(element) ||
      isWithinCustomDropdown(element)
    ) {
      continue;
    }
    allElementsInOrder.push({
      element: element as HTMLElement,
      isCustomDropdown: false,
    });
  }

  // Sort all elements by their position in the DOM to maintain visual order
  allElementsInOrder.sort((a, b) => {
    const position = a.element.compareDocumentPosition(b.element);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      return -1; // a comes before b
    } else if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      return 1; // b comes before a
    }
    return 0; // same element
  });

  // Now process all elements in DOM order
  for (const { element, isCustomDropdown } of allElementsInOrder) {
    if (processedElements.has(element)) {
      continue;
    }

    if (isCustomDropdown) {
      // Process custom dropdown
      const descriptor = buildCustomDropdownDescriptor(
        form,
        element,
        fields.length + 1,
      );
      if (!fields.some((existing) => existing.id === descriptor.id)) {
        fields.push(descriptor);
        processedElements.add(element);
      }
      continue;
    }

    // Process regular form elements
    if (element instanceof HTMLInputElement) {
      const type = element.type.toLowerCase();

      if (type === "file") {
        const descriptor = buildFileDescriptor(element, form);
        if (!fields.some((existing) => existing.id === descriptor.id)) {
          fields.push(descriptor);
        }
        processedElements.add(element);
        if (descriptor.element !== element) {
          processedElements.add(descriptor.element);
        }
        continue;
      }

      if (["button", "submit", "hidden", "reset", "image"].includes(type)) {
        continue;
      }

      if (type === "radio") {
        const groupName = element.name || element.id;
        if (!groupName) {
          continue;
        }

        const existing = radioGroups.get(groupName);
        if (existing) {
          existing.inputElements.push(element);
          existing.options?.push(buildOption(element));
        } else {
          const descriptor = buildDescriptor(element, "radio", form);
          descriptor.inputElements = [element];
          descriptor.options = [buildOption(element)];
          descriptor.allowMultiple = false;
          radioGroups.set(groupName, descriptor);
          fields.push(descriptor);
        }
        processedElements.add(element);
        continue;
      }

      if (type === "checkbox") {
        const groupName = element.name || element.id;
        if (!groupName) {
          continue;
        }
        const existing = checkboxGroups.get(groupName);
        if (existing) {
          existing.inputElements.push(element);
          existing.options?.push(buildOption(element));
        } else {
          const descriptor = buildDescriptor(element, "checkbox", form);
          descriptor.inputElements = [element];
          descriptor.options = [buildOption(element)];
          descriptor.allowMultiple = true;
          checkboxGroups.set(groupName, descriptor);
          fields.push(descriptor);
        }
        processedElements.add(element);
        continue;
      }

      // Angular Material datepicker inputs usually appear as readonly text
      // inputs. Detect them through Material/date host markers and treat them
      // as date fields so the voice flow asks for them instead of skipping.
      const resolvedType = isAngularMaterialDateInput(element)
        ? "date"
        : mapInputType(type);
      const descriptor = buildDescriptor(element, resolvedType, form);
      descriptor.inputElements = [element];
      descriptor.initialValue = element.value;
      fields.push(descriptor);
      processedElements.add(element);
      continue;
    }

    if (element instanceof HTMLSelectElement) {
      const descriptor = buildDescriptor(element, "select", form);
      descriptor.selectElement = element;
      descriptor.inputElements = [];
      descriptor.allowMultiple = element.multiple;
      // Record the browser-auto-selected default so isPendingField can tell the
      // difference between "user hasn't touched this" and "user explicitly chose".
      descriptor.initialValue = element.value;
      descriptor.options = Array.from(element.options)
        // Skip placeholder entries like `<option value="">Please Select</option>`
        // and `<option disabled value="">…</option>`. These exist purely to seed
        // the dropdown's empty state, not as something the user could select.
        .filter((option) => {
          if (option.disabled) {
            return false;
          }
          const rawValue = option.value;
          return rawValue !== undefined && rawValue.trim() !== "";
        })
        .map((option) => ({
          value: option.value,
          label: cleanLabel(option.textContent?.trim()) || option.value,
        }));
      fields.push(descriptor);
      processedElements.add(element);
      continue;
    }

    if (element instanceof HTMLTextAreaElement) {
      const descriptor = buildDescriptor(element, "textarea", form);
      descriptor.textareaElement = element;
      descriptor.inputElements = [];
      fields.push(descriptor);
      processedElements.add(element);
    }
  }

  return fields;
}

function mapInputType(inputType: string): VoiceFormFieldType {
  switch (inputType) {
    case "number":
      return "number";
    case "email":
      return "email";
    case "tel":
      return "tel";
    case "date":
      return "date";
    case "textarea":
      return "textarea";
    default:
      return "text";
  }
}

function isAngularMaterialDateInput(element: HTMLInputElement): boolean {
  if (element.type.toLowerCase() === "date") {
    return true;
  }
  if (
    element.hasAttribute("data-mat-calendar") ||
    element.hasAttribute("matdatepicker") ||
    element.hasAttribute("ng-reflect-mat-datepicker") ||
    element.hasAttribute("data-mat-datepicker")
  ) {
    return true;
  }
  if (element.closest("dynamic-date-input")) {
    return true;
  }
  const matFormField = element.closest("mat-form-field");
  return Boolean(
    matFormField?.querySelector("mat-datepicker-toggle, mat-datepicker"),
  );
}

function buildDescriptor(
  element:
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement
    | HTMLElement,
  type: VoiceFormFieldType,
  form: HTMLElement,
): ExtractedFormField {
  const fallbackId = generateFallbackId(form, element);
  const controlId = pickControlId(element, fallbackId);
  const controlName = pickControlName(element) || controlId;
  const label = findLabel(form, element) ?? prettifyLabel(controlId);
  const constraints = collectConstraints(element);
  const groupInfo = extractGroupInfo(element);

  return {
    id: controlId,
    name: controlName,
    label: cleanLabel(label) ?? prettifyLabel(controlId),
    type,
    constraints,
    options: [],
    allowMultiple: false,
    element: element as HTMLElement,
    inputElements: [],
    groupId: groupInfo.id,
    groupLabel: cleanLabel(groupInfo.label),
    groupIndex: groupInfo.index,
  };
}

function buildFileDescriptor(
  input: HTMLInputElement,
  form: HTMLElement,
): ExtractedFormField {
  const host = resolveFileUploadHost(input);
  const descriptor = buildDescriptor(host ?? input, "file", form);
  const hostLabel = readFileUploadLabel(host);

  if (hostLabel) {
    descriptor.label = cleanLabel(hostLabel) ?? descriptor.label;
  }

  descriptor.constraints = {
    ...descriptor.constraints,
    required:
      descriptor.constraints.required || readFileUploadRequired(input, host),
  };
  descriptor.element = host ?? input;
  descriptor.inputElements = [input];
  descriptor.initialValue = input.value;
  descriptor.options = [];
  descriptor.allowMultiple = input.multiple;

  return descriptor;
}

function resolveFileUploadHost(input: HTMLInputElement): HTMLElement | null {
  return input.closest<HTMLElement>(FILE_UPLOAD_HOST_SELECTOR);
}

function readFileUploadLabel(host: HTMLElement | null): string | undefined {
  if (!host) {
    return undefined;
  }

  return (
    host.getAttribute("label-name") ||
    host.getAttribute("labelname") ||
    host.getAttribute("ng-reflect-label-name") ||
    host.getAttribute("aria-label") ||
    host.getAttribute("data-label") ||
    host.getAttribute("title") ||
    host.querySelector<HTMLElement>(".input-label")?.textContent?.trim() ||
    undefined
  );
}

function readFileUploadRequired(
  input: HTMLInputElement,
  host: HTMLElement | null,
): boolean {
  return Boolean(
    input.required ||
      input.getAttribute("aria-required") === "true" ||
      host?.hasAttribute("required") ||
      host?.getAttribute("aria-required") === "true" ||
      host?.getAttribute("ng-reflect-required") === "true" ||
      host?.getAttribute("data-required") === "true" ||
      host?.querySelector(
        ".astrick-text, .asterisk-symbol, [class*='asterisk']",
      ),
  );
}

function collectConstraints(
  element:
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement
    | HTMLElement,
): ConstraintSet {
  const constraints: ConstraintSet = {
    // Prefer native required property, but fall back to aria-required="true" because
    // Angular Material reactive-form inputs remove the native required attribute and
    // rely on aria-required for accessibility instead.
    required:
      ((element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement) &&
        Boolean(element.required)) ||
      element.getAttribute("aria-required") === "true",
  };

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    const minLength = element.minLength;
    const maxLength = element.maxLength;
    if (minLength >= 0) {
      constraints.minLength = minLength;
    }
    if (maxLength >= 0) {
      constraints.maxLength = maxLength;
    }

    if (element instanceof HTMLInputElement) {
      if (element.pattern) {
        constraints.pattern = element.pattern;
      }
      if (element.min !== "") {
        const min = Number(element.min);
        if (!Number.isNaN(min)) {
          constraints.min = min;
        }
      }
      if (element.max !== "") {
        const max = Number(element.max);
        if (!Number.isNaN(max)) {
          constraints.max = max;
        }
      }
      if (element.step !== "" && element.step !== "any") {
        const step = Number(element.step);
        if (!Number.isNaN(step)) {
          constraints.step = step;
        }
      }
    }
  }

  return constraints;
}

function findLabel(
  form: HTMLElement,
  element: HTMLElement,
): string | undefined {
  // PRIORITY 1: Look for dynamic-label components first (custom Angular components)
  // These are typically siblings to mat-form-field containers
  const matFormField = element.closest("mat-form-field");

  if (matFormField) {
    // Check if there's a dynamic-label sibling to the mat-form-field
    let sibling: Element | null = matFormField.previousElementSibling;
    while (sibling instanceof HTMLElement) {
      if (sibling.matches("dynamic-label")) {
        const text = extractLabelText(sibling);
        if (text && !text.match(/^(please select|enter|input)/i)) {
          return text;
        }
      }
      const dynamicLabel = sibling.querySelector("dynamic-label");
      if (dynamicLabel) {
        const text = extractLabelText(dynamicLabel);
        if (text && !text.match(/^(please select|enter|input)/i)) {
          return text;
        }
      }
      sibling = sibling.previousElementSibling;
    }
  }

  // PRIORITY 2: Check aria-labelledby
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const ids = labelledBy.split(/\s+/).filter(Boolean);
    const parts: string[] = [];
    for (const id of ids) {
      const selectorId =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(id)
          : id.replace(/[\"'\\]/g, "");
      const target = form.querySelector<HTMLElement>(`#${selectorId}`);
      if (target) {
        const text = extractLabelText(target);
        if (text) {
          parts.push(text);
        }
      }
    }
    if (parts.length) {
      return parts.join(" ");
    }
  }

  // PRIORITY 3: Check for wrapping labels (but skip Material placeholders)
  const wrappingLabel = element.closest("label");
  if (wrappingLabel) {
    // Skip Material form field placeholder labels
    const isMaterialLabel =
      wrappingLabel.classList.contains("mat-form-field-label") ||
      wrappingLabel.closest(
        ".mat-form-field-label-wrapper, .mat-form-field-label",
      );
    if (!isMaterialLabel) {
      return extractLabelText(wrappingLabel);
    }
  }

  // PRIORITY 4: Walk up the DOM tree looking for labels
  let current: HTMLElement | null = element.parentElement;
  let depth = 0;
  const maxDepth = 10; // Increased to handle deeply nested Material form fields

  // A label that is explicitly tied to a DIFFERENT input (via `for=`) describes
  // that other input, not ours — skip it. Walking up past our own field
  // wrapper otherwise grabs the previous field's label as ours.
  const labelBelongsToOtherInput = (label: Element): boolean => {
    const forValue =
      label instanceof HTMLLabelElement
        ? label.htmlFor
        : (label.getAttribute("for") ?? "");
    return Boolean(forValue && element.id && forValue !== element.id);
  };

  while (current && depth < maxDepth) {
    depth++;

    // First, check if current element has a sibling label (common pattern)
    let sibling: Element | null = current.previousElementSibling;
    while (sibling instanceof HTMLElement) {
      // Check if sibling is a label or contains a label
      const siblingLabel = sibling.matches("label, dynamic-label")
        ? sibling
        : sibling.querySelector("label, dynamic-label");
      if (siblingLabel) {
        // Skip Material form field placeholder labels
        const isInsideMaterialLabelWrapper = siblingLabel.closest(
          ".mat-form-field-label-wrapper, .mat-form-field-label",
        );
        if (
          !isInsideMaterialLabelWrapper &&
          !labelBelongsToOtherInput(siblingLabel)
        ) {
          const text = extractLabelText(siblingLabel);
          if (text && !text.match(/^(please select|enter|input)/i)) {
            return text;
          }
        }
      }
      sibling = sibling.previousElementSibling;
    }

    // Then check within the current container for labels
    const scopedLabel = current.querySelector<HTMLElement>(
      ":scope > label, :scope > dynamic-label",
    );
    if (scopedLabel) {
      // Skip Material form field placeholder labels
      const isInsideMaterialLabelWrapper = scopedLabel.closest(
        ".mat-form-field-label-wrapper, .mat-form-field-label",
      );
      if (
        !isInsideMaterialLabelWrapper &&
        !labelBelongsToOtherInput(scopedLabel)
      ) {
        const text = extractLabelText(scopedLabel);
        if (text && !text.match(/^(please select|enter|input)/i)) {
          return text;
        }
      }
    }

    current = current.parentElement;
  }

  // PRIORITY 5: Check for label[for="id"] association as a last resort
  // This is checked last because Angular Material form fields use internal labels
  // that contain placeholders, not the actual field label
  if (element.id) {
    const directLabel = form.querySelector<HTMLLabelElement>(
      `label[for="${element.id}"]`,
    );
    if (directLabel) {
      // Skip Material form field placeholder labels (identified by class or parent container)
      const isInsideMaterialField = directLabel.closest("mat-form-field");
      const isMaterialLabel =
        directLabel.classList.contains("mat-form-field-label") ||
        directLabel.closest(
          ".mat-form-field-label-wrapper, .mat-form-field-label",
        );
      if (!isInsideMaterialField && !isMaterialLabel) {
        return extractLabelText(directLabel);
      }
    }
  }

  return undefined;
}

function extractLabelText(element: Element): string | undefined {
  // Clone the element to avoid modifying the DOM
  const clone = element.cloneNode(true) as HTMLElement;

  // Remove elements that shouldn't be part of the label text
  const toRemove = clone.querySelectorAll(
    'img, svg, mat-icon, .material-icons, [role="img"]',
  );
  toRemove.forEach((el) => el.remove());

  const text = clone.textContent?.trim();
  return text || undefined;
}

function cleanLabel(label: string | undefined): string | undefined {
  if (!label) return label;
  // Remove trailing asterisk (*) which indicates required field
  return label.replace(/\s*\*\s*$/, "").trim();
}

function prettifyLabel(id: string): string {
  return id
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function slugifyLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function generateFallbackId(form: HTMLElement, element: Element): string {
  // For HTMLFormElement, use form.elements
  if (form instanceof HTMLFormElement) {
    const controls = Array.from(form.elements) as Element[];
    const index = controls.indexOf(element);
    if (index >= 0) {
      return `field_${index}`;
    }
    const fallbackIndex = controls.length + 1;
    return `field_${fallbackIndex}`;
  }

  // For generic HTMLElement, query all form controls
  const controls = Array.from(
    form.querySelectorAll<Element>("input, select, textarea"),
  );
  const index = controls.indexOf(element);
  if (index >= 0) {
    return `field_${index}`;
  }
  const fallbackIndex = controls.length + 1;
  return `field_${fallbackIndex}`;
}

function buildOption(element: HTMLInputElement): {
  value: string;
  label: string;
} {
  const rawValue =
    element.value ||
    element.getAttribute("value") ||
    element.getAttribute("data-value") ||
    element.id ||
    element.name ||
    "";
  const trimmedValue = rawValue.trim();
  const rawLabelSource =
    element.getAttribute("aria-label") ||
    element.closest("label")?.textContent ||
    undefined;
  const fallbackLabel = prettifyLabel(trimmedValue);
  const normalizedLabel = rawLabelSource
    ? rawLabelSource.trim()
    : fallbackLabel.replace(/\s+/g, " ").trim();
  const trimmedLabel = cleanLabel(normalizedLabel) || trimmedValue;

  return {
    value: trimmedValue,
    label: trimmedLabel,
  };
}

function pickControlId(element: HTMLElement, fallbackId: string): string {
  const direct = pickFromAttributes(element, CONTROL_ID_CANDIDATES);
  if (direct) {
    return direct;
  }

  const descendant = element.querySelector<HTMLElement>(
    CONTROL_DESCENDANT_SELECTOR,
  );
  if (descendant) {
    const inherited = pickFromAttributes(descendant, CONTROL_ID_CANDIDATES);
    if (inherited) {
      return inherited;
    }
  }

  return fallbackId;
}

function pickControlName(element: HTMLElement): string | undefined {
  const direct = pickFromAttributes(element, CONTROL_NAME_CANDIDATES);
  if (direct) {
    return direct;
  }

  const descendant = element.querySelector<HTMLElement>(
    CONTROL_DESCENDANT_SELECTOR,
  );
  if (descendant) {
    const inherited = pickFromAttributes(descendant, CONTROL_NAME_CANDIDATES);
    if (inherited) {
      return inherited;
    }
  }

  return undefined;
}

function pickFromAttributes(
  element: HTMLElement,
  attributes: readonly string[],
): string | undefined {
  for (const attribute of attributes) {
    const value = readAttribute(element, attribute);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readAttribute(
  element: HTMLElement,
  attribute: string,
): string | undefined {
  if (attribute === "id") {
    return element.id?.trim() || undefined;
  }
  const value = element.getAttribute(attribute);
  if (value && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function extractGroupInfo(element: Element): {
  id?: string;
  label?: string;
  index?: number;
} {
  // First, try to detect mat-tab (Angular Material tabs)
  // Walk up the DOM tree to find tab content containers
  let current: Element | null = element;
  let tabContentId: string | undefined;
  let tabContentElement: HTMLElement | undefined;

  while (current) {
    const id = current.getAttribute("id");
    const classList = current.classList;

    // Check for mat-tab-content-* ID
    if (id && id.startsWith("mat-tab-content-")) {
      tabContentId = id;
      tabContentElement = current as HTMLElement;
      break;
    }

    // Also check for mat-tab-body class with data-mat-tab-body-content or role="tabpanel"
    if (
      classList.contains("mat-tab-body") ||
      classList.contains("mat-mdc-tab-body") ||
      current.getAttribute("role") === "tabpanel"
    ) {
      // Try to find the ID from aria-labelledby or nearby elements
      const ariaLabelledBy = current.getAttribute("aria-labelledby");
      if (ariaLabelledBy) {
        // Label ID format: mat-tab-label-0-0, we want content: mat-tab-content-0-0
        tabContentId = ariaLabelledBy.replace(
          "mat-tab-label-",
          "mat-tab-content-",
        );
        tabContentElement = current as HTMLElement;
        break;
      }

      // Check if parent or current has ID
      if (id && (id.includes("mat-tab") || id.includes("panel"))) {
        tabContentId = id;
        tabContentElement = current as HTMLElement;
        break;
      }
    }

    current = current.parentElement;
  }

  if (tabContentId && tabContentElement) {
    // Extract tab index from the content ID (e.g., "mat-tab-content-0-1" -> index 1)
    const indexMatch = tabContentId.match(/-(\d+)$/);
    let tabIndex: number | undefined;
    if (indexMatch) {
      tabIndex = Number(indexMatch[1]);
    }

    // Find the corresponding tab label using aria-controls
    // The tab label should have aria-controls pointing to this content ID
    let tabLabel: string | undefined;
    const tabGroup = tabContentElement.closest("mat-tab-group");
    if (tabGroup) {
      const labelElement = tabGroup.querySelector<HTMLElement>(
        `[role="tab"][aria-controls="${tabContentId}"]`,
      );
      if (labelElement) {
        // Get the text from .mat-tab-label-content
        const labelContent = labelElement.querySelector(
          ".mat-tab-label-content",
        );
        tabLabel = labelContent?.textContent?.trim();
      }
    }

    if (tabLabel || tabIndex !== undefined) {
      return {
        id: tabContentId,
        label: tabLabel,
        index: tabIndex,
      };
    }
  }

  // Fall back to data-step attributes
  const container = element.closest<HTMLElement>("[data-step]");
  if (!container) {
    return {};
  }

  const idAttr = container.getAttribute("data-step") ?? undefined;
  const labelAttr =
    container.getAttribute("data-step-label") ??
    container
      .querySelector("[data-step-title]")
      ?.getAttribute("data-step-title") ??
    container.querySelector("h1, h2, h3")?.textContent?.trim() ??
    undefined;
  const indexAttr = container.getAttribute("data-step-index");

  let index: number | undefined;
  if (indexAttr) {
    const parsed = Number(indexAttr);
    if (!Number.isNaN(parsed)) {
      index = parsed;
    }
  } else if (idAttr) {
    const parsed = Number(idAttr);
    if (!Number.isNaN(parsed)) {
      index = parsed;
    }
  }

  return {
    id: idAttr,
    label: labelAttr,
    index,
  };
}

export function isCustomDropdownElement(
  element: HTMLElement | null | undefined,
): element is HTMLElement {
  if (!element || element instanceof HTMLSelectElement) {
    return false;
  }
  if (isDropdownHost(element)) {
    return true;
  }
  if (element.matches("ng-select, .ng-select")) {
    return true;
  }
  const role = element.getAttribute("role");
  if (role === "listbox" || role === "combobox") {
    return true;
  }
  const ariaHasPopup = element.getAttribute("aria-haspopup");
  return ariaHasPopup === "listbox" || ariaHasPopup === "true";
}

export function getDropdownOptionContainers(
  element: HTMLElement,
): ParentNode[] {
  const containers: ParentNode[] = [element];
  const doc = element.ownerDocument;
  if (!doc) {
    return containers;
  }

  const interactiveNodes: HTMLElement[] = [];
  if (element.matches(CUSTOM_DROPDOWN_SELECTOR)) {
    interactiveNodes.push(element);
  }
  element
    .querySelectorAll<HTMLElement>(CUSTOM_DROPDOWN_SELECTOR)
    .forEach((node) => {
      if (!interactiveNodes.includes(node)) {
        interactiveNodes.push(node);
      }
    });

  for (const node of interactiveNodes) {
    if (!containers.includes(node)) {
      containers.push(node);
    }
  }

  // Check for mobile bottom-drawer (app-mobile-view-list) FIRST.
  // It is a sibling of ng-select inside host components like searchable-dropdown.
  // The radio buttons inside it always represent the full option list and are always
  // present in the DOM (CSS-hidden when the drawer is closed).
  const parent = element.parentElement;
  const mobileDrawer =
    parent?.querySelector<HTMLElement>(MOBILE_BOTTOM_DRAWER_SELECTOR) ?? null;
  if (mobileDrawer && !containers.includes(mobileDrawer)) {
    containers.push(mobileDrawer);
  }

  // When the mobile drawer is present with radio-button options we intentionally
  // skip ng-select's body-level panel.  Both contain the same items, but ng-select
  // panels in production builds lack explicit value attributes, so their options
  // fall back to label-as-value and produce duplicate entries with the radio-button
  // options (which carry proper ng-reflect-value attributes).
  const mobileDrawerHasRadioOptions = Boolean(
    mobileDrawer?.querySelector("mat-radio-button"),
  );

  const panelIdSet = new Set<string>();
  if (!mobileDrawerHasRadioOptions) {
    const accumulateIds = (source: HTMLElement) => {
      for (const id of collectPanelIds(source)) {
        panelIdSet.add(id);
      }
    };
    accumulateIds(element);
    interactiveNodes.forEach(accumulateIds);

    for (const id of panelIdSet) {
      const panel = doc.getElementById(id);
      if (panel && !containers.includes(panel)) {
        containers.push(panel);
      }
    }
  }

  return containers;
}

export function readDropdownOptionMetadata(optionElement: HTMLElement): {
  value?: string;
  label?: string;
} {
  // Special handling for Angular Material radio buttons (used in mobile bottom-drawer)
  // mat-radio-button's textContent includes a hidden &nbsp; span which corrupts the label.
  const isMatRadioButton =
    optionElement.tagName.toLowerCase() === "mat-radio-button";

  let label: string | undefined;
  if (isMatRadioButton) {
    const labelContent = optionElement.querySelector<HTMLElement>(
      ".mat-radio-label-content",
    );
    if (labelContent) {
      const clone = labelContent.cloneNode(true) as HTMLElement;
      // Remove hidden display:none spans (Angular Material renders an &nbsp; spacer)
      clone
        .querySelectorAll<HTMLElement>(
          '[style*="display: none"], [style*="display:none"]',
        )
        .forEach((n) => n.remove());
      const text = clone.textContent?.replace(/\s+/g, " ").trim();
      if (text) label = text;
    }
    if (!label) {
      // Fallback: Replace non-breaking spaces and collapse whitespace
      label =
        optionElement.textContent
          ?.replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim() || undefined;
    }
  } else {
    label =
      optionElement.getAttribute("data-label") ||
      optionElement.getAttribute("aria-label") ||
      optionElement.querySelector(".ng-option-label")?.textContent ||
      optionElement.textContent ||
      undefined;
    if (label) {
      label = label.trim();
      if (!label) {
        label = undefined;
      }
    }
  }

  let value =
    optionElement.getAttribute("data-value") ||
    optionElement.getAttribute("ng-reflect-value") ||
    optionElement.getAttribute("value") ||
    undefined;

  if (!value) {
    const labelledBy = optionElement.getAttribute("aria-labelledby");
    if (labelledBy) {
      const doc = optionElement.ownerDocument;
      if (doc) {
        const ref = doc.getElementById(labelledBy);
        const refText = ref?.textContent?.trim();
        if (refText) {
          value = refText;
        }
      }
    }
  }

  if (!value || value === optionElement.getAttribute("id")) {
    if (label) {
      value = label;
    }
  }

  if (value) {
    value = value.trim();
    if (!value) {
      value = undefined;
    }
  }

  return { value, label };
}

export function isDropdownExpanded(element: HTMLElement): boolean {
  if (element.getAttribute("aria-expanded") === "true") {
    return true;
  }
  if (element.classList.contains("ng-select-opened")) {
    return true;
  }
  const expanded = element.querySelector("[aria-expanded='true']");
  if (expanded) {
    return true;
  }
  // Check for mobile bottom-drawer: sibling app-mobile-view-list with .show on its container
  const parent = element.parentElement;
  if (parent) {
    const mobileDrawer = parent.querySelector<HTMLElement>(
      MOBILE_BOTTOM_DRAWER_SELECTOR,
    );
    if (mobileDrawer?.querySelector(".upload-container.show")) {
      return true;
    }
  }
  return false;
}

export function openDropdownElement(element: HTMLElement): boolean {
  if (isDropdownExpanded(element)) {
    return false;
  }
  const toggle =
    element.querySelector<HTMLElement>(DROPDOWN_TOGGLE_SELECTOR) ?? element;
  const comboboxInput = element.querySelector<HTMLInputElement>(
    "input[role='combobox']",
  );
  const events: Array<keyof HTMLElementEventMap> = [
    "mousedown",
    "mouseup",
    "click",
  ];
  for (const type of events) {
    toggle.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true }),
    );
  }

  if (!isDropdownExpanded(element) && comboboxInput) {
    comboboxInput.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowDown",
        code: "ArrowDown",
      }),
    );
  }

  return isDropdownExpanded(element);
}

export async function ensureCustomDropdownOptions(
  field: ExtractedFormField,
  timeoutMs: number = 3000,
): Promise<void> {
  const { element } = field;
  if (!isCustomDropdownElement(element)) {
    return;
  }

  const meta = registerCustomDropdown(field, element);
  scheduleOptionsUpdate(meta, true);
  if (!HAS_WINDOW) {
    return;
  }

  const deadline = Date.now() + Math.max(timeoutMs, 0);
  let dropdownOpened = false;
  const hasExistingOptions = Boolean(field.options && field.options.length);

  if (!hasExistingOptions) {
    await new Promise<void>((resolve) => {
      const attempt = () => {
        scheduleOptionsUpdate(meta, true);
        if (field.options && field.options.length) {
          if (dropdownOpened) {
            closeDropdownElement(element);
          }
          resolve();
          return;
        }

        if (Date.now() >= deadline) {
          if (dropdownOpened) {
            closeDropdownElement(element);
          }
          resolve();
          return;
        }

        if (!dropdownOpened) {
          dropdownOpened = openDropdownElement(element) || dropdownOpened;
        }

        meta.pendingEnsure = setTimeout(attempt, OPTION_ENSURE_POLL_MS);
      };

      attempt();
    });

    if (meta.pendingEnsure !== undefined) {
      clearTimeout(meta.pendingEnsure);
      meta.pendingEnsure = undefined;
    }
  }

  // For virtualized dropdowns, the first pass may only contain visible items.
  // Keep collecting options while scrolling so we can capture the full list.
  const remainingTime = Math.max(0, deadline - Date.now());
  if (remainingTime > 0) {
    await collectAllDropdownOptions(field, remainingTime);
  }
}

export function closeDropdownElement(element: HTMLElement): void {
  // Close mobile bottom-drawer if it is currently showing
  const parent = element.parentElement;
  if (parent) {
    const mobileDrawer = parent.querySelector<HTMLElement>(
      MOBILE_BOTTOM_DRAWER_SELECTOR,
    );
    if (mobileDrawer) {
      const showContainer = mobileDrawer.querySelector<HTMLElement>(
        ".upload-container.show",
      );
      if (showContainer) {
        // Prefer the explicit close/cross button; fall back to the background overlay
        const crossBtn = mobileDrawer.querySelector<HTMLElement>(
          ".dropdown-heading img",
        );
        const bgView =
          mobileDrawer.querySelector<HTMLElement>(".background-view");
        const closeTarget = crossBtn ?? bgView;
        if (closeTarget) {
          closeTarget.dispatchEvent(
            new MouseEvent("click", { bubbles: true, cancelable: true }),
          );
        }
      }
    }
  }

  if (!isDropdownExpanded(element)) {
    return;
  }
  const combo =
    element.querySelector<HTMLElement>("[role='combobox']") ?? element;
  combo.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
      code: "Escape",
    }),
  );
  if (isDropdownExpanded(element)) {
    const toggle =
      element.querySelector<HTMLElement>(DROPDOWN_TOGGLE_SELECTOR) ?? element;
    const events: Array<keyof HTMLElementEventMap> = [
      "mousedown",
      "mouseup",
      "click",
    ];
    for (const type of events) {
      toggle.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true }),
      );
    }
  }
}

function registerCustomDropdown(
  descriptor: ExtractedFormField,
  element: HTMLElement,
): CustomDropdownMeta {
  let meta = customDropdownRegistry.get(element);
  if (meta) {
    meta.descriptor = descriptor;
  } else {
    meta = {
      descriptor,
      element,
      observers: [],
      panelObservers: new Map<string, MutationObserver>(),
    };
    customDropdownRegistry.set(element, meta);

    if (HAS_MUTATION_OBSERVER) {
      const observer = new MutationObserver(() => scheduleOptionsUpdate(meta!));
      observer.observe(element, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      meta.observers.push(observer);
    }
  }

  if (HAS_MUTATION_OBSERVER) {
    ensurePanelObservers(meta);
  }

  descriptor.options = collectCustomDropdownOptions(element);
  return meta;
}

function scheduleOptionsUpdate(
  meta: CustomDropdownMeta,
  immediate: boolean = false,
): void {
  if (meta.pendingUpdate !== undefined) {
    clearTimeout(meta.pendingUpdate);
    meta.pendingUpdate = undefined;
  }

  const execute = () => {
    meta.pendingUpdate = undefined;
    meta.descriptor.options = collectCustomDropdownOptions(meta.element);
    if (HAS_MUTATION_OBSERVER) {
      ensurePanelObservers(meta);
    }
  };

  if (immediate) {
    execute();
  } else {
    meta.pendingUpdate = setTimeout(execute, OPTION_UPDATE_DEBOUNCE_MS);
  }
}

function ensurePanelObservers(meta: CustomDropdownMeta): void {
  if (!HAS_MUTATION_OBSERVER) {
    return;
  }
  const doc = meta.element.ownerDocument;
  if (!doc) {
    return;
  }

  const panelIds = collectPanelIds(meta.element);
  const seen = new Set(panelIds);

  for (const [id, observer] of meta.panelObservers.entries()) {
    if (!seen.has(id) || !doc.getElementById(id)) {
      observer.disconnect();
      meta.panelObservers.delete(id);
    }
  }

  const attachToPanel = (id: string): boolean => {
    const panel = doc.getElementById(id);
    if (!panel) {
      return false;
    }
    const observer = new MutationObserver(() => scheduleOptionsUpdate(meta));
    observer.observe(panel, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    meta.panelObservers.set(id, observer);
    return true;
  };

  let pendingAttachment = false;
  for (const id of panelIds) {
    if (!meta.panelObservers.has(id)) {
      const attached = attachToPanel(id);
      if (!attached) {
        pendingAttachment = true;
      }
    }
  }

  if (!pendingAttachment) {
    if (meta.bodyObserver) {
      meta.bodyObserver.disconnect();
      meta.bodyObserver = undefined;
    }
    return;
  }

  if (meta.bodyObserver) {
    return;
  }

  const body = doc.body;
  if (!body) {
    return;
  }

  meta.bodyObserver = new MutationObserver(() => {
    ensurePanelObservers(meta);
    scheduleOptionsUpdate(meta);
  });
  meta.bodyObserver.observe(body, { childList: true, subtree: true });
}

function collectCustomDropdownOptions(
  element: HTMLElement,
): Array<{ value: string; label: string }> {
  const containers = getDropdownOptionContainers(element);
  const results = new Map<string, { value: string; label: string }>();

  for (const container of containers) {
    const optionElements = container.querySelectorAll<HTMLElement>(
      DROPDOWN_OPTION_SELECTOR,
    );
    optionElements.forEach((optionElement) => {
      const { value, label } = readDropdownOptionMetadata(optionElement);
      const normalizedLabel = label?.trim();
      const normalizedValue = value?.trim() ?? normalizedLabel;
      if (!normalizedLabel || !normalizedValue) {
        return;
      }
      const key = `${normalizedLabel.toLowerCase()}\u0000${normalizedValue.toLowerCase()}`;
      if (!results.has(key)) {
        results.set(key, {
          value: normalizedValue,
          label: normalizedLabel,
        });
      }
    });
  }

  return Array.from(results.values());
}

function mergeVisibleDropdownOptions(
  containers: ParentNode[],
  results: Map<string, { value: string; label: string }>,
): void {
  for (const container of containers) {
    const optionElements = container.querySelectorAll<HTMLElement>(
      DROPDOWN_OPTION_SELECTOR,
    );
    optionElements.forEach((optionElement) => {
      const { value, label } = readDropdownOptionMetadata(optionElement);
      const normalizedLabel = label?.trim();
      const normalizedValue = value?.trim() ?? normalizedLabel;
      if (!normalizedLabel || !normalizedValue) {
        return;
      }
      const key = `${normalizedLabel.toLowerCase()}\u0000${normalizedValue.toLowerCase()}`;
      if (!results.has(key)) {
        results.set(key, {
          value: normalizedValue,
          label: normalizedLabel,
        });
      }
    });
  }
}

function getScrollableContainers(containers: ParentNode[]): HTMLElement[] {
  const scrollTargets: HTMLElement[] = [];
  for (const container of containers) {
    if (!(container instanceof HTMLElement)) {
      continue;
    }
    const candidates = new Set<HTMLElement>([
      container,
      ...Array.from(
        container.querySelectorAll<HTMLElement>(
          ".ng-dropdown-panel-items, .scroll-host, .cdk-virtual-scroll-viewport, [role='listbox'], [role='presentation']",
        ),
      ),
    ]);
    candidates.forEach((candidate) => {
      if (
        candidate.scrollHeight > candidate.clientHeight + 1 &&
        !scrollTargets.includes(candidate)
      ) {
        scrollTargets.push(candidate);
      }
    });
  }
  return scrollTargets;
}

async function collectAllDropdownOptions(
  field: ExtractedFormField,
  timeoutMs: number,
): Promise<void> {
  const { element } = field;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const collected = new Map<string, { value: string; label: string }>();
  const wasExpanded = isDropdownExpanded(element);

  if (!wasExpanded) {
    openDropdownElement(element);
    await new Promise((resolve) => setTimeout(resolve, OPTION_ENSURE_POLL_MS));
  }

  try {
    const collectVisible = () => {
      const containers = getDropdownOptionContainers(element);
      mergeVisibleDropdownOptions(containers, collected);
      return containers;
    };

    let containers = collectVisible();
    if (!collected.size) {
      return;
    }

    const scrollTargets = getScrollableContainers(containers);
    if (!scrollTargets.length) {
      field.options = Array.from(collected.values());
      return;
    }

    // Normalize to top to avoid missing options that are above the selected item.
    scrollTargets.forEach((target) => {
      target.scrollTop = 0;
      target.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await new Promise((resolve) => setTimeout(resolve, OPTION_ENSURE_POLL_MS));
    containers = collectVisible();

    let previousCount = collected.size;
    let stablePasses = 0;

    while (Date.now() < deadline) {
      let moved = false;
      for (const target of scrollTargets) {
        const maxScrollTop = Math.max(
          0,
          target.scrollHeight - target.clientHeight,
        );
        if (maxScrollTop <= 0) {
          continue;
        }
        const step = Math.max(48, Math.floor(target.clientHeight * 0.85));
        const next = Math.min(maxScrollTop, target.scrollTop + step);
        if (next > target.scrollTop + 0.5) {
          target.scrollTop = next;
          target.dispatchEvent(new Event("scroll", { bubbles: true }));
          moved = true;
        }
      }

      await new Promise((resolve) =>
        setTimeout(resolve, OPTION_ENSURE_POLL_MS),
      );
      containers = collectVisible();

      if (collected.size === previousCount) {
        stablePasses += 1;
      } else {
        stablePasses = 0;
        previousCount = collected.size;
      }

      if (!moved || stablePasses >= 2) {
        break;
      }
    }

    field.options = Array.from(collected.values());
  } finally {
    if (!wasExpanded) {
      closeDropdownElement(element);
    }
  }
}

function collectPanelIds(element: HTMLElement): string[] {
  const ids = new Set<string>();
  const collectFrom = (node: Element | null) => {
    if (!node) {
      return;
    }
    const candidates = [
      node.getAttribute("aria-owns"),
      node.getAttribute("aria-controls"),
      node.getAttribute("data-target"),
    ];
    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      candidate
        .split(/\s+/)
        .map((id) => id.trim())
        .filter(Boolean)
        .forEach((id) => ids.add(id));
    }
  };

  collectFrom(element);
  element
    .querySelectorAll<HTMLElement>(
      "[aria-owns], [aria-controls], [data-target]",
    )
    .forEach((node) => collectFrom(node));

  return Array.from(ids);
}
