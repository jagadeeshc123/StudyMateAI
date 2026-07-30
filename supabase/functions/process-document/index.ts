import { extractText, getDocumentProxy } from "npm:unpdf@1.8.0";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireAuthenticatedUser } from "../_shared/auth.ts";
import { createSupabaseAdminClient } from "../_shared/supabase-admin.ts";
import {
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  GeminiEmbeddingError,
  stableContentHash,
} from "../_shared/gemini-embeddings.ts";
import {
  createRequestId,
  logOperational,
  requestJsonResponse,
  type SafeReasonCode,
} from "../_shared/request-context.ts";
import { chunkExtractedPages } from "../_shared/text.ts";
import { enforceRateLimit } from "../_shared/rate-limit.ts";
import { verifyOwnedPdfObject } from "../_shared/storage-object.ts";
import {
  type DocumentEmbeddingResult,
  embedDocumentChunks,
  pendingDocumentEmbeddingResult,
} from "./document-embeddings.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PDF_PAGES = 500;
const MAX_EXTRACTED_CHARACTERS = 2_000_000;
const MAX_DOCUMENT_CHUNKS = 2_500;
const PROCESSING_LEASE_SECONDS = 15 * 60;

interface ProcessDocumentBody {
  documentId?: unknown;
  action?: unknown;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Unknown document-processing error.";
}

