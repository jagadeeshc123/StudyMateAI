import { createClient } from "npm:@supabase/supabase-js@2.79.0";

function requireEnvironmentVariable(name: string): string {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error(`Missing required server environment variable: ${name}`);
  }

  return value;
}

export function createSupabaseAdminClient() {
  return createClient(
    requireEnvironmentVariable("SUPABASE_URL"),
    requireEnvironmentVariable("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
