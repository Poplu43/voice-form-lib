# Voice Form Filling Library

Voice-first experience that extracts HTML forms, guides users through each question with Azure Speech Services, and uses Amazon Bedrock to intelligently map responses back to the correct form fields. The code is written in TypeScript and ships as an embeddable library for web applications.

## Features

### Core Capabilities

- **Speech Recognition & Synthesis**: Speech-to-text and text-to-speech via Azure Cognitive Services Speech SDK with optimized response times
- **Intelligent Form Extraction**: Automatic extraction of standard HTML form fields, including validation metadata and select/radio/checkbox options, with support for custom dropdown components (ng-select, searchable-dropdown)
- **AI-Powered Response Routing**: Uses Amazon Bedrock (Claude) to intelligently map free-form user answers to the correct fields with phonetic matching and text normalization
- **Multi-Language Support**: Full support for English and Hindi with configurable voice selection
- **Smart Validation**: Constraint-aware field assignment with audible retry prompts if user input violates form rules
- **Multi-Step Navigation**: Automatic tab/section detection and navigation for complex multi-step forms

### Advanced Features

#### Voice Commands

- **Reset Command**: Users can say "reset" or "reset the form" to clear all entered data. System asks for confirmation before resetting
- **Quit/Finish Commands**: Users can say "quit", "finish", or "stop" to exit the voice flow. System asks for confirmation and properly releases microphone access
- **Phonetic Matching**: Handles common homophones and phonetic variations (e.g., "General" vs "Journal", "Sikh" vs "Sick")

#### Smart Field Handling

- **All Options Announced**: For dropdown fields, all available options are read aloud (not just the first 5)
- **Manual Entry Detection**: If a user manually types a value in a field while the assistant is speaking, the field is automatically skipped
- **Multi-Field Extraction**: Users can provide answers to multiple fields in a single response (e.g., "I am Hindu, income is 50000, and I am unmarried")

#### Text Normalization & Accuracy

- **Punctuation Cleanup**: Trailing punctuation is automatically removed from numeric inputs (e.g., "1000." becomes "1000")
- **Special Character Preservation**: Important special characters in addresses are preserved (e.g., "4/23" remains "4/23")
- **70% Similarity Matching**: Dropdown options are matched using intelligent string similarity (70%+ threshold) for better accuracy under noisy speech conditions
- **Input Pause Support**: User natural speaking pauses (3-4 seconds) are handled properly without premature timeout

#### Performance Optimizations

- **Fast Response Time**: Reduced silence detection timeout to 2.5 seconds for 50% faster responses after user stops speaking
- **Instant UI Updates**: Special command confirmations and new questions appear immediately in the UI without delays
- **Efficient Dropdown Handling**: Removed unnecessary readonly checks for dropdown fields, allowing community/religion selections to work properly

#### User Experience Enhancements

- **Clear Status Messages**: Updated user-facing messages for better clarity:
  - "Voice assistant is ready. You can start speaking." (on start)
  - "Voice assistant stopped. You can restart anytime." (on stop)
  - "All fields completed successfully!" (on completion)
  - "Moving to {field}" (when advancing to next field)
- **Transcript Management**: Previous user responses are automatically cleared when the system asks a new question
- **Proper Microphone Cleanup**: Microphone access is explicitly released when user quits or finishes the form

## Project Structure

```text
voice-form-filling/
├─ src/                 # Library source (compiled with `tsc`)
│  ├─ index.ts          # Public initializeVoiceForm() entry point
│  ├─ VoiceFormService.ts  # Main service (3800+ lines) with form flow logic
│  ├─ bedrockRouter.ts  # Bedrock SDK integration with enhanced LLM prompts
│  ├─ formExtractor.ts  # DOM field parsing helpers with custom dropdown support
│  └─ types.ts          # Shared type definitions
├─ tsconfig.json        # Library TypeScript config (emits to dist/)
├─ tsconfig.app.json    # TypeScript config for build tooling
├─ vite.config.ts       # Vite dev/build configuration
└─ package.json
```

## Running This Repo Locally

```bash
yarn install
cp .env.example .env.local
# …fill in your real keys in .env.local, then:
yarn dev            # http://localhost:3045
```

