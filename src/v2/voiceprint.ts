/**
 * voiceprint.ts — small pure helpers for building an enrolled voiceprint.
 *
 * Kept apart from gatedSpeechProvider.ts so it carries no onnxruntime / mic /
 * network imports and can be reasoned about (and tested) on its own.
 */

/** Cosine similarity of two L2-normalised embeddings (CAM++ returns those). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Keeps the mutually-consistent readings and discards the odd one out.
 *
 * Enrollment averages several recordings into one centroid, and the average is
 * only as good as its worst member: a reading captured over a slammed door, with
 * the speaker turned away from the mic, or (if phrase verification is off) in
 * somebody else's voice sits far from the rest in embedding space and drags the
 * centroid away from the real voice. That shows up later as the genuine speaker
 * repeatedly failing their own threshold — the hardest symptom to diagnose,
 * because nothing about it looks like an enrollment problem.
 *
 * Each reading is scored by its mean similarity to the others, and anything
 * trailing the best-agreeing reading by more than `tolerance` is dropped. Under
 * three readings there is no majority to appeal to, so all are kept.
 */
export function dropInconsistentEmbeddings(
  embeddings: Float32Array[],
  tolerance = 0.15,
): { kept: Float32Array[]; agreement: number[]; dropped: number } {
  const agreement = embeddings.map((a, i) => {
    let sum = 0;
    for (let j = 0; j < embeddings.length; j++) {
      if (i !== j) sum += cosineSimilarity(a, embeddings[j]);
    }
    return embeddings.length > 1 ? sum / (embeddings.length - 1) : 1;
  });

  if (embeddings.length < 3) {
    return { kept: embeddings, agreement, dropped: 0 };
  }

  const best = Math.max(...agreement);
  const kept = embeddings.filter((_, i) => agreement[i] >= best - tolerance);
  // Never return nothing: if the tolerance somehow excludes everything, the
  // caller is better off with a noisy profile than with no profile at all.
  if (!kept.length) return { kept: embeddings, agreement, dropped: 0 };
  return { kept, agreement, dropped: embeddings.length - kept.length };
}
