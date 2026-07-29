import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MessageSquare, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import Navbar from "@/components/Navbar";
import SourceExcerpt from "@/components/SourceExcerpt";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/contexts/AuthContext";
import { setActiveBatch } from "@/integrations/supabase/active-batch";
import {
  clearActiveSession,
  getActiveSession,
  setActiveSession,
} from "@/integrations/supabase/active-session";
import type { PersistedMessage, SourceCitation } from "@/integrations/supabase/chat";
import {
  deleteChatSession,
  listChatSessions,
  renameChatSession,
  type ChatSessionSummary,
} from "@/integrations/supabase/sessions";

interface HistoryEntry {
  id: string;
  question: string;
  answer: string;
  sources: SourceCitation[];
  createdAt: string;
}

function parseAssistant(content: string): { answer: string; sources: SourceCitation[] } {
  try {
    const parsed = JSON.parse(content) as { answer?: unknown; sources?: unknown };
    const sources = Array.isArray(parsed.sources)
      ? parsed.sources.filter((source): source is SourceCitation =>
          typeof source === "object" && source !== null &&
          "pageNumber" in source && typeof source.pageNumber === "number" &&
          "excerpt" in source && typeof source.excerpt === "string")
      : [];
    if (typeof parsed.answer === "string") return { answer: parsed.answer, sources };
  } catch {
    // Legacy answers may be stored as plain text.
  }
  return { answer: content, sources: [] };
}

function buildEntries(messages: PersistedMessage[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  let pending: HistoryEntry | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      pending = {
        id: message.id,
        question: message.content,
        answer: "",
        sources: [],
        createdAt: message.created_at,
      };
      entries.push(pending);
    } else if (pending && !pending.answer) {
      const parsed = parseAssistant(message.content);
      pending.answer = parsed.answer;
      pending.sources = parsed.sources;
      pending = null;
    }
  }
  return entries.reverse();
}

function modeLabel(mode: ChatSessionSummary["mode"]): string {
  if (mode === "single_document") return "Single document";
  if (mode === "comparison") return "Comparison";
  return "Multi-document";
}

