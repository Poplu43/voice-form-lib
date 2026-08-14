import type { AudioRecordingPair } from "./noiseSuppression";
import { encodeWavPcm16, float32ToInt16 } from "./noiseSuppressionDsp";

/**
 * Accumulates raw-vs-processed recording samples across multiple
 * BrowserNoiseSuppressor start()/stop() cycles within one voice-form
 * session. A new mic/noise-suppression pipeline is created per form field
 * (not once per session — see V2VoiceFormService.startContinuousListening),
 * so without this, `recordAudio` would only ever reflect the most recently
 * answered field instead of the whole session.
 *
 * Stores each turn's samples as a whole Float32Array chunk (concatenated via
 * TypedArray.set() only when a recording is actually requested), rather than
 * pushing individual samples into a plain array — `arr.push(...bigArray)`
 * throws "Maximum call stack size exceeded" once a chunk gets into the tens
 * of thousands of samples (a few seconds of real audio), since spreading
 * into a function call passes every element as a separate argument.
 */
export class SessionRecordingAccumulator {
  private rawChunks: Float32Array[] = [];
  private processedChunks: Float32Array[] = [];
  private rawSampleRate = 0;
  private processedSampleRate = 0;

  reset(): void {
    this.rawChunks = [];
    this.processedChunks = [];
    this.rawSampleRate = 0;
    this.processedSampleRate = 0;
  }

  absorb(noiseSuppressor: {
    getRawSampleArrays(): {
      raw: Float32Array;
      processed: Float32Array;
      rawSampleRate: number;
      processedSampleRate: number;
    } | null;
  }): void {
    const data = noiseSuppressor.getRawSampleArrays();
    if (!data) return;
    this.rawChunks.push(data.raw);
    this.processedChunks.push(data.processed);
    this.rawSampleRate = data.rawSampleRate;
    this.processedSampleRate = data.processedSampleRate;
  }

  getRecordings(): AudioRecordingPair | null {
    if (this.rawChunks.length === 0 && this.processedChunks.length === 0) {
      return null;
    }
    const raw = concatFloat32(this.rawChunks);
    const processed = concatFloat32(this.processedChunks);
    return {
      raw: new Blob(
        [encodeWavPcm16(float32ToInt16(raw), this.rawSampleRate)],
        { type: "audio/wav" },
      ),
      processed: new Blob(
        [encodeWavPcm16(float32ToInt16(processed), this.processedSampleRate)],
        { type: "audio/wav" },
      ),
    };
  }
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
