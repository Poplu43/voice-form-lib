# Third-Party Notices

The MIT licence in `LICENSE` covers the original source in this repository.
The following bundled artifacts are **not** covered by it and carry their own terms.

## Bundled model weights — `demo-myscheme/models/`

| File | Project | Licence |
|---|---|---|
| `silero_vad.onnx` | [snakers4/silero-vad](https://github.com/snakers4/silero-vad) | MIT |
| `gtcrn_simple.onnx` | [Xiaobin-Rong/gtcrn](https://github.com/Xiaobin-Rong/gtcrn) | Apache-2.0 |
| `campplus.onnx` | [modelscope/3D-Speaker](https://github.com/modelscope/3D-Speaker) | Apache-2.0 |

The two Apache-2.0 models require that the licence text and any NOTICE file be
carried with redistribution. If this repository is ever made public or the
models are shipped in a build, include upstream's `LICENSE`/`NOTICE` alongside
them.

## Vendored fixture — `nsp.html`

An offline copy of a National Scholarship Portal page, retained only as a DOM
fixture for `scripts/debug-extract.*`. It is **not** original work, is not
licensed for redistribution, and reproduces third-party branding.

> **Before making this repository public**, remove `nsp.html`. A verbatim copy of
> a live government portal is trivially repurposed as a phishing page, and
> republishing its branding is not covered by any licence granted here.

## Personal data — `demo-myscheme/voice_profile.json`

A 192-dimension speaker embedding enrolled from a real voice. This is biometric
data of an identifiable person, not licensed content.

> **Before making this repository public**, remove it and replace it with
> `voice_profile.example.json`, which is a synthetic vector matching no one.

`.gitignore` carries commented-out rules for both files, ready to re-enable.

## Runtime dependencies

npm dependencies are not vendored here; their licences resolve through
`package.json` / `yarn.lock`. Note that `microsoft-cognitiveservices-speech-sdk`
(v1 legacy path) and the Sarvam and AWS Bedrock SDKs are clients for commercial
services governed by their own terms of use.
