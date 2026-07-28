import type { ResponseMode } from "../_shared/chat-controls.ts";

export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";
export const INTERMEDIATE_SUMMARY_OUTPUT_TOKENS = 2_048;
export const REDUCTION_SUMMARY_OUTPUT_TOKENS = 4_096;
export const MAX_RETRY_OUTPUT_TOKENS = 16_384;

const GEMINI_API_ROOT =
  "https://generativelanguage.googleapis.com/v1beta/models";

export type GeminiProviderErrorCode =
  | "authentication"
  | "quota"
  | "output_limit"
  | "empty_response"
  | "network_failure"
  | "invalid_request"
  | "unavailable"
  | "safety"
  | "recitation"
  | "provider_failure";

export class GeminiProviderError extends Error {
  constructor(
    public readonly code: GeminiProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GeminiProviderError";
  }
}

export interface GeminiTextRequestOptions {
  model: string;
  apiKey: string;
  responseMode: ResponseMode;
  callStage: "intermediate" | "final";
  context: string;
  systemInstruction: string;
  input: string;
  outputTokenBudget: number;
}

export interface GeminiGenerateContentResult {
  text: string;
  finishReason: string | null;
}

export interface GeminiSafeDiagnostics {
  httpStatus: number | null;
  googleErrorStatus: string | null;
  googleErrorMessage: string | null;
  promptFeedbackBlockReason: string | null;
  promptFeedbackBlockReasonMessage: string | null;
  model: string;
  outputBudget: number;
  finishReason: string | null;
}

export type GeminiFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type GeminiDiagnosticLogger = (
  level: "info" | "error",
  diagnostics: GeminiSafeDiagnostics,
) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizedModelName(model: string): string {
  return model.startsWith("models/") ? model.slice("models/".length) : model;
}

export function geminiGenerateContentUrl(model: string): string {
  return `${GEMINI_API_ROOT}/${
    encodeURIComponent(normalizedModelName(model))
  }:generateContent`;
}

function completeGroundedPrompt(options: GeminiTextRequestOptions): string {
  return [
    options.systemInstruction,
    `DOCUMENT CONTEXT:\n${options.context}`,
    options.input,
  ].join("\n\n");
}

