import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { BookOpen, Check, Send, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import Navbar from "@/components/Navbar";
import SourceExcerpt from "@/components/SourceExcerpt";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/contexts/AuthContext";
import { getActiveBatch, setActiveBatch } from "@/integrations/supabase/active-batch";
import {
  clearActiveSession,
  getActiveSession,
  setActiveSession,
  type ChatSessionMode,
} from "@/integrations/supabase/active-session";
import {
  askDocument,
  loadChatHistory,
  type PersistedMessage,
  type ResponseMode,
  type SourceCitation,
} from "@/integrations/supabase/chat";
import {
  listManagedDocuments,
  type ManagedDocument,
} from "@/integrations/supabase/documents";
import {
  askSession,
  createChatSession,
  loadSessionHistory,
} from "@/integrations/supabase/sessions";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: SourceCitation[];
}

function documentTitle(document: ManagedDocument): string {
  return document.display_name ?? document.original_file_name;
}

function parseAssistantContent(content: string): Pick<Message, "content" | "sources"> {
  try {
    const parsed = JSON.parse(content) as { answer?: unknown; sources?: unknown };
    const sources = Array.isArray(parsed.sources)
      ? parsed.sources.filter(
          (source): source is SourceCitation =>
            typeof source === "object" && source !== null &&
            "pageNumber" in source && typeof source.pageNumber === "number" &&
            "excerpt" in source && typeof source.excerpt === "string",
        )
      : [];
    if (typeof parsed.answer === "string") return { content: parsed.answer, sources };
  } catch {
    // Legacy assistant rows may contain plain text.
  }
  return { content, sources: [] };
}

function toMessage(message: PersistedMessage): Message {
  const assistant = message.role === "assistant"
    ? parseAssistantContent(message.content)
    : { content: message.content, sources: [] };
  return { id: message.id, role: message.role, ...assistant };
}

