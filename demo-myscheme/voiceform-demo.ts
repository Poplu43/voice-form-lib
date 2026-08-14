/// <reference types="vite/client" />
// Minimal harness for the ported voiceform.ts.
// Drop this file and voiceform.html into the library's `demo-myscheme/` folder,
// then run `npm run dev` and open http://localhost:3045/voiceform.html
//
// The `@voice-form` alias -> ../src is already defined in vite.config.ts.
import {
  VoiceForm,
  voiceProfileFromCentroid,
  type TranscriptResult,
} from "@voice-form/v2/voiceform";
import profileJson from "./voice_profile.json";

const $ = (id: string) => document.getElementById(id)!;
const log = (s: string) => {
  const p = document.createElement("div");
  p.textContent = s;
  $("log").prepend(p);
};

let vf: VoiceForm | null = null;
let session: { stop: () => Promise<any> } | null = null;

async function ensureLoaded(): Promise<VoiceForm> {
  if (vf) return vf;
  log("loading models…");
  vf = new VoiceForm({
    sarvamApiKey: import.meta.env.VITE_SARVAM_API_KEY,
    // Self-hosted ONNX under demo-myscheme/models/ (put the 3 uploaded files there).
    models: {
      sileroVad: "/models/silero_vad.onnx",
      campplus: "/models/campplus.onnx",
      gtcrn: "/models/gtcrn_simple.onnx",
    },
    // Same-origin proxy to dodge api.sarvam.ai CORS (see the vite.config snippet).
    sarvamRestUrl: "/api/sarvam-stt",
    matchThreshold: 0.5, // run calibrate() on real hardware to tune this
  });
  await vf.load();
  log("models ready.");
  return vf;
}

$("start").addEventListener("click", async () => {
  const v = await ensureLoaded();
  // Reuse the voiceprint enrolled by the Python tool.
  const profile = voiceProfileFromCentroid(profileJson.centroid, profileJson.phrase);
  log("listening — only the enrolled speaker is transcribed.");
  session = v.listen(profile, {
    onResult: (r: TranscriptResult) =>
      log(`✓ [${r.timestamp}] (${r.similarity.toFixed(2)}) ${r.text}`),
    onRejected: ({ similarity }) =>
      log(`· other speaker (${similarity.toFixed(2)}) — dropped, never billed`),
    onError: (m) => log(`error: ${m}`),
  });
  ($("start") as HTMLButtonElement).disabled = true;
  ($("stop") as HTMLButtonElement).disabled = false;
});

$("stop").addEventListener("click", async () => {
  if (!session) return;
  const s = await session.stop();
  session = null;
  log(`stopped. sent ${s.keptS.toFixed(1)}s of ${s.audioS.toFixed(1)}s · cost ₹${s.costInr.toFixed(4)}`);
  ($("start") as HTMLButtonElement).disabled = false;
  ($("stop") as HTMLButtonElement).disabled = true;
});
