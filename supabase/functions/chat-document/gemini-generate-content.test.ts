import { RESPONSE_MODES, type ResponseMode } from "../_shared/chat-controls.ts";
import {
  citationsFromIds,
  selectStrongestCitationIds,
} from "./document-sources.ts";
import {
  createGeminiGenerateContentRequestBody,
  DEFAULT_GEMINI_MODEL,
  extractGeminiGenerateContentText,
  type GeminiFetch,
  geminiGenerateContentUrl,
  GeminiProviderError,
  type GeminiSafeDiagnostics,
  requestGeminiText,
} from "./gemini-generate-content.ts";

const CHUNK_1 = "11111111-1111-4111-8111-111111111111";
const CHUNK_2 = "22222222-2222-4222-8222-222222222222";
const CHUNK_3 = "33333333-3333-4333-8333-333333333333";
const NO_DIAGNOSTIC_LOG = () => undefined;

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }.`,
    );
  }
}

Deno.test("default Gemini model is gemini-3.1-flash-lite", () => {
  assertEquals(DEFAULT_GEMINI_MODEL, "gemini-3.1-flash-lite");
});

function requestOptions(
  mode: ResponseMode = "concise",
): Parameters<typeof requestGeminiText>[0] {
  return {
    requestId: "11111111-1111-4111-8111-111111111111",
    model: DEFAULT_GEMINI_MODEL,
    apiKey: "test-api-key",
    responseMode: mode,
    callStage: "final",
    context: "Machine learning finds patterns in document data.",
    systemInstruction:
      "Answer only from the supplied document and return plain text.",
    input: "What is ML?",
    outputTokenBudget: RESPONSE_MODES[mode].maxOutputTokens,
  };
}

function completedResponse(...parts: string[]): Response {
  return new Response(
    JSON.stringify({
      candidates: [{
        content: { parts: parts.map((text) => ({ text })) },
        finishReason: "STOP",
      }],
    }),
    { status: 200 },
  );
}

function maxTokensResponse(): Response {
  return new Response(
    JSON.stringify({
      candidates: [{
        content: { parts: [{ text: "Partial answer" }] },
        finishReason: "MAX_TOKENS",
      }],
    }),
    { status: 200 },
  );
}

function googleErrorResponse(
  status: number,
  googleStatus: string,
  message: string,
): Response {
  return new Response(
    JSON.stringify({ error: { code: status, status: googleStatus, message } }),
    { status },
  );
}

async function assertProviderError(
  response: Response,
  code: string,
  message: string,
): Promise<void> {
  try {
    await requestGeminiText(
      requestOptions(),
      async () => response.clone(),
      NO_DIAGNOSTIC_LOG,
      async () => undefined,
    );
  } catch (error) {
    if (
      error instanceof GeminiProviderError && error.code === code &&
      error.message === message
    ) {
      return;
    }
    throw error;
  }

  throw new Error(`${code} unexpectedly succeeded.`);
}

Deno.test("generateContent request uses the exact minimal payload", async () => {
  const options = requestOptions("balanced");
  const body = createGeminiGenerateContentRequestBody(options, 4_096);
  const generationConfig = body.generationConfig as Record<string, unknown>;
  const contents = body.contents as Array<Record<string, unknown>>;
  const parts = contents[0].parts as Array<Record<string, unknown>>;

  assertEquals(Object.keys(body), ["contents", "generationConfig"]);
  assertEquals(contents[0].role, "user");
  assertEquals(typeof parts[0].text, "string");
  assertEquals(generationConfig, {
    temperature: 0.2,
    maxOutputTokens: 4_096,
  });
  assertEquals("store" in body, false);
  assertEquals("response_format" in body, false);
  assertEquals("input" in body, false);
  assertEquals("generation_config" in body, false);
  assertEquals("previous_interaction_id" in body, false);
  assertEquals("background" in body, false);
  assertEquals("stream" in body, false);
  assertEquals("model" in body, false);
  assertEquals("thinking_level" in generationConfig, false);
  assertEquals("thinking_budget" in generationConfig, false);
  assertEquals(
    geminiGenerateContentUrl(options.model),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent",
  );
});

Deno.test("successful plain-text response is returned", async () => {
  const answer = await requestGeminiText(
    requestOptions(),
    async () => completedResponse("Machine learning finds patterns in data."),
    NO_DIAGNOSTIC_LOG,
  );

  assertEquals(answer, "Machine learning finds patterns in data.");
});

Deno.test("multiple candidate text parts are concatenated", () => {
  const result = extractGeminiGenerateContentText({
    candidates: [{
      content: {
        parts: [
          { text: "Machine " },
          { inlineData: { mimeType: "text/plain" } },
          { text: "learning." },
        ],
      },
      finishReason: "STOP",
    }],
  });

  assertEquals(result.text, "Machine learning.");
  assertEquals(result.finishReason, "STOP");
});

Deno.test("400 INVALID_ARGUMENT maps to configuration error", async () => {
  await assertProviderError(
    googleErrorResponse(400, "INVALID_ARGUMENT", "Invalid JSON payload."),
    "invalid_request",
    "The Gemini request configuration is invalid.",
  );
});

Deno.test("403 maps to invalid or restricted API key", async () => {
  await assertProviderError(
    googleErrorResponse(403, "PERMISSION_DENIED", "API key denied."),
    "authentication",
    "The Gemini API key is invalid or restricted.",
  );
});

Deno.test("429 maps to free-tier quota exhaustion", async () => {
  await assertProviderError(
    googleErrorResponse(429, "RESOURCE_EXHAUSTED", "Quota exceeded."),
    "quota",
    "The free Gemini quota has been reached. Please try again later.",
  );
});

Deno.test("503 maps to temporary Gemini unavailability", async () => {
  await assertProviderError(
    googleErrorResponse(503, "UNAVAILABLE", "Service unavailable."),
    "unavailable",
    "Gemini is temporarily unavailable. Please try again.",
  );
});

Deno.test("404 maps to an invalid answer model", async () => {
  await assertProviderError(
    googleErrorResponse(404, "NOT_FOUND", "Model was not found."),
    "model_unavailable",
    "The configured Gemini answer model is unavailable. Contact the application administrator.",
  );
});

Deno.test("provider timeouts are distinct from network failures", async () => {
  const options = { ...requestOptions(), timeoutMs: 1 };

  try {
    await requestGeminiText(
      options,
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
      NO_DIAGNOSTIC_LOG,
      async () => undefined,
    );
  } catch (error) {
    if (error instanceof GeminiProviderError && error.code === "timeout") {
      return;
    }
    throw error;
  }

  throw new Error("Timed-out Gemini request unexpectedly succeeded.");
});

Deno.test("MAX_TOKENS retries once with a doubled budget", async () => {
  const budgets: number[] = [];
  const fetchGemini: GeminiFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const config = body.generationConfig as Record<string, unknown>;
    budgets.push(config.maxOutputTokens as number);
    return budgets.length === 1
      ? maxTokensResponse()
      : completedResponse("The retry completed successfully.");
  };

  const answer = await requestGeminiText(
    requestOptions(),
    fetchGemini,
    NO_DIAGNOSTIC_LOG,
  );

  assertEquals(answer, "The retry completed successfully.");
  assertEquals(budgets, [2_048, 4_096]);
});

Deno.test("a transient 503 recovers with one bounded retry", async () => {
  let calls = 0;
  const answer = await requestGeminiText(
    requestOptions(),
    async () => {
      calls += 1;
      return calls === 1
        ? googleErrorResponse(503, "UNAVAILABLE", "temporary")
        : completedResponse("Recovered answer.");
    },
    NO_DIAGNOSTIC_LOG,
    async () => undefined,
  );
  assertEquals(answer, "Recovered answer.");
  assertEquals(calls, 2);
});

Deno.test("a second MAX_TOKENS response is not retried again", async () => {
  let requestCount = 0;

  try {
    await requestGeminiText(
      requestOptions(),
      async () => {
        requestCount += 1;
        return maxTokensResponse();
      },
      NO_DIAGNOSTIC_LOG,
    );
  } catch (error) {
    if (
      error instanceof GeminiProviderError && error.code === "output_limit"
    ) {
      assertEquals(requestCount, 2);
      return;
    }
    throw error;
  }

  throw new Error("Repeated MAX_TOKENS responses unexpectedly succeeded.");
});

Deno.test("empty candidates return an empty-response error", () => {
  try {
    extractGeminiGenerateContentText({ candidates: [] });
  } catch (error) {
    if (
      error instanceof GeminiProviderError && error.code === "empty_response"
    ) {
      return;
    }
    throw error;
  }

  throw new Error("Empty candidates unexpectedly succeeded.");
});

Deno.test("prompt feedback maps to a blocked response without logging its message", async () => {
  const diagnostics: GeminiSafeDiagnostics[] = [];
  const options = requestOptions();

  try {
    await requestGeminiText(
      options,
      async () =>
        new Response(
          JSON.stringify({
            candidates: [],
            promptFeedback: {
              blockReason: "SAFETY",
              blockReasonMessage:
                `Blocked key ${options.apiKey} and "private excerpt".`,
            },
          }),
          { status: 200 },
        ),
      (_level, diagnostic) => diagnostics.push(diagnostic),
    );
  } catch (error) {
    if (
      !(error instanceof GeminiProviderError) ||
      error.code !== "safety"
    ) {
      throw error;
    }
  }

  assertEquals(diagnostics[0].httpStatus, 200);
  assertEquals(diagnostics[0].model, DEFAULT_GEMINI_MODEL);
  assertEquals(diagnostics[0].reasonCode, "safety");
  assertEquals(JSON.stringify(diagnostics[0]).includes(options.apiKey), false);
  assertEquals(
    JSON.stringify(diagnostics[0]).includes("private excerpt"),
    false,
  );
});

Deno.test("SAFETY finish reason returns a blocked-response error", () => {
  try {
    extractGeminiGenerateContentText({
      candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }],
    });
  } catch (error) {
    if (
      error instanceof GeminiProviderError &&
      error.code === "safety" &&
      error.message === "Gemini blocked the response for safety reasons."
    ) {
      return;
    }
    throw error;
  }

  throw new Error("A safety-blocked response unexpectedly succeeded.");
});

Deno.test("RECITATION finish reason returns a provider-response error", () => {
  try {
    extractGeminiGenerateContentText({
      candidates: [{ content: { parts: [] }, finishReason: "RECITATION" }],
    });
  } catch (error) {
    if (
      error instanceof GeminiProviderError && error.code === "recitation"
    ) {
      return;
    }
    throw error;
  }

  throw new Error("A recitation-blocked response unexpectedly succeeded.");
});

Deno.test("OTHER finish reason returns a provider failure", () => {
  try {
    extractGeminiGenerateContentText({
      candidates: [{
        content: { parts: [{ text: "Partial response" }] },
        finishReason: "OTHER",
      }],
    });
  } catch (error) {
    if (
      error instanceof GeminiProviderError && error.code === "provider_failure"
    ) {
      return;
    }
    throw error;
  }

  throw new Error("An OTHER response unexpectedly succeeded.");
});

Deno.test("provider diagnostics contain only approved safe fields", async () => {
  const diagnostics: GeminiSafeDiagnostics[] = [];
  const options = requestOptions();
  await requestGeminiText(
    options,
    async () => completedResponse("Safe answer."),
    (_level, diagnostic) => diagnostics.push(diagnostic),
  );

  assertEquals(Object.keys(diagnostics[0]).sort(), [
    "finishReason",
    "httpStatus",
    "model",
    "outputBudget",
    "reasonCode",
    "requestId",
    "stage",
  ]);
});

Deno.test("Google error diagnostics omit keys and provider message text", async () => {
  const diagnostics: GeminiSafeDiagnostics[] = [];
  const options = requestOptions();

  try {
    await requestGeminiText(
      options,
      async () =>
        googleErrorResponse(
          400,
          "INVALID_ARGUMENT",
          `Key ${options.apiKey} rejected text "private document excerpt".`,
        ),
      (_level, diagnostic) => diagnostics.push(diagnostic),
    );
  } catch (error) {
    if (
      !(error instanceof GeminiProviderError) ||
      error.code !== "invalid_request"
    ) {
      throw error;
    }
  }

  assertEquals(
    JSON.stringify(diagnostics[0]).includes(options.apiKey),
    false,
  );
  assertEquals(
    JSON.stringify(diagnostics[0]).includes("private document excerpt"),
    false,
  );
});

Deno.test("server-generated citations remain database-backed", () => {
  const chunks = [
    { id: CHUNK_1, page_number: 2, content: "Strongest ML evidence." },
    { id: CHUNK_2, page_number: 3, content: "Second strongest evidence." },
    { id: CHUNK_3, page_number: 3, content: "Additional evidence." },
  ];
  const citations = citationsFromIds(
    selectStrongestCitationIds(chunks, "balanced"),
    chunks,
    "What is ML?",
    6,
  );

  assertEquals(citations.map((citation) => citation.chunkId), [
    CHUNK_1,
    CHUNK_2,
    CHUNK_3,
  ]);
  assertEquals(citations.map((citation) => citation.pageNumber), [2, 3, 3]);
  assertEquals(citations[0].excerpt, "Strongest ML evidence.");
});
