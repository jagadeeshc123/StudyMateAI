import {
  embeddingConfigurationFromEnvironment,
  embeddingToPostgres,
  formatEmbeddingDocument,
  GEMINI_EMBEDDING_BATCH_SIZE,
  GeminiEmbeddingError,
  type GeminiEmbeddingFetch,
  generateGeminiEmbeddings,
  normalizeEmbeddingText,
  stableContentHash,
} from "../_shared/gemini-embeddings.ts";
import { createSupabaseAdminClient } from "../_shared/supabase-admin.ts";
import {
  logOperational,
  type SafeReasonCode,
} from "../_shared/request-context.ts";

const CHUNK_LOAD_PAGE_SIZE = 500;
const FREE_TIER_BATCH_PAUSE_MS = 6_000;
const PROCESSING_LEASE_MINUTES = 10;

export interface StoredEmbeddingChunk {
  id: string;
  content: string;
  content_hash: string;
  embedding_status: string;
  embedding_model: string | null;
  embedding: unknown;
}

export interface PlannedEmbeddingChunk {
  id: string;
  embeddingInput: string;
  contentHash: string;
}

export interface DocumentEmbeddingResult {
  status: "ready" | "failed" | "skipped";
  totalChunks: number;
  embeddedChunks: number;
  skippedChunks: number;
  failedChunks: number;
  error: string | null;
}

export async function planDocumentEmbeddings(
  chunks: StoredEmbeddingChunk[],
  model: string,
  documentTitle?: string | null,
): Promise<PlannedEmbeddingChunk[]> {
  const planned: PlannedEmbeddingChunk[] = [];

  for (const chunk of chunks) {
    const normalizedContent = normalizeEmbeddingText(chunk.content);
    const embeddingInput = formatEmbeddingDocument(
      normalizedContent,
      documentTitle,
    );
    const contentHash = await stableContentHash(embeddingInput);
    const unchangedReadyEmbedding = chunk.embedding_status === "ready" &&
      chunk.embedding !== null &&
      chunk.embedding_model === model &&
      chunk.content_hash === contentHash;

    if (!unchangedReadyEmbedding) {
      planned.push({ id: chunk.id, embeddingInput, contentHash });
    }
  }

  return planned;
}

