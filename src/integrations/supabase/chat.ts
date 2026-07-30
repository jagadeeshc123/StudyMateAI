import { invokeEdgeFunction } from "@/integrations/supabase/edge-functions";

export interface SourceCitation {
  chunkId?: string;
  documentId?: string;
  documentName?: string;
  pageNumber: number;
  excerpt: string;
  fullExcerpt?: string;
}

export type ResponseMode = "concise" | "balanced" | "detailed";

export interface ChatAnswer {
  answer: string;
  sources: SourceCitation[];
  notFound: boolean;
}

export interface PersistedMessage {
  id: string;
  document_id: string | null;
  chat_session_id?: string;
  retrieval_mode?: string;
  selected_document_count?: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

interface ChatHistoryResponse {
  messages: PersistedMessage[];
}

export async function askDocument(
  documentId: string,
  question: string,
  responseMode: ResponseMode = "balanced",
  requestId?: string,
): Promise<ChatAnswer> {
  const topK = responseMode === "concise" ? 3 : responseMode === "detailed" ? 8 : 6;
  return invokeEdgeFunction<ChatAnswer>("chat-document", {
    documentId,
    question,
    top_k: topK,
    response_mode: responseMode,
  }, requestId);
}

export async function loadChatHistory(documentId: string): Promise<PersistedMessage[]> {
  const response = await invokeEdgeFunction<ChatHistoryResponse>("chat-document", {
    action: "history",
    documentId,
  });

  return response.messages;
}
