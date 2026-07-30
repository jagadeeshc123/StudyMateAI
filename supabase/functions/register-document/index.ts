import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireAuthenticatedUser } from "../_shared/auth.ts";
import { createSupabaseAdminClient } from "../_shared/supabase-admin.ts";
import { enforceRateLimit } from "../_shared/rate-limit.ts";
import { verifyOwnedPdfObject } from "../_shared/storage-object.ts";
import {
  createRequestId,
  logOperational,
  requestJsonResponse,
  type SafeReasonCode,
} from "../_shared/request-context.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RegisterDocumentBody {
  documentId?: unknown;
  originalFileName?: unknown;
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
      functionName: "register-document",
      operationType: "upload_register",
      stage: "register-document",
      httpStatus: status,
      reasonCode,
      requestCount: 1,
      failureCount: 1,
      durationMs: Date.now() - startedAt,
    });
    return respond({ error: message }, status, retryAfter);
  };

  try {
    const { user } = await requireAuthenticatedUser(request);
    await enforceRateLimit(user.id, "upload_register", requestId);
    const body = await request.json() as RegisterDocumentBody;
    const documentId = typeof body.documentId === "string"
      ? body.documentId
      : "";
    const originalFileName = typeof body.originalFileName === "string"
      ? body.originalFileName.trim()
      : "";
    if (!UUID_PATTERN.test(documentId)) {
      throw new HttpError(400, "A valid document ID is required.");
    }
    if (
      !originalFileName || Array.from(originalFileName).length > 255 ||
      /\p{Cc}/u.test(originalFileName)
    ) {
      throw new HttpError(400, "The PDF filename is invalid.");
    }

    const verified = await verifyOwnedPdfObject(user.id, documentId);
    if (!verified) {
      throw new HttpError(
        422,
        "The uploaded PDF could not be verified. Upload it again.",
        "storage_failure",
      );
    }

    const admin = createSupabaseAdminClient();
    const { data, error } = await admin.rpc("register_uploaded_document", {
      target_document_id: documentId,
      target_user_id: user.id,
      target_original_file_name: originalFileName,
      target_storage_path: verified.path,
      verified_file_size: verified.size,
      verified_mime_type: verified.mimeType,
      maximum_pending_documents: 10,
    });
    if (error || !data) {
      if (error?.code === "P0001") {
        throw new HttpError(
          429,
          "Too many uploads are waiting for processing. Finish or remove them before uploading more.",
          "rate_limited",
          60,
        );
      }
      throw new HttpError(
        500,
        "The uploaded PDF could not be registered safely.",
        "database_failure",
      );
    }

    logOperational("info", {
      requestId,
      functionName: "register-document",
      operationType: "upload_register",
      stage: "register-document-complete",
      httpStatus: 200,
      reasonCode: "none",
      requestCount: 1,
      successCount: 1,
      durationMs: Date.now() - startedAt,
    });
    return respond({ document: data });
  } catch (error) {
    if (error instanceof HttpError) {
      return fail(
        error.message,
        error.status,
        error.reasonCode,
        error.retryAfterSeconds,
      );
    }
    return fail(
      "The uploaded PDF could not be registered safely.",
      500,
      "internal_failure",
    );
  }
});
