import {
  createEmbeddingRequestBody,
  DEFAULT_GEMINI_EMBEDDING_DIMENSIONS,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  formatEmbeddingDocument,
  formatEmbeddingQuery,
  GEMINI_EMBEDDING_CONCURRENCY,
  GeminiEmbeddingError,
  type GeminiEmbeddingFetch,
  generateGeminiEmbeddings,
  normalizeEmbeddingText,
  stableContentHash,
} from "./gemini-embeddings.ts";
import {
  planDocumentEmbeddings,
  type StoredEmbeddingChunk,
} from "../process-document/document-embeddings.ts";

const NO_LOG = () => undefined;
const NO_DELAY = () => Promise.resolve();

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }.`,
    );
  }
}

function embeddingOptions() {
  return {
    apiKey: "test-key",
    model: DEFAULT_GEMINI_EMBEDDING_MODEL,
    dimensions: DEFAULT_GEMINI_EMBEDDING_DIMENSIONS,
  };
}

function vectorResponse(dimensions = 768, firstValue = 1): Response {
  return new Response(
    JSON.stringify({
      embedding: {
        values: Array.from(
          { length: dimensions },
          (_, index) => index === 0 ? firstValue : 0,
        ),
      },
    }),
    { status: 200 },
  );
}

Deno.test("gemini-embedding-2 asymmetric prefixes are applied consistently", () => {
  assertEquals(
    formatEmbeddingQuery("  What\n is ML?  "),
    "task: question answering | query: What is ML?",
  );
  assertEquals(
    formatEmbeddingDocument("  A\n document chunk  ", " ML Guide.pdf "),
    "title: ML Guide.pdf | text: A document chunk",
  );
  assertEquals(
    formatEmbeddingDocument("Untitled content", "  "),
    "title: none | text: Untitled content",
  );
});

Deno.test("embedContent request uses 768 dimensions and no taskType", () => {
  const body = createEmbeddingRequestBody(
    formatEmbeddingQuery("paraphrased question"),
    embeddingOptions(),
  );
  const serialized = JSON.stringify(body);

  assertEquals(Object.keys(body).sort(), ["content", "embedContentConfig"]);
  assertEquals(body.embedContentConfig, { outputDimensionality: 768 });
  assertEquals(serialized.includes("taskType"), false);
  assertEquals(serialized.includes("task_type"), false);
  assertEquals(serialized.includes("RETRIEVAL_"), false);
});

Deno.test("multiple inputs use only controlled synchronous embedContent calls", async () => {
  const urls: string[] = [];
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const fetchEmbedding: GeminiEmbeddingFetch = async (input) => {
    urls.push(String(input));
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    await Promise.resolve();
    activeRequests -= 1;
    return vectorResponse();
  };

  const embeddings = await generateGeminiEmbeddings(
    Array.from({ length: 8 }, (_, index) => `document ${index}`),
    embeddingOptions(),
    fetchEmbedding,
    NO_LOG,
    NO_DELAY,
  );

  assertEquals(embeddings.length, 8);
  assertEquals(maximumActiveRequests <= GEMINI_EMBEDDING_CONCURRENCY, true);
  assertEquals(urls.every((url) => url.endsWith(":embedContent")), true);
  assertEquals(urls.some((url) => /batch/i.test(url)), false);
});

Deno.test("768-dimensional vectors are validated without manual normalization", async () => {
  const [embedding] = await generateGeminiEmbeddings(
    [formatEmbeddingQuery("question")],
    embeddingOptions(),
    async () => vectorResponse(768, 2),
    NO_LOG,
    NO_DELAY,
  );

  assertEquals(embedding.length, 768);
  assertEquals(embedding[0], 2);
});

Deno.test("embedding text normalization and content hashing are stable", async () => {
  assertEquals(normalizeEmbeddingText("  café\n\tlesson "), "café lesson");
  assertEquals(
    await stableContentHash("  café\nlesson "),
    await stableContentHash("café lesson"),
  );
});

Deno.test("model changes force backfill while matching ready embeddings skip", async () => {
  const content = "Stable document content";
  const title = "Study Guide.pdf";
  const contentHash = await stableContentHash(
    formatEmbeddingDocument(content, title),
  );
  const chunks: StoredEmbeddingChunk[] = [{
    id: "chunk-current",
    content,
    content_hash: contentHash,
    embedding_status: "ready",
    embedding_model: DEFAULT_GEMINI_EMBEDDING_MODEL,
    embedding: "[1,0]",
  }, {
    id: "chunk-old-model",
    content,
    content_hash: contentHash,
    embedding_status: "ready",
    embedding_model: "gemini-embedding-001",
    embedding: "[1,0]",
  }, {
    id: "chunk-failed",
    content: "Retry this content",
    content_hash: "old-hash",
    embedding_status: "failed",
    embedding_model: DEFAULT_GEMINI_EMBEDDING_MODEL,
    embedding: null,
  }];

  const planned = await planDocumentEmbeddings(
    chunks,
    DEFAULT_GEMINI_EMBEDDING_MODEL,
    title,
  );
  assertEquals(
    planned.map((chunk) => chunk.id),
    ["chunk-old-model", "chunk-failed"],
  );
});

Deno.test("free quota exhaustion uses bounded exponential backoff", async () => {
  let requestCount = 0;
  const delays: number[] = [];

  try {
    await generateGeminiEmbeddings(
      [formatEmbeddingQuery("quota test")],
      embeddingOptions(),
      async () => {
        requestCount += 1;
        return new Response("quota", { status: 429 });
      },
      NO_LOG,
      (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
    );
  } catch (error) {
    if (error instanceof GeminiEmbeddingError && error.code === "quota") {
      assertEquals(requestCount, 3);
      assertEquals(delays.length, 2);
      if (delays[0] < 500 || delays[0] >= 750) {
        throw new Error(`Unexpected first retry delay: ${delays[0]}`);
      }
      if (delays[1] < 1_000 || delays[1] >= 1_250) {
        throw new Error(`Unexpected second retry delay: ${delays[1]}`);
      }
      return;
    }
    throw error;
  }

  throw new Error("Quota exhaustion unexpectedly succeeded.");
});

Deno.test("invalid embedding key is not retried", async () => {
  let requestCount = 0;

  try {
    await generateGeminiEmbeddings(
      [formatEmbeddingQuery("authentication test")],
      embeddingOptions(),
      async () => {
        requestCount += 1;
        return new Response("forbidden", { status: 403 });
      },
      NO_LOG,
      NO_DELAY,
    );
  } catch (error) {
    if (
      error instanceof GeminiEmbeddingError && error.code === "authentication"
    ) {
      assertEquals(requestCount, 1);
      return;
    }
    throw error;
  }

  throw new Error("Invalid embedding authentication unexpectedly succeeded.");
});

Deno.test("invalid requests and unavailable models use distinct errors", async () => {
  for (
    const scenario of [
      { status: 400, code: "invalid_request" },
      { status: 404, code: "model_unavailable" },
    ] as const
  ) {
    try {
      await generateGeminiEmbeddings(
        [formatEmbeddingQuery("provider mapping")],
        embeddingOptions(),
        async () => new Response("provider error", { status: scenario.status }),
        NO_LOG,
        NO_DELAY,
      );
    } catch (error) {
      if (
        error instanceof GeminiEmbeddingError && error.code === scenario.code
      ) {
        continue;
      }
      throw error;
    }

    throw new Error(`${scenario.code} unexpectedly succeeded.`);
  }
});

Deno.test("embedding timeout is distinct and preserves keyword fallback guidance", async () => {
  try {
    await generateGeminiEmbeddings(
      [formatEmbeddingQuery("timeout test")],
      { ...embeddingOptions(), timeoutMs: 1 },
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
      NO_LOG,
      NO_DELAY,
    );
  } catch (error) {
    if (
      error instanceof GeminiEmbeddingError && error.code === "timeout" &&
      error.message.includes("Keyword search remains available")
    ) return;
    throw error;
  }

  throw new Error("Timed-out embedding request unexpectedly succeeded.");
});

Deno.test("embedding network failures stop after bounded retries", async () => {
  let requestCount = 0;

  try {
    await generateGeminiEmbeddings(
      [formatEmbeddingDocument("network test", "Test.pdf")],
      embeddingOptions(),
      async () => {
        requestCount += 1;
        throw new TypeError("network unavailable");
      },
      NO_LOG,
      NO_DELAY,
    );
  } catch (error) {
    if (
      error instanceof GeminiEmbeddingError &&
      error.code === "network_failure"
    ) {
      assertEquals(requestCount, 3);
      return;
    }
    throw error;
  }

  throw new Error(
    "A repeated embedding network failure unexpectedly succeeded.",
  );
});

Deno.test("transient embedding failure retries with a bound", async () => {
  let requestCount = 0;
  const fetchEmbedding: GeminiEmbeddingFetch = async () => {
    requestCount += 1;
    return requestCount < 3
      ? new Response("unavailable", { status: 503 })
      : vectorResponse();
  };

  const embeddings = await generateGeminiEmbeddings(
    [formatEmbeddingDocument("retry test", "Test.pdf")],
    embeddingOptions(),
    fetchEmbedding,
    NO_LOG,
    NO_DELAY,
  );

  assertEquals(requestCount, 3);
  assertEquals(embeddings[0].length, 768);
});

Deno.test("missing, mismatched, and non-finite vectors are rejected", async () => {
  const scenarios = [
    {
      response: new Response(JSON.stringify({})),
      code: "invalid_response",
    },
    { response: vectorResponse(767), code: "dimension_mismatch" },
    {
      response: new Response(JSON.stringify({
        embedding: {
          values: Array.from(
            { length: 768 },
            (_, index) => index === 0 ? "NaN" : 0,
          ),
        },
      })),
      code: "invalid_response",
    },
  ] as const;

  for (const scenario of scenarios) {
    try {
      await generateGeminiEmbeddings(
        [formatEmbeddingQuery("validation test")],
        embeddingOptions(),
        async () => scenario.response.clone(),
        NO_LOG,
        NO_DELAY,
      );
    } catch (error) {
      if (
        error instanceof GeminiEmbeddingError && error.code === scenario.code
      ) {
        continue;
      }
      throw error;
    }
    throw new Error(`${scenario.code} unexpectedly succeeded.`);
  }
});
