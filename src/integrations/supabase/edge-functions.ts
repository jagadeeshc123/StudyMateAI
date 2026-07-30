import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

interface EdgeFunctionErrorBody {
  error?: unknown;
  requestId?: unknown;
  retryAfter?: unknown;
}

export class EdgeFunctionError extends Error {
  constructor(
    message: string,
    public readonly requestId: string | null,
    public readonly status: number | null = null,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    const retryMessage = retryAfterSeconds
      ? ` Retry after about ${retryAfterSeconds} seconds.`
      : "";
    super(`${message}${retryMessage}${requestId ? ` Request ID: ${requestId}` : ""}`);
    this.name = "EdgeFunctionError";
  }
}

export async function invokeEdgeFunction<TResult>(
  functionName: string,
  body: Record<string, unknown>,
  requestId: string = crypto.randomUUID(),
): Promise<TResult> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;

  if (sessionError || !accessToken) {
    throw new EdgeFunctionError("Your session has expired. Log in again and retry.", null);
  }

  const { data, error } = await supabase.functions.invoke<TResult>(functionName, {
    body,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "x-request-id": requestId,
    },
  });

  if (error) {
    let message = error.message || `The ${functionName} request failed.`;
    let requestId: string | null = null;
    let status: number | null = null;
    let retryAfterSeconds: number | null = null;

    if (error instanceof FunctionsHttpError) {
      status = error.context.status;
      try {
        const responseBody = await error.context.json() as EdgeFunctionErrorBody;

        if (typeof responseBody.error === "string" && responseBody.error.trim()) {
          message = responseBody.error;
        }
        if (typeof responseBody.requestId === "string" && responseBody.requestId.trim()) {
          requestId = responseBody.requestId;
        }
        if (
          typeof responseBody.retryAfter === "number" &&
          Number.isFinite(responseBody.retryAfter)
        ) {
          retryAfterSeconds = Math.max(1, Math.trunc(responseBody.retryAfter));
        }
      } catch {
        // Keep the Supabase client error when the function did not return JSON.
      }
    }

    throw new EdgeFunctionError(message, requestId, status, retryAfterSeconds);
  }

  if (data === null || data === undefined) {
    throw new EdgeFunctionError(`The ${functionName} function returned no data.`, null);
  }

  return data;
}
