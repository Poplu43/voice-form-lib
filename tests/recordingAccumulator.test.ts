import { describe, expect, it } from "vitest";
import { SessionRecordingAccumulator } from "../src/v2/recordingAccumulator";

async function readWavHeader(blob: Blob) {
  // jsdom's Blob doesn't implement arrayBuffer(), and Node's Response can't
  // read jsdom's Blob internals either — FileReader is the one API jsdom
  // implements natively against its own Blob.
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
  const view = new DataView(buffer);
  return {
    riff: String.fromCharCode(
      view.getUint8(0),
      view.getUint8(1),
      view.getUint8(2),
      view.getUint8(3),
    ),
    sampleRate: view.getUint32(24, true),
    dataSize: view.getUint32(40, true),
  };
}

function fakeNoiseSuppressor(
  data: {
    raw: number[];
    processed: number[];
    rawSampleRate: number;
    processedSampleRate: number;
  } | null,
) {
  return {
    getRawSampleArrays: () =>
      data && {
        raw: Float32Array.from(data.raw),
        processed: Float32Array.from(data.processed),
        rawSampleRate: data.rawSampleRate,
        processedSampleRate: data.processedSampleRate,
      },
  };
}

describe("SessionRecordingAccumulator", () => {
  it("returns null when nothing was ever absorbed", () => {
    const acc = new SessionRecordingAccumulator();
    expect(acc.getRecordings()).toBeNull();
  });

  it("absorbing a source with no data is a no-op", () => {
    const acc = new SessionRecordingAccumulator();
    acc.absorb(fakeNoiseSuppressor(null));
    expect(acc.getRecordings()).toBeNull();
  });

  it("accumulates across multiple absorb() calls instead of overwriting", async () => {
    const acc = new SessionRecordingAccumulator();
    acc.absorb(
      fakeNoiseSuppressor({
        raw: new Array(1000).fill(0.1),
        processed: new Array(500).fill(0.2),
        rawSampleRate: 48000,
        processedSampleRate: 16000,
      }),
    );
    acc.absorb(
      fakeNoiseSuppressor({
        raw: new Array(2000).fill(0.3),
        processed: new Array(800).fill(0.4),
        rawSampleRate: 48000,
        processedSampleRate: 16000,
      }),
    );

    const recordings = acc.getRecordings();
    expect(recordings).not.toBeNull();

    const rawHeader = await readWavHeader(recordings!.raw);
    expect(rawHeader.riff).toBe("RIFF");
    expect(rawHeader.dataSize).toBe((1000 + 2000) * 2);
    expect(rawHeader.sampleRate).toBe(48000);

    const processedHeader = await readWavHeader(recordings!.processed);
    expect(processedHeader.dataSize).toBe((500 + 800) * 2);
    expect(processedHeader.sampleRate).toBe(16000);
  });

  it("does not throw on realistically large multi-second recordings across several turns", async () => {
    // Regression test: an earlier implementation accumulated via
    // `arr.push(...bigFloat32Array)`, which throws "Maximum call stack size
    // exceeded" once a single turn's chunk gets into the tens of thousands
    // of samples — a few seconds of real 48kHz audio, easily reached across
    // a multi-field voice-form conversation. Each turn here is ~4s at 48kHz.
    const acc = new SessionRecordingAccumulator();
    const samplesPerTurn = 192_000;
    for (let turn = 0; turn < 3; turn++) {
      expect(() =>
        acc.absorb(
          fakeNoiseSuppressor({
            raw: new Array(samplesPerTurn).fill(0.1),
            processed: new Array(samplesPerTurn / 3).fill(0.1),
            rawSampleRate: 48000,
            processedSampleRate: 16000,
          }),
        ),
      ).not.toThrow();
    }

    const recordings = acc.getRecordings();
    expect(recordings).not.toBeNull();
    const rawHeader = await readWavHeader(recordings!.raw);
    expect(rawHeader.dataSize).toBe(samplesPerTurn * 3 * 2);
  });

  it("reset() clears prior accumulation so a later absorb() starts fresh", async () => {
    const acc = new SessionRecordingAccumulator();
    acc.absorb(
      fakeNoiseSuppressor({
        raw: new Array(5000).fill(0.1),
        processed: new Array(5000).fill(0.1),
        rawSampleRate: 48000,
        processedSampleRate: 16000,
      }),
    );
    expect(acc.getRecordings()).not.toBeNull();

    acc.reset();
    expect(acc.getRecordings()).toBeNull();

    acc.absorb(
      fakeNoiseSuppressor({
        raw: new Array(300).fill(0.2),
        processed: new Array(300).fill(0.2),
        rawSampleRate: 48000,
        processedSampleRate: 16000,
      }),
    );
    const recordings = acc.getRecordings();
    const rawHeader = await readWavHeader(recordings!.raw);
    expect(rawHeader.dataSize).toBe(300 * 2);
  });
});