async function attemptDocumentEmbeddings(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  documentId: string,
  documentTitle: string | null,
  requestId: string,
): Promise<DocumentEmbeddingResult> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  const targetModel = Deno.env.get("GEMINI_EMBEDDING_MODEL") ||
    DEFAULT_GEMINI_EMBEDDING_MODEL;

  const recordFailure = async (errorMessage: string) => {
    const failureValues = {
      embedding: null,
      embedding_status: "failed",
      embedding_error: errorMessage,
      embedding_model: targetModel,
      embedded_at: null,
    };
    const { error } = await supabase
      .from("document_chunks")
      .update(failureValues)
      .eq("document_id", documentId)
      .in("embedding_status", ["pending", "failed", "skipped"]);

    const { error: incompatibleError } = await supabase
      .from("document_chunks")
      .update(failureValues)
      .eq("document_id", documentId)
      .eq("embedding_status", "ready")
      .neq("embedding_model", targetModel);

    if (error || incompatibleError) {
      logOperational("error", {
        requestId,
        stage: "process-document-record-embedding-failure",
        httpStatus: 500,
        reasonCode: "database_failure",
      });
    }
  };

  if (!apiKey) {
    const errorMessage =
      "Semantic indexing is not configured. Keyword search remains available.";
    await recordFailure(errorMessage);
    logOperational("warn", {
      requestId,
      stage: "process-document-embeddings",
      httpStatus: 200,
      reasonCode: "provider_unavailable",
      model: targetModel,
    });
    return {
      status: "failed",
      totalChunks: 0,
      embeddedChunks: 0,
      skippedChunks: 0,
      failedChunks: 0,
      error: errorMessage,
    };
  }

  try {
    return await embedDocumentChunks(
      supabase,
      documentId,
      apiKey,
      documentTitle,
      fetch,
      undefined,
      requestId,
    );
  } catch (error) {
    const errorMessage = error instanceof GeminiEmbeddingError
      ? error.message
      : "Semantic indexing failed. Keyword search remains available.";
    logOperational("warn", {
      requestId,
      stage: "process-document-embeddings",
      httpStatus: 200,
      reasonCode: error instanceof GeminiEmbeddingError
        ? error.code === "quota"
          ? "provider_quota"
          : error.code === "authentication"
          ? "provider_authentication"
          : error.code === "model_unavailable"
          ? "provider_model_unavailable"
          : error.code === "dimension_mismatch"
          ? "provider_invalid_dimension"
          : error.code === "network_failure"
          ? "provider_network_failure"
          : error.code === "timeout"
          ? "provider_timeout"
          : "provider_unavailable"
        : "internal_failure",
    });
    await recordFailure(errorMessage);
    return {
      status: "failed",
      totalChunks: 0,
      embeddedChunks: 0,
      skippedChunks: 0,
      failedChunks: 0,
      error: errorMessage,
    };
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Only POST requests are supported." }, 405);
  }

  const requestId = createRequestId(request.headers.get("x-request-id"));
  const startedAt = Date.now();
  const respond = (
    body: Record<string, unknown>,
    status = 200,
    retryAfter?: number,
  ) =>
    requestJsonResponse(
      requestId,
      { ...body, ...(retryAfter ? { retryAfter } : {}) },
      status,
      retryAfter ? { "Retry-After": String(retryAfter) } : {},
    );
  const fail = (
    message: string,
    status: number,
    reasonCode: SafeReasonCode,
    retryAfter?: number,
  ) => {
    logOperational(status >= 500 ? "error" : "warn", {
      requestId,
      stage: "process-document",
      httpStatus: status,
      reasonCode,
      requestCount: 1,
      failureCount: 1,
      durationMs: Date.now() - startedAt,
    });
    return respond({ error: message }, status, retryAfter);
  };

  let supabase: ReturnType<typeof createSupabaseAdminClient> | null = null;
  let documentId: string | null = null;
  let userId: string | null = null;
  let processingLeaseId: string | null = null;
  let recoveredStaleLease = false;

  try {
    const { user, supabase: callerSupabase } = await requireAuthenticatedUser(
      request,
    );
    userId = user.id;
    const body = (await request.json()) as ProcessDocumentBody;
    documentId = typeof body.documentId === "string" ? body.documentId : null;
    const action = body.action === "backfill_embeddings"
      ? "backfill_embeddings"
      : "process";

    if (!documentId || !UUID_PATTERN.test(documentId)) {
      return fail("A valid document ID is required.", 400, "invalid_request");
    }

    const { data: document, error: documentError } = await callerSupabase
      .from("documents")
      .select(
        "id, user_id, storage_path, file_size, mime_type, processing_status, display_name, original_file_name",
      )
      .eq("id", documentId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (documentError) {
      return fail(
        "The document could not be checked before processing.",
        500,
        "database_failure",
      );
    }

    if (!document || document.user_id !== user.id) {
      return fail("Document not found or unavailable.", 404, "not_found");
    }

    const documentTitle = document.display_name?.trim() ||
      document.original_file_name?.trim() || null;

    if (action === "backfill_embeddings") {
      await enforceRateLimit(user.id, "embedding_backfill", requestId);
      if (document.processing_status !== "ready") {
        return fail(
          "Embeddings can only be created after PDF text extraction is ready.",
          409,
          "conflict",
        );
      }

      supabase = createSupabaseAdminClient();
      const embedding = await attemptDocumentEmbeddings(
        supabase,
        documentId,
        documentTitle,
        requestId,
      );
      logOperational(embedding.status === "failed" ? "warn" : "info", {
        requestId,
        stage: "process-document-backfill-complete",
        httpStatus: 200,
        reasonCode: embedding.status === "failed"
          ? "provider_unavailable"
          : "none",
        chunkCount: embedding.totalChunks,
        durationMs: Date.now() - startedAt,
      });
      return respond({
        documentId,
        status: "ready",
        embedding,
      });
    }

    await enforceRateLimit(user.id, "process_document", requestId);

    if (document.mime_type !== "application/pdf") {
      throw new Error("The stored document is not a PDF.");
    }

    supabase = createSupabaseAdminClient();
    const verifiedObject = await verifyOwnedPdfObject(user.id, documentId);
    if (
      !verifiedObject || verifiedObject.path !== document.storage_path ||
      verifiedObject.size !== document.file_size ||
      verifiedObject.mimeType !== document.mime_type
    ) {
      return fail(
        "The registered PDF is missing or does not match its verified upload. Upload it again.",
        422,
        "storage_failure",
      );
    }

    processingLeaseId = crypto.randomUUID();
    const { data: claimRows, error: processingStatusError } = await supabase
      .rpc(
        "claim_document_processing",
        {
          target_document_id: documentId,
          target_user_id: user.id,
          requested_lease_id: processingLeaseId,
          stale_after_seconds: PROCESSING_LEASE_SECONDS,
          maximum_active_jobs: 2,
          retry_delay_seconds: 60,
        },
      );
    if (processingStatusError) {
      throw new Error("Could not claim document processing safely.");
    }
    const claim = (claimRows as
      | Array<{
        claim_status: string;
        recovered_stale_lease: boolean;
        retry_after_seconds: number;
      }>
      | null)?.[0];
    if (!claim || claim.claim_status === "not_found") {
      processingLeaseId = null;
      return fail("Document not found or unavailable.", 404, "not_found");
    }
    if (claim.claim_status === "active") {
      processingLeaseId = null;
      return fail(
        "This document is already being processed. Please wait before retrying.",
        409,
        "processing_active",
        claim.retry_after_seconds,
      );
    }
    if (claim.claim_status === "retry_later") {
      processingLeaseId = null;
      return fail(
        "Please wait before retrying this document.",
        429,
        "rate_limited",
        claim.retry_after_seconds,
      );
    }
    if (claim.claim_status === "too_many_active") {
      processingLeaseId = null;
      return fail(
        "Too many processing jobs are active. Please wait before retrying.",
        429,
        "rate_limited",
        claim.retry_after_seconds,
      );
    }
    if (claim.claim_status !== "claimed") {
      processingLeaseId = null;
      return fail(
        "This document is not in a retryable processing state.",
        409,
        "conflict",
      );
    }
    recoveredStaleLease = claim.recovered_stale_lease;
    if (recoveredStaleLease) {
      logOperational("warn", {
        requestId,
        functionName: "process-document",
        operationType: "extraction",
        stage: "process-document-stale-lease-recovered",
        httpStatus: 200,
        reasonCode: "stale_lease_recovered",
        staleLeaseRecoveryCount: 1,
      });
    }

    const { data: pdfFile, error: downloadError } = await supabase.storage
      .from("documents")
      .download(verifiedObject.path);

    if (downloadError || !pdfFile) {
      throw new Error(
        `Could not download the private PDF: ${
          downloadError?.message ?? "No file was returned."
        }`,
      );
    }

    const pdfBytes = new Uint8Array(await pdfFile.arrayBuffer());
    const extractionStartedAt = Date.now();
    const pdf = await getDocumentProxy(pdfBytes);
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new HttpError(
        422,
        "PDF is too large for synchronous processing. Use a PDF with 500 pages or fewer.",
        "resource_limit",
      );
    }
    const extracted = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(extracted.text)
      ? extracted.text
      : [extracted.text];
    const chunks = chunkExtractedPages(pages);
    const extractedCharacterCount = pages.reduce(
      (total, page) => total + page.length,
      0,
    );

    if (extractedCharacterCount > MAX_EXTRACTED_CHARACTERS) {
      throw new HttpError(
        422,
        "PDF is too large for synchronous processing. Reduce its searchable text and retry.",
        "resource_limit",
      );
    }
    if (chunks.length > MAX_DOCUMENT_CHUNKS) {
      throw new HttpError(
        422,
        "PDF produces too many searchable sections for synchronous processing.",
        "resource_limit",
      );
    }

    if (chunks.length === 0) {
      throw new Error(
        "No searchable text was found in this PDF. Scanned/image-only PDFs need OCR, which is not part of this MVP.",
      );
    }

    const chunksWithHashes = await Promise.all(chunks.map(async (chunk) => ({
      ...chunk,
      content_hash: await stableContentHash(chunk.content),
      embedding_status: "pending",
    })));

    const { data: heartbeatAccepted, error: heartbeatError } = await supabase
      .rpc("heartbeat_document_processing", {
        target_document_id: documentId,
        target_user_id: user.id,
        target_lease_id: processingLeaseId,
      });
    if (heartbeatError || heartbeatAccepted !== true) {
      throw new Error("The document processing lease expired.");
    }

    const chunkInsertionStartedAt = Date.now();
    const { data: savedChunkCount, error: completionError } = await supabase
      .rpc("complete_document_extraction", {
        target_document_id: documentId,
        target_user_id: user.id,
        target_lease_id: processingLeaseId,
        extracted_page_count: extracted.totalPages,
        extracted_character_count: extractedCharacterCount,
        extracted_chunks: chunksWithHashes,
      });
    if (completionError || savedChunkCount !== chunks.length) {
      throw new Error("The extracted text could not be saved atomically.");
    }
    processingLeaseId = null;
    logOperational("info", {
      requestId,
      functionName: "process-document",
      operationType: "extraction",
      stage: "process-document-extraction-complete",
      httpStatus: 200,
      reasonCode: "none",
      requestCount: 1,
      successCount: 1,
      chunkCount: chunks.length,
      pageCount: extracted.totalPages,
      extractedCharacterCount,
      chunkInsertionDurationMs: Date.now() - chunkInsertionStartedAt,
      documentReadyAt: new Date().toISOString(),
      contextCharacterCount: extractedCharacterCount,
      extractionDurationMs: Date.now() - extractionStartedAt,
    });

    logOperational("info", {
      requestId,
      stage: "process-document-complete",
      httpStatus: 200,
      reasonCode: "none",
      chunkCount: chunks.length,
      durationMs: Date.now() - startedAt,
    });
    return respond({
      documentId,
      status: "ready",
      pageCount: extracted.totalPages,
      chunkCount: chunks.length,
      recoveredStaleLease,
      embedding: pendingDocumentEmbeddingResult(chunks.length),
    });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    const safeErrorMessage = error instanceof HttpError
      ? error.message
      : errorMessage.startsWith("No searchable text was found")
      ? errorMessage
      : errorMessage === "The stored document is not a PDF."
      ? errorMessage
      : "PDF processing failed. Please retry or upload a different searchable PDF.";
    const userInputFailure = safeErrorMessage.startsWith(
      "No searchable text was found",
    ) || safeErrorMessage === "The stored document is not a PDF.";

    if (supabase && documentId && userId && processingLeaseId) {
      const { error: failedStatusError } = await supabase.rpc(
        "fail_document_processing",
        {
          target_document_id: documentId,
          target_user_id: userId,
          target_lease_id: processingLeaseId,
          safe_failure_reason: safeErrorMessage,
        },
      );

      if (failedStatusError) {
        logOperational("error", {
          requestId,
          stage: "process-document-record-failure",
          httpStatus: 500,
          reasonCode: "database_failure",
          durationMs: Date.now() - startedAt,
        });
      }
    }

    return fail(
      safeErrorMessage,
      error instanceof HttpError ? error.status : userInputFailure ? 422 : 500,
      error instanceof HttpError
        ? error.reasonCode
        : errorMessage === "The document processing lease expired."
        ? "processing_timeout"
        : errorMessage.startsWith("No searchable text was found")
        ? "no_chunks_created"
        : "extraction_failed",
      error instanceof HttpError ? error.retryAfterSeconds : undefined,
    );
  }
});
