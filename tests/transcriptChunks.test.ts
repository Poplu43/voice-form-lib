import { describe, expect, it } from "vitest";
import { appendWithOverlap, isRevisionOf } from "../src/v2/transcriptChunks";

describe("appendWithOverlap", () => {
  it("joins two slices of one sentence", () => {
    expect(appendWithOverlap("मेरा नाम", "अभिनव है")).toBe("मेरा नाम अभिनव है");
  });

  it("drops repeated context words at the seam", () => {
    // ASRs commonly repeat a word of lead-in context on a new window.
    expect(appendWithOverlap("मेरा नाम", "नाम अभिनव है")).toBe(
      "मेरा नाम अभिनव है",
    );
  });

  it("drops a multi-word overlap, preferring the longest match", () => {
    expect(appendWithOverlap("my income is five", "is five lakh rupees")).toBe(
      "my income is five lakh rupees",
    );
  });

  it("ignores case and punctuation when matching the seam", () => {
    expect(appendWithOverlap("pin code is", "Is, 110001")).toBe(
      "pin code is 110001",
    );
  });

  it("returns the base unchanged when the slice adds nothing new", () => {
    expect(appendWithOverlap("hello there", "there")).toBe("hello there");
    expect(appendWithOverlap("hello there", "   ")).toBe("hello there");
  });

  it("handles an empty base", () => {
    expect(appendWithOverlap("", "first words")).toBe("first words");
  });

  it("produces a strict prefix extension, which is what the form service " +
    "reads as 'same answer, more words'", () => {
    const slices = ["mera naam", "naam abhinav", "hai"];
    let text = "";
    const emitted: string[] = [];
    for (const slice of slices) {
      text = appendWithOverlap(text, slice);
      emitted.push(text);
    }
    expect(emitted).toEqual([
      "mera naam",
      "mera naam abhinav",
      "mera naam abhinav hai",
    ]);
    for (let i = 1; i < emitted.length; i++) {
      expect(emitted[i].startsWith(emitted[i - 1])).toBe(true);
      expect(emitted[i].length).toBeGreaterThan(emitted[i - 1].length);
    }
  });
});

describe("isRevisionOf", () => {
  it("recognises a realtime transcript restating and correcting the turn", () => {
    // Observed against api.sarvam.ai: the final rewrote "too" as "2 lakh".
    const partial = "My community is OBC, and my income is too";
    const final = "My community is OBC and my income is 2 lakh.";
    expect(isRevisionOf(partial, final)).toBe(true);
  });

  it("does not mistake the next REST slice for a revision", () => {
    expect(isRevisionOf("मेरा नाम", "अभिनव है")).toBe(false);
    expect(isRevisionOf("my community is OBC", "and my income is two lakh")).toBe(
      false,
    );
  });

  it("treats a repeated-context slice as a slice, not a revision", () => {
    // One overlapping word is a seam, not a restatement.
    expect(isRevisionOf("my income is five", "five lakh rupees")).toBe(false);
  });

  it("needs no shared prefix decision when either side is empty", () => {
    expect(isRevisionOf("", "anything")).toBe(false);
    expect(isRevisionOf("anything", "")).toBe(false);
  });

  it("scales the requirement for very short turns", () => {
    // A two-word answer only has two words to agree on.
    expect(isRevisionOf("OBC please", "OBC please, general")).toBe(true);
  });
});