export function createGeminiGenerateContentRequestBody(
  options: GeminiTextRequestOptions,
  outputTokenBudget: number,
): Record<string, unknown> {
  return {
    contents: [{
      role: "user",
      parts: [{ text: completeGroundedPrompt(options) }],
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: outputTokenBudget,
    },
  };
}

function finishReasonFromResponse(response: unknown): string | null {
  if (!isRecord(response) || !Array.isArray(response.candidates)) return null;
  const candidate = response.candidates[0];
  return isRecord(candidate) && typeof candidate.finishReason === "string"
    ? candidate.finishReason
    : null;
}

export function extractGeminiGenerateContentText(
  response: unknown,
): GeminiGenerateContentResult {
  if (
    !isRecord(response) || !Array.isArray(response.candidates) ||
    response.candidates.length === 0
  ) {
    throw new GeminiProviderError(
      "empty_response",
      "Gemini returned an empty response. Please try again.",
    );
  }

  const candidate = response.candidates[0];
  const finishReason = isRecord(candidate) &&
      typeof candidate.finishReason === "string"
    ? candidate.finishReason
    : null;

  if (finishReason === "MAX_TOKENS") {
    throw new GeminiProviderError(
      "output_limit",
      "The AI response could not be completed. Please try again.",
    );
  }

  if (finishReason === "SAFETY") {
    throw new GeminiProviderError(
      "safety",
      "Gemini blocked the response for safety reasons.",
    );
  }

  if (finishReason === "RECITATION") {
    throw new GeminiProviderError(
      "recitation",
      "Gemini blocked the response because of recitation controls.",
    );
  }

  if (finishReason === "OTHER") {
    throw new GeminiProviderError(
      "provider_failure",
      "Gemini could not complete the response. Please try again.",
    );
  }

  if (finishReason && finishReason !== "STOP") {
    throw new GeminiProviderError(
      "provider_failure",
      "Gemini could not complete the response. Please try again.",
    );
  }

  const content = isRecord(candidate) && isRecord(candidate.content)
    ? candidate.content
    : null;
  const parts = content && Array.isArray(content.parts) ? content.parts : [];
  const text = parts
    .filter((part) => isRecord(part) && typeof part.text === "string")
    .map((part) => isRecord(part) ? part.text as string : "")
    .join("")
    .trim();

  if (!text) {
    throw new GeminiProviderError(
      "empty_response",
      "Gemini returned an empty response. Please try again.",
    );
  }

  return { text, finishReason };
}

function sanitizedGoogleMessage(value: unknown, apiKey: string): string | null {
  if (typeof value !== "string") return null;

  const withoutKey = apiKey ? value.split(apiKey).join("[REDACTED]") : value;
  const sanitized = withoutKey
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/(["']).*?\1/g, "$1[REDACTED]$1")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[REDACTED_TOKEN]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return sanitized || null;
}

interface PromptFeedbackDetails {
  blockReason: string | null;
  blockReasonMessage: string | null;
}

function promptFeedbackFromResponse(
  response: unknown,
  apiKey: string,
): PromptFeedbackDetails {
  const promptFeedback = isRecord(response) && isRecord(response.promptFeedback)
    ? response.promptFeedback
    : null;

  return {
    blockReason:
      promptFeedback && typeof promptFeedback.blockReason === "string"
        ? promptFeedback.blockReason
        : null,
    blockReasonMessage: sanitizedGoogleMessage(
      promptFeedback?.blockReasonMessage,
      apiKey,
    ),
  };
}

interface GoogleErrorDetails {
  status: string | null;
  message: string | null;
}

async function readGoogleError(
  response: Response,
  apiKey: string,
): Promise<GoogleErrorDetails> {
  let payload: unknown;

  try {
    payload = JSON.parse(await response.text());
  } catch {
    return { status: null, message: null };
  }

  const error = isRecord(payload) && isRecord(payload.error)
    ? payload.error
    : null;
  return {
    status: error && typeof error.status === "string" ? error.status : null,
    message: sanitizedGoogleMessage(error?.message, apiKey),
  };
}

function httpError(
  status: number,
  googleStatus: string | null,
): GeminiProviderError {
  if (status === 400 && googleStatus === "INVALID_ARGUMENT") {
    return new GeminiProviderError(
      "invalid_request",
      "The Gemini request configuration is invalid.",
    );
  }
  if (status === 401 || status === 403) {
    return new GeminiProviderError(
      "authentication",
      "The Gemini API key is invalid or restricted.",
    );
  }
  if (status === 429) {
    return new GeminiProviderError(
      "quota",
      "The free Gemini quota has been reached. Please try again later.",
    );
  }
  if ([500, 502, 503, 504].includes(status)) {
    return new GeminiProviderError(
      "unavailable",
      "Gemini is temporarily unavailable. Please try again.",
    );
  }
  if (status === 400) {
    return new GeminiProviderError(
      "invalid_request",
      "The Gemini request configuration is invalid.",
    );
  }
  return new GeminiProviderError(
    "provider_failure",
    "Gemini could not generate a response. Please try again.",
  );
}

const defaultLogger: GeminiDiagnosticLogger = (level, diagnostics) => {
  console[level]("Gemini generateContent", diagnostics);
};

export async function requestGeminiText(
  options: GeminiTextRequestOptions,
  fetchGemini: GeminiFetch = fetch,
  logDiagnostic: GeminiDiagnosticLogger = defaultLogger,
): Promise<string> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const outputBudget = attempt === 1
      ? options.outputTokenBudget
      : Math.min(options.outputTokenBudget * 2, MAX_RETRY_OUTPUT_TOKENS);
    let response: Response;

    try {
      response = await fetchGemini(geminiGenerateContentUrl(options.model), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": options.apiKey,
        },
        body: JSON.stringify(
          createGeminiGenerateContentRequestBody(options, outputBudget),
        ),
      });
    } catch {
      logDiagnostic("error", {
        httpStatus: null,
        googleErrorStatus: null,
        googleErrorMessage: null,
        promptFeedbackBlockReason: null,
        promptFeedbackBlockReasonMessage: null,
        model: options.model,
        outputBudget,
        finishReason: null,
      });
      throw new GeminiProviderError(
        "network_failure",
        "Could not reach Gemini. Please try again.",
      );
    }

    if (!response.ok) {
      const googleError = await readGoogleError(response, options.apiKey);
      logDiagnostic("error", {
        httpStatus: response.status,
        googleErrorStatus: googleError.status,
        googleErrorMessage: googleError.message,
        promptFeedbackBlockReason: null,
        promptFeedbackBlockReasonMessage: null,
        model: options.model,
        outputBudget,
        finishReason: null,
      });
      throw httpError(response.status, googleError.status);
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      logDiagnostic("error", {
        httpStatus: response.status,
        googleErrorStatus: null,
        googleErrorMessage: null,
        promptFeedbackBlockReason: null,
        promptFeedbackBlockReasonMessage: null,
        model: options.model,
        outputBudget,
        finishReason: null,
      });
      throw new GeminiProviderError(
        "provider_failure",
        "Gemini returned an unreadable response. Please try again.",
      );
    }

    const finishReason = finishReasonFromResponse(payload);
    const promptFeedback = promptFeedbackFromResponse(payload, options.apiKey);

    try {
      const result = extractGeminiGenerateContentText(payload);
      logDiagnostic("info", {
        httpStatus: response.status,
        googleErrorStatus: null,
        googleErrorMessage: null,
        promptFeedbackBlockReason: null,
        promptFeedbackBlockReasonMessage: null,
        model: options.model,
        outputBudget,
        finishReason: result.finishReason,
      });
      return result.text;
    } catch (error) {
      if (!(error instanceof GeminiProviderError)) throw error;

      logDiagnostic("error", {
        httpStatus: response.status,
        googleErrorStatus: null,
        googleErrorMessage: null,
        promptFeedbackBlockReason: promptFeedback.blockReason,
        promptFeedbackBlockReasonMessage: promptFeedback.blockReasonMessage,
        model: options.model,
        outputBudget,
        finishReason,
      });

      if (error.code === "output_limit" && attempt === 1) continue;
      throw error;
    }
  }

  throw new GeminiProviderError(
    "output_limit",
    "The AI response could not be completed. Please try again.",
  );
}
