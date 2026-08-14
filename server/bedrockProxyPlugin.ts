import type { IncomingMessage, ServerResponse } from "node:http";
import { loadEnv, type Plugin } from "vite";

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { V2BedrockRouter } from "../src/v2/v2BedrockRouter";
import { findBestOptionMatch } from "../src/v1/bedrockRouter";
import type {
  BedrockRoutingRequest,
  BedrockRoutingResponse,
  VoiceFormFieldDescriptor,
} from "../src/v2/types";

const ROUTE_PATH = "/api/bedrock/route";

interface ProxyConfig {
  modelId: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  debug: boolean;
}

/**
 * Vite dev plugin that exposes a server-side proxy for Amazon Bedrock at
 * `POST /api/bedrock/route`.
 *
 * The browser POSTs a {@link BedrockRoutingRequest}; this plugin runs the
 * actual Bedrock call here in Node — where the AWS credentials live — and
 * returns the {@link BedrockRoutingResponse} verbatim.
 *
 * The credentials are picked up from the existing `VITE_AWS_*` env vars that
 * docker-compose / .env.local already define. Reading them here in Node is
 * safe; the browser bundle never references `import.meta.env.VITE_AWS_*`, so
 * Vite has nothing to inline.
 */
export function bedrockProxyPlugin(): Plugin {
  let router: V2BedrockRouter | null = null;
  let initError: string | null = null;
  // Variables loaded from `.env*` files by Vite. Populated in `configResolved`
  // because Vite reads .env via `loadEnv()` and does NOT copy them into
  // `process.env`. Without this, running `yarn dev` against a real
  // `.env.local` would error with "Missing env vars" even though Vite sees
  // them. In docker-compose `process.env` already has them via the
  // `environment:` block, which still works via the fallback in `pick`.
  let envFromFiles: Record<string, string> = {};

  const init = () => {
    if (router || initError) return;
    const config = readConfigFromEnv(envFromFiles);
    if (config instanceof Error) {
      initError = config.message;
      return;
    }
    const client = new BedrockRuntimeClient({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
      },
    });
    router = new V2BedrockRouter({
      client,
      modelId: config.modelId,
      debug: config.debug,
    });
  };

  return {
    name: "voice-form-filling:bedrock-proxy",
    configResolved(resolvedConfig) {
      // `loadEnv("", envDir, "")` reads every variable (no prefix filter) from
      // .env, .env.local, .env.<mode>, .env.<mode>.local in the project's
      // envDir. Mode is empty so we get every layer, regardless of
      // development/production.
      envFromFiles = loadEnv(
        resolvedConfig.mode,
        resolvedConfig.envDir,
        "",
      ) as Record<string, string>;
    },
    configureServer(server) {
      init();
      server.middlewares.use(ROUTE_PATH, async (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        if (initError) {
          sendJson(res, 503, { error: initError });
          return;
        }
        if (!router) {
          sendJson(res, 503, { error: "Bedrock proxy not initialised." });
          return;
        }

        try {
          const body = await readJsonBody<BedrockRoutingRequest>(req);
          if (!body || typeof body.userInput !== "string") {
            sendJson(res, 400, {
              error: "Invalid request body. Expected { userInput, pendingFields, … }.",
            });
            return;
          }
          const rawResponse: BedrockRoutingResponse =
            await router.routeAnswer(body);
          const response = dropHallucinatedSelectAssignments(rawResponse, body);
          sendJson(res, 200, response);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          // eslint-disable-next-line no-console
          console.error("[bedrock-proxy] routeAnswer failed:", error);
          sendJson(res, 500, { error: message });
        }
      });
    },
  };
}