Credentials are the only thing not committed. Everything else — the ONNX model
weights, the enrolled voiceprint, and the `nsp.html` form fixture — is in the
repo, so a fresh clone runs as-is.

### Bundled assets

| Asset | Notes |
|---|---|
| `demo-myscheme/models/silero_vad.onnx` | Voice-activity detection. Upstream: [snakers4/silero-vad](https://github.com/snakers4/silero-vad) (MIT). |
| `demo-myscheme/models/gtcrn_simple.onnx` | Noise suppression. Upstream: [Xiaobin-Rong/gtcrn](https://github.com/Xiaobin-Rong/gtcrn) (Apache-2.0). |
| `demo-myscheme/models/campplus.onnx` | Speaker verification, 28 MB. Upstream: [modelscope/3D-Speaker](https://github.com/modelscope/3D-Speaker). |
| `demo-myscheme/voice_profile.json` | An enrolled 192-dim speaker embedding. Re-enrol in the demo UI to make it match *your* voice; `voice_profile.example.json` is a synthetic stand-in matching nobody. |

`yarn setup` verifies the model checksums and re-downloads any that are missing.
Only the speaker-gating demo needs them — the core voice-form flow runs without.

> **If this repo is ever made public**, drop `voice_profile.json` (biometric data
> of an identifiable person) and `nsp.html` (a verbatim offline copy of a live
> government portal, reusable as a phishing template). `.gitignore` has the rules
> commented out and ready to re-enable.

### Credentials

`.env.example` lists every variable the project reads. Note that all of them are
`VITE_`-prefixed, which means **Vite inlines them into the browser bundle** — any
key you put there is readable by anyone who loads the page. That's acceptable for
local development only. For anything deployed, proxy through a backend instead;
see *Pattern 4: Backend Proxy for Bedrock* below.

## Quick Start

### 1. Install the Library

```bash
npm install @myscheme/voice-form-filling
# or
npm install /path/to/myscheme-voice-form-filling-0.1.2.tgz
```

### 2. Initialize Voice Form

```typescript
import { initializeVoiceForm } from "@myscheme/voice-form-filling";

const controller = await initializeVoiceForm({
  formSelector: "#my-form",
  azureSpeech: {
    subscriptionKey: "YOUR_AZURE_KEY",
    region: "eastus",
  },
  bedrock: {
    modelId: "anthropic.claude-3-haiku-20240307",
    // Option 1: Provide AWS credentials (not recommended for production)
    client: new BedrockRuntimeClient({
      region: "us-east-1",
      credentials: {
        /* ... */
      },
    }),
    // Option 2: Provide a proxy router (recommended for production)
    // router: new ProxyBedrockRouter('https://your-api.com/bedrock')
  },
  uiHooks: {
    onPrompt: (data) => console.log("Question:", data.text),
    onTranscript: (data) => console.log("User said:", data.text),
    onResetRequested: () => {
      // IMPORTANT: Implement your form reset logic here
      document.querySelector("#my-form").reset();
    },
  },
});

// Start the voice flow
await controller.start();
```

### 3. Implement Reset Hook (Important!)

The library delegates form reset to your application. You **must** implement `onResetRequested`:

```typescript
// Component class
class MyComponent {
  onResetVoice() {
    this.myForm.reset();
    // Restore defaults if needed
    this.myForm.patchValue({ state: this.defaultState });
  }
}

// When initializing
uiHooks: {
  onResetRequested: () => this.component.onResetVoice();
}
```

### 4. Handle UI Updates

```typescript
uiHooks: {
  onSpeechSynthesis: (data) => {
    // Show what assistant is saying
    document.getElementById('assistant-text').textContent = data.text;
  },
  onTranscript: (data) => {
    // Show what user is saying
    document.getElementById('user-text').textContent = data.text;
    if (data.isFinal) {
      // Transcript is final, process complete
    }
  },
  onAssignment: (data) => {
    // Highlight filled field
    document.querySelector(`#${data.fieldId}`)?.classList.add('filled');
  }
}
```

## Usage Guide

### Voice Command Reference

| Command                | Description                       | Example Phrases                                            |
| ---------------------- | --------------------------------- | ---------------------------------------------------------- |
| **Answer Fields**      | Provide answers to form questions | "My name is John", "I am 25 years old", "General category" |
| **Multi-Field Answer** | Answer multiple fields at once    | "I am Hindu, income is 50000, unmarried"                   |
| **Reset Form**         | Clear all entered data            | "reset", "reset the form", "start over"                    |
| **Quit Voice Flow**    | Exit voice assistant              | "quit", "stop", "finish", "I want to quit"                 |
| **Confirmation**       | Respond to yes/no questions       | "yes", "yeah", "no", "nope", "continue", "stop"            |

### How Voice Interaction Works

1. **Start the Flow**: Click "Start Voice Input" button
2. **Listen for Questions**: The assistant will ask about each required field
3. **Speak Your Answer**: After hearing the question, speak your response clearly
4. **Silent Pause Detection**: After you stop speaking for 2.5 seconds, the system processes your answer
5. **Automatic Validation**: Your answer is validated against field constraints
6. **Move to Next Field**: Upon successful validation, the assistant moves to the next field
7. **Completion**: After all fields are filled, you can review and edit any field

### Special Behaviors

#### Dropdown Fields

- **All Options Read**: The assistant reads ALL available options for dropdown fields, not just a subset
- **Flexible Matching**: You don't need to say the exact option label; approximate matches work (70%+ similarity)
- **Example**: For Community field with options "GENERAL, OBC, SC, ST, ST-PVGT", you can say "general", "OBC category", or "scheduled caste"

#### Manual Field Editing

- **Skip Voice Input**: If you manually type/select a value while the assistant is asking, that field is automatically skipped
- **Concurrent Editing**: You can fill multiple fields manually while voice flow continues

#### Reset Behavior

- **Voice Confirmation**: When you say "reset", the system asks via voice: "Are you sure you want to reset the entire form?"
- **No Visual Dialog**: Voice reset uses voice confirmation only (no popup dialogs)
- **Client Delegation**: The library doesn't reset your form directly - it calls your `onResetRequested` hook after confirmation
- **Smart Implementation**: You should implement form reset logic in your component and pass it to the library
- **Flow Restart**: After successful reset, the voice flow automatically restarts from the first field/tab
- **UI Updates**: The assistant announces "Form has been reset. All fields have been cleared. Let's start from the beginning."

#### Quit/Finish Behavior

- **Confirmation Required**: When you say "quit" or "finish", the system asks "Are you sure you want to quit?"
- **Microphone Release**: Upon confirmation, the microphone access is explicitly released
- **Resume Capability**: You can restart voice flow anytime by clicking "Start Voice Input" again

### Performance Characteristics

- **Initial Silence Timeout**: 8 seconds (time allowed before first word)
- **Inter-Word Silence Timeout**: 2.5 seconds (time between words before processing)
- **Dropdown Loading**: Up to 4 seconds wait for custom dropdown options to load
- **Response Processing**: Typically < 1 second for Bedrock LLM to route answers

## Prerequisites

- Node.js 18+
- Azure Speech resource with a subscription key and region
- Amazon Bedrock access with an identity that can invoke Claude 3 models (Haiku, Sonnet, or Opus)
- Modern browser with microphone support (Chrome, Edge, Safari, Firefox)

## Basic Usage

```ts
import { initializeVoiceForm, AwsBedrockRouter } from "voice-form-filling";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

const controller = await initializeVoiceForm({
  formSelector: "#checkout-form",
  azureSpeech: {
    subscriptionKey: process.env.AZURE_SPEECH_KEY!,
    region: process.env.AZURE_SPEECH_REGION!,
  },
  bedrock: {
    modelId: "anthropic.claude-3-haiku-20240307",
    router: new AwsBedrockRouter({
      client: new BedrockRuntimeClient({ region: "us-east-1" }),
      modelId: "anthropic.claude-3-haiku-20240307",
    }),
  },
});

await controller.start();
```

Use the optional `uiHooks` callbacks to surface transcripts or status updates, and call `controller.stop()` when the user leaves the flow.

### Implementing Reset Functionality

The library provides voice-based reset command ("reset", "reset the form") with voice confirmation, but **you must implement the actual form reset logic** in your application using the `onResetRequested` hook.

#### Architecture

- **Form Button Reset**: Shows visual dialog, then resets form (your existing implementation)
- **Voice Reset**: Uses voice confirmation, then calls your reset callback (no dialog)

#### Implementation Example

```typescript
// 1. Create separate reset methods in your component
class MyFormComponent {
  // For form button clicks - with visual dialog
  onReset() {
    this.matDialog
      .open(ConfirmationDialogComponent, { data: "Are you sure?" })
      .afterClosed()
      .subscribe((confirmed) => {
        if (confirmed) {
          this.myForm.reset();
          // Additional cleanup...
        }
      });
  }

  // For voice commands - no dialog (voice handles confirmation)
  onResetVoice() {
    this.myForm.reset();
    // Additional cleanup...
    // Restore any default values if needed
  }
}

// 2. Pass the voice reset callback to the library
const controller = await initializeVoiceForm({
  formSelector: "#my-form",
  // ... other config
  uiHooks: {
    onResetRequested: () => {
      // Call your form's reset method
      myFormComponent.onResetVoice();
    },
    onQuit: (payload) => {
      if (payload.confirmed) {
        console.log("User confirmed quit");
        // Navigate away, cleanup, etc.
      } else {
        console.log("User cancelled quit");
      }
    },
  },
});
```

#### Angular Integration Example

```typescript
// voice-assistant.helper.ts
export class VoiceAssistantHelper {
  constructor(
    private zone: NgZone,
    private cdr: ChangeDetectorRef,
    private formSelector: string,
    private autoStart: boolean = false,
    private componentResetCallback?: () => Promise<void> | void,
  ) {}

  private buildUiHooks(): UiHooks {
    return {
      // ... other hooks
      onResetRequested: async () => {
        if (this.componentResetCallback) {
          const result = this.componentResetCallback();
          if (result && typeof result.then === "function") {
            await result;
          }
        }
      },
    };
  }
}

// your-component.ts
export class YourComponent {
  voiceAssistant!: VoiceAssistantHelper;

  ngOnInit() {
    // Pass the reset callback when initializing
    this.voiceAssistant = new VoiceAssistantHelper(
      this.zone,
      this.cdr,
      "#your-form",
      false,
      () => this.onResetVoice(), // Call voice-specific reset (no dialog)
    );
  }

  // For button clicks - with dialog
  onReset() {
    this.matDialog
      .open(ConfirmationDialogComponent)
      .afterClosed()
      .subscribe((confirmed) => {
        if (confirmed) {
          this.performReset();
        }
      });
  }

  // For voice commands - no dialog
  onResetVoice() {
    this.performReset();
  }

  private performReset() {
    this.myForm.reset();
    // Restore default values
    this.myForm.get("stateField")?.setValue(this.defaultState);
    // Clear dependent dropdowns
    this.clearDependentDropdowns();
  }
}
```

#### Reset Flow

**Button Click Reset:**

1. User clicks "Reset" button
2. Visual dialog appears: "Are you sure?"
3. User clicks "Yes" or "No"
4. If Yes → form resets

**Voice Reset:**

1. User says "reset"
2. Voice asks: "Are you sure you want to reset the entire form? Say yes or no"
3. User says "yes" or "no"
4. If Yes → `onResetRequested()` hook called → form resets → voice announces completion → flow restarts
5. If No → voice announces cancellation → continues with current field

#### Best Practices

1. **Separate Methods**: Keep `onReset()` (with dialog) and `onResetVoice()` (no dialog) separate
2. **Extract Common Logic**: Put actual reset logic in a shared private method
3. **Preserve Defaults**: Some fields (like State, Gender) should be restored to defaults after reset
4. **Clear Dependencies**: Clear dependent dropdown lists when parent field is reset
5. **Async Support**: `onResetRequested` supports both sync and async callbacks

### Configuration Options

```typescript
interface VoiceFormInitOptions {
  formSelector: string; // CSS selector for the form element
  azureSpeech: {
    subscriptionKey: string; // Azure Speech Service key
    region: string; // Azure region (e.g., "eastus")
  };
  bedrock: {
    modelId?: string; // Bedrock model ID (default: Claude 3 Haiku)
    router?: BedrockRouter; // Custom router implementation
    client?: BedrockRuntimeClient; // AWS Bedrock client
  };
  language?: "en-US" | "hi-IN"; // Initial language (default: "en-US")
  defaultLanguage?: "en-US" | "hi-IN"; // Fallback language
  uiHooks?: {
    onPrompt?: (payload: { text: string; fieldId?: string }) => void;
    onSpeechSynthesis?: (payload: { text: string }) => void;
    onTranscript?: (payload: { text: string; isFinal?: boolean }) => void;
    onAssignment?: (payload: {
      fieldId: string;
      value: string | string[];
    }) => void;
    onStatus?: (payload: { message: string }) => void;
    onError?: (payload: { error: Error }) => void;
    onFieldsExtracted?: (payload: {
      fields: VoiceFormFieldDescriptor[];
    }) => void;
    onStepChange?: (payload: {
      stepId: string;
      label: string;
      index: number;
      fieldIds: string[];
    }) => void;
    onQuit?: (payload: { confirmed: boolean }) => void;
    onResetRequested?: () => Promise<void> | void;
  };
  debug?: {
    logExtractedFields?: boolean; // Log field extraction details to console
  };
}
```

### UI Hooks Explanation

- **onPrompt**: Fired when assistant asks a question. Display this as the main prompt in your UI
- **onSpeechSynthesis**: Fired when assistant is about to speak (TTS). Shows what the assistant will say
- **onTranscript**: Fired when user speaks (STT). Display real-time transcription with `isFinal: false`, final text with `isFinal: true`
- **onAssignment**: Fired when a field value is successfully set. Use to highlight filled fields
- **onStatus**: Fired for status updates like "Voice assistant started", "Skipped {field}", "Moving to {field}"
- **onError**: Fired when errors occur (e.g., microphone access denied, API failures)
- **onFieldsExtracted**: Fired once after form fields are extracted, useful for debugging
- **onStepChange**: Fired when moving between form steps/tabs
- **onQuit**: Fired when user says "quit" or "finish". Payload indicates if quit was confirmed or cancelled
- **onResetRequested**: **[IMPORTANT]** Fired when user says "reset" and confirms. **You must implement this hook to actually reset your form**. The library handles voice confirmation but delegates the actual reset action to your application

## Common Integration Patterns

### Pattern 1: Simple Vanilla JS Form

```typescript
import { initializeVoiceForm } from "@myscheme/voice-form-filling";

const formElement = document.querySelector("#checkout-form");
let controller;

document.getElementById("start-voice").addEventListener("click", async () => {
  if (!controller) {
    controller = await initializeVoiceForm({
      formSelector: "#checkout-form",
      azureSpeech: {
        /* credentials */
      },
      bedrock: {
        /* credentials */
      },
      uiHooks: {
        onResetRequested: () => {
          formElement.reset();
        },
        onPrompt: (data) => {
          document.getElementById("question").textContent = data.text;
        },
        onTranscript: (data) => {
          document.getElementById("transcript").textContent = data.text;
        },
      },
    });
  }
  await controller.start();
});

document.getElementById("stop-voice").addEventListener("click", () => {
  if (controller) {
    controller.stop();
  }
});
```

### Pattern 2: React Integration

```typescript
import { useEffect, useRef, useState } from 'react';
import { initializeVoiceForm, VoiceFormController } from '@myscheme/voice-form-filling';

function MyForm() {
  const [prompt, setPrompt] = useState('');
  const [transcript, setTranscript] = useState('');
  const [isActive, setIsActive] = useState(false);
  const controllerRef = useRef<VoiceFormController | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    // Initialize on mount
    initializeVoiceForm({
      formSelector: '#my-form',
      azureSpeech: { /* credentials */ },
      bedrock: { /* credentials */ },
      uiHooks: {
        onResetRequested: () => {
          formRef.current?.reset();
        },
        onPrompt: (data) => setPrompt(data.text),
        onTranscript: (data) => setTranscript(data.text),
        onStatus: (data) => console.log(data.message)
      }
    }).then(controller => {
      controllerRef.current = controller;
    });

    // Cleanup on unmount
    return () => {
      if (controllerRef.current) {
        controllerRef.current.stop();
      }
    };
  }, []);

  const toggleVoice = async () => {
    if (!controllerRef.current) return;

    if (isActive) {
      await controllerRef.current.stop();
      setIsActive(false);
    } else {
      await controllerRef.current.start();
      setIsActive(true);
    }
  };

  return (
    <div>
      <button onClick={toggleVoice}>
        {isActive ? 'Stop Voice' : 'Start Voice'}
      </button>
      <div className="voice-ui">
        <p>Assistant: {prompt}</p>
        <p>You: {transcript}</p>
      </div>
      <form ref={formRef} id="my-form">
        {/* form fields */}
      </form>
    </div>
  );
}
```

### Pattern 3: Angular Service with Helper Class

```typescript
// voice-assistant.helper.ts
import { NgZone, ChangeDetectorRef } from "@angular/core";
import {
  VoiceFormController,
  initializeVoiceForm,
} from "@myscheme/voice-form-filling";

