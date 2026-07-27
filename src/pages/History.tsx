import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, MessageSquare, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { setActiveBatch } from "@/integrations/supabase/active-batch";
import Navbar from "@/components/Navbar";
import SourceExcerpt from "@/components/SourceExcerpt";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import type { PersistedMessage, SourceCitation } from "@/integrations/supabase/chat";
import { listManagedDocuments, type ManagedDocument } from "@/integrations/supabase/documents";
import {
  clearAllHistory,
  clearDocumentHistory,
  loadAllHistoryMessages,
} from "@/integrations/supabase/history";

interface HistoryEntry {
  id: string;
  documentId: string;
  question: string;
  answer: string;
  sources: SourceCitation[];
  createdAt: string;
}

interface HistoryGroup {
  document: ManagedDocument;
  entries: HistoryEntry[];
}

type ClearTarget = { type: "all" } | { type: "document"; document: ManagedDocument };

function documentTitle(document: ManagedDocument): string {
  return document.display_name ?? document.original_file_name;
}

function parseAssistantMessage(content: string): { answer: string; sources: SourceCitation[] } {
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

    if (typeof parsed.answer === "string") return { answer: parsed.answer, sources };
  } catch {
    // Older assistant rows may contain plain text.
  }

  return { answer: content, sources: [] };
}

