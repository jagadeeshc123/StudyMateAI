export const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-2";
export const DEFAULT_GEMINI_EMBEDDING_DIMENSIONS = 768;
export const GEMINI_EMBEDDING_BATCH_SIZE = 10;
export const GEMINI_EMBEDDING_CONCURRENCY = 2;

const GEMINI_MODELS_ROOT =
  "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_TRANSIENT_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_JITTER_MS = 250;
export const GEMINI_EMBEDDING_TIMEOUT_MS = 30_000;

export type GeminiEmbeddingErrorCode =
  | "invalid_request"
  | "authentication"
  | "model_unavailable"
  | "quota"
  | "temporarily_unavailable"
  | "network_failure"
  | "timeout"
  | "invalid_response"
  | "dimension_mismatch";

export class GeminiEmbeddingError extends Error {
  constructor(
    public readonly code: GeminiEmbeddingErrorCode,
    message: string,
    public readonly transient = false,
  ) {
    super(message);
    this.name = "GeminiEmbeddingError";
  }
}

export interface GeminiEmbeddingOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  timeoutMs?: number;
}

export interface GeminiEmbeddingDiagnostics {
  model: string;
  dimensions: number;
  inputCount: number;
  requestIndex: number;
  httpStatus: number | null;
  errorCode: GeminiEmbeddingErrorCode | "none";
  attempt: number;
}

export type GeminiEmbeddingLogger = (
  level: "info" | "error",
  diagnostics: GeminiEmbeddingDiagnostics,
) => void;

export type GeminiEmbeddingFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type EmbeddingDelay = (milliseconds: number) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizedModelName(model: string): string {
  return model.startsWith("models/") ? model.slice("models/".length) : model;
}

export function normalizeEmbeddingText(value: string): string {
  return value
    .normalize("NFKC")
    .split(String.fromCharCode(0)).join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatEmbeddingQuery(question: string): string {
  return `task: question answering | query: ${
    normalizeEmbeddingText(question)
  }`;
}

export function formatEmbeddingDocument(
  content: string,
  documentTitle?: string | null,
): string {
  const title = normalizeEmbeddingText(documentTitle ?? "") || "none";
  return `title: ${title} | text: ${normalizeEmbeddingText(content)}`;
}

export async function stableContentHash(value: string): Promise<string> {
  const normalized = normalizeEmbeddingText(value);
  const bytes = new TextEncoder().encode(normalized);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function embeddingConfigurationFromEnvironment(): {
  model: string;
  dimensions: number;
} {
  const model = Deno.env.get("GEMINI_EMBEDDING_MODEL") ||
    DEFAULT_GEMINI_EMBEDDING_MODEL;
  const rawDimensions = Deno.env.get("GEMINI_EMBEDDING_DIMENSIONS");
  const dimensions = rawDimensions
    ? Number.parseInt(rawDimensions, 10)
    : DEFAULT_GEMINI_EMBEDDING_DIMENSIONS;

  if (dimensions !== DEFAULT_GEMINI_EMBEDDING_DIMENSIONS) {
    throw new GeminiEmbeddingError(
      "dimension_mismatch",
      `StudyMate requires ${DEFAULT_GEMINI_EMBEDDING_DIMENSIONS}-dimension embeddings.`,
    );
  }

  return { model, dimensions };
}

export function createEmbeddingRequestBody(
  text: string,
  options: GeminiEmbeddingOptions,
): Record<string, unknown> {
  return {
    content: {
      role: "user",
      parts: [{ text: normalizeEmbeddingText(text) }],
    },
    embedContentConfig: {
      outputDimensionality: options.dimensions,
    },
  };
}

function embeddingUrl(model: string): string {
  return `${GEMINI_MODELS_ROOT}/${
    encodeURIComponent(normalizedModelName(model))
  }:embedContent`;
}

function providerError(status: number): GeminiEmbeddingError {
  if (status === 400) {
    return new GeminiEmbeddingError(
      "invalid_request",
      "The embedding request configuration is invalid.",
    );
  }
  if (status === 401 || status === 403) {
    return new GeminiEmbeddingError(
      "authentication",
      "The Gemini embedding API key is invalid or restricted.",
    );
  }
  if (status === 404) {
    return new GeminiEmbeddingError(
      "model_unavailable",
      "The configured Gemini embedding model is unavailable.",
    );
  }
  if (status === 429) {
    return new GeminiEmbeddingError(
      "quota",
      "The free Gemini embedding quota has been exhausted. Keyword search remains available.",
      true,
    );
  }
  if (status >= 500 && status <= 599) {
    return new GeminiEmbeddingError(
      "temporarily_unavailable",
      "The Gemini embedding provider is temporarily unavailable. Keyword search remains available.",
      true,
    );
  }
  return new GeminiEmbeddingError(
    "invalid_response",
    "The Gemini embedding provider rejected the request.",
  );
}

function validatedVector(payload: unknown, dimensions: number): number[] {
  const embedding = isRecord(payload) && isRecord(payload.embedding)
    ? payload.embedding
    : null;
  const values = embedding?.values;

  if (!Array.isArray(values)) {
    throw new GeminiEmbeddingError(
      "invalid_response",
      "The embedding provider response did not contain a vector.",
    );
  }
  if (values.length !== dimensions) {
    throw new GeminiEmbeddingError(
      "dimension_mismatch",
      `The embedding provider returned a vector that was not ${dimensions} dimensions.`,
    );
  }

  return values.map((item) => {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw new GeminiEmbeddingError(
        "invalid_response",
        "The embedding provider returned invalid vector values.",
      );
    }
    return item;
  });
}

const defaultLogger: GeminiEmbeddingLogger = (level, diagnostics) => {
  if (Deno.env.get("OBSERVABILITY_ENABLED")?.toLowerCase() !== "true") return;
  console[level]("Gemini embeddings", diagnostics);
};

const defaultDelay: EmbeddingDelay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function retryDelayMilliseconds(attempt: number): number {
  const exponentialDelay = INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1);
  return exponentialDelay + Math.floor(Math.random() * MAX_RETRY_JITTER_MS);
}

