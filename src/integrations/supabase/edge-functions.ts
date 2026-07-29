import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

interface EdgeFunctionErrorBody {
  error?: unknown;
  requestId?: unknown;
}

export class EdgeFunctionError extends Error {
  constructor(message: string, public readonly requestId: string | null) {
    super(requestId ? `${message} Request ID: ${requestId}` : message);
    this.name = "EdgeFunctionError";
  }
}

export async function invokeEdgeFunction<TResult>(
  functionName: string,
  body: Record<string, unknown>,
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
    },
  });

  if (error) {
    let message = error.message || `The ${functionName} request failed.`;
    let requestId: string | null = null;

    if (error instanceof FunctionsHttpError) {
      try {
        const responseBody = await error.context.json() as EdgeFunctionErrorBody;

        if (typeof responseBody.error === "string" && responseBody.error.trim()) {
          message = responseBody.error;
        }
        if (typeof responseBody.requestId === "string" && responseBody.requestId.trim()) {
          requestId = responseBody.requestId;
        }
      } catch {
        // Keep the Supabase client error when the function did not return JSON.
      }
    }

    throw new EdgeFunctionError(message, requestId);
  }

  if (data === null || data === undefined) {
    throw new EdgeFunctionError(`The ${functionName} function returned no data.`, null);
  }

  return data;
}
