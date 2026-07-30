import { jsonResponse } from "./cors.ts";

export type SafeReasonCode =
  | "authentication_required"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "resource_limit"
  | "processing_active"
  | "extraction_failed"
  | "no_chunks_created"
  | "processing_timeout"
  | "stale_lease_recovered"
  | "keyword_no_match"
  | "semantic_unavailable_keyword_active"
  | "retrieval_no_evidence"
  | "citation_validation_uncertain"
  | "citation_validation_failed"
  | "provider_failed"
  | "message_persistence_failed"
  | "provider_authentication"
  | "provider_quota"
  | "provider_model_unavailable"
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_network_failure"
  | "provider_empty_response"
  | "provider_blocked"
  | "provider_output_limit"
  | "provider_invalid_dimension"
  | "storage_failure"
  | "database_failure"
  | "internal_failure";

export interface SafeOperationalLog {
  requestId: string;
  stage: string;
  httpStatus: number;
  reasonCode: SafeReasonCode | "none";
  functionName?: string;
  operationType?: string;
  sessionMode?: string;
  requestCount?: number;
  successCount?: number;
  failureCount?: number;
  model?: string;
  documentCount?: number;
  chunkCount?: number;
  pageCount?: number;
  extractedCharacterCount?: number;
  chunkInsertionDurationMs?: number;
  documentReadyAt?: string;
  embeddingRequestCount?: number;
  keywordCandidateCount?: number;
  semanticCandidateCount?: number;
  hybridCandidateCount?: number;
  selectedChunkCount?: number;
  citationValidationResult?:
    | "supported"
    | "uncertain"
    | "failed"
    | "no_evidence";
  contextCharacterCount?: number;
  durationMs?: number;
  providerDurationMs?: number;
  extractionDurationMs?: number;
  embeddingDurationMs?: number;
  retrievalDurationMs?: number;
  rateLimitRejectionCount?: number;
  staleLeaseRecoveryCount?: number;
  deletionPartialFailureCount?: number;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_OPERATIONAL_KEYS = new Set<keyof SafeOperationalLog>([
  "requestId",
  "stage",
  "httpStatus",
  "reasonCode",
  "functionName",
  "operationType",
  "sessionMode",
  "requestCount",
  "successCount",
  "failureCount",
  "model",
  "documentCount",
  "chunkCount",
  "pageCount",
  "extractedCharacterCount",
  "chunkInsertionDurationMs",
  "documentReadyAt",
  "embeddingRequestCount",
  "keywordCandidateCount",
  "semanticCandidateCount",
  "hybridCandidateCount",
  "selectedChunkCount",
  "citationValidationResult",
  "contextCharacterCount",
  "durationMs",
  "providerDurationMs",
  "extractionDurationMs",
  "embeddingDurationMs",
  "retrievalDurationMs",
  "rateLimitRejectionCount",
  "staleLeaseRecoveryCount",
  "deletionPartialFailureCount",
]);

export function createRequestId(candidate?: unknown): string {
  return typeof candidate === "string" && UUID_PATTERN.test(candidate)
    ? candidate
    : crypto.randomUUID();
}

export function requestJsonResponse(
  requestId: string,
  body: Record<string, unknown>,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  const response = jsonResponse({ ...body, requestId }, status);
  for (const [name, value] of new Headers(extraHeaders)) {
    response.headers.set(name, value);
  }
  return response;
}

export function logOperational(
  level: "info" | "warn" | "error",
  details: SafeOperationalLog,
): void {
  if (Deno.env.get("OBSERVABILITY_ENABLED")?.toLowerCase() !== "true") {
    return;
  }
  const safeDetails = Object.fromEntries(
    Object.entries(details).filter(([key]) =>
      SAFE_OPERATIONAL_KEYS.has(key as keyof SafeOperationalLog)
    ),
  );
  console[level]("StudyMate operation", safeDetails);
}
