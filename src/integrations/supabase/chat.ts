import { invokeEdgeFunction } from "@/integrations/supabase/edge-functions";

export interface SourceCitation {
  pageNumber: number;
  excerpt: string;
}

export interface ChatAnswer {
  answer: string;
  sources: SourceCitation[];
  notFound: boolean;
}

export interface PersistedMessage {
  id: string;
  document_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

interface ChatHistoryResponse {
  messages: PersistedMessage[];
}

export async function askDocument(documentId: string, question: string): Promise<ChatAnswer> {
  return invokeEdgeFunction<ChatAnswer>("chat-document", { documentId, question });
}

export async function loadChatHistory(documentId: string): Promise<PersistedMessage[]> {
  const response = await invokeEdgeFunction<ChatHistoryResponse>("chat-document", {
    action: "history",
    documentId,
  });

  return response.messages;
}