export interface VoiceAssistantState {
  isActive: boolean;
  prompt: string;
  transcript: string;
  statusMessage: string;
}

export class VoiceAssistantHelper {
  private controller: VoiceFormController | null = null;
  public state: VoiceAssistantState = {
    isActive: false,
    prompt: "",
    transcript: "",
    statusMessage: "",
  };

  constructor(
    private zone: NgZone,
    private cdr: ChangeDetectorRef,
    private formSelector: string,
    private resetCallback?: () => void,
  ) {}

  async initialize(azureConfig: any, bedrockConfig: any): Promise<void> {
    this.controller = await initializeVoiceForm({
      formSelector: this.formSelector,
      azureSpeech: azureConfig,
      bedrock: bedrockConfig,
      uiHooks: {
        onResetRequested: () => {
          if (this.resetCallback) {
            this.zone.run(() => this.resetCallback!());
          }
        },
        onPrompt: (data) => {
          this.zone.run(() => {
            this.state.prompt = data.text;
            this.cdr.markForCheck();
          });
        },
        onTranscript: (data) => {
          this.zone.run(() => {
            this.state.transcript = data.text;
            this.cdr.markForCheck();
          });
        },
        onStatus: (data) => {
          this.zone.run(() => {
            this.state.statusMessage = data.message;
            this.cdr.markForCheck();
          });
        },
      },
    });
  }

