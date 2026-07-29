import { jsonResponse } from "./cors.ts";

export type SafeReasonCode =
  | "authentication_required"
  | "invalid_request"
  | "not_found"
  | "conflict"
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
  model?: string;
  documentCount?: number;
  chunkCount?: number;
  durationMs?: number;
}

export function createRequestId(): string {
  return crypto.randomUUID();
}

export function requestJsonResponse(
  requestId: string,
  body: Record<string, unknown>,
  status = 200,
): Response {
  return jsonResponse({ ...body, requestId }, status);
}

export function logOperational(
  level: "info" | "warn" | "error",
  details: SafeOperationalLog,
): void {
  console[level]("StudyMate operation", details);
}
