# Sarvam Integration - Remaining Steps

The Sarvam speech service files have been created. Here are the remaining integration steps:

## ✅ Completed

1. Created `sarvamSpeech.ts` with STT and TTS WebSocket clients
2. Updated `types.ts` with `SarvamSpeechConfig` and added "sarvam" to `SpeechProvider`
3. Updated `index.ts` exports to include Sarvam types
4. Created `SARVAM_INTEGRATION.md` with proxy setup guide

## ⚠️ Important: API Key Header Issue

Sarvam requires `Api-Subscription-Key` header on WebSocket connections, which browsers cannot set directly. You **must** use a proxy server. See `SARVAM_INTEGRATION.md` for setup instructions.

## 🔄 TODO: VoiceFormService.ts Updates

Add these imports at the top:

```typescript
import {
  SarvamSpeechService,
  SarvamSTTClient,
  SarvamSTTMessage,
} from "./sarvamSpeech";
```

In the constructor, add Sarvam provider detection (after Bhashini check):

```typescript
else if (options.sarvamSpeech) {
  this.speechProvider = "sarvam";
  this.sarvamSpeechService = new SarvamSpeechService(options.sarvamSpeech);
  console.log("[VoiceForm] Using Sarvam speech provider");
}
```

Add private fields:

```typescript
// Sarvam-specific fields
private sarvamSpeechService: SarvamSpeechService | null = null;
private sarvamSTTClient: SarvamSTTClient | null = null;
private sarvamMediaStream: MediaStream | null = null;
private sarvamAudioContext: AudioContext | null = null;
private sarvamScriptProcessor: ScriptProcessorNode | null = null;
private sarvamSendInterval: ReturnType<typeof setInterval> | null = null;
```

Add Sarvam STT recognizer method (similar to `ensureBhashiniRecognizer`):

```typescript
private async ensureSarvamRecognizer(): Promise<SarvamSTTClient> {
  if (this.sarvamSTTClient && this.sarvamSpeechService?.sttConnected) {
    return this.sarvamSTTClient;
  }

  if (!this.sarvamSpeechService) {
    throw new Error("Sarvam speech service not initialized");
  }

  this.sarvamSTTClient = await this.sarvamSpeechService.createSTTClient(
    (message: SarvamSTTMessage) => {
      this.handleSarvamResponse(message);
    }
  );

  // Start audio capture similar to Bhashini
  await this.startSarvamAudioCapture();

  return this.sarvamSTTClient;
}
```

Add Sarvam response handler:

```typescript
private handleSarvamResponse(message: SarvamSTTMessage): void {
  if (!this.listenContext || this.listenContext.completed) {
    return;
  }

  if (message.type === "data" && message.data?.transcript) {
    const transcript = message.data.transcript;
    console.log(`[VoiceForm] Sarvam transcript: "${transcript}"`);

    // Update buffered text (replace, not append)
    this.listenContext.buffered = transcript;
    this.listenContext.heardSpeech = true;

    // Emit to UI
    const contextCopy = this.listenContext;
    this.emitTranscript({
      text: transcript,
      isFinal: false,
    });

    this.scheduleFinalize(contextCopy);
  }
}
```

Add audio capture methods (similar to Bhashini - copy structure from `startBhashiniAudioCapture`):

```typescript
private async startSarvamAudioCapture(): Promise<void> {
  // Implementation similar to startBhashiniAudioCapture
  // but use sarvamSpeechService.sendAudioToSTT(audioData)
}

private cleanupSarvamResources(): void {
  // Implementation similar to cleanupBhashiniResources
}
```

Add Sarvam TTS method (in `speak` routing):

```typescript
if (this.speechProvider === "sarvam") {
  await this.speakWithSarvam(text, guard);
}
```

Add `speakWithSarvam` method (similar to `speakWithBhashini`):

```typescript
private async speakWithSarvam(text: string, guard: number): Promise<void> {
  if (!this.sarvamSpeechService) {
    console.warn("[VoiceForm] Sarvam TTS not available, skipping speech");
    return;
  }

  const token = ++this.speakToken;
  this.speaking = true;

  // Implementation similar to speakWithBhashini
  // Use sarvamSpeechService.synthesizeSpeech(text)
  // Then playAudio (decode base64 to audio, play via HTML5 Audio element)
}
```

