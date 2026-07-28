import {
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  formatEmbeddingDocument,
  stableContentHash,
} from "../_shared/gemini-embeddings.ts";
import {
  embedDocumentChunks,
  type StoredEmbeddingChunk,
} from "./document-embeddings.ts";

interface TestChunk extends StoredEmbeddingChunk {
  document_id: string;
  page_number: number;
  chunk_index: number;
  embedding_error: string | null;
  embedded_at: string | null;
}

interface QueryResult {
  data: unknown[] | null;
  error: { message: string } | null;
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }.`,
    );
  }
}

class TestQuery implements PromiseLike<QueryResult> {
  private operation: "select" | "update" | null = null;
  private updateValues: Record<string, unknown> = {};
  private returningIds = false;
  private readonly filters: Array<(chunk: TestChunk) => boolean> = [];
  private rangeStart = 0;
  private rangeEnd = Number.POSITIVE_INFINITY;

  constructor(private readonly database: TestDatabase) {}

  select(): this {
    if (this.operation === "update") {
      this.returningIds = true;
    } else {
      this.operation = "select";
    }
    return this;
  }

  update(values: Record<string, unknown>): this {
    this.operation = "update";
    this.updateValues = values;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((chunk) => chunk[column as keyof TestChunk] === value);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push((chunk) =>
      values.includes(chunk[column as keyof TestChunk])
    );
    return this;
  }

  or(): this {
    // Tests contain no stale processing rows, so the recovery OR predicate is
    // intentionally a no-op in this focused in-memory adapter.
    return this;
  }

  order(): this {
    return this;
  }

  range(start: number, end: number): this {
    this.rangeStart = start;
    this.rangeEnd = end;
    return this;
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?:
      | ((value: QueryResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute(): QueryResult {
    const matches = this.database.chunks.filter((chunk) =>
      this.filters.every((filter) => filter(chunk))
    );

    if (this.operation === "select") {
      return {
        data: matches
          .sort((left, right) =>
            left.page_number - right.page_number ||
            left.chunk_index - right.chunk_index
          )
          .slice(this.rangeStart, this.rangeEnd + 1),
        error: null,
      };
    }

    if (this.operation === "update") {
      if (
        this.updateValues.embedding_status === "ready" &&
        matches.some((chunk) => chunk.id === this.database.failReadySaveFor)
      ) {
        return { data: null, error: { message: "simulated save failure" } };
      }

      for (const chunk of matches) Object.assign(chunk, this.updateValues);
      return {
        data: this.returningIds
          ? matches.map((chunk) => ({ id: chunk.id }))
          : null,
        error: null,
      };
    }

    return { data: null, error: { message: "unsupported test query" } };
  }
}

class TestDatabase {
  failReadySaveFor: string | null = null;

  constructor(readonly chunks: TestChunk[]) {}

  from(table: string): TestQuery {
    if (table !== "document_chunks") {
      throw new Error(`Unexpected test table: ${table}`);
    }
    return new TestQuery(this);
  }
}

function testChunk(id: string, content: string): TestChunk {
  return {
    id,
    document_id: "document-1",
    page_number: Number(id.slice(-1)),
    chunk_index: 0,
    content,
    content_hash: "old-hash",
    embedding_status: "failed",
    embedding_error: "previous failure",
    embedding_model: DEFAULT_GEMINI_EMBEDDING_MODEL,
    embedded_at: null,
    embedding: null,
  };
}

function vectorResponse(): Response {
  return new Response(JSON.stringify({
    embedding: {
      values: Array.from(
        { length: 768 },
        (_, valueIndex) => valueIndex === 0 ? 1 : 0,
      ),
    },
  }));
}

const NO_DELAY = () => Promise.resolve();

Deno.test("backfill retries failed chunks and remains idempotent", async () => {
  const chunk = testChunk("chunk-1", "Backfill this existing document chunk.");
  const database = new TestDatabase([chunk]);
  let requestCount = 0;
  const fetchEmbedding = async () => {
    requestCount += 1;
    return vectorResponse();
  };

  const firstResult = await embedDocumentChunks(
    database as never,
    "document-1",
    "test-key",
    "Backfill Guide.pdf",
    fetchEmbedding,
    NO_DELAY,
  );
  const secondResult = await embedDocumentChunks(
    database as never,
    "document-1",
    "test-key",
    "Backfill Guide.pdf",
    fetchEmbedding,
    NO_DELAY,
  );

  assertEquals(firstResult.status, "ready");
  assertEquals(secondResult.status, "skipped");
  assertEquals(requestCount, 1);
  assertEquals(chunk.embedding_status, "ready");
  assertEquals(
    chunk.content_hash,
    await stableContentHash(formatEmbeddingDocument(
      "Backfill this existing document chunk.",
      "Backfill Guide.pdf",
    )),
  );
});

Deno.test("a partial embedding save failure preserves completed chunks", async () => {
  const first = testChunk("chunk-1", "First chunk succeeds.");
  const second = testChunk("chunk-2", "Second chunk save fails.");
  const database = new TestDatabase([first, second]);
  database.failReadySaveFor = second.id;

  const result = await embedDocumentChunks(
    database as never,
    "document-1",
    "test-key",
    "Partial Save.pdf",
    async () => vectorResponse(),
    NO_DELAY,
  );

  assertEquals(result.status, "failed");
  assertEquals(result.embeddedChunks, 1);
  assertEquals(result.failedChunks, 1);
  assertEquals(first.embedding_status, "ready");
  assertEquals(second.embedding_status, "failed");
  assertEquals(second.content, "Second chunk save fails.");
});
