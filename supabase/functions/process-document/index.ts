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
import {
  type DocumentEmbeddingResult,
  embedDocumentChunks,
} from "./document-embeddings.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSERT_BATCH_SIZE = 250;

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

  const requestId = createRequestId();
  const startedAt = Date.now();
  const respond = (body: Record<string, unknown>, status = 200) =>
    requestJsonResponse(requestId, body, status);
  const fail = (
    message: string,
    status: number,
    reasonCode: SafeReasonCode,
  ) => {
    logOperational(status >= 500 ? "error" : "warn", {
      requestId,
      stage: "process-document",
      httpStatus: status,
      reasonCode,
      durationMs: Date.now() - startedAt,
    });
    return respond({ error: message }, status);
  };

  let supabase: ReturnType<typeof createSupabaseAdminClient> | null = null;
  let documentId: string | null = null;
  let documentExists = false;

  try {
    const { user, supabase: callerSupabase } = await requireAuthenticatedUser(
      request,
    );
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
        "id, user_id, storage_path, mime_type, processing_status, display_name, original_file_name",
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

    documentExists = true;
    const documentTitle = document.display_name?.trim() ||
      document.original_file_name?.trim() || null;

    if (action === "backfill_embeddings") {
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

    if (document.mime_type !== "application/pdf") {
      throw new Error("The stored document is not a PDF.");
    }

    if (
      document.processing_status !== "uploaded" &&
      document.processing_status !== "failed"
    ) {
      return fail(
        document.processing_status === "processing"
          ? "This document is already processing."
          : "This document is not in a retryable processing state.",
        409,
        "conflict",
      );
    }

    supabase = createSupabaseAdminClient();
    const { data: claimedDocument, error: processingStatusError } =
      await supabase
        .from("documents")
        .update({
          processing_status: "processing",
          processing_error: null,
          page_count: null,
        })
        .eq("id", documentId)
        .eq("user_id", user.id)
        .in("processing_status", ["uploaded", "failed"])
        .select("id")
        .maybeSingle();

    if (processingStatusError) {
      throw new Error(
        `Could not mark the document as processing: ${processingStatusError.message}`,
      );
    }

    if (!claimedDocument) {
      return fail(
        "This document is already processing or is no longer retryable.",
        409,
        "conflict",
      );
    }

    const { error: clearChunksError } = await supabase
      .from("document_chunks")
      .delete()
      .eq("document_id", documentId);

    if (clearChunksError) {
      throw new Error(
        `Could not clear previous document chunks: ${clearChunksError.message}`,
      );
    }

    const { data: pdfFile, error: downloadError } = await supabase.storage
      .from("documents")
      .download(document.storage_path);

    if (downloadError || !pdfFile) {
      throw new Error(
        `Could not download the private PDF: ${
          downloadError?.message ?? "No file was returned."
        }`,
      );
    }

    const pdfBytes = new Uint8Array(await pdfFile.arrayBuffer());
    const pdf = await getDocumentProxy(pdfBytes);
    const extracted = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(extracted.text)
      ? extracted.text
      : [extracted.text];
    const chunks = chunkExtractedPages(pages);

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

    for (
      let offset = 0;
      offset < chunksWithHashes.length;
      offset += INSERT_BATCH_SIZE
    ) {
      const batch = chunksWithHashes.slice(offset, offset + INSERT_BATCH_SIZE)
        .map((chunk) => ({
          ...chunk,
          document_id: documentId,
        }));
      const { error: insertError } = await supabase.from("document_chunks")
        .insert(batch);

      if (insertError) {
        throw new Error(
          `Could not save extracted text: ${insertError.message}`,
        );
      }
    }

    const { data: readyDocument, error: readyStatusError } = await supabase
      .from("documents")
      .update({
        processing_status: "ready",
        processing_error: null,
        page_count: extracted.totalPages,
      })
      .eq("id", documentId)
      .eq("user_id", user.id)
      .eq("processing_status", "processing")
      .select("id")
      .maybeSingle();

    if (readyStatusError) {
      throw new Error(
        `The text was extracted, but the ready status could not be saved: ${readyStatusError.message}`,
      );
    }

    if (!readyDocument) {
      throw new Error("The document changed or was deleted while processing.");
    }

    // Extraction readiness is independent from semantic-search readiness.
    // Every embedding failure is contained so keyword Q&A remains available.
    const embedding = await attemptDocumentEmbeddings(
      supabase,
      documentId,
      documentTitle,
      requestId,
    );

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
      embedding,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return fail(error.message, error.status, error.reasonCode);
    }

    const errorMessage = getErrorMessage(error);
    const safeErrorMessage =
      errorMessage.startsWith("No searchable text was found")
        ? errorMessage
        : errorMessage === "The stored document is not a PDF."
        ? errorMessage
        : "PDF processing failed. Please retry or upload a different searchable PDF.";
    const userInputFailure = safeErrorMessage.startsWith(
      "No searchable text was found",
    ) || safeErrorMessage === "The stored document is not a PDF.";

    if (supabase && documentId && documentExists) {
      const { error: failedStatusError } = await supabase
        .from("documents")
        .update({
          processing_status: "failed",
          processing_error: safeErrorMessage,
          page_count: null,
        })
        .eq("id", documentId)
        .eq("processing_status", "processing");

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
      userInputFailure ? 422 : 500,
      userInputFailure ? "invalid_request" : "internal_failure",
    );
  }
});