Update `ensureActiveRecognizer` to include Sarvam:

```typescript
async ensureActiveRecognizer() {
  if (this.speechProvider === "sarvam") {
    return this.ensureSarvamRecognizer();
  }
  // ... existing code for bhashini and azure
}
```

Update `stop` method to cleanup Sarvam:

```typescript
else if (this.speechProvider === "sarvam") {
  this.cleanupSarvamResources();
}
```

Update `setLanguage` to support Sarvam:

```typescript
else if (this.speechProvider === "sarvam") {
  this.cleanupSarvamResources();
  if (this.sarvamSpeechService) {
    this.sarvamSpeechService.updateLanguage(language);
  }
  // ... update this.language
}
```

Update `initialize` method to handle Sarvam language:

```typescript
else if (this.speechProvider === "sarvam") {
  if (this.sarvamSpeechService) {
    if (!this.options.sarvamSpeech?.language) {
      this.sarvamSpeechService.updateLanguage(defaultLanguage.code);
    }
    // Map to Sarvam language if configured
    const sarvamLang = this.options.sarvamSpeech?.language;
    if (sarvamLang) {
      const mappedCode: SupportedLanguage =
        sarvamLang === "hi-IN" ? "hi-IN" : "en-US";
      const sarvamLanguage = this.resolveDefaultLanguage(mappedCode);
      this.language = sarvamLanguage;
      console.log(`[VoiceForm] Using Sarvam language: ${sarvamLang}`);
    } else {
      this.language = defaultLanguage;
    }
  }
}
```

## 🔄 TODO: Environment Configuration

Update `environment.ts`:

```typescript
voiceForm: {
  enabled: true,
  formSelector: "#general-info-form-root form",
  autoStart: false,
  defaultLanguage: "en-US",

  // Sarvam Speech configuration
  sarvamSpeech: {
    apiKey: "your-sarvam-api-key",
    proxyUrl: "ws://localhost:3000/proxy/sarvam", // Your proxy server
    language: "hi", // "hi" for Hindi, "en" for English
    // Optional TTS customization
    speaker: "meera",
    pace: 1.0,
    pitch: 1.0,
    loudness: 1.0
  },

  // ... bedrock config
}
```

## 🔄 TODO: voice-assistant.helper.ts Updates

Add Sarvam config type to `NormalizedVoiceFormConfig`:

```typescript
sarvamSpeech?: {
  apiKey: string;
  proxyUrl?: string;
  language?: string;
  speaker?: string;
  pitch?: number;
  pace?: number;
  loudness?: number;
};
```

Add Sarvam validation in `ensureVoiceFormConfig`:

```typescript
// Check for Sarvam configuration
if (raw.sarvamSpeech) {
  const sarvamConfig = raw.sarvamSpeech;
  const hasApiKey = (sarvamConfig.apiKey || "").trim() !== "";

  if (hasApiKey) {
    config.sarvamSpeech = {
      apiKey: sarvamConfig.apiKey!,
      proxyUrl: sarvamConfig.proxyUrl,
      language: sarvamConfig.language,
      speaker: sarvamConfig.speaker,
      pitch: sarvamConfig.pitch,
      pace: sarvamConfig.pace,
      loudness: sarvamConfig.loudness,
    };
    this.logVoiceInfo("Using Sarvam speech provider");
    return config;
  }
}
```

## 🔄 TODO: Build and Test

1. Build the library:

   ```bash
   cd voice-form-filling
   npm run build
   ```

2. Package and install:

   ```bash
   npm pack --pack-destination ../nsp_umang/lib/
   cd ../nsp_umang
   npm install ./lib/myscheme-voice-form-filling-0.1.4.tgz --legacy-peer-deps
   ```

3. Set up proxy server (see `SARVAM_INTEGRATION.md`)

4. Test with Hindi and English

## 📝 Notes

- Sarvam supports more languages than Bhashini (10+ Indian languages)
- Better English pronunciation than Bhashini
- Requires proxy server for browser usage
- TTS quality is generally good across languages
- STT accuracy varies by language (best for Hindi and English)
