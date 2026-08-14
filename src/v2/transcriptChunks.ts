/**
 * transcriptChunks.ts — joining incremental STT results into one answer.
 *
 * Both low-latency STT paths (the gated provider's sliced REST calls, and the
 * Sarvam realtime socket flushed mid-utterance) produce several transcripts per
 * turn, each covering only the audio since the last one. Two things go wrong if
 * you just concatenate them:
 *
 *   1. ASRs repeat a word or two of context at the start of a new window, so
 *      "मेरा नाम" + "नाम अभिनव" must become "मेरा नाम अभिनव", not
 *      "मेरा नाम नाम अभिनव".
 *   2. The form service treats a transcript that is a strict prefix-extension of
 *      the previous one as "same answer, more words", and anything else as a new
 *      segment — so each emission has to carry the whole turn, not just the
 *      newest slice.
 *
 * `appendWithOverlap` handles (1); emitting its cumulative result handles (2).
 */

const normalizeWord = (w: string): string =>
  w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

const wordsOf = (s: string): string[] =>
  s.trim().split(/\s+/).map(normalizeWord).filter(Boolean);

/**
 * True when `incoming` looks like a rewritten version of `base` rather than the
 * next piece after it.
 *
 * The two incremental sources differ: a realtime socket sends the whole turn
 * every time and revises words as it hears more ("income is too" becomes
 * "income is 2 lakh"), while sliced REST sends disjoint pieces. A long shared
 * prefix is what separates them — a revision must REPLACE the text it revises,
 * where a slice must be appended.
 */
export function isRevisionOf(base: string, incoming: string): boolean {
  const baseWords = wordsOf(base);
  const incomingWords = wordsOf(incoming);
  if (!baseWords.length || !incomingWords.length) return false;

  let shared = 0;
  while (
    shared < baseWords.length &&
    shared < incomingWords.length &&
    baseWords[shared] === incomingWords[shared]
  ) {
    shared++;
  }
  return shared >= Math.min(3, Math.ceil(baseWords.length / 2));
}

/**
 * Appends `incoming` to `current`, dropping any word-level overlap at the seam.
 * Comparison ignores case and punctuation, so "naam." and "naam" count as the
 * same word. Returns `current` unchanged when `incoming` adds nothing.
 */
export function appendWithOverlap(current: string, incoming: string): string {
  const add = incoming.trim();
  if (!add) return current.trim();
  const base = current.trim();
  if (!base) return add;

  const baseWords = base.split(/\s+/);
  const addWords = add.split(/\s+/);
  const maxOverlap = Math.min(baseWords.length, addWords.length);
  for (let size = maxOverlap; size >= 1; size--) {
    const tail = baseWords.slice(-size).map(normalizeWord).join(" ");
    const head = addWords.slice(0, size).map(normalizeWord).join(" ");
    if (tail && tail === head) {
      const rest = addWords.slice(size);
      return rest.length ? `${base} ${rest.join(" ")}` : base;
    }
  }
  return `${base} ${add}`;
}
