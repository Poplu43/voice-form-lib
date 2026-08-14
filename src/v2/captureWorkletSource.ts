// A minimal first-party AudioWorkletProcessor used only to tap the final,
// already-denoised/gated signal off the audio graph and hand it to the main
// thread. It's authored as a plain string and loaded via a Blob URL rather
// than a separate shipped file — this is pure, dependency-free code we wrote
// ourselves, so there's no CDN/asset-hosting question for it at all, and it
// fully retires the deprecated ScriptProcessorNode.

export const CAPTURE_PROCESSOR_NAME = "vff-capture-processor";

const CAPTURE_PROCESSOR_SOURCE = `
class VffCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      const channel = input[0];
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(CAPTURE_PROCESSOR_NAME)}, VffCaptureProcessor);
`;

export function createCaptureWorkletBlobUrl(): string {
  const blob = new Blob([CAPTURE_PROCESSOR_SOURCE], {
    type: "application/javascript",
  });
  return URL.createObjectURL(blob);
}
