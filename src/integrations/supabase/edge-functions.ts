import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

interface EdgeFunctionErrorBody {
  error?: unknown;
}

export async function invokeEdgeFunction<TResult>(
  functionName: string,
  body: Record<string, unknown>,
): Promise<TResult> {
  const { data, error } = await supabase.functions.invoke<TResult>(functionName, { body });

  if (error) {
    let message = error.message || `The ${functionName} request failed.`;

    if (error instanceof FunctionsHttpError) {
      try {
        const responseBody = await error.context.json() as EdgeFunctionErrorBody;

        if (typeof responseBody.error === "string" && responseBody.error.trim()) {
          message = responseBody.error;
        }
      } catch {
        // Keep the Supabase client error when the function did not return JSON.
      }
    }

    throw new Error(message);
  }

  if (data === null || data === undefined) {
    throw new Error(`The ${functionName} function returned no data.`);
  }

  return data;
}
