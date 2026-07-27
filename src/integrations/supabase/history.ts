import { supabase } from "@/integrations/supabase/client";
import type { PersistedMessage } from "@/integrations/supabase/chat";

async function requireCurrentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getSession();
  const userId = data.session?.user.id;

  if (error || !userId) {
    throw new Error("Your session has expired. Log in again to manage history.");
  }

  return userId;
}

export async function loadAllHistoryMessages(documentIds: string[]): Promise<PersistedMessage[]> {
  await requireCurrentUserId();

  if (documentIds.length === 0) return [];

  const { data, error } = await supabase
    .from("messages")
    .select("id, document_id, role, content, created_at")
    .in("document_id", documentIds)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    throw new Error(`Could not load Q&A history: ${error.message}`);
  }

  return (data ?? []) as PersistedMessage[];
}

export async function clearDocumentHistory(documentId: string): Promise<void> {
  await requireCurrentUserId();
  const { error } = await supabase.rpc("clear_user_history", {
    target_document_id: documentId,
  });

  if (error) {
    throw new Error(`Could not clear this document's history: ${error.message}`);
  }
}

export async function clearAllHistory(): Promise<void> {
  await requireCurrentUserId();
  const { error } = await supabase.rpc("clear_user_history", {
    target_document_id: null,
  });

  if (error) {
    throw new Error(`Could not clear Q&A history: ${error.message}`);
  }
}
