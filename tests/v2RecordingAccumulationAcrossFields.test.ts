import { beforeEach, describe, expect, it, vi } from "vitest";

// A new BrowserNoiseSuppressor (and its recording buffers) is created and
// torn down once per form field within a voice-form session (see
// V2VoiceFormService.startContinuousListening/stopContinuousListening in
// voiceFormService.ts), not once per session. Before this fix,
// SarvamSpeechService.getAudioRecordings() only ever reflected the most
// recently completed field's audio, silently discarding every earlier
// field's recording. This test drives startListening()/stopListening()
// twice, simulating two fields, and asserts the accumulated recording
// spans both — not just the second.

const sttSocket = {
  on: vi.fn(),
  connect: vi.fn(),
  transcribe: vi.fn(),
  flush: vi.fn(),
  close: vi.fn(),
};

const speechToTextStreamingConnect = vi.fn(async () => sttSocket);

vi.mock("sarvamai", () => {
  return {
    SarvamAIClient: vi.fn().mockImplementation(() => ({
      speechToTextStreaming: { connect: speechToTextStreamingConnect },
    })),
  };
});

const { SarvamSpeechService } = await import("../src/v2/sarvamSpeech");

async function readWavHeader(blob: Blob) {
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
  const view = new DataView(buffer);
  return { dataSize: view.getUint32(40, true) };
}

function fakeInputEvent(length: number, value: number) {
  const data = new Float32Array(length).fill(value);
  return { inputBuffer: { getChannelData: () => data } };
}

async function answerOneField(service: InstanceType<typeof SarvamSpeechService>) {
  await service.startListening({
    onSpeechStart: vi.fn(),
    onSpeechEnd: vi.fn(),
    onFinal: vi.fn(),
  } as any);
  const noiseSuppressor = (service as any).noiseSuppressor;
  const processor = noiseSuppressor.processor;
  processor.onaudioprocess(fakeInputEvent(2048, 0.5));
  await service.stopListening();
}

describe("SarvamSpeechService — recordAudio accumulates across fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the first field's recording instead of discarding it when a second field is answered", async () => {
    const service = new SarvamSpeechService({
      apiKey: "test-key",
      noiseSuppression: { recordAudio: true, mode: "legacy-rms" },
    });

    await answerOneField(service); // field 1: 2048 raw-tap samples via the ScriptProcessor path
    await answerOneField(service); // field 2: another 2048 samples

    const recordings = service.getAudioRecordings();
    expect(recordings).not.toBeNull();

    const processedHeader = await readWavHeader(recordings!.processed);
    // Each field emits 2048 processed samples; both must be present.
    expect(processedHeader.dataSize).toBe(2 * 2048 * 2);
  });

  it("resetAudioRecordingSession() clears prior fields so a new session starts fresh", async () => {
    const service = new SarvamSpeechService({
      apiKey: "test-key",
      noiseSuppression: { recordAudio: true, mode: "legacy-rms" },
    });

    await answerOneField(service);
    expect(service.getAudioRecordings()).not.toBeNull();

    service.resetAudioRecordingSession();
    expect(service.getAudioRecordings()).toBeNull();

    await answerOneField(service);
    const recordings = service.getAudioRecordings();
    const processedHeader = await readWavHeader(recordings!.processed);
    expect(processedHeader.dataSize).toBe(2048 * 2);
  });
});
