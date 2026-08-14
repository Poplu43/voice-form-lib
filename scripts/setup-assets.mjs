#!/usr/bin/env node
/**
 * One-time setup for local assets that are deliberately NOT committed to git.
 *
 *   node scripts/setup-assets.mjs
 *
 * Two kinds of asset are handled:
 *
 *   1. demo-myscheme/voice_profile.json — a speaker-embedding voiceprint.
 *      Biometric data, so the real one is never committed. This seeds a
 *      synthetic placeholder so the demo compiles; re-enrol in the browser
 *      to get a profile that actually matches your voice.
 *
 *   2. demo-myscheme/models/*.onnx — ~30 MB of third-party model weights,
 *      kept out of git to avoid bloating clones and re-distributing models
 *      under their own upstream licences.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_DIR = resolve(ROOT, "demo-myscheme/models");

/**
 * `sha256` pins the exact build this project was developed against.
 * A mismatch is not automatically fatal — it means upstream republished the
 * file — but you should confirm the new weights behave before trusting them.
 *
 * `url: null` means the maintainers have not pinned a stable public download
 * for that file. Fetch it manually from `source` and drop it in demo-myscheme/models/.
 */
const MODELS = [
  {
    file: "silero_vad.onnx",
    bytes: 2327524,
    sha256: "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
    url: "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
    source: "https://github.com/snakers4/silero-vad (MIT)",
  },
  {
    file: "gtcrn_simple.onnx",
    bytes: 535190,
    sha256: "b4718df6228e7bdf1a8a435cf98f838636eb2fd331acabf86ba87c5192ebcb87",
    url: "https://github.com/Xiaobin-Rong/gtcrn/raw/main/stream/onnx_models/gtcrn_simple.onnx",
    source: "https://github.com/Xiaobin-Rong/gtcrn (Apache-2.0)",
  },
  {
    file: "campplus.onnx",
    bytes: 28281164,
    sha256: "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2",
    url: null, // No stable public URL pinned — see `source`.
    source:
      "CampPlus speaker-verification model, ONNX export. " +
      "Upstream: https://github.com/modelscope/3D-Speaker " +
      "(ModelScope: iic/speech_campplus_sv_zh-cn_16k-common)",
  },
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function checkExisting(m, path) {
  const digest = sha256(readFileSync(path));
  if (digest === m.sha256) {
    console.log(`  ok    ${m.file} (checksum verified)`);
  } else {
    console.log(`  warn  ${m.file} present but checksum differs from the pinned build`);
    console.log(`        expected ${m.sha256}`);
    console.log(`        actual   ${digest}`);
  }
}

async function download(m, path) {
  console.log(`  get   ${m.file} (~${(m.bytes / 1e6).toFixed(1)} MB)`);
  const res = await fetch(m.url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const digest = sha256(buf);

  if (digest !== m.sha256) {
    console.log(`  warn  ${m.file} checksum differs from the pinned build.`);
    console.log(`        expected ${m.sha256}`);
    console.log(`        actual   ${digest}`);
    console.log(`        Upstream likely republished. Verify before trusting: ${m.source}`);
  }

  writeFileSync(path, buf);
  console.log(`  done  ${m.file}`);
}

async function setupModels() {
  console.log("\nONNX models -> demo-myscheme/models/");
  mkdirSync(MODEL_DIR, { recursive: true });

  const manual = [];

  for (const m of MODELS) {
    const path = resolve(MODEL_DIR, m.file);

    if (existsSync(path)) {
      checkExisting(m, path);
      continue;
    }

    if (!m.url) {
      manual.push(m);
      console.log(`  skip  ${m.file} — no pinned public URL, fetch manually`);
      continue;
    }

    try {
      await download(m, path);
    } catch (err) {
      manual.push(m);
      console.log(`  fail  ${m.file}: ${err.message}`);
    }
  }

  return manual;
}

function setupVoiceProfile() {
  console.log("\nVoice profile -> demo-myscheme/");
  const real = resolve(ROOT, "demo-myscheme/voice_profile.json");
  const example = resolve(ROOT, "demo-myscheme/voice_profile.example.json");

  if (existsSync(real)) {
    console.log("  ok    voice_profile.json already present — left untouched");
    return;
  }

  copyFileSync(example, real);
  console.log("  done  seeded voice_profile.json from voice_profile.example.json");
  console.log("        This is a SYNTHETIC placeholder — it matches nobody's voice.");
  console.log("        Re-enrol in the demo UI to build a real profile.");
}

console.log("Setting up local assets (these are intentionally not in git)…");

setupVoiceProfile();
const manual = await setupModels();

if (manual.length) {
  console.log("\n" + "─".repeat(64));
  console.log("Manual step required — download these and place them in");
  console.log(`  ${MODEL_DIR}`);
  for (const m of manual) {
    console.log(`\n  ${m.file}  (${(m.bytes / 1e6).toFixed(1)} MB)`);
    console.log(`    sha256: ${m.sha256}`);
    console.log(`    source: ${m.source}`);
  }
  console.log("─".repeat(64));
  console.log("\nThe speaker-gating demo will not run until these are in place.");
  process.exitCode = 1;
} else {
  console.log("\nAll assets ready. Copy .env.example to .env.local, add your keys, then `yarn dev`.");
}
