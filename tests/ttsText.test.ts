import { describe, expect, it } from "vitest";
import { formatTextForTts } from "../src/v2/ttsText";

describe("formatTextForTts", () => {
  it("adds spaces around every hyphen", () => {
    expect(formatTextForTts("A-B-C")).toBe("A - B - C");
  });

  it("does not keep adding spaces when text is already formatted", () => {
    expect(formatTextForTts("A - B")).toBe("A - B");
  });

  it("joins two slash-separated text options with or", () => {
    expect(formatTextForTts("Yes/No")).toBe("Yes or No");
  });

  it("comma-separates slash-separated text options and uses or before the last one", () => {
    expect(formatTextForTts("Male/Female/Other")).toBe(
      "Male, Female or Other",
    );
    expect(formatTextForTts("A/B/C/D")).toBe("A, B, C or D");
  });

  it("keeps numeric slash chains unchanged", () => {
    expect(formatTextForTts("5/3")).toBe("5/3");
    expect(formatTextForTts("1/2/3")).toBe("1/2/3");
    expect(formatTextForTts("01/02/2026")).toBe("01/02/2026");
  });

  it("keeps number-word slash chains unchanged", () => {
    expect(formatTextForTts("five/three")).toBe("five/three");
  });

  it("treats mixed numeric and text slash chains as choice lists", () => {
    expect(formatTextForTts("1/2/3/NA")).toBe("1, 2, 3 or NA");
    expect(formatTextForTts("5/NA")).toBe("5 or NA");
  });

  it("formats abbreviation and translated-label slash pairs", () => {
    expect(formatTextForTts("Mr./श्री")).toBe("Mr. or श्री");
    expect(formatTextForTts("Mrs./श्रीमती")).toBe("Mrs. or श्रीमती");
    expect(formatTextForTts("Ms./सुश्री")).toBe("Ms. or सुश्री");
  });

  it("formats the Applicant Title prompt naturally", () => {
    expect(
      formatTextForTts(
        "Please tell me your Applicant's Title. Mr./श्री, Mrs./श्रीमती, or Ms./सुश्री.",
      ),
    ).toBe(
      "Please tell me your Applicant's Title. Mr. or श्री, Mrs. or श्रीमती, or Ms. or सुश्री.",
    );
  });

  it("combines slash and hyphen formatting", () => {
    expect(formatTextForTts("Yes/No - Required")).toBe(
      "Yes or No - Required",
    );
  });
});