function readConfigFromEnv(
  envFromFiles: Record<string, string>,
): ProxyConfig | Error {
  // We deliberately read the existing VITE_-prefixed vars (rather than rename
  // them) so docker-compose.yml and .env.example don't need to change. The
  // values are read here in Node from two sources:
  //   1. .env / .env.local files (via Vite's loadEnv) — covers `yarn dev`.
  //   2. process.env                                  — covers docker-compose
  //                                                     and CI, where the vars
  //                                                     are injected directly.
  // The browser code never references `import.meta.env.VITE_AWS_*`, and the
  // vite.config.ts `envPrefix` whitelist keeps those keys out of the bundle.
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = (envFromFiles[key] || process.env[key] || "").trim();
      if (value) return value;
    }
    return "";
  };
  const modelId = pick("VITE_BEDROCK_MODEL_ID", "BEDROCK_MODEL_ID");
  const region = pick("VITE_BEDROCK_REGION", "BEDROCK_REGION", "AWS_REGION");
  const accessKeyId = pick("VITE_AWS_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID");
  const secretAccessKey = pick(
    "VITE_AWS_SECRET_ACCESS_KEY",
    "AWS_SECRET_ACCESS_KEY",
  );
  const sessionToken = pick("VITE_AWS_SESSION_TOKEN", "AWS_SESSION_TOKEN");
  const debug = /^(1|true)$/i.test(
    envFromFiles.BEDROCK_PROXY_DEBUG ||
      process.env.BEDROCK_PROXY_DEBUG ||
      "",
  );

  const missing: string[] = [];
  if (!modelId) missing.push("VITE_BEDROCK_MODEL_ID");
  if (!region) missing.push("VITE_BEDROCK_REGION");
  if (!accessKeyId) missing.push("VITE_AWS_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("VITE_AWS_SECRET_ACCESS_KEY");
  if (missing.length) {
    return new Error(
      `Bedrock proxy is not configured. Missing env vars: ${missing.join(", ")}.`,
    );
  }

  return {
    modelId,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken: sessionToken || undefined,
    debug,
  };
}

/**
 * Defensive filter for hallucinated dropdown assignments.
 *
 * The Bedrock LLM is told (in the prompt) to extract answers for any pending
 * field that the user mentioned. With State=HARYANA visible in completedFields
 * and a long list of Haryana districts/tehsils/villages in pendingFields,
 * Claude 3 Haiku has a habit of "completing" District/SubDistrict/Village with
 * plausible values even when the user only voiced answers for unrelated
 * fields like Religion or Marital Status.
 *
 * The library's own verification step is supposed to catch this, but it relies
 * on the LLM cooperating with the verification call. As a belt-and-braces
 * guard, we drop any selectable-field assignment whose chosen option has no
 * direct lexical or phonetic evidence in the user's utterance.
 *
 * Non-selectable fields (text/number/date/email/tel) are not filtered — their
 * values are arbitrary user input.
 */
function dropHallucinatedSelectAssignments(
  response: BedrockRoutingResponse,
  request: BedrockRoutingRequest,
): BedrockRoutingResponse {
  const utterance = request.userInput?.trim();
  if (!utterance) return response;

  const allFields: VoiceFormFieldDescriptor[] = [
    ...request.pendingFields,
    ...request.completedFields,
  ];

  const findField = (
    id: string,
  ): VoiceFormFieldDescriptor | undefined =>
    allFields.find(
      (f) => f.id === id || f.name === id || f.label === id,
    );

  const isSelectable = (type: string): boolean =>
    type === "select" || type === "radio" || type === "checkbox";

  const hasEvidence = (
    option: { value: string; label: string },
  ): boolean => {
    // findBestOptionMatch returns the best candidate-in-utterance vs option
    // score, with `exact` / `phoneticExact` flags. A real user mention scores
    // 1.0 (exact) or 0.85+ (phonetic / substring). LLM hallucinations score
    // around 0.4 — well below the 0.7 cutoff used here.
    const match = findBestOptionMatch(utterance, [option]);
    if (!match) return false;
    if (match.exact || match.phoneticExact) return true;
    return match.score >= 0.7;
  };

  const filtered = response.assignments.filter((assignment) => {
    if (assignment.skip || assignment.value === undefined) return true;
    const field = findField(assignment.fieldId);
    if (!field || !isSelectable(field.type) || !field.options?.length) {
      return true;
    }

    const values: string[] = Array.isArray(assignment.value)
      ? assignment.value
      : [assignment.value];
    return values.every((value) => {
      // Resolve the option the assignment refers to (matches by value or label).
      const option = field.options!.find(
        (opt) => opt.value === value || opt.label === value,
      );
      // If the assignment doesn't map to a known option, leave it alone — the
      // library's downstream validateAssignment will reject it anyway.
      if (!option) return true;
      return hasEvidence(option);
    });
  });

  if (filtered.length === response.assignments.length) {
    return response;
  }
  return { ...response, assignments: filtered };
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}