  async start(): Promise<void> {
    if (this.controller) {
      await this.controller.start();
      this.state.isActive = true;
    }
  }

  async stop(): Promise<void> {
    if (this.controller) {
      await this.controller.stop();
      this.state.isActive = false;
    }
  }

  destroy(): void {
    if (this.controller) {
      this.controller.stop();
      this.controller = null;
    }
  }
}

// component.ts
export class MyFormComponent implements OnInit, OnDestroy {
  voiceAssistant!: VoiceAssistantHelper;

  constructor(
    private zone: NgZone,
    private cdr: ChangeDetectorRef,
  ) {}

  async ngOnInit() {
    this.voiceAssistant = new VoiceAssistantHelper(
      this.zone,
      this.cdr,
      "#my-form",
      () => this.onResetVoice(),
    );

    await this.voiceAssistant.initialize(
      { subscriptionKey: "...", region: "..." },
      { modelId: "..." /* ... */ },
    );
  }

  onResetVoice() {
    this.myForm.reset();
    // Additional cleanup
  }

  toggleVoice() {
    if (this.voiceAssistant.state.isActive) {
      this.voiceAssistant.stop();
    } else {
      this.voiceAssistant.start();
    }
  }

  ngOnDestroy() {
    this.voiceAssistant.destroy();
  }
}
```

### Pattern 4: Backend Proxy for Bedrock (Recommended for Production)

```typescript
// Backend: Express.js proxy endpoint
app.post("/api/bedrock-proxy", authenticate, async (req, res) => {
  try {
    const { userInput, pendingFields, completedFields, language } = req.body;

    const bedrockClient = new BedrockRuntimeClient({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const router = new AwsBedrockRouter({
      client: bedrockClient,
      modelId: "anthropic.claude-3-haiku-20240307",
    });

    const response = await router.routeAnswer({
      userInput,
      pendingFields,
      completedFields,
      language,
    });

    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Frontend: Custom proxy router
class ProxyBedrockRouter implements BedrockRouter {
  constructor(private endpoint: string) {}

  async routeAnswer(
    input: BedrockRoutingRequest,
  ): Promise<BedrockRoutingResponse> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error(`Proxy error: ${response.status}`);
    }

    return await response.json();
  }
}

// Use in client
const controller = await initializeVoiceForm({
  formSelector: "#my-form",
  azureSpeech: {
    /* ... */
  },
  bedrock: {
    modelId: "anthropic.claude-3-haiku-20240307",
    router: new ProxyBedrockRouter("/api/bedrock-proxy"),
  },
  uiHooks: {
    /* ... */
  },
});
```

## Troubleshooting

### Common Issues

#### "Microphone not working"

- **Cause**: Browser denied microphone permission or page is not HTTPS
- **Solution**:
  - Check browser permissions (usually icon in address bar)
  - Ensure page is loaded via HTTPS or localhost
  - On mobile devices, page must use HTTPS for microphone access

#### "Voice assistant not clearing dropdown"

- **Cause**: Custom dropdown component not recognized
- **Solution**: The library supports ng-select and most custom dropdowns. Implement proper reset logic in your `onResetVoice()` method to clear dropdown values.

#### "Reset not working via voice"

- **Cause**: `onResetRequested` hook not implemented
- **Solution**: You must implement the `onResetRequested` hook to actually reset your form. See "Implementing Reset Functionality" section above.
  ```typescript
  uiHooks: {
    onResetRequested: () => {
      myForm.reset();
      // Additional cleanup
    };
  }
  ```

#### "Reset shows two dialogs"

- **Cause**: Both form button and voice assistant showing confirmation dialogs
- **Solution**: Create separate methods: `onReset()` with dialog for button, `onResetVoice()` without dialog for voice. Pass `onResetVoice` to the voice assistant.

#### "Changes not appearing after rebuild"

- **Cause**: Angular build cache serving old files
- **Solution**:
  ```bash
  rm -rf .angular/cache node_modules/@myscheme/voice-form-filling
  npm install ../voice-form-filling/myscheme-voice-form-filling-0.1.2.tgz --legacy-peer-deps
  ```

#### "Field marked as disabled but user filled it"

- **Cause**: Field has `readonly` attribute but is not truly disabled
- **Solution**: Library now only checks `disabled` attribute for actual disabled state, not `readonly`

#### "Assistant taking too long to respond"

- **Current Behavior**: 2.5 second silence timeout after user stops speaking
- **Adjustment**: Modify `SILENCE_TIMEOUT_MS` in VoiceFormService.ts if needed

#### "Dropdown values not matching"

- **Cause**: Strict matching failing on noisy speech input
- **Solution**: Library uses 70% similarity matching. Check that dropdown options are loaded (console should show option count)

#### "Special command not recognized"

- **Cause**: LLM confidence below threshold (70%)
- **Solution**: Speak clearly: "I want to reset", "I want to quit", "please reset the form"

### Best Practices

1. **Speak Clearly**: Speak at a normal pace with clear pronunciation
2. **Natural Pauses**: Pause for 3-4 seconds between thoughts is okay
3. **Exact Matches**: For critical fields (like PIN codes), speak slowly and clearly
4. **Multi-Field Answers**: You can provide multiple answers at once: "I am Hindu, income 50000, unmarried"
5. **Manual Override**: Feel free to manually type values - voice flow will skip those fields
6. **Tab Navigation**: Let the voice assistant guide you through tabs/sections automatically
7. **Review Before Submit**: After all fields are complete, review your entries before final submission

## Development

### Building the Library

```bash
# Type check
npm run typecheck

# Build
npm run build

# Package
npm pack
```

Compiled artifacts land in `dist/`, mirroring the structure in `src/`.

### Installing in Angular Project

```bash
# From your Angular project directory
npm install ../voice-form-filling/myscheme-voice-form-filling-0.1.2.tgz --legacy-peer-deps

# Clear Angular cache if changes don't appear
rm -rf .angular/cache
```

### Key Implementation Files

- **VoiceFormService.ts** (4300+ lines): Core service managing voice flow, field extraction, speech recognition/synthesis
  - `buildQuestion()`: Generates questions for each field, reads all dropdown options
  - `collectAnswerForField()`: Manages question → listen → validate → apply cycle
  - `confirmReset()`: Voice confirmation for reset command (mirrors confirmQuit pattern)
  - `confirmQuit()`: Voice confirmation for quit/finish commands
  - `speak()`: TTS with optimized emit order for instant UI updates
  - `listen()`: STT with silence detection and transcript buffering
  - `runFormFlow()`: Main loop handling multi-step form navigation

- **bedrockRouter.ts** (1100+ lines): LLM integration with comprehensive prompt engineering
  - System prompt with special command detection
  - Phonetic matching rules (General/Journal, Sikh/Sick)
  - Text normalization rules (punctuation cleanup, special char preservation)
  - 11 examples covering various input scenarios

- **formExtractor.ts**: DOM parsing for standard HTML and custom dropdown components
  - Support for ng-select, searchable-dropdown, div[role=listbox]
  - Automatic option extraction from dropdown components
  - Tab/section detection for multi-step forms

## Amazon Bedrock Notes

- **Security**: Browsers should not store long-lived AWS secrets. For production, expose a secure backend endpoint that proxies Bedrock requests and pass it into the library as a custom `BedrockRouter` implementation.
- **Model Compatibility**: The included `AwsBedrockRouter` helper formats prompts for Anthropic Claude 3 models (Haiku, Sonnet, Opus). Adapt the prompt builder if you prefer other providers.
- **LLM Capabilities**: The system prompt includes:
  - Special command detection (reset, quit, finish) with confidence scoring
  - Phonetic/homophone handling for common misrecognitions
  - Text normalization rules for addresses, numbers, punctuation
  - 70%+ similarity matching algorithm for dropdown options
  - 11 comprehensive examples covering various user input patterns

## Recent Improvements (v0.1.2)

### Architecture Refactoring (Latest)

- **Reset Delegation**: Completely removed form reset logic from library (~530 lines). Reset is now delegated to client applications via `onResetRequested` hook
- **Hook-Based Design**: Library provides voice confirmation; client provides reset implementation
- **Separation of Concerns**: Library is now framework-agnostic for reset - works with Angular, React, Vue, or vanilla JS
- **Two Reset Paths**: Form button uses visual dialog, voice uses voice confirmation (no duplicate dialogs)

### UI Synchronization

- Fixed special command messages appearing instantly in UI (quit, reset, finish confirmations)
- Previous user transcripts now clear immediately when new questions are asked
- Emit order optimized: speech text → clear transcript → async operations
- Reset confirmation prompt now displays correctly in UI during voice interaction

### Performance Enhancements

- Silence timeout reduced from 5s to 2.5s (50% faster response time)
- Removed unnecessary readonly checks for dropdown fields
- Optimized dropdown option loading with retry mechanisms

### Accuracy Improvements

- All dropdown options now announced (previously only first 5)
- Phonetic matching for common homophones (General/Journal, Sikh/Sick)
- Text normalization: strip punctuation from numbers, preserve special chars in addresses
- 70%+ similarity matching for dropdown options
- Multi-field extraction: handle multiple answers in single response

### Smart Field Management

- Manual entry detection: skip voice input if user manually fills field
- Reset command with voice confirmation and client-side delegation
- Quit/Finish commands with proper microphone cleanup
- Tab/step navigation with automatic synchronization
- Field state tracking across multi-step forms

### User Experience

- Updated status messages for clarity
- Instant UI updates for all interactions
- Proper transcript clearing and prompt management
- Support for natural speaking pauses (3-4 seconds)

## License

This library is provided as-is for integration into web applications.
