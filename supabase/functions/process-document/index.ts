import { extractText, getDocumentProxy } from "npm:unpdf@1.8.0";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
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

  const supabase = createSupabaseAdminClient();
  let documentId: string | null = null;
  let documentExists = false;

  try {
    const body = (await request.json()) as ProcessDocumentBody;
    documentId = typeof body.documentId === "string" ? body.documentId : null;

    if (!documentId || !UUID_PATTERN.test(documentId)) {
      return jsonResponse({ error: "A valid document ID is required." }, 400);
    }

    const { data: document, error: documentError } = await supabase
      .from("documents")
      .select("id, storage_path, mime_type")
      .eq("id", documentId)
      .maybeSingle();

    if (documentError) {
      throw new Error(`Could not load the document record: ${documentError.message}`);
    }

    if (!document) {
      return jsonResponse({ error: "Document not found." }, 404);
    }

    documentExists = true;

    if (document.mime_type !== "application/pdf") {
      throw new Error("The stored document is not a PDF.");
    }

    const { error: processingStatusError } = await supabase
      .from("documents")
      .update({ processing_status: "processing" })
      .eq("id", documentId);

    if (processingStatusError) {
      throw new Error(`Could not mark the document as processing: ${processingStatusError.message}`);
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

    const { error: deleteError } = await supabase
      .from("document_chunks")
      .delete()
      .eq("document_id", documentId);

    if (deleteError) {
      throw new Error(`Could not replace existing document chunks: ${deleteError.message}`);
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

    const { error: readyStatusError } = await supabase
      .from("documents")
      .update({ processing_status: "ready" })
      .eq("id", documentId);

    if (readyStatusError) {
      throw new Error(`The text was extracted, but the ready status could not be saved: ${readyStatusError.message}`);
    }

    return jsonResponse({
      documentId,
      status: "ready",
      pageCount: extracted.totalPages,
      chunkCount: chunks.length,
    });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error("process-document failed", { documentId, error: errorMessage });

    if (documentId && documentExists) {
      const { error: failedStatusError } = await supabase
        .from("documents")
        .update({ processing_status: "failed" })
        .eq("id", documentId);

      if (failedStatusError) {
        console.error("Could not mark document as failed", failedStatusError.message);
      }
    }

    return jsonResponse({ error: errorMessage }, 500);
  }
});
