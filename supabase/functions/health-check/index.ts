import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireAuthenticatedUser } from "../_shared/auth.ts";
import { createSupabaseAdminClient } from "../_shared/supabase-admin.ts";
import {
  DEFAULT_GEMINI_EMBEDDING_DIMENSIONS,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
} from "../_shared/gemini-embeddings.ts";
import { DEFAULT_GEMINI_MODEL } from "../chat-document/gemini-generate-content.ts";
import {
  createRequestId,
  logOperational,
  requestJsonResponse,
} from "../_shared/request-context.ts";

function configurationPresent(): boolean {
  return Boolean(
    Deno.env.get("SUPABASE_URL") &&
      Deno.env.get("SUPABASE_ANON_KEY") &&
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") &&
      Deno.env.get("GEMINI_API_KEY"),
  );
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse(
      { error: "Only GET and POST requests are supported." },
      405,
    );
  }

  const requestId = createRequestId(request.headers.get("x-request-id"));
  const startedAt = Date.now();
  const url = new URL(request.url);
  const detailRequested = request.method === "POST" ||
    url.searchParams.get("check") === "readiness";

  if (!detailRequested) {
    return requestJsonResponse(requestId, {
      status: "live",
      functionAvailable: true,
    });
  }

  try {
    await requireAuthenticatedUser(request);
    const admin = createSupabaseAdminClient();
    const databaseStartedAt = Date.now();
    const { error: databaseError } = await admin.from("documents").select("id")
      .limit(1);
    const databaseDurationMs = Date.now() - databaseStartedAt;
    const { error: storageError } = await admin.storage.from("documents").list(
      "__health_check__",
      { limit: 1 },
    );
    const ready = configurationPresent() && !databaseError && !storageError;

    logOperational(ready ? "info" : "warn", {
      requestId,
      functionName: "health-check",
      operationType: "readiness",
      stage: "health-check-readiness",
      httpStatus: ready ? 200 : 503,
      reasonCode: ready
        ? "none"
        : databaseError
        ? "database_failure"
        : storageError
        ? "storage_failure"
        : "provider_unavailable",
      requestCount: 1,
      successCount: ready ? 1 : 0,
      failureCount: ready ? 0 : 1,
      durationMs: Date.now() - startedAt,
      retrievalDurationMs: databaseDurationMs,
    });

    return requestJsonResponse(requestId, {
      status: ready ? "ready" : "not_ready",
      functionAvailable: true,
      requiredConfigurationPresent: configurationPresent(),
      databaseReachable: !databaseError,
      storageReachable: !storageError,
      answerModel: Deno.env.get("GEMINI_MODEL") || DEFAULT_GEMINI_MODEL,
      embeddingModel: Deno.env.get("GEMINI_EMBEDDING_MODEL") ||
        DEFAULT_GEMINI_EMBEDDING_MODEL,
      embeddingDimensions: Number(
        Deno.env.get("GEMINI_EMBEDDING_DIMENSIONS") ||
          DEFAULT_GEMINI_EMBEDDING_DIMENSIONS,
      ),
      applicationVersion: Deno.env.get("APP_VERSION") || "unspecified",
    }, ready ? 200 : 503);
  } catch (error) {
    if (error instanceof HttpError) {
      return requestJsonResponse(
        requestId,
        { error: error.message },
        error.status,
      );
    }
    return requestJsonResponse(
      requestId,
      { error: "Readiness could not be checked safely." },
      503,
    );
  }
});
