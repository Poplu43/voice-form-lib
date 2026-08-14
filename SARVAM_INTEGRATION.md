# Sarvam AI Integration

## Overview

Sarvam AI provides streaming Speech-to-Text (STT) and Text-to-Speech (TTS) APIs. This integration uses the official **`sarvamai` npm library** for browser-compatible implementation.

### Features

- **11 Languages**: Hindi, Bengali, Tamil, Telugu, Kannada, Malayalam, Marathi, Gujarati, Punjabi, Odia, and English (Indian accent)
- **Low Latency**: Real-time streaming with minimal delay
- **Official SDK**: Uses the `sarvamai` npm package for reliable integration
- **Browser Compatible**: Works directly in browser environments

## Installation

```bash
npm install sarvamai
```

## Configuration Options

```typescript
interface SarvamSpeechConfig {
  apiKey: string; // Required: Your Sarvam API key
  language?: string; // "hi-IN", "en-IN", etc. (BCP-47 format)

  // TTS Customization
  speaker?: string; // Voice name (default: auto-selected per language)
  pitch?: number; // 0.5 to 2.0 (default: 1.0)
  pace?: number; // 0.3 to 3.0 (default: 1.0)
  loudness?: number; // 0.5 to 2.0 (default: 1.0)
}
```

## Language Support

Sarvam supports these languages with BCP-47 codes:

| Code    | Language         |
| ------- | ---------------- |
| `hi-IN` | Hindi            |
| `en-IN` | English (Indian) |
| `bn-IN` | Bengali          |
| `ta-IN` | Tamil            |
| `te-IN` | Telugu           |
| `ml-IN` | Malayalam        |
| `mr-IN` | Marathi          |
| `gu-IN` | Gujarati         |
| `kn-IN` | Kannada          |
| `pa-IN` | Punjabi          |
| `od-IN` | Odia             |

And more (see [Sarvam documentation](https://docs.sarvam.ai) for complete list).

## Default Voice Speakers by Language

| Language          | Default Speaker |
| ----------------- | --------------- |
| Hindi (hi-IN)     | meera           |
| English (en-IN)   | arvind          |
| Bengali (bn-IN)   | anushka         |
| Tamil (ta-IN)     | kanha           |
| Telugu (te-IN)    | priya           |
| Malayalam (ml-IN) | lakshmi         |
| Marathi (mr-IN)   | aarav           |
| Gujarati (gu-IN)  | diya            |
| Kannada (kn-IN)   | ishaan          |
| Punjabi (pa-IN)   | kabir           |

## Usage in Environment

```typescript
voiceForm: {
  enabled: true,
  formSelector: "#general-info-form-root form",
  autoStart: false,
  defaultLanguage: "en-US",

  // Sarvam Speech configuration
  sarvamSpeech: {
    apiKey: "your-sarvam-api-key",
    language: "hi-IN", // Hindi
    // Optional TTS customization
    speaker: "meera",
    pace: 1.0,
    pitch: 1.0,
    loudness: 1.0
  },

  // Bedrock config...
  bedrock: {
    // ...
  }
}
```

## Technical Implementation

### Using the Official Library

This integration uses the `sarvamai` npm package which provides:

- Automatic WebSocket connection management
- Built-in authentication handling
- Type-safe API methods
- Async/await patterns for streaming
- Browser and Node.js compatibility

### STT (Speech-to-Text)

```typescript
import { SarvamAIClient } from "sarvamai";

const client = new SarvamAIClient({
  apiSubscriptionKey: "your-api-key",
});

const connection = await client.speechToTextStreaming.connect({
  model: "saaras:v3",
  mode: "transcribe",
  language_code: "hi-IN",
  sample_rate: 16000,
  input_audio_codec: "pcm_s16le",
  high_vad_sensitivity: true,
});

// Send audio
await connection.transcribe({
  audio: base64AudioData,
  encoding: "audio/pcm",
  sample_rate: 16000,
});

// Listen for results
for await (const message of connection) {
  console.log(message.data.transcript);
}
```

### TTS (Text-to-Speech)

```typescript
const connection = await client.textToSpeechStreaming.connect({
  model: "bulbul:v3",
  send_completion_event: true,
});

await connection.configure({
  target_language_code: "hi-IN",
  speaker: "meera",
  pace: 1.0,
  pitch: 1.0,
  loudness: 1.0,
  output_audio_codec: "mp3",
});

await connection.convert("नमस्ते, मैं सरवम हूं");
await connection.flush();

// Collect audio chunks
for await (const message of connection) {
  if (message.type === "audio") {
    playAudio(message.data.audio); // base64 audio chunk
  }
}
```

## Troubleshooting

### Installation Issues

Ensure the library is installed:

```bash
npm install sarvamai
```

### Connection Failures

1. **Check API Key**: Verify your Sarvam API key is valid
2. **Check Console**: Look for detailed error messages
3. **Network**: Ensure WebSocket connections aren't blocked

### Audio Issues

- **Sample Rate**: Always use 16000 Hz for best quality
- **Format**: STT expects PCM 16-bit mono audio
- **Browser**: Requires HTTPS for microphone access

## Resources

- [sarvamai npm package](https://www.npmjs.com/package/sarvamai)
- [Sarvam STT Streaming API](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/streaming-api)
- [Sarvam TTS Streaming API](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/text-to-speech/streaming-api/web-socket)
- [Sarvam API Reference](https://docs.sarvam.ai/api-reference-docs/introduction)