const History = () => {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [renameTarget, setRenameTarget] = useState<ChatSessionSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ChatSessionSummary | null>(null);
  const [mutating, setMutating] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSessions(await listChatSessions());
      setLoadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load chat history.";
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visibleSessions = useMemo(() => {
    const search = searchText.trim().toLocaleLowerCase();
    if (!search) return sessions;
    return sessions.filter((session) =>
      session.title.toLocaleLowerCase().includes(search) ||
      session.documents.some((document) =>
        (document.displayName ?? document.originalFileName).toLocaleLowerCase().includes(search)
      ) ||
      session.messages.some((message) => message.content.toLocaleLowerCase().includes(search))
    );
  }, [searchText, sessions]);

  const openSession = (session: ChatSessionSummary) => {
    if (!user) return;
    const validDocuments = session.documents.filter((document) => document.processingStatus === "ready");
    if (validDocuments.length !== session.documents.length || validDocuments.length === 0) {
      toast.error("This session no longer has its complete ready document selection.");
      return;
    }
    const documentIds = validDocuments.map((document) => document.id);
    setActiveBatch(user.id, documentIds);
    setActiveSession(user.id, { sessionId: session.id, mode: session.mode, documentIds });
    navigate(`/chat?session=${session.id}`);
  };

  const confirmRename = async () => {
    if (!renameTarget || mutating) return;
    const title = renameValue.trim();
    if (!title || Array.from(title).length > 150 || /\p{Cc}/u.test(title)) {
      toast.error("Session titles must be 1-150 characters without control characters.");
      return;
    }
    setMutating(true);
    try {
      await renameChatSession(renameTarget.id, title);
      setSessions((current) => current.map((session) =>
        session.id === renameTarget.id ? { ...session, title } : session
      ));
      setRenameTarget(null);
      toast.success("Session renamed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not rename the session.");
    } finally {
      setMutating(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || mutating) return;
    setMutating(true);
    try {
      await deleteChatSession(deleteTarget.id);
      setSessions((current) => current.filter((session) => session.id !== deleteTarget.id));
      if (user && getActiveSession(user.id)?.sessionId === deleteTarget.id) clearActiveSession(user.id);
      setDeleteTarget(null);
      toast.success("Chat session deleted. Documents were kept.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the session.");
    } finally {
      setMutating(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <Navbar />
      <div className="container px-4 py-10">
        <div className="mx-auto max-w-5xl">
          <div className="mb-7">
            <h1 className="text-3xl font-bold sm:text-4xl">Chat History</h1>
            <p className="mt-2 text-muted-foreground">Reopen single-document, multi-document, and comparison sessions.</p>
          </div>
          <Input
            type="search"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="Search sessions, documents, questions, and answers..."
            aria-label="Search chat history"
            className="mb-6"
          />

          {loading ? (
            <p className="text-sm text-muted-foreground" role="status">Loading chat sessions...</p>
          ) : loadError ? (
            <p className="text-sm text-destructive" role="alert">{loadError}</p>
          ) : visibleSessions.length === 0 ? (
            <Card><CardContent className="p-8 text-center text-muted-foreground">
              {sessions.length === 0 ? "No saved chat sessions yet." : "No sessions match this search."}
            </CardContent></Card>
          ) : (
            <div className="space-y-5">
              {visibleSessions.map((session) => {
                const entries = buildEntries(session.messages);
                return (
                  <Card key={session.id} className="border-2">
                    <CardHeader>
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <CardTitle className="truncate" title={session.title}>{session.title}</CardTitle>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {modeLabel(session.mode)} · Updated {new Date(session.updatedAt).toLocaleString()}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {session.documents.length === 0 ? (
                              <span className="rounded-full bg-muted px-2 py-1 text-xs">No documents available</span>
                            ) : session.documents.map((document) => (
                              <span key={document.id} className="max-w-64 truncate rounded-full bg-primary/10 px-2 py-1 text-xs" title={document.displayName ?? document.originalFileName}>
                                {document.position}. {document.displayName ?? document.originalFileName}
                                {document.processingStatus !== "ready" ? " (unavailable)" : ""}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" onClick={() => openSession(session)} disabled={session.documents.length === 0}>
                            <MessageSquare className="mr-2 h-4 w-4" />Open
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => {
                            setRenameTarget(session);
                            setRenameValue(session.title);
                          }}>
                            <Pencil className="mr-2 h-4 w-4" />Rename
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => setDeleteTarget(session)}>
                            <Trash2 className="mr-2 h-4 w-4" />Delete
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {entries.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No messages remain in this session.</p>
                      ) : entries.map((entry) => (
                        <div key={entry.id} className="rounded-lg border p-4">
                          <p className="text-xs text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</p>
                          <p className="mt-2 text-sm font-semibold">Question</p>
                          <p className="mt-1 whitespace-pre-wrap text-sm">{entry.question}</p>
                          <p className="mt-3 text-sm font-semibold">Answer</p>
                          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{entry.answer || "No saved answer is available."}</p>
                          {entry.sources.length > 0 && (
                            <div className="mt-3 space-y-2 border-t pt-3">
                              <p className="text-xs font-semibold">Sources</p>
                              {entry.sources.map((source, index) => (
                                <SourceExcerpt
                                  key={source.chunkId ?? `${source.documentId}-${source.pageNumber}-${index}`}
                                  source={source}
                                  documentName={source.documentId
                                    ? session.documents.find((document) => document.id === source.documentId)?.displayName
                                      ?? session.documents.find((document) => document.id === source.documentId)?.originalFileName
                                      ?? source.documentName
                                    : source.documentName}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <Dialog open={Boolean(renameTarget)} onOpenChange={(open) => !open && !mutating && setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Rename chat session</DialogTitle><DialogDescription>Document names are unchanged.</DialogDescription></DialogHeader>
          <Input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={150} autoFocus />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)} disabled={mutating}>Cancel</Button>
            <Button onClick={() => void confirmRename()} disabled={mutating}>{mutating ? "Saving..." : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && !mutating && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete this chat session?</AlertDialogTitle><AlertDialogDescription>Questions, answers, and source excerpts will be removed. The PDFs will be kept.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutating}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(event) => { event.preventDefault(); void confirmDelete(); }} disabled={mutating} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {mutating ? "Deleting..." : "Delete session"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default History;
