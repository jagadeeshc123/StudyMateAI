import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, MessageSquare, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { setActiveBatch } from "@/integrations/supabase/active-batch";
import Navbar from "@/components/Navbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  deleteDocument,
  listManagedDocuments,
  processDocument,
  renameDocument,
  validateDisplayName,
  type ManagedDocument,
} from "@/integrations/supabase/documents";

function formatFileSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function documentTitle(document: ManagedDocument): string {
  return document.display_name ?? document.original_file_name;
}

const Documents = () => {
  const [documents, setDocuments] = useState<ManagedDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<ManagedDocument | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ManagedDocument | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [visibleErrorId, setVisibleErrorId] = useState<string | null>(null);
  const navigate = useNavigate();
  const { user } = useAuth();

  const openInChat = (documentId: string) => {
    if (!user) return;
    setActiveBatch(user.id, [documentId]);
    navigate(`/chat?document=${documentId}`);
  };

  const refreshDocuments = useCallback(async () => {
    try {
      const nextDocuments = await listManagedDocuments();
      setDocuments(nextDocuments);
      setLoadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load documents.";
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshDocuments();
  }, [refreshDocuments]);

  const openRename = (document: ManagedDocument) => {
    setRenameTarget(document);
    setRenameValue(documentTitle(document));
    setRenameError(null);
  };

  const submitRename = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renameTarget || renaming) return;

    const validationError = validateDisplayName(renameValue);
    if (validationError) {
      setRenameError(validationError);
      return;
    }

    setRenaming(true);
    setRenameError(null);
    try {
      const trimmedName = renameValue.trim();
      await renameDocument(renameTarget.id, trimmedName);
      setDocuments((current) => current.map((document) =>
        document.id === renameTarget.id ? { ...document, display_name: trimmedName } : document
      ));
      setRenameTarget(null);
      toast.success("Document renamed.");
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : "Could not rename the document.");
    } finally {
      setRenaming(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deletingId) return;

    const target = deleteTarget;
    setDeleteTarget(null);
    setDeletingId(target.id);
    setDocuments((current) => current.map((document) =>
      document.id === target.id ? { ...document, processing_status: "deleting" } : document
    ));

    try {
      await deleteDocument(target.id);
      setDocuments((current) => current.filter((document) => document.id !== target.id));
      toast.success("Document and its private file were deleted.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not delete the document.";
      toast.error(message);
      await refreshDocuments();
    } finally {
      setDeletingId(null);
    }
  };

  const retryProcessing = async (document: ManagedDocument) => {
    if (retryingId || !["failed", "uploaded"].includes(document.processing_status)) return;

    setRetryingId(document.id);
    setDocuments((current) => current.map((item) =>
      item.id === document.id
        ? { ...item, processing_status: "processing", processing_error: null }
        : item
    ));

    try {
      await processDocument(document.id);
      toast.success("Document processing completed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Document processing failed.");
    } finally {
      setRetryingId(null);
      await refreshDocuments();
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <Navbar />
      <div className="container px-4 py-10">
        <div className="mx-auto max-w-5xl">
          <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-3xl font-bold sm:text-4xl">Your Documents</h1>
              <p className="mt-2 text-muted-foreground">Manage private PDFs, processing, and document statistics.</p>
            </div>
            <Button variant="outline" onClick={() => void refreshDocuments()} disabled={loading}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground" role="status">Loading your documents...</p>
          ) : loadError ? (
            <p className="text-sm text-destructive" role="alert">{loadError}</p>
          ) : documents.length === 0 ? (
            <Card className="border-2">
              <CardContent className="p-8 text-center text-muted-foreground">
                You have not uploaded any documents yet.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {documents.map((document) => {
                const status = document.id === deletingId ? "deleting" : document.processing_status;
                const retryable = status === "failed" || status === "uploaded";
                const operationBusy = document.id === deletingId || document.id === retryingId;

                return (
                  <Card key={document.id} className="border-2">
                    <CardHeader className="pb-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <CardTitle className="flex items-center gap-2">
                            <FileText className="h-5 w-5 shrink-0 text-primary" />
                            <span className="truncate">{documentTitle(document)}</span>
                          </CardTitle>
                          <p className="mt-1 truncate text-sm text-muted-foreground" title={document.original_file_name}>
                            Original: {document.original_file_name}
                          </p>
                        </div>
                        <Badge variant={status === "failed" ? "destructive" : status === "ready" ? "default" : "secondary"}>
                          {status.charAt(0).toUpperCase() + status.slice(1)}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
                        <div><dt className="text-muted-foreground">File size</dt><dd className="font-medium">{formatFileSize(document.file_size)}</dd></div>
                        <div><dt className="text-muted-foreground">Uploaded</dt><dd className="font-medium">{new Date(document.created_at).toLocaleString()}</dd></div>
                        <div><dt className="text-muted-foreground">Pages</dt><dd className="font-medium">{document.page_count ?? "—"}</dd></div>
                        <div><dt className="text-muted-foreground">Chunks</dt><dd className="font-medium">{document.chunk_count}</dd></div>
                        <div><dt className="text-muted-foreground">Messages</dt><dd className="font-medium">{document.message_count}</dd></div>
                      </dl>

                      {visibleErrorId === document.id && document.processing_error && (
                        <p className="mt-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
                          {document.processing_error}
                        </p>
                      )}

                      <div className="mt-5 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={() => openInChat(document.id)}
                          disabled={status !== "ready" || operationBusy}
                        >
                          <MessageSquare className="mr-2 h-4 w-4" />
                          Open in Chat
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => openRename(document)} disabled={status === "deleting" || operationBusy}>
                          <Pencil className="mr-2 h-4 w-4" />
                          Rename
                        </Button>
                        {retryable && (
                          <Button size="sm" variant="outline" onClick={() => void retryProcessing(document)} disabled={operationBusy}>
                            <RefreshCw className="mr-2 h-4 w-4" />
                            {document.id === retryingId ? "Processing..." : "Retry Processing"}
                          </Button>
                        )}
                        {document.processing_error && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setVisibleErrorId((current) => current === document.id ? null : document.id)}
                          >
                            {visibleErrorId === document.id ? "Hide processing error" : "View processing error"}
                          </Button>
                        )}
                        <Button size="sm" variant="destructive" onClick={() => setDeleteTarget(document)} disabled={operationBusy}>
                          <Trash2 className="mr-2 h-4 w-4" />
                          {document.id === deletingId ? "Deleting..." : status === "deleting" ? "Retry Delete" : "Delete"}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <Dialog open={Boolean(renameTarget)} onOpenChange={(open) => !open && !renaming && setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename document</DialogTitle>
            <DialogDescription>The original filename will remain unchanged.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submitRename} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="display-name">Display name</Label>
              <Input
                id="display-name"
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                disabled={renaming}
                autoFocus
              />
            </div>
            {renameError && <p className="text-sm text-destructive" role="alert">{renameError}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenameTarget(null)} disabled={renaming}>Cancel</Button>
              <Button type="submit" disabled={renaming}>{renaming ? "Saving..." : "Save name"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the private PDF, extracted chunks, and its chat history for {deleteTarget ? documentTitle(deleteTarget) : "this document"}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete document
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Documents;
