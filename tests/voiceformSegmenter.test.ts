import { describe, expect, it } from "vitest";
import {
  FRAME,
  SAMPLE_RATE,
  Segmenter,
  type InterimSpeech,
  type VAD,
} from "../src/v2/voiceform";

const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000; // 32ms

/** A VAD stand-in: speech is any frame whose first sample is non-zero. Keeps
 *  these tests free of onnxruntime and the real Silero model. */
function fakeVad(): VAD {
  return {
    async process(frame: Float32Array) {
      return frame[0] === 0 ? 0 : 1;
    },
    reset() {},
  } as unknown as VAD;
}

const speechFrame = () => new Float32Array(FRAME).fill(0.4);
const silenceFrame = () => new Float32Array(FRAME);

describe("Segmenter interim snapshots", () => {
  it("hands out speech while the user is still talking", async () => {
    const interims: InterimSpeech[] = [];
    const seg = new Segmenter(fakeVad(), {
      minSilenceMs: 300,
      interimMs: 100, // ~3 frames
      onInterim: (i) => interims.push(i),
    });

    for (let i = 0; i < 12; i++) {
      // No utterance is emitted yet — this is all mid-speech.
      expect(await seg.push(speechFrame())).toBeNull();
    }

    expect(interims.length).toBeGreaterThanOrEqual(3);
    expect(interims[0].elapsedMs).toBeLessThanOrEqual(200);
    expect(interims[0].index).toBe(1);
    // Snapshots grow, and each is a prefix of the next.
    for (let i = 1; i < interims.length; i++) {
      expect(interims[i].audio.length).toBeGreaterThan(
        interims[i - 1].audio.length,
      );
      expect(interims[i].index).toBe(interims[i - 1].index + 1);
      expect(interims[i].runId).toBe(interims[0].runId);
    }
    // newAudio covers only what arrived since the previous snapshot.
    expect(interims[1].newAudio.length).toBeGreaterThan(0);
    expect(interims[1].newAudio.length).toBeLessThan(
      interims[1].audio.length,
    );
  });

  it("reports sample offsets that stay valid against the finished utterance", async () => {
    const interims: InterimSpeech[] = [];
    const seg = new Segmenter(fakeVad(), {
      minSilenceMs: 300,
      interimMs: 100,
      onInterim: (i) => interims.push(i),
    });

    for (let i = 0; i < 15; i++) await seg.push(speechFrame());

    let utterance = null;
    for (let i = 0; i < 20 && !utterance; i++) {
      utterance = await seg.push(silenceFrame());
    }

    expect(utterance).not.toBeNull();
    const last = interims[interims.length - 1];
    expect(utterance!.runId).toBe(last.runId);
    // Every interim snapshot is a prefix of the utterance, so a cursor taken
    // mid-speech (restCursor) still points at the right sample afterwards.
    expect(utterance!.audio.length).toBeGreaterThanOrEqual(last.audio.length);
    for (let i = 0; i < last.audio.length; i += 97) {
      expect(utterance!.audio[i]).toBe(last.audio[i]);
    }
  });

  it("starts a new run, with a new id, for the next utterance", async () => {
    const runStarts: number[] = [];
    const seg = new Segmenter(fakeVad(), {
      minSilenceMs: 300,
      interimMs: 100,
      onRunStart: (id) => runStarts.push(id),
    });

    const sayOneThing = async () => {
      for (let i = 0; i < 15; i++) await seg.push(speechFrame());
      let utterance = null;
      for (let i = 0; i < 20 && !utterance; i++) {
        utterance = await seg.push(silenceFrame());
      }
      return utterance;
    };

    const first = await sayOneThing();
    const second = await sayOneThing();

    expect(runStarts).toHaveLength(2);
    expect(second!.runId).toBe(first!.runId + 1);
  });

  it("emits no snapshots when interimMs is omitted (unchanged old behaviour)", async () => {
    const interims: InterimSpeech[] = [];
    const seg = new Segmenter(fakeVad(), {
      minSilenceMs: 300,
      onInterim: (i) => interims.push(i),
    });

    for (let i = 0; i < 20; i++) await seg.push(speechFrame());
    expect(interims).toHaveLength(0);
  });

  it("emits a one-word answer when minSpeechMs is lowered for it", async () => {
    // "No" is ~300ms. At the library default (380ms) the segmenter discards it
    // silently, so no utterance exists, no speaker check runs, and a transcript
    // for it downstream has nothing to be approved against.
    const shortAnswer = async (seg: Segmenter) => {
      for (let i = 0; i < 9; i++) await seg.push(speechFrame()); // ~290ms
      let utterance = null;
      for (let i = 0; i < 20 && !utterance; i++) {
        utterance = await seg.push(silenceFrame());
      }
      return utterance;
    };

    const strict = new Segmenter(fakeVad(), { minSilenceMs: 300 });
    expect(await shortAnswer(strict)).toBeNull();

    const lenient = new Segmenter(fakeVad(), {
      minSilenceMs: 300,
      minSpeechMs: 200,
    });
    expect(await shortAnswer(lenient)).not.toBeNull();
  });

  it("marks a length-capped utterance as 'still talking', not as an endpoint", async () => {
    // The cap closes the audio chunk; the speaker has not stopped. A caller that
    // treats this as end-of-turn cuts off anyone giving a long answer.
    const seg = new Segmenter(fakeVad(), { minSilenceMs: 300, maxMs: 500 });
    let utterance = null;
    for (let i = 0; i < 40 && !utterance; i++) {
      utterance = await seg.push(speechFrame());
    }
    expect(utterance).not.toBeNull();
    expect(utterance!.reason).toBe("maxLength");
  });

  it("marks an utterance ended by silence as an endpoint", async () => {
    const seg = new Segmenter(fakeVad(), { minSilenceMs: 300 });
    for (let i = 0; i < 15; i++) await seg.push(speechFrame());
    let utterance = null;
    for (let i = 0; i < 20 && !utterance; i++) {
      utterance = await seg.push(silenceFrame());
    }
    expect(utterance!.reason).toBe("endpoint");
  });

  it("can widen the endpoint mid-answer for someone still listing details", async () => {
    const seg = new Segmenter(fakeVad(), { minSilenceMs: 300 });
    for (let i = 0; i < 15; i++) await seg.push(speechFrame());

    seg.setMinSilenceMs(900);

    // The old 300ms endpoint would have fired by now; the widened one holds.
    const oldEndpointFrames = Math.ceil(300 / FRAME_MS);
    for (let i = 0; i < oldEndpointFrames + 1; i++) {
      expect(await seg.push(silenceFrame())).toBeNull();
    }
    // It still ends once the longer silence is reached.
    let utterance = null;
    for (let i = 0; i < 30 && !utterance; i++) {
      utterance = await seg.push(silenceFrame());
    }
    expect(utterance).not.toBeNull();
  });

  it("keeps the endpoint at minSilenceMs of silence", async () => {
    const seg = new Segmenter(fakeVad(), { minSilenceMs: 300 });
    for (let i = 0; i < 15; i++) await seg.push(speechFrame());

    const framesToEndpoint = Math.floor(300 / FRAME_MS);
    for (let i = 0; i < framesToEndpoint - 1; i++) {
      expect(await seg.push(silenceFrame())).toBeNull();
    }
    expect(await seg.push(silenceFrame())).not.toBeNull();
  });
});
