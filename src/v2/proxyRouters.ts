import type {
  BedrockProxyConfig,
  BedrockRouter,
  BedrockRoutingRequest,
  BedrockRoutingResponse,
  TranslatedOptionMapping,
  V2SupportedLanguage,
} from "./types";

export class BedrockProxyRouter implements BedrockRouter {
  private readonly endpoint: string;
  private readonly fetchInit: RequestInit;

  constructor(config: BedrockProxyConfig) {
    this.endpoint = config.routerUrl;
    this.fetchInit = config.fetchInit ?? {};
  }

  async routeAnswer(
    input: BedrockRoutingRequest,
  ): Promise<BedrockRoutingResponse> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      ...this.fetchInit,
      headers: {
        "Content-Type": "application/json",
        ...(this.fetchInit.headers ?? {}),
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error(
        `BedrockProxyRouter: ${response.status} ${response.statusText}`,
      );
    }
    return (await response.json()) as BedrockRoutingResponse;
  }
}

export interface BedrockProxyTranslatorTranslatePromptRequest {
  kind: "translate-prompt";
  text: string;
  targetLanguage: V2SupportedLanguage;
}

export interface BedrockProxyTranslatorTranslateOptionsRequest {
  kind: "translate-options";
  options: { value: string; label: string }[];
  targetLanguage: V2SupportedLanguage;
}

export interface BedrockProxyTranslatorOptions {
  endpoint: string;
  fetchInit?: RequestInit;
}

export class BedrockProxyTranslator {
  private readonly endpoint: string;
  private readonly fetchInit: RequestInit;
  private readonly cache = new Map<string, unknown>();

  constructor(opts: BedrockProxyTranslatorOptions) {
    this.endpoint = opts.endpoint;
    this.fetchInit = opts.fetchInit ?? {};
  }

  clearCache(): void {
    this.cache.clear();
  }

  async translatePrompt(
    text: string,
    targetLanguage: V2SupportedLanguage,
  ): Promise<string> {
    if (!text.trim()) return text;
    if (targetLanguage === "en-IN") return text;

    const cacheKey = `prompt|${targetLanguage}|${text}`;
    const cached = this.cache.get(cacheKey);
    if (typeof cached === "string") return cached;

    const body: BedrockProxyTranslatorTranslatePromptRequest = {
      kind: "translate-prompt",
      text,
      targetLanguage,
    };
    const translated = await this.post<{ translated: string }>(body);
    this.cache.set(cacheKey, translated.translated);
    return translated.translated;
  }

  async translateOptions(
    options: { value: string; label: string }[],
    targetLanguage: V2SupportedLanguage,
  ): Promise<TranslatedOptionMapping[]> {
    if (options.length === 0) return [];
    if (targetLanguage === "en-IN") {
      return options.map((opt) => ({
        value: opt.value,
        originalLabel: opt.label,
        translatedLabel: opt.label,
        language: targetLanguage,
      }));
    }

    const cacheKey = `options|${targetLanguage}|${options
      .map((opt) => opt.label)
      .join("")}`;
    const cached = this.cache.get(cacheKey);
    if (Array.isArray(cached)) {
      return cached as TranslatedOptionMapping[];
    }

    const body: BedrockProxyTranslatorTranslateOptionsRequest = {
      kind: "translate-options",
      options,
      targetLanguage,
    };
    const response = await this.post<{
      mappings: TranslatedOptionMapping[];
    }>(body);
    this.cache.set(cacheKey, response.mappings);
    return response.mappings;
  }

  private async post<T>(body: unknown): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      ...this.fetchInit,
      headers: {
        "Content-Type": "application/json",
        ...(this.fetchInit.headers ?? {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `BedrockProxyTranslator: ${response.status} ${response.statusText}`,
      );
    }
    return (await response.json()) as T;
  }
}
