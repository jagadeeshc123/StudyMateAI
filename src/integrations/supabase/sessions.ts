import { invokeEdgeFunction } from "@/integrations/supabase/edge-functions";
import type { ChatAnswer, PersistedMessage, ResponseMode } from "@/integrations/supabase/chat";
import type { ChatSessionMode } from "@/integrations/supabase/active-session";

export interface SessionDocumentSummary {
  id: string;
  displayName: string | null;
  originalFileName: string;
  processingStatus: string;
  position: number;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  mode: ChatSessionMode;
  createdAt: string;
  updatedAt: string;
  documents: SessionDocumentSummary[];
  messages: PersistedMessage[];
}

interface CreateSessionResponse {
  session: {
    id: string;
    title: string;
    mode: ChatSessionMode;
    documents: SessionDocumentSummary[];
  };
}

interface SessionHistoryResponse {
  session: {
    id: string;
    title: string;
    mode: ChatSessionMode;
    documents: SessionDocumentSummary[];
  };
  messages: PersistedMessage[];
}

export async function createChatSession(
  documentIds: string[],
  mode: ChatSessionMode,
): Promise<CreateSessionResponse["session"]> {
  const response = await invokeEdgeFunction<CreateSessionResponse>("chat-session", {
    action: "create",
    documentIds,
    mode,
  });
  return response.session;
}

export async function loadSessionHistory(sessionId: string): Promise<SessionHistoryResponse> {
  return invokeEdgeFunction<SessionHistoryResponse>("chat-session", {
    action: "history",
    sessionId,
  });
}

export async function askSession(
  sessionId: string,
  documentIds: string[],
  question: string,
  responseMode: ResponseMode,
): Promise<ChatAnswer> {
  return invokeEdgeFunction<ChatAnswer>("chat-session", {
    action: "ask",
    sessionId,
    documentIds,
    question,
    response_mode: responseMode,
  });
}

export async function listChatSessions(): Promise<ChatSessionSummary[]> {
  const response = await invokeEdgeFunction<{ sessions: ChatSessionSummary[] }>("chat-session", {
    action: "list",
  });
  return response.sessions;
}

export async function renameChatSession(sessionId: string, title: string): Promise<void> {
  await invokeEdgeFunction("chat-session", { action: "rename", sessionId, title });
}

export async function deleteChatSession(sessionId: string): Promise<void> {
  await invokeEdgeFunction("chat-session", { action: "delete", sessionId });
}
