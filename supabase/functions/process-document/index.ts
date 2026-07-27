import { extractText, getDocumentProxy } from "npm:unpdf@1.8.0";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireAuthenticatedUser } from "../_shared/auth.ts";
import { createSupabaseAdminClient } from "../_shared/supabase-admin.ts";
import { chunkExtractedPages } from "../_shared/text.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSERT_BATCH_SIZE = 250;

interface ProcessDocumentBody {
  documentId?: unknown;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown document-processing error.";
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Only POST requests are supported." }, 405);
  }

  let supabase: ReturnType<typeof createSupabaseAdminClient> | null = null;
  let documentId: string | null = null;
  let documentExists = false;

  try {
    const { user, supabase: callerSupabase } = await requireAuthenticatedUser(request);
    const body = (await request.json()) as ProcessDocumentBody;
    documentId = typeof body.documentId === "string" ? body.documentId : null;

    if (!documentId || !UUID_PATTERN.test(documentId)) {
      return jsonResponse({ error: "A valid document ID is required." }, 400);
    }

    const { data: document, error: documentError } = await callerSupabase
      .from("documents")
      .select("id, user_id, storage_path, mime_type, processing_status")
      .eq("id", documentId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (documentError) {
      throw new Error(`Could not load the document record: ${documentError.message}`);
    }

    if (!document || document.user_id !== user.id) {
      const ownershipLookup = createSupabaseAdminClient();
      const { data: existingDocument, error: lookupError } = await ownershipLookup
        .from("documents")
        .select("id")
        .eq("id", documentId)
        .maybeSingle();

      if (lookupError) {
        throw new Error(`Could not verify document ownership: ${lookupError.message}`);
      }

      return existingDocument
        ? jsonResponse({ error: "You do not have access to this document." }, 403)
        : jsonResponse({ error: "Document not found." }, 404);
    }

    documentExists = true;

    if (document.mime_type !== "application/pdf") {
      throw new Error("The stored document is not a PDF.");
    }

    if (document.processing_status !== "uploaded" && document.processing_status !== "failed") {
      return jsonResponse({
        error: document.processing_status === "processing"
          ? "This document is already processing."
          : `This document cannot be processed while its status is ${document.processing_status}.`,
      }, 409);
    }

    supabase = createSupabaseAdminClient();
    const { data: claimedDocument, error: processingStatusError } = await supabase
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
      throw new Error(`Could not mark the document as processing: ${processingStatusError.message}`);
    }

    if (!claimedDocument) {
      return jsonResponse({ error: "This document is already processing or is no longer retryable." }, 409);
    }

    const { error: clearChunksError } = await supabase
      .from("document_chunks")
      .delete()
      .eq("document_id", documentId);

    if (clearChunksError) {
      throw new Error(`Could not clear previous document chunks: ${clearChunksError.message}`);
    }

    const { data: pdfFile, error: downloadError } = await supabase.storage
      .from("documents")
      .download(document.storage_path);

    if (downloadError || !pdfFile) {
      throw new Error(`Could not download the private PDF: ${downloadError?.message ?? "No file was returned."}`);
    }

    const pdfBytes = new Uint8Array(await pdfFile.arrayBuffer());
    const pdf = await getDocumentProxy(pdfBytes);
    const extracted = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(extracted.text) ? extracted.text : [extracted.text];
    const chunks = chunkExtractedPages(pages);

    if (chunks.length === 0) {
      throw new Error("No searchable text was found in this PDF. Scanned/image-only PDFs need OCR, which is not part of this MVP.");
    }

    for (let offset = 0; offset < chunks.length; offset += INSERT_BATCH_SIZE) {
      const batch = chunks.slice(offset, offset + INSERT_BATCH_SIZE).map((chunk) => ({
        ...chunk,
        document_id: documentId,
      }));
      const { error: insertError } = await supabase.from("document_chunks").insert(batch);

      if (insertError) {
        throw new Error(`Could not save extracted text: ${insertError.message}`);
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
      throw new Error(`The text was extracted, but the ready status could not be saved: ${readyStatusError.message}`);
    }

    if (!readyDocument) {
      throw new Error("The document changed or was deleted while processing.");
    }

    return jsonResponse({
      documentId,
      status: "ready",
      pageCount: extracted.totalPages,
      chunkCount: chunks.length,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse({ error: error.message }, error.status);
    }

    const errorMessage = getErrorMessage(error);
    console.error("process-document failed", { documentId, error: errorMessage });

    if (supabase && documentId && documentExists) {
      const { error: failedStatusError } = await supabase
        .from("documents")
        .update({
          processing_status: "failed",
          processing_error: errorMessage,
          page_count: null,
        })
        .eq("id", documentId)
        .eq("processing_status", "processing");

      if (failedStatusError) {
        console.error("Could not mark document as failed", failedStatusError.message);
      }
    }

    return jsonResponse({ error: errorMessage }, 500);
  }
});
