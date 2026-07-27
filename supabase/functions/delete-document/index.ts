import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireAuthenticatedUser } from "../_shared/auth.ts";
import { createSupabaseAdminClient } from "../_shared/supabase-admin.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface DeleteDocumentBody {
  documentId?: unknown;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Only POST requests are supported." }, 405);
  }

  try {
    const { user, supabase: callerSupabase } = await requireAuthenticatedUser(request);
    const body = (await request.json()) as DeleteDocumentBody;
    const documentId = typeof body.documentId === "string" ? body.documentId : "";

    if (!UUID_PATTERN.test(documentId)) {
      return jsonResponse({ error: "A valid document ID is required." }, 400);
    }

    const { data: document, error: documentError } = await callerSupabase
      .from("documents")
      .select("id, user_id, storage_path, processing_status")
      .eq("id", documentId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (documentError) {
      throw new Error(`Could not load the document: ${documentError.message}`);
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

    const previousStatus = document.processing_status === "deleting"
      ? null
      : document.processing_status;
    const supabase = createSupabaseAdminClient();
    if (previousStatus) {
      const { data: claimedDocument, error: claimError } = await supabase
        .from("documents")
        .update({ processing_status: "deleting" })
        .eq("id", documentId)
        .eq("user_id", user.id)
        .eq("processing_status", previousStatus)
        .select("id")
        .maybeSingle();

      if (claimError) {
        throw new Error(`Could not begin document deletion: ${claimError.message}`);
      }

      if (!claimedDocument) {
        return jsonResponse({ error: "The document changed while deletion was starting. Refresh and try again." }, 409);
      }
    }

    const { error: storageError } = await supabase.storage
      .from("documents")
      .remove([document.storage_path]);

    if (storageError) {
      if (previousStatus) {
        const { error: restoreError } = await supabase
          .from("documents")
          .update({ processing_status: previousStatus })
          .eq("id", documentId)
          .eq("user_id", user.id)
          .eq("processing_status", "deleting");

        if (restoreError) {
          console.error("Could not restore document status after Storage deletion failed", {
            documentId,
            error: restoreError.message,
          });
        }
      }

      return jsonResponse({
        error: `The private file could not be deleted. The document was kept: ${storageError.message}`,
      }, 502);
    }

    const { data: deletedDocument, error: deleteError } = await supabase
      .from("documents")
      .delete()
      .eq("id", documentId)
      .eq("user_id", user.id)
      .eq("processing_status", "deleting")
      .select("id")
      .maybeSingle();

    if (deleteError) {
      console.error("Storage object was deleted but the document row could not be removed", {
        documentId,
        error: deleteError.message,
      });
      return jsonResponse({
        error: "The private file was deleted, but its document record could not be removed. Please retry deletion.",
      }, 500);
    }

    // A concurrent retry may have deleted the same row after both requests removed
    // the same private object. Treat that idempotent outcome as success.
    if (!deletedDocument) {
      console.info("Document row was already removed by a concurrent deletion", { documentId });
    }

    return jsonResponse({ documentId, deleted: true });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse({ error: error.message }, error.status);
    }

    const message = error instanceof Error ? error.message : "Unexpected document deletion error.";
    console.error("delete-document failed", message);
    return jsonResponse({ error: message }, 500);
  }
});
