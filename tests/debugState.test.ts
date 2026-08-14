import { describe, it, expect, beforeEach } from "vitest";
import {
  storeExtractedFields,
  getLatestExtractedFields,
} from "../src/debugState";
import type { VoiceFormFieldDescriptor } from "../src/types";

const sampleField: VoiceFormFieldDescriptor = {
  id: "f1",
  name: "first_name",
  label: "First Name",
  type: "text",
  constraints: { required: true },
};

describe("debugState", () => {
  beforeEach(() => {
    storeExtractedFields([]);
  });

  it("returns an empty array initially", () => {
    expect(getLatestExtractedFields()).toEqual([]);
  });

  it("stores and retrieves the latest extracted fields", () => {
    storeExtractedFields([sampleField]);
    expect(getLatestExtractedFields()).toEqual([sampleField]);
  });

  it("overwrites previously stored fields on subsequent calls", () => {
    storeExtractedFields([sampleField]);
    storeExtractedFields([]);
    expect(getLatestExtractedFields()).toEqual([]);
  });

  it("returns the same reference that was stored (no defensive copy)", () => {
    const fields: VoiceFormFieldDescriptor[] = [sampleField];
    storeExtractedFields(fields);
    expect(getLatestExtractedFields()).toBe(fields);
  });
});
