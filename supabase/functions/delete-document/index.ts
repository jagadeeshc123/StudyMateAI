import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireAuthenticatedUser } from "../_shared/auth.ts";
import { createSupabaseAdminClient } from "../_shared/supabase-admin.ts";
import {
  createRequestId,
  logOperational,
  requestJsonResponse,
  type SafeReasonCode,
} from "../_shared/request-context.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      stage: "delete-document",
      httpStatus: status,
      reasonCode,
      durationMs: Date.now() - startedAt,
    });
    return respond({ error: message }, status);
  };

  try {
    const { user, supabase: callerSupabase } = await requireAuthenticatedUser(
      request,
    );
    const body = (await request.json()) as DeleteDocumentBody;
    const documentId = typeof body.documentId === "string"
      ? body.documentId
      : "";

    if (!UUID_PATTERN.test(documentId)) {
      return fail("A valid document ID is required.", 400, "invalid_request");
    }

    const { data: document, error: documentError } = await callerSupabase
      .from("documents")
      .select("id, user_id, storage_path, processing_status")
      .eq("id", documentId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (documentError) {
      return fail(
        "The document could not be checked before deletion.",
        500,
        "database_failure",
      );
    }

    if (!document || document.user_id !== user.id) {
      return fail("Document not found or unavailable.", 404, "not_found");
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
        return fail(
          "Document deletion could not be started. Please retry.",
          500,
          "database_failure",
        );
      }

      if (!claimedDocument) {
        return fail(
          "The document changed while deletion was starting. Refresh and try again.",
          409,
          "conflict",
        );
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
          logOperational("error", {
            requestId,
            stage: "delete-document-restore-status",
            httpStatus: 500,
            reasonCode: "database_failure",
            durationMs: Date.now() - startedAt,
          });
        }
      }

      return fail(
        "The private file could not be deleted. The document record was kept so you can retry safely.",
        502,
        "storage_failure",
      );
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
      return fail(
        "The private file was deleted, but its document record could not be removed. Please retry deletion.",
        500,
        "database_failure",
      );
    }

    // A concurrent retry may have deleted the same row after both requests removed
    // the same private object. Treat that idempotent outcome as success.
    if (!deletedDocument) {
      logOperational("info", {
        requestId,
        stage: "delete-document-idempotent-retry",
        httpStatus: 200,
        reasonCode: "none",
        durationMs: Date.now() - startedAt,
      });
    }

    logOperational("info", {
      requestId,
      stage: "delete-document-complete",
      httpStatus: 200,
      reasonCode: "none",
      durationMs: Date.now() - startedAt,
    });
    return respond({ documentId, deleted: true });
  } catch (error) {
    if (error instanceof HttpError) {
      return fail(error.message, error.status, error.reasonCode);
    }

    return fail(
      "Document deletion failed unexpectedly. Please retry.",
      500,
      "internal_failure",
    );
  }
});
