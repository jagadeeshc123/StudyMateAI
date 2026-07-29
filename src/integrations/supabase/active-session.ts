export type ChatSessionMode = "single_document" | "multi_document" | "comparison";

export interface ActiveChatSession {
  sessionId: string;
  mode: ChatSessionMode;
  documentIds: string[];
}

const ACTIVE_SESSION_PREFIX = "studymate:active-session:";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function storageKey(userId: string): string {
  return `${ACTIVE_SESSION_PREFIX}${userId}`;
}

export function getActiveSession(userId: string): ActiveChatSession | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(storageKey(userId)) ?? "null") as Partial<ActiveChatSession> | null;
    if (!parsed || typeof parsed.sessionId !== "string" || !UUID_PATTERN.test(parsed.sessionId)) return null;
    if (!Array.isArray(parsed.documentIds) || parsed.documentIds.length < 1 || parsed.documentIds.length > 5) return null;
    if (parsed.documentIds.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) return null;
    if (!parsed.mode || !["single_document", "multi_document", "comparison"].includes(parsed.mode)) return null;
    return {
      sessionId: parsed.sessionId,
      mode: parsed.mode,
      documentIds: [...new Set(parsed.documentIds)],
    };
  } catch {
    return null;
  }
}

export function setActiveSession(userId: string, session: ActiveChatSession): void {
  sessionStorage.setItem(storageKey(userId), JSON.stringify(session));
}

export function clearActiveSession(userId: string): void {
  sessionStorage.removeItem(storageKey(userId));
}

export function removeDocumentFromActiveSession(userId: string, documentId: string): void {
  const active = getActiveSession(userId);
  if (!active || !active.documentIds.includes(documentId)) return;
  clearActiveSession(userId);
}

export function clearAllActiveSessions(): void {
  for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = sessionStorage.key(index);
    if (key?.startsWith(ACTIVE_SESSION_PREFIX)) sessionStorage.removeItem(key);
  }
}