const Chat = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<ManagedDocument[]>([]);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [mode, setMode] = useState<ChatSessionMode>("single_document");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [responseMode, setResponseMode] = useState<ResponseMode>("balanced");
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const initialRouteSelection = useRef({
    documentId: searchParams.get("document"),
    sessionId: searchParams.get("session"),
  });

  const readyDocuments = useMemo(
    () => documents.filter((document) => document.processing_status === "ready"),
    [documents],
  );
  const selectedDocuments = useMemo(
    () => selectedDocumentIds.flatMap((id) => {
      const document = readyDocuments.find((candidate) => candidate.id === id);
      return document ? [document] : [];
    }),
    [readyDocuments, selectedDocumentIds],
  );

  useEffect(() => {
    let active = true;
    const load = async () => {
      setDocumentsLoading(true);
      setHistoryLoading(true);
      setDocumentsError(null);
      setChatError(null);
      setMessages([]);
      try {
        const ownedDocuments = await listManagedDocuments();
        if (!active) return;
        setDocuments(ownedDocuments);
        const readyIds = new Set(
          ownedDocuments.filter((document) => document.processing_status === "ready")
            .map((document) => document.id),
        );

        const storedSession = user ? getActiveSession(user.id) : null;
        const requestedSessionId = initialRouteSelection.current.sessionId;
        const requestedDocumentId = initialRouteSelection.current.documentId;
        const sessionToRestore = requestedSessionId || storedSession?.sessionId || null;
        if (sessionToRestore) {
          try {
            const history = await loadSessionHistory(sessionToRestore);
            const validIds = history.session.documents.map((document) => document.id)
              .filter((id) => readyIds.has(id));
            if (validIds.length !== history.session.documents.length || validIds.length === 0) {
              throw new Error("This session no longer has its original ready document selection.");
            }
            if (!active) return;
            setMode(history.session.mode);
            setSessionId(history.session.id);
            setSelectedDocumentIds(validIds);
            setMessages(history.messages.map(toMessage));
            if (user) {
              setActiveSession(user.id, {
                sessionId: history.session.id,
                mode: history.session.mode,
                documentIds: validIds,
              });
              setActiveBatch(user.id, validIds);
            }
            setSearchParams({ session: history.session.id }, { replace: true });
            return;
          } catch (error) {
            if (user) clearActiveSession(user.id);
            if (requestedSessionId) throw error;
          }
        }

        const requestedReady = requestedDocumentId && readyIds.has(requestedDocumentId)
          ? requestedDocumentId
          : null;
        if (requestedDocumentId && !requestedReady) {
          throw new Error("The requested document is unavailable or not ready.");
        }
        const activeReadyIds = user
          ? getActiveBatch(user.id).filter((id) => readyIds.has(id)).slice(0, 5)
          : [];
        const initialId = requestedReady || activeReadyIds[0] || null;
        setMode("single_document");
        setSessionId(null);
        setSelectedDocumentIds(initialId ? [initialId] : []);
        if (initialId) {
          const history = await loadChatHistory(initialId);
          if (active) setMessages(history.map(toMessage));
        }
        if (user) setActiveBatch(user.id, activeReadyIds);
      } catch (error) {
        if (!active) return;
        const message = error instanceof Error ? error.message : "Could not load chat documents.";
        setDocumentsError(message);
        toast.error(message);
      } finally {
        if (active) {
          setDocumentsLoading(false);
          setHistoryLoading(false);
        }
      }
    };
    void load();
    return () => { active = false; };
  }, [setSearchParams, user]);

  const resetSessionForSelection = (
    nextMode: ChatSessionMode,
    nextDocumentIds: string[],
  ) => {
    setMode(nextMode);
    setSelectedDocumentIds(nextDocumentIds);
    setSessionId(null);
    setMessages([]);
    setChatError(null);
    if (user) {
      clearActiveSession(user.id);
      setActiveBatch(user.id, nextDocumentIds);
    }
    if (nextMode === "single_document" && nextDocumentIds[0]) {
      setSearchParams({ document: nextDocumentIds[0] }, { replace: true });
      setHistoryLoading(true);
      void loadChatHistory(nextDocumentIds[0])
        .then((history) => setMessages(history.map(toMessage)))
        .catch((error) => {
          const message = error instanceof Error ? error.message : "Could not load chat history.";
          setChatError(message);
          toast.error(message);
        })
        .finally(() => setHistoryLoading(false));
    } else {
      setSearchParams({}, { replace: true });
    }
  };

  const changeMode = (nextMode: ChatSessionMode) => {
    const nextIds = nextMode === "single_document"
      ? selectedDocumentIds.slice(0, 1)
      : selectedDocumentIds;
    resetSessionForSelection(nextMode, nextIds);
  };

  const toggleDocument = (documentId: string) => {
    if (isLoading || historyLoading) return;
    if (mode === "single_document") {
      resetSessionForSelection(mode, [documentId]);
      return;
    }
    const selected = selectedDocumentIds.includes(documentId);
    if (!selected && selectedDocumentIds.length === 5) {
      toast.error("Select no more than five documents per session.");
      return;
    }
    const nextIds = selected
      ? selectedDocumentIds.filter((id) => id !== documentId)
      : [...selectedDocumentIds, documentId];
    resetSessionForSelection(mode, nextIds);
  };

  const handleSend = async () => {
    const question = input.trim();
    if (!question || selectedDocumentIds.length === 0 || isLoading) return;
    const optimisticId = crypto.randomUUID();
    setMessages((current) => [...current, { id: optimisticId, role: "user", content: question, sources: [] }]);
    setInput("");
    setChatError(null);
    setIsLoading(true);
    try {
      let answer;
      if (mode === "single_document" && !sessionId) {
        answer = await askDocument(selectedDocumentIds[0], question, responseMode);
      } else {
        let trustedSessionId = sessionId;
        if (!trustedSessionId) {
          const session = await createChatSession(selectedDocumentIds, mode);
          trustedSessionId = session.id;
          setSessionId(session.id);
          setSearchParams({ session: session.id }, { replace: true });
          if (user) {
            setActiveSession(user.id, {
              sessionId: session.id,
              mode,
              documentIds: selectedDocumentIds,
            });
          }
        }
        answer = await askSession(
          trustedSessionId,
          selectedDocumentIds,
          question,
          responseMode,
        );
      }
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: answer.answer,
        sources: answer.sources,
      }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The question could not be answered.";
      setMessages((current) => current.filter((item) => item.id !== optimisticId));
      setInput(question);
      setChatError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const inputDisabled = isLoading || historyLoading || selectedDocumentIds.length === 0;

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-background to-muted/30">
      <Navbar />
      <div className="container flex-1 px-4 py-6">
        <div className="mx-auto flex h-full max-w-5xl flex-col">
          <div className="mb-5 space-y-4">
            <div>
              <h1 className="text-3xl font-bold">Chat with Your Documents</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Ask one PDF, study several together, or compare their evidence.
              </p>
            </div>

            <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <label htmlFor="chat-mode" className="text-sm font-medium">Chat mode</label>
                <p className="text-xs text-muted-foreground">Selections are revalidated by the server.</p>
              </div>
              <Select value={mode} onValueChange={(value) => changeMode(value as ChatSessionMode)} disabled={isLoading || historyLoading}>
                <SelectTrigger id="chat-mode" className="w-full sm:w-56" aria-label="Chat mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="single_document">Single document</SelectItem>
                  <SelectItem value="multi_document">Multi-document</SelectItem>
                  <SelectItem value="comparison">Comparison</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {documentsLoading ? (
              <p className="text-sm text-muted-foreground" role="status">Loading documents...</p>
            ) : documentsError ? (
              <p className="text-sm text-destructive" role="alert">{documentsError}</p>
            ) : documents.length === 0 ? (
              <div className="flex items-center gap-3">
                <p className="text-sm text-muted-foreground">No uploaded documents are available.</p>
                <Button variant="outline" size="sm" onClick={() => navigate("/upload")}>Upload PDFs</Button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">
                    Selected {selectedDocumentIds.length}/{mode === "single_document" ? 1 : 5}
                  </p>
                  {mode !== "single_document" && selectedDocumentIds.length === 5 && (
                    <p className="text-xs text-muted-foreground">Five-document limit reached</p>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {documents.map((document) => {
                    const ready = document.processing_status === "ready";
                    const selected = selectedDocumentIds.includes(document.id);
                    return (
                      <button
                        key={document.id}
                        type="button"
                        onClick={() => toggleDocument(document.id)}
                        disabled={!ready || isLoading || historyLoading}
                        aria-pressed={selected}
                        className={`flex min-w-0 items-center gap-2 rounded-md border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                          selected ? "border-primary bg-primary/10" : "hover:bg-muted"
                        }`}
                      >
                        {selected ? <Check className="h-4 w-4 shrink-0 text-primary" /> : <BookOpen className="h-4 w-4 shrink-0" />}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium" title={documentTitle(document)}>
                            {documentTitle(document)}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {ready
                              ? `Semantic: ${document.embedding_status ?? "pending"}`
                              : `Unavailable: ${document.processing_status}`}
                          </span>
                        </span>
                        {selected && mode !== "single_document" && <X className="h-3 w-3 shrink-0" aria-hidden="true" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <Card className="mb-4 flex-1 border-2">
            <CardContent className="p-0">
              <ScrollArea className="h-[calc(100vh-29rem)] min-h-72 p-6">
                <div className="space-y-6">
                  {historyLoading ? (
                    <p className="text-sm text-muted-foreground" role="status">Loading saved messages...</p>
                  ) : messages.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {selectedDocuments.length > 0
                        ? `Ask a question across ${selectedDocuments.map(documentTitle).join(", ")}.`
                        : "Select at least one ready document."}
                    </p>
                  ) : messages.map((message) => (
                    <div key={message.id} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[85%] rounded-lg px-4 py-3 ${message.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                        {message.role === "assistant" && (
                          <div className="mb-2 flex items-center gap-2">
                            <Sparkles className="h-4 w-4 text-primary" />
                            <span className="text-xs font-semibold text-primary">AI Assistant</span>
                          </div>
                        )}
                        <p className="whitespace-pre-wrap text-sm">{message.content}</p>
                        {message.sources.length > 0 && (
                          <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
                            <p className="text-xs font-semibold">Sources</p>
                            {message.sources.map((source, index) => (
                              <SourceExcerpt
                                key={source.chunkId ?? `${source.documentId}-${source.pageNumber}-${index}`}
                                source={source}
                                documentName={source.documentId
                                  ? selectedDocuments.find((document) => document.id === source.documentId)?.display_name
                                    ?? selectedDocuments.find((document) => document.id === source.documentId)?.original_file_name
                                    ?? source.documentName
                                  : source.documentName ?? (selectedDocuments.length === 1 ? documentTitle(selectedDocuments[0]) : undefined)}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {isLoading && (
                    <div className="flex justify-start">
                      <div className="rounded-lg bg-muted px-4 py-3" role="status">Generating a grounded answer...</div>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="border-2">
            <CardContent className="p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <label htmlFor="answer-depth" className="text-sm font-medium">Answer depth</label>
                <Select value={responseMode} onValueChange={(value) => setResponseMode(value as ResponseMode)} disabled={isLoading}>
                  <SelectTrigger id="answer-depth" className="w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="concise">Concise</SelectItem>
                    <SelectItem value="balanced">Balanced</SelectItem>
                    <SelectItem value="detailed">Detailed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <form onSubmit={(event) => { event.preventDefault(); void handleSend(); }} className="flex gap-2">
                <Input
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder={selectedDocumentIds.length > 0 ? "Ask about or compare the selected documents..." : "Select a ready document first..."}
                  maxLength={1_000}
                  disabled={inputDisabled}
                />
                <Button type="submit" variant="hero" disabled={inputDisabled || !input.trim()} aria-label="Send question">
                  <Send className="h-4 w-4" />
                </Button>
              </form>
              {chatError && <p className="mt-2 text-sm text-destructive" role="alert">{chatError}</p>}
              <p className="mt-2 text-xs text-muted-foreground">
                Answers use only retrieved evidence. Semantic failures automatically retain keyword search.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default Chat;
