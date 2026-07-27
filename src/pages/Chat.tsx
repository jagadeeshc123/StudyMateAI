import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import SourceExcerpt from "@/components/SourceExcerpt";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Send, BookOpen, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { getActiveBatch, setActiveBatch } from "@/integrations/supabase/active-batch";
import {
  askDocument,
  loadChatHistory,
  type PersistedMessage,
  type ResponseMode,
  type SourceCitation,
} from "@/integrations/supabase/chat";
import {
  listDocuments,
  type DocumentSummary,
} from "@/integrations/supabase/documents";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: SourceCitation[];
}

function parseAssistantContent(content: string): Pick<Message, "content" | "sources"> {
  try {
    const parsed = JSON.parse(content) as { answer?: unknown; sources?: unknown };
    const sources = Array.isArray(parsed.sources)
      ? parsed.sources.filter(
          (source): source is SourceCitation =>
            typeof source === "object"
            && source !== null
            && "pageNumber" in source
            && typeof source.pageNumber === "number"
            && "excerpt" in source
            && typeof source.excerpt === "string",
        )
      : [];

    if (typeof parsed.answer === "string") {
      return { content: parsed.answer, sources };
    }
  } catch {
    // Older or manually inserted assistant messages may contain plain text.
  }

  return { content, sources: [] };
}

function toMessage(message: PersistedMessage): Message {
  const assistantContent = message.role === "assistant"
    ? parseAssistantContent(message.content)
    : { content: message.content, sources: [] };

  return {
    id: message.id,
    role: message.role,
    ...assistantContent,
  };
}