async function requestEmbedding(
  text: string,
  requestIndex: number,
  inputCount: number,
  options: GeminiEmbeddingOptions,
  fetchEmbedding: GeminiEmbeddingFetch,
  logDiagnostic: GeminiEmbeddingLogger,
  delay: EmbeddingDelay,
): Promise<number[]> {
  for (let attempt = 1; attempt <= MAX_TRANSIENT_RETRIES + 1; attempt += 1) {
    let response: Response;
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? GEMINI_EMBEDDING_TIMEOUT_MS,
    );

    try {
      response = await fetchEmbedding(embeddingUrl(options.model), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": options.apiKey,
        },
        body: JSON.stringify(createEmbeddingRequestBody(text, options)),
        signal: controller.signal,
      });
    } catch {
      const timedOut = controller.signal.aborted;
      const error = new GeminiEmbeddingError(
        timedOut ? "timeout" : "network_failure",
        timedOut
          ? "The Gemini embedding request timed out. Keyword search remains available."
          : "The Gemini embedding network request failed. Keyword search remains available.",
        true,
      );
      logDiagnostic("error", {
        model: options.model,
        dimensions: options.dimensions,
        inputCount,
        requestIndex,
        httpStatus: null,
        errorCode: error.code,
        attempt,
      });

      if (attempt <= MAX_TRANSIENT_RETRIES) {
        await delay(retryDelayMilliseconds(attempt));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const error = providerError(response.status);
      logDiagnostic("error", {
        model: options.model,
        dimensions: options.dimensions,
        inputCount,
        requestIndex,
        httpStatus: response.status,
        errorCode: error.code,
        attempt,
      });

      if (error.transient && attempt <= MAX_TRANSIENT_RETRIES) {
        await delay(retryDelayMilliseconds(attempt));
        continue;
      }
      throw error;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      const error = new GeminiEmbeddingError(
        "invalid_response",
        "The embedding provider returned an unreadable response.",
      );
      logDiagnostic("error", {
        model: options.model,
        dimensions: options.dimensions,
        inputCount,
        requestIndex,
        httpStatus: response.status,
        errorCode: error.code,
        attempt,
      });
      throw error;
    }

    try {
      const embedding = validatedVector(payload, options.dimensions);
      logDiagnostic("info", {
        model: options.model,
        dimensions: options.dimensions,
        inputCount,
        requestIndex,
        httpStatus: response.status,
        errorCode: "none",
        attempt,
      });
      return embedding;
    } catch (error) {
      if (!(error instanceof GeminiEmbeddingError)) throw error;
      logDiagnostic("error", {
        model: options.model,
        dimensions: options.dimensions,
        inputCount,
        requestIndex,
        httpStatus: response.status,
        errorCode: error.code,
        attempt,
      });
      throw error;
    }
  }

  throw new GeminiEmbeddingError(
    "network_failure",
    "The Gemini embedding network request failed. Keyword search remains available.",
  );
}

export async function generateGeminiEmbeddings(
  texts: string[],
  options: GeminiEmbeddingOptions,
  fetchEmbedding: GeminiEmbeddingFetch = fetch,
  logDiagnostic: GeminiEmbeddingLogger = defaultLogger,
  delay: EmbeddingDelay = defaultDelay,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const normalizedTexts = texts.map(normalizeEmbeddingText);
  if (normalizedTexts.some((text) => !text)) {
    throw new GeminiEmbeddingError(
      "invalid_request",
      "Embedding text must not be empty.",
    );
  }

  const embeddings = Array<number[]>(normalizedTexts.length);
  let nextIndex = 0;
  const workerCount = Math.min(
    GEMINI_EMBEDDING_CONCURRENCY,
    normalizedTexts.length,
  );

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < normalizedTexts.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      embeddings[currentIndex] = await requestEmbedding(
        normalizedTexts[currentIndex],
        currentIndex,
        normalizedTexts.length,
        options,
        fetchEmbedding,
        logDiagnostic,
        delay,
      );
    }
  }));

  return embeddings;
}

export function embeddingToPostgres(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
