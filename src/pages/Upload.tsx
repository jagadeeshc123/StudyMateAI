import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { File, Upload as UploadIcon, X } from "lucide-react";
import { toast } from "sonner";
import Navbar from "@/components/Navbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { setActiveBatch } from "@/integrations/supabase/active-batch";
import {
  processDocument,
  uploadDocument,
  validatePdfFile,
} from "@/integrations/supabase/documents";

type FileStatus = "validating" | "rejected" | "validated" | "uploading" | "processing" | "ready" | "failed";

interface BatchFile {
  id: string;
  file: File;
  status: FileStatus;
  error: string | null;
  documentId: string | null;
}

interface BatchSummary {
  ready: number;
  rejected: number;
  failed: number;
}

const STATUS_LABELS: Record<FileStatus, string> = {
  validating: "Validating",
  rejected: "Rejected",
  validated: "Ready to upload",
  uploading: "Uploading",
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
};
const MAX_UPLOAD_BATCH_SIZE = 5;

const Upload = () => {
  const [files, setFiles] = useState<BatchFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [batchSummary, setBatchSummary] = useState<BatchSummary | null>(null);
  const navigate = useNavigate();
  const { user } = useAuth();

  const updateFile = (id: string, update: Partial<BatchFile>) => {
    setFiles((current) => current.map((item) => item.id === id ? { ...item, ...update } : item));
  };

  const addFiles = async (candidateFiles: File[]) => {
    if (candidateFiles.length === 0) return;
    const availableSlots = Math.max(MAX_UPLOAD_BATCH_SIZE - files.length, 0);
    if (availableSlots === 0) {
      toast.error(`Upload no more than ${MAX_UPLOAD_BATCH_SIZE} PDFs at a time.`);
      return;
    }
    if (candidateFiles.length > availableSlots) {
      toast.error(
        `Only the first ${availableSlots} file(s) were added. Upload no more than ${MAX_UPLOAD_BATCH_SIZE} PDFs at a time.`,
      );
    }
    candidateFiles = candidateFiles.slice(0, availableSlots);

    setBatchSummary(null);
    const candidates: BatchFile[] = candidateFiles.map((file) => ({
      id: crypto.randomUUID(),
      file,
      status: "validating",
      error: null,
      documentId: null,
    }));
    setFiles((current) => [...current, ...candidates]);

    const validationResults = await Promise.all(candidates.map(async (candidate) => ({
      candidate,
      validationError: await validatePdfFile(candidate.file),
    })));

    for (const { candidate, validationError } of validationResults) {
      updateFile(candidate.id, validationError
        ? { status: "rejected", error: validationError }
        : { status: "validated", error: null });
    }

    const rejectedCount = validationResults.filter((result) => result.validationError).length;
    const acceptedCount = candidates.length - rejectedCount;

    if (acceptedCount > 0) toast.success(`${acceptedCount} PDF file(s) passed validation.`);
    if (rejectedCount > 0) toast.error(`${rejectedCount} file(s) were rejected; other valid files remain available.`);
  };

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    if (!isUploading) await addFiles(Array.from(event.dataTransfer.files));
  };

  const handleFileInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    await addFiles(Array.from(event.target.files || []));
    event.target.value = "";
  };

  const handleUpload = async () => {
    const uploadableFiles = files.filter((item) => item.status === "validated");
    if (uploadableFiles.length === 0 || !user) {
      toast.error("Add at least one valid PDF before uploading.");
      return;
    }

    setIsUploading(true);
    setBatchSummary(null);
    const readyDocumentIds: string[] = [];

    for (const item of uploadableFiles) {
      updateFile(item.id, { status: "uploading", error: null });

      try {
        const document = await uploadDocument(item.file);
        updateFile(item.id, {
          status: "processing",
          documentId: document.id,
        });

        try {
          await processDocument(document.id);
          readyDocumentIds.push(document.id);
          updateFile(item.id, { status: "ready", error: null });
        } catch (error) {
          updateFile(item.id, {
            status: "failed",
            error: error instanceof Error ? error.message : "PDF text extraction failed.",
          });
        }
      } catch (error) {
        updateFile(item.id, {
          status: "failed",
          error: error instanceof Error ? error.message : "Upload failed.",
        });
      }
    }

    const summary: BatchSummary = {
      ready: readyDocumentIds.length,
      rejected: files.filter((item) => item.status === "rejected").length,
      failed: uploadableFiles.length - readyDocumentIds.length,
    };

    setBatchSummary(summary);
    setIsUploading(false);
    toast.info(`${summary.ready} ready · ${summary.rejected} rejected · ${summary.failed} failed`);

    if (readyDocumentIds.length > 0) {
      setActiveBatch(user.id, readyDocumentIds);
      navigate("/chat");
    }
  };

  const uploadableCount = files.filter((item) => item.status === "validated").length;

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <Navbar />
      <div className="container px-4 py-12">
        <div className="mx-auto max-w-3xl">
          <div className="mb-8 text-center">
            <h1 className="mb-3 text-3xl font-bold sm:text-4xl">Upload Your Study Materials</h1>
            <p className="text-lg text-muted-foreground">Each PDF is validated and processed independently.</p>
          </div>

          <Card className="border-2">
            <CardHeader>
              <CardTitle>PDF Documents</CardTitle>
              <CardDescription>Up to five searchable PDFs per batch and 20 MB each. Invalid files do not block valid files.</CardDescription>
            </CardHeader>
            <CardContent>
              <div
                onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(event) => void handleDrop(event)}
                className={`rounded-lg border-2 border-dashed p-12 text-center transition-all ${
                  isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50"
                }`}
              >
                <UploadIcon className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
                <h3 className="mb-2 text-lg font-semibold">Drag and drop your PDFs here</h3>
                <p className="mb-4 text-sm text-muted-foreground">or browse for one or more files</p>
                <label htmlFor="file-input">
                  <Button variant="outline" asChild>
                    <span className="cursor-pointer"><File className="mr-2 h-4 w-4" />Choose Files</span>
                  </Button>
                </label>
                <input
                  id="file-input"
                  type="file"
                  accept=".pdf,application/pdf"
                  multiple
                  className="hidden"
                  onChange={(event) => void handleFileInput(event)}
                  disabled={isUploading}
                />
              </div>

              {files.length > 0 && (
                <div className="mt-6 space-y-2">
                  <h4 className="font-semibold">Batch files ({files.length})</h4>
                  {files.map((item) => (
                    <div key={item.id} className="rounded-lg border bg-card p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <File className="h-5 w-5 shrink-0 text-primary" />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{item.file.name}</p>
                            <p className="text-xs text-muted-foreground">{(item.file.size / 1024 / 1024).toFixed(2)} MB</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant={item.status === "rejected" || item.status === "failed" ? "destructive" : item.status === "ready" ? "default" : "secondary"}>
                            {STATUS_LABELS[item.status]}
                          </Badge>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setFiles((current) => current.filter((file) => file.id !== item.id))}
                            disabled={isUploading || ["uploading", "processing"].includes(item.status)}
                            aria-label={`Remove ${item.file.name}`}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      {item.error && <p className="mt-2 text-sm text-destructive" role="alert">{item.error}</p>}
                    </div>
                  ))}
                </div>
              )}

              {batchSummary && (
                <p className="mt-4 rounded-md bg-muted p-3 text-sm font-medium" role="status">
                  Batch result: {batchSummary.ready} ready · {batchSummary.rejected} rejected · {batchSummary.failed} failed
                </p>
              )}

              <div className="mt-6 flex justify-end">
                <Button variant="hero" size="lg" onClick={() => void handleUpload()} disabled={uploadableCount === 0 || isUploading}>
                  <UploadIcon className="mr-2 h-5 w-5" />
                  {isUploading ? "Processing batch..." : "Upload & Start Chatting"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default Upload;