const Chat = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [responseMode, setResponseMode] = useState<ResponseMode>("balanced");
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const requestedDocumentId = searchParams.get("document");
  const { user } = useAuth();
  const readyDocuments = useMemo(
    () => documents.filter((document) => document.processing_status === "ready"),
    [documents],
  );
  const selectedDocument = readyDocuments.find((document) => document.id === selectedDocumentId);

  useEffect(() => {
    let isActive = true;

    const loadDocuments = async () => {
      setDocuments([]);
      setSelectedDocumentId(null);
      setMessages([]);
      setDocumentsLoading(true);

      try {
        const activeDocumentIds = user ? getActiveBatch(user.id) : [];
        const ownedReadyDocuments = await listDocuments();
        const ownedDocumentsById = new Map(
          ownedReadyDocuments.map((document) => [document.id, document]),
        );
        const uploadedDocuments = activeDocumentIds
          .map((id) => ownedDocumentsById.get(id))
          .filter((document): document is DocumentSummary => Boolean(document));

        if (user) setActiveBatch(user.id, uploadedDocuments.map((document) => document.id));

        if (isActive) {
          const firstReadyDocument = uploadedDocuments.find(
            (document) => document.processing_status === "ready",
          );
          const requestedDocument = uploadedDocuments.find(
            (document) => document.id === requestedDocumentId && document.processing_status === "ready",
          );
          const requestedDocumentUnavailable = Boolean(requestedDocumentId && !requestedDocument);
          setDocuments(uploadedDocuments);
          setSelectedDocumentId((currentId) =>
            requestedDocumentUnavailable
              ? null
              : uploadedDocuments.some(
              (document) => document.id === currentId && document.processing_status === "ready",
            )
              ? currentId
              : requestedDocument?.id ?? firstReadyDocument?.id ?? null,
          );
          setDocumentsError(requestedDocumentUnavailable
            ? "The requested document is not available in your active batch."
            : null);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not load uploaded documents.";

        if (isActive) {
          setDocumentsError(message);
          toast.error(message);
        }
      } finally {
        if (isActive) {
          setDocumentsLoading(false);
        }
      }
    };

    void loadDocuments();

    return () => {
      isActive = false;
    };
  }, [requestedDocumentId, user]);

  useEffect(() => {
    let isActive = true;

    if (!selectedDocumentId) {
      setMessages([]);
      return () => {
        isActive = false;
      };
    }

    const loadHistory = async () => {
      setHistoryLoading(true);
      setChatError(null);

      try {
        const persistedMessages = await loadChatHistory(selectedDocumentId);

        if (isActive) {
          setMessages(persistedMessages.map(toMessage));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not load chat history.";

        if (isActive) {
          setMessages([]);
          setChatError(message);
          toast.error(message);
        }
      } finally {
        if (isActive) {
          setHistoryLoading(false);
        }
      }
    };

    void loadHistory();

    return () => {
      isActive = false;
    };
  }, [selectedDocumentId]);

  const handleSend = async () => {
    const question = input.trim();

    if (!question || !selectedDocumentId || isLoading) {
      return;
    }

    const optimisticMessageId = crypto.randomUUID();
    const userMessage: Message = {
      id: optimisticMessageId,
      role: "user",
      content: question,
      sources: [],
    };

    setMessages((previous) => [...previous, userMessage]);
    setInput("");
    setChatError(null);
    setIsLoading(true);

    try {
      const response = await askDocument(selectedDocumentId, question, responseMode);
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: response.answer,
        sources: response.sources,
      };
      setMessages((previous) => [...previous, assistantMessage]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The question could not be answered.";
      setMessages((previous) => previous.filter((item) => item.id !== optimisticMessageId));
      setInput(question);
      setChatError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const pendingCount = documents.filter(
    (document) => document.processing_status === "uploaded" || document.processing_status === "processing",
  ).length;
  const failedCount = documents.filter((document) => document.processing_status === "failed").length;
  const inputDisabled = isLoading || historyLoading || !selectedDocumentId;

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-background to-muted/30">
      <Navbar />

      <div className="container flex-1 px-4 py-6">
        <div className="mx-auto flex h-full max-w-5xl flex-col">
          <div className="mb-6">
            <h1 className="mb-2 text-3xl font-bold">Chat with Your Documents</h1>
            {documentsLoading ? (
              <p className="text-sm text-muted-foreground" role="status">
                Loading uploaded documents...
              </p>
            ) : documentsError ? (
              <p className="text-sm text-destructive">{documentsError}</p>
            ) : readyDocuments.length > 0 ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Select one ready document:</p>
                <div className="flex flex-wrap gap-2">
                  {readyDocuments.map((document) => (
                    <button
                      key={document.id}
                      type="button"
                      onClick={() => {
                        setSelectedDocumentId(document.id);
                        setSearchParams({ document: document.id }, { replace: true });
                      }}
                      disabled={isLoading || historyLoading}
                      aria-pressed={document.id === selectedDocumentId}
                      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                        document.id === selectedDocumentId
                          ? "bg-primary text-primary-foreground"
                          : "bg-primary/10 text-primary hover:bg-primary/20"
                      }`}
                    >
                      <BookOpen className="mr-1 h-3 w-3" />
                      {document.display_name ?? document.original_file_name}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm text-muted-foreground">
                  No ready documents are in the active upload batch.
                </p>
                <Button type="button" variant="outline" size="sm" onClick={() => navigate("/documents")}>
                  Add from Documents
                </Button>
              </div>
            )}
            {pendingCount > 0 && (
              <p className="mt-2 text-sm text-muted-foreground" role="status">
                {pendingCount} document(s) are awaiting or undergoing text processing.
              </p>
            )}
            {failedCount > 0 && (
              <p className="mt-2 text-sm text-destructive">
                Text extraction failed for {failedCount} document(s).
              </p>
            )}
          </div>

          <Card className="mb-4 flex-1 border-2">
            <CardContent className="p-0">
              <ScrollArea className="h-[calc(100vh-24rem)] p-6">
                <div className="space-y-6">
                  {historyLoading ? (
                    <p className="text-sm text-muted-foreground" role="status">
                      Loading saved messages...
                    </p>
                  ) : messages.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {selectedDocument
                        ? `Ask a question about ${selectedDocument.display_name ?? selectedDocument.original_file_name}.`
                        : "Select a ready document before asking a question."}
                    </p>
                  ) : (
                    messages.map((message) => (
                      <div
                        key={message.id}
                        className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`max-w-[80%] rounded-lg px-4 py-3 ${
                            message.role === "user"
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted"
                          }`}
                        >
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
                                  key={source.chunkId ?? `${source.pageNumber}-${index}`}
                                  source={source}
                                  documentName={selectedDocument
                                    ? selectedDocument.display_name ?? selectedDocument.original_file_name
                                    : undefined}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                  {isLoading && (
                    <div className="flex justify-start">
                      <div className="max-w-[80%] rounded-lg bg-muted px-4 py-3">
                        <div className="flex items-center gap-2" role="status" aria-label="Generating answer">
                          <div className="h-2 w-2 animate-bounce rounded-full bg-primary" />
                          <div className="h-2 w-2 animate-bounce rounded-full bg-primary delay-100" />
                          <div className="h-2 w-2 animate-bounce rounded-full bg-primary delay-200" />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="border-2">
            <CardContent className="p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <label htmlFor="source-context" className="text-sm font-medium">Answer depth</label>
                <Select value={responseMode} onValueChange={(value) => setResponseMode(value as ResponseMode)} disabled={isLoading}>
                  <SelectTrigger id="source-context" className="w-44" aria-label="Answer depth">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="concise">Concise</SelectItem>
                    <SelectItem value="balanced">Balanced</SelectItem>
                    <SelectItem value="detailed">Detailed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSend();
                }}
                className="flex gap-2"
              >
                <Input
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder={selectedDocumentId
                    ? "Ask a question about the selected document..."
                    : "Select a ready document first..."}
                  className="flex-1"
                  maxLength={1_000}
                  disabled={inputDisabled}
                />
                <Button
                  type="submit"
                  variant="hero"
                  disabled={inputDisabled || !input.trim()}
                  aria-label="Send question"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </form>
              {chatError && (
                <p className="mt-2 text-sm text-destructive" role="alert">
                  {chatError}
                </p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                Press Enter to send · Answers use only the selected PDF and include page references
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default Chat;
