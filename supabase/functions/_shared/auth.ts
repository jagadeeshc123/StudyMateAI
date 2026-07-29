import {
  createClient,
  type SupabaseClient,
  type User,
} from "npm:@supabase/supabase-js@2.79.0";
import type { SafeReasonCode } from "./request-context.ts";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly reasonCode: SafeReasonCode = "invalid_request",
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function requireEnvironmentVariable(name: string): string {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error(`Missing required server environment variable: ${name}`);
  }

  return value;
}

interface AuthenticatedCaller {
  user: User;
  supabase: SupabaseClient;
}

export async function requireAuthenticatedUser(
  request: Request,
): Promise<AuthenticatedCaller> {
  const authorization = request.headers.get("Authorization");

  if (
    !authorization?.startsWith("Bearer ") ||
    authorization.slice(7).trim().length === 0
  ) {
    throw new HttpError(
      401,
      "Authentication is required.",
      "authentication_required",
    );
  }

  const supabaseAuth = createClient(
    requireEnvironmentVariable("SUPABASE_URL"),
    requireEnvironmentVariable("SUPABASE_ANON_KEY"),
    {
      global: { headers: { Authorization: authorization } },
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
  const { data, error } = await supabaseAuth.auth.getUser();

  if (error || !data.user) {
    throw new HttpError(
      401,
      "Your session is invalid or has expired.",
      "authentication_required",
    );
  }

  return { user: data.user, supabase: supabaseAuth };
}
