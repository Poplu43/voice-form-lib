export function formatTextForTts(text: string): string {
  return formatSlashLists(text).replace(/\s*-\s*/g, " - ");
}

const SLASH_CHAIN_PATTERN =
  /[\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)*\.?(?:\s*\/\s*[\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)*\.?)+/gu;

const NUMBER_WORDS = new Set([
  "zero",
  "oh",
  "one",
  "first",
  "two",
  "second",
  "three",
  "third",
  "four",
  "fourth",
  "five",
  "fifth",
  "six",
  "sixth",
  "seven",
  "seventh",
  "eight",
  "eighth",
  "nine",
  "ninth",
  "ten",
  "tenth",
  "eleven",
  "eleventh",
  "twelve",
  "twelfth",
  "thirteen",
  "thirteenth",
  "fourteen",
  "fourteenth",
  "fifteen",
  "fifteenth",
  "sixteen",
  "sixteenth",
  "seventeen",
  "seventeenth",
  "eighteen",
  "eighteenth",
  "nineteen",
  "nineteenth",
  "twenty",
  "twentieth",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "lakh",
  "crore",
]);

function formatSlashLists(text: string): string {
  return text.replace(SLASH_CHAIN_PATTERN, (match) => {
    const parts = match.split(/\s*\/\s*/).filter(Boolean);
    if (parts.length < 2 || parts.every(isNumericLikePart)) {
      return match;
    }
    return joinChoiceParts(parts);
  });
}

function isNumericLikePart(part: string): boolean {
  const normalized = part
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .trim();
  if (/^\d+$/.test(normalized)) return true;
  return normalized
    .split(/[-\s]+/)
    .filter(Boolean)
    .every((token) => NUMBER_WORDS.has(token));
}

function joinChoiceParts(parts: string[]): string {
  if (parts.length === 2) {
    return `${parts[0]} or ${parts[1]}`;
  }
  return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}
