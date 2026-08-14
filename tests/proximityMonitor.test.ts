import { describe, expect, it } from "vitest";
import {
  HopAccumulator,
  StreamingLinearResampler,
} from "../src/v2/proximityMonitor";

function ramp(length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = i;
  return out;
}

describe("StreamingLinearResampler", () => {
  it("passes samples through unchanged when rates are equal", () => {
    const rs = new StreamingLinearResampler(16000, 16000);
    const out = rs.process(Float32Array.from([1, 2, 3, 4, 5]));
    // With step=1 the last sample is held back until its successor arrives.
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    expect(Array.from(rs.process(Float32Array.from([6])))).toEqual([5]);
  });

  it("downsamples 48k→16k to roughly a third of the samples", () => {
    const rs = new StreamingLinearResampler(48000, 16000);
    let produced = 0;
    // Feed 4800 native samples (100 ms @48k); expect ~1600 out (100 ms @16k).
    for (let block = 0; block < 10; block++) {
      produced += rs.process(ramp(480)).length;
    }
    expect(produced).toBeGreaterThan(1500);
    expect(produced).toBeLessThan(1700);
  });

  it("is continuous across block boundaries (interpolates the seam)", () => {
    const whole = new StreamingLinearResampler(3, 2);
    const wholeOut = Array.from(whole.process(Float32Array.from([0, 3, 6, 9, 12])));

    const split = new StreamingLinearResampler(3, 2);
    const a = Array.from(split.process(Float32Array.from([0, 3])));
    const b = Array.from(split.process(Float32Array.from([6, 9, 12])));

    expect([...a, ...b]).toEqual(wholeOut);
  });

  it("rejects non-positive rates", () => {
    expect(() => new StreamingLinearResampler(0, 16000)).toThrow();
    expect(() => new StreamingLinearResampler(48000, -1)).toThrow();
  });
});

describe("HopAccumulator", () => {
  it("emits nothing until a full hop is buffered", () => {
    const acc = new HopAccumulator(4);
    expect(acc.push(Float32Array.from([1, 2]))).toEqual([]);
    const hops = acc.push(Float32Array.from([3, 4, 5]));
    expect(hops.length).toBe(1);
    expect(Array.from(hops[0])).toEqual([1, 2, 3, 4]);
  });

  it("emits multiple hops from one large push and keeps the remainder", () => {
    const acc = new HopAccumulator(2);
    const hops = acc.push(Float32Array.from([1, 2, 3, 4, 5]));
    expect(hops.map((h) => Array.from(h))).toEqual([
      [1, 2],
      [3, 4],
    ]);
    // The leftover 5 stays buffered until a partner arrives.
    expect(acc.push(Float32Array.from([6])).map((h) => Array.from(h))).toEqual([
      [5, 6],
    ]);
  });

  it("rejects a non-integer hop size", () => {
    expect(() => new HopAccumulator(3.5)).toThrow();
    expect(() => new HopAccumulator(0)).toThrow();
  });
});