async function loadDocumentChunks(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  documentId: string,
): Promise<StoredEmbeddingChunk[]> {
  const chunks: StoredEmbeddingChunk[] = [];

  for (let offset = 0;; offset += CHUNK_LOAD_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("document_chunks")
      .select(
        "id, content, content_hash, embedding_status, embedding_model, embedding",
      )
      .eq("document_id", documentId)
      .order("page_number", { ascending: true })
      .order("chunk_index", { ascending: true })
      .range(offset, offset + CHUNK_LOAD_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Could not load chunks for embedding: ${error.message}`);
    }

    const page = (data ?? []) as StoredEmbeddingChunk[];
    chunks.push(...page);
    if (page.length < CHUNK_LOAD_PAGE_SIZE) break;
  }

  return chunks;
}

function safeEmbeddingError(error: unknown): string {
  if (error instanceof GeminiEmbeddingError) return error.message;
  return "Semantic indexing failed. Keyword search remains available.";
}

function embeddingReasonCode(errorCode: string): SafeReasonCode {
  switch (errorCode) {
    case "authentication":
      return "provider_authentication";
    case "quota":
      return "provider_quota";
    case "model_unavailable":
      return "provider_model_unavailable";
    case "timeout":
      return "provider_timeout";
    case "network_failure":
      return "provider_network_failure";
    case "dimension_mismatch":
      return "provider_invalid_dimension";
    default:
      return "provider_unavailable";
  }
}

async function markEmbeddingBatchFailed(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  chunkIds: string[],
  model: string,
  errorMessage: string,
  requestId: string,
): Promise<void> {
  if (chunkIds.length === 0) return;

  const { error } = await supabase
    .from("document_chunks")
    .update({
      embedding: null,
      embedding_status: "failed",
      embedding_error: errorMessage,
      embedding_model: model,
      embedded_at: null,
    })
    .in("id", chunkIds)
    .eq("embedding_status", "processing");

  if (error) {
    logOperational("error", {
      requestId,
      stage: "process-document-record-embedding-batch-failure",
      httpStatus: 500,
      reasonCode: "database_failure",
      chunkCount: chunkIds.length,
    });
  }
}

const defaultDelay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function embedDocumentChunks(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  documentId: string,
  apiKey: string,
  documentTitle: string | null,
  fetchEmbedding: GeminiEmbeddingFetch = fetch,
  delay: (milliseconds: number) => Promise<void> = defaultDelay,
  requestId: string = crypto.randomUUID(),
): Promise<DocumentEmbeddingResult> {
  const configuration = embeddingConfigurationFromEnvironment();
  const staleBefore = new Date(
    Date.now() - PROCESSING_LEASE_MINUTES * 60_000,
  ).toISOString();
  const { error: staleClaimError } = await supabase
    .from("document_chunks")
    .update({
      embedding_status: "pending",
      embedding_error: "A previous embedding attempt was interrupted.",
      embedded_at: null,
    })
    .eq("document_id", documentId)
    .eq("embedding_status", "processing")
    .or(`embedded_at.is.null,embedded_at.lt.${staleBefore}`);

  if (staleClaimError) {
    throw new Error(
      `Could not recover interrupted embedding work: ${staleClaimError.message}`,
    );
  }

  const chunks = await loadDocumentChunks(supabase, documentId);
  const planned = await planDocumentEmbeddings(
    chunks,
    configuration.model,
    documentTitle,
  );
  const skippedChunks = chunks.length - planned.length;

  if (planned.length === 0) {
    return {
      status: chunks.length > 0 ? "skipped" : "ready",
      totalChunks: chunks.length,
      embeddedChunks: 0,
      skippedChunks,
      failedChunks: 0,
      error: null,
    };
  }

  let embeddedChunks = 0;
  let failedChunks = 0;
  let lastError: string | null = null;

  for (
    let offset = 0;
    offset < planned.length;
    offset += GEMINI_EMBEDDING_BATCH_SIZE
  ) {
    const batch = planned.slice(offset, offset + GEMINI_EMBEDDING_BATCH_SIZE);
    const { data: claimedRows, error: claimError } = await supabase
      .from("document_chunks")
      .update({
        embedding: null,
        embedding_status: "processing",
        embedding_error: null,
        embedding_model: configuration.model,
        embedded_at: new Date().toISOString(),
      })
      .in("id", batch.map((chunk) => chunk.id))
      .in("embedding_status", ["pending", "failed", "skipped", "ready"])
      .select("id");

    if (claimError) {
      throw new Error(
        `Could not claim chunks for embedding: ${claimError.message}`,
      );
    }

    const claimedIds = new Set(
      (claimedRows ?? []).map((row) => String(row.id)),
    );
    const claimedBatch = batch.filter((chunk) => claimedIds.has(chunk.id));
    if (claimedBatch.length === 0) continue;
    let savedInBatch = 0;

    try {
      const embeddings = await generateGeminiEmbeddings(
        claimedBatch.map((chunk) => chunk.embeddingInput),
        {
          apiKey,
          model: configuration.model,
          dimensions: configuration.dimensions,
        },
        fetchEmbedding,
        (level, diagnostic) =>
          logOperational(level, {
            requestId,
            stage: "process-document-embedding-provider",
            httpStatus: diagnostic.httpStatus ?? 0,
            reasonCode: diagnostic.errorCode === "none"
              ? "none"
              : embeddingReasonCode(diagnostic.errorCode),
            model: diagnostic.model,
            chunkCount: diagnostic.inputCount,
          }),
        delay,
      );

      for (let index = 0; index < claimedBatch.length; index += 1) {
        const chunk = claimedBatch[index];
        const { error: saveError } = await supabase
          .from("document_chunks")
          .update({
            embedding: embeddingToPostgres(embeddings[index]),
            embedding_status: "ready",
            embedding_error: null,
            embedding_model: configuration.model,
            embedded_at: new Date().toISOString(),
            content_hash: chunk.contentHash,
          })
          .eq("id", chunk.id)
          .eq("embedding_status", "processing");

        if (saveError) {
          throw new Error(
            `Could not save a chunk embedding: ${saveError.message}`,
          );
        }
        embeddedChunks += 1;
        savedInBatch += 1;
      }
    } catch (error) {
      lastError = safeEmbeddingError(error);
      const failedBatch = claimedBatch.slice(savedInBatch);
      failedChunks += failedBatch.length;
      await markEmbeddingBatchFailed(
        supabase,
        failedBatch.map((chunk) => chunk.id),
        configuration.model,
        lastError,
        requestId,
      );
      break;
    }

    if (offset + GEMINI_EMBEDDING_BATCH_SIZE < planned.length) {
      await delay(FREE_TIER_BATCH_PAUSE_MS);
    }
  }

  logOperational(failedChunks > 0 ? "warn" : "info", {
    requestId,
    stage: "process-document-embedding-result",
    httpStatus: 200,
    reasonCode: failedChunks > 0 ? "provider_unavailable" : "none",
    model: configuration.model,
    chunkCount: chunks.length,
  });

  return {
    status: failedChunks > 0
      ? "failed"
      : embeddedChunks > 0
      ? "ready"
      : "skipped",
    totalChunks: chunks.length,
    embeddedChunks,
    skippedChunks,
    failedChunks,
    error: lastError,
  };
}
