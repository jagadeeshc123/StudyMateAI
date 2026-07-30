import { HttpError } from "./auth.ts";
import { createSupabaseAdminClient } from "./supabase-admin.ts";
import { logOperational } from "./request-context.ts";

export type RateLimitOperation =
  | "upload_register"
  | "process_document"
  | "embedding_backfill"
  | "chat"
  | "complete_summary"
  | "delete_document"
  | "session_create";

interface RateLimitPolicy {
  minute: number;
  hour: number;
}

export const RATE_LIMIT_POLICIES: Record<RateLimitOperation, RateLimitPolicy> =
  {
    upload_register: { minute: 5, hour: 20 },
    process_document: { minute: 5, hour: 20 },
    embedding_backfill: { minute: 1, hour: 6 },
    chat: { minute: 10, hour: 100 },
    complete_summary: { minute: 2, hour: 10 },
    delete_document: { minute: 5, hour: 30 },
    session_create: { minute: 5, hour: 20 },
  };

interface RateLimitRow {
  allowed: boolean;
  retry_after_seconds: number;
}

export async function enforceRateLimit(
  userId: string,
  operation: RateLimitOperation,
  requestId: string,
): Promise<void> {
  const policy = RATE_LIMIT_POLICIES[operation];
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("consume_user_rate_limit", {
    target_user_id: userId,
    target_operation: operation,
    minute_limit: policy.minute,
    hour_limit: policy.hour,
  });

  if (error) {
    throw new HttpError(
      503,
      "Request limits could not be checked safely. Please retry shortly.",
      "database_failure",
      30,
    );
  }

  const result = (data as RateLimitRow[] | null)?.[0];
  if (!result?.allowed) {
    const retryAfter = Math.min(
      Math.max(Math.trunc(result?.retry_after_seconds ?? 60), 1),
      3600,
    );
    logOperational("warn", {
      requestId,
      stage: "rate-limit-rejected",
      functionName: operation,
      operationType: operation,
      httpStatus: 429,
      reasonCode: "rate_limited",
      rateLimitRejectionCount: 1,
    });
    throw new HttpError(
      429,
      "The request limit has been reached. Try again later.",
      "rate_limited",
      retryAfter,
    );
  }
}
