import type { ResponseMode } from "../_shared/chat-controls.ts";

export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";
export const INTERMEDIATE_SUMMARY_OUTPUT_TOKENS = 2_048;
export const REDUCTION_SUMMARY_OUTPUT_TOKENS = 4_096;
export const MAX_RETRY_OUTPUT_TOKENS = 16_384;
export const GEMINI_ANSWER_TIMEOUT_MS = 45_000;

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
  | "provider_failure"
  | "model_unavailable"
  | "timeout";

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
  requestId: string;
  timeoutMs?: number;
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
  requestId: string;
  stage: "intermediate" | "final";
  httpStatus: number | null;
  model: string;
  outputBudget: number;
  finishReason: string | null;
  reasonCode: GeminiProviderErrorCode | "none";
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

interface PromptFeedbackDetails {
  blockReason: string | null;
}

function promptFeedbackFromResponse(response: unknown): PromptFeedbackDetails {
  const promptFeedback = isRecord(response) && isRecord(response.promptFeedback)
    ? response.promptFeedback
    : null;

  return {
    blockReason:
      promptFeedback && typeof promptFeedback.blockReason === "string"
        ? promptFeedback.blockReason
        : null,
  };
}

interface GoogleErrorDetails {
  status: string | null;
}

async function readGoogleError(
  response: Response,
): Promise<GoogleErrorDetails> {
  let payload: unknown;

  try {
    payload = JSON.parse(await response.text());
  } catch {
    return { status: null };
  }

  const error = isRecord(payload) && isRecord(payload.error)
    ? payload.error
    : null;
  return {
    status: error && typeof error.status === "string" ? error.status : null,
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
  if (status === 404 || googleStatus === "NOT_FOUND") {
    return new GeminiProviderError(
      "model_unavailable",
      "The configured Gemini answer model is unavailable. Contact the application administrator.",
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
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? GEMINI_ANSWER_TIMEOUT_MS,
    );

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
        signal: controller.signal,
      });
    } catch {
      const timedOut = controller.signal.aborted;
      logDiagnostic("error", {
        requestId: options.requestId,
        stage: options.callStage,
        httpStatus: null,
        model: options.model,
        outputBudget,
        finishReason: null,
        reasonCode: timedOut ? "timeout" : "network_failure",
      });
      throw new GeminiProviderError(
        timedOut ? "timeout" : "network_failure",
        timedOut
          ? "The Gemini request timed out. Please try again."
          : "Could not reach Gemini. Please try again.",
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const googleError = await readGoogleError(response);
      const providerError = httpError(response.status, googleError.status);
      logDiagnostic("error", {
        requestId: options.requestId,
        stage: options.callStage,
        httpStatus: response.status,
        model: options.model,
        outputBudget,
        finishReason: null,
        reasonCode: providerError.code,
      });
      throw providerError;
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      logDiagnostic("error", {
        requestId: options.requestId,
        stage: options.callStage,
        httpStatus: response.status,
        model: options.model,
        outputBudget,
        finishReason: null,
        reasonCode: "provider_failure",
      });
      throw new GeminiProviderError(
        "provider_failure",
        "Gemini returned an unreadable response. Please try again.",
      );
    }

    const finishReason = finishReasonFromResponse(payload);
    const promptFeedback = promptFeedbackFromResponse(payload);

    if (promptFeedback.blockReason) {
      logDiagnostic("error", {
        requestId: options.requestId,
        stage: options.callStage,
        httpStatus: response.status,
        model: options.model,
        outputBudget,
        finishReason,
        reasonCode: "safety",
      });
      throw new GeminiProviderError(
        "safety",
        "Gemini blocked the response for safety reasons.",
      );
    }

    try {
      const result = extractGeminiGenerateContentText(payload);
      logDiagnostic("info", {
        requestId: options.requestId,
        stage: options.callStage,
        httpStatus: response.status,
        model: options.model,
        outputBudget,
        finishReason: result.finishReason,
        reasonCode: "none",
      });
      return result.text;
    } catch (error) {
      if (!(error instanceof GeminiProviderError)) throw error;

      logDiagnostic("error", {
        requestId: options.requestId,
        stage: options.callStage,
        httpStatus: response.status,
        model: options.model,
        outputBudget,
        finishReason,
        reasonCode: error.code,
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