function buildHistoryEntries(messages: PersistedMessage[]): HistoryEntry[] {
  const messagesByDocument = new Map<string, PersistedMessage[]>();

  for (const message of messages) {
    const documentMessages = messagesByDocument.get(message.document_id) ?? [];
    documentMessages.push(message);
    messagesByDocument.set(message.document_id, documentMessages);
  }

  const entries: HistoryEntry[] = [];

  for (const [documentId, documentMessages] of messagesByDocument) {
    let pendingEntry: HistoryEntry | null = null;

    for (const message of documentMessages) {
      if (message.role === "user") {
        pendingEntry = {
          id: message.id,
          documentId,
          question: message.content,
          answer: "",
          sources: [],
          createdAt: message.created_at,
        };
        entries.push(pendingEntry);
      } else if (pendingEntry && !pendingEntry.answer) {
        const parsed = parseAssistantMessage(message.content);
        pendingEntry.answer = parsed.answer;
        pendingEntry.sources = parsed.sources;
        pendingEntry = null;
      }
    }
  }

  return entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

const History = () => {
  const [documents, setDocuments] = useState<ManagedDocument[]>([]);
  const [messages, setMessages] = useState<PersistedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedDocumentId, setSelectedDocumentId] = useState("all");
  const [searchText, setSearchText] = useState("");
  const [clearTarget, setClearTarget] = useState<ClearTarget | null>(null);
  const [clearing, setClearing] = useState(false);
  const navigate = useNavigate();
  const { user } = useAuth();

  const openInChat = (documentId: string) => {
    if (!user) return;
    setActiveBatch(user.id, [documentId]);
    navigate(`/chat?document=${documentId}`);
  };

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const ownedDocuments = await listManagedDocuments();
      const historyMessages = await loadAllHistoryMessages(ownedDocuments.map((document) => document.id));
      setDocuments(ownedDocuments);
      setMessages(historyMessages);
      setLoadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load Q&A history.";
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const groups = useMemo<HistoryGroup[]>(() => {
    const normalizedSearch = searchText.trim().toLowerCase();
    const entries = buildHistoryEntries(messages).filter((entry) =>
      (selectedDocumentId === "all" || entry.documentId === selectedDocumentId)
      && (!normalizedSearch
        || entry.question.toLowerCase().includes(normalizedSearch)
        || entry.answer.toLowerCase().includes(normalizedSearch))
    );

    return documents
      .filter((document) => selectedDocumentId === "all" || document.id === selectedDocumentId)
      .map((document) => ({
        document,
        entries: entries.filter((entry) => entry.documentId === document.id),
      }))
      .filter((group) => group.entries.length > 0);
  }, [documents, messages, searchText, selectedDocumentId]);

  const confirmClear = async () => {
    if (!clearTarget || clearing) return;

    setClearing(true);
    try {
      if (clearTarget.type === "all") {
        await clearAllHistory();
        setMessages([]);
        setDocuments((current) => current.map((document) => ({ ...document, message_count: 0 })));
        toast.success("All Q&A history was cleared. Your documents were kept.");
      } else {
        await clearDocumentHistory(clearTarget.document.id);
        setMessages((current) => current.filter(
          (message) => message.document_id !== clearTarget.document.id
        ));
        setDocuments((current) => current.map((document) =>
          document.id === clearTarget.document.id ? { ...document, message_count: 0 } : document
        ));
        toast.success("Document history was cleared. The PDF was kept.");
      }
      setClearTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not clear history.");
    } finally {
      setClearing(false);
    }
  };

  const totalQuestions = buildHistoryEntries(messages).length;

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <Navbar />
      <div className="container px-4 py-10">
        <div className="mx-auto max-w-5xl">
          <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-3xl font-bold sm:text-4xl">Q&A History</h1>
              <p className="mt-2 text-muted-foreground">Review saved questions, answers, and cited pages.</p>
            </div>
            <Button
              variant="destructive"
              onClick={() => setClearTarget({ type: "all" })}
              disabled={loading || totalQuestions === 0}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Clear All History
            </Button>
          </div>

          <Card className="mb-6 border-2">
            <CardContent className="grid gap-4 p-4 sm:grid-cols-2">
              <Input
                type="search"
                placeholder="Search questions and answers..."
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                aria-label="Search Q&A history"
              />
              <Select value={selectedDocumentId} onValueChange={setSelectedDocumentId}>
                <SelectTrigger aria-label="Filter history by document">
                  <SelectValue placeholder="All documents" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All documents</SelectItem>
                  {documents.map((document) => (
                    <SelectItem key={document.id} value={document.id}>{documentTitle(document)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          {loading ? (
            <p className="text-sm text-muted-foreground" role="status">Loading Q&A history...</p>
          ) : loadError ? (
            <p className="text-sm text-destructive" role="alert">{loadError}</p>
          ) : groups.length === 0 ? (
            <Card className="border-2">
              <CardContent className="p-8 text-center text-muted-foreground">
                {totalQuestions === 0 ? "No saved Q&A history yet." : "No history matches these filters."}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-6">
              {groups.map(({ document, entries }) => (
                <Card key={document.id} className="border-2">
                  <CardHeader>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <CardTitle className="flex items-center gap-2">
                        <BookOpen className="h-5 w-5 text-primary" />
                        {documentTitle(document)}
                      </CardTitle>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={() => openInChat(document.id)}
                          disabled={document.processing_status !== "ready"}
                        >
                          <MessageSquare className="mr-2 h-4 w-4" />
                          Open in Chat
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setClearTarget({ type: "document", document })}>
                          <Trash2 className="mr-2 h-4 w-4" />
                          Clear History
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {entries.map((entry) => (
                      <div key={entry.id} className="rounded-lg border p-4">
                        <p className="text-xs text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</p>
                        <p className="mt-2 text-sm font-semibold">Question</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm">{entry.question}</p>
                        <p className="mt-3 text-sm font-semibold">Answer</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                          {entry.answer || "No saved answer is available."}
                        </p>
                        {entry.sources.length > 0 && (
                          <div className="mt-3 border-t pt-3">
                            <p className="text-xs font-semibold">Cited pages</p>
                            <div className="mt-2 space-y-2">
                              {entry.sources.map((source, index) => (
                                <SourceExcerpt
                                  key={source.chunkId ?? `${source.pageNumber}-${index}`}
                                  source={source}
                                  documentName={documentTitle(document)}
                                />
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={Boolean(clearTarget)} onOpenChange={(open) => !open && !clearing && setClearTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {clearTarget?.type === "all" ? "Clear all Q&A history?" : "Clear this document's history?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Saved questions and answers will be permanently removed. The related private PDF documents will not be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void confirmClear();
              }}
              disabled={clearing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {clearing ? "Clearing..." : "Clear history"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default History;
