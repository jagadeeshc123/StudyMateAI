import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Upload as UploadIcon, File, X } from "lucide-react";
import { toast } from "sonner";
import {
  processDocument,
  uploadDocument,
  validatePdfFile,
} from "@/integrations/supabase/documents";

interface UploadProgress {
  current: number;
  total: number;
  fileName: string;
  phase: "uploading" | "processing";
}

const Upload = () => {
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const navigate = useNavigate();

  const isUploading = uploadProgress !== null;

  const addFiles = async (candidateFiles: File[]) => {
    const validFiles: File[] = [];

    for (const file of candidateFiles) {
      const validationError = await validatePdfFile(file);

      if (validationError) {
        toast.error(`${file.name}: ${validationError}`);
      } else {
        validFiles.push(file);
      }
    }

    if (validFiles.length > 0) {
      setFiles((previousFiles) => [...previousFiles, ...validFiles]);
      toast.success(`Added ${validFiles.length} PDF file(s)`);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    if (!isUploading) {
      await addFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await addFiles(Array.from(e.target.files || []));
    e.target.value = "";
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
    toast.info("File removed");
  };

  const handleUpload = async () => {
    if (files.length === 0) {
      toast.error("Please add at least one PDF file");
      return;
    }

    setWorkflowError(null);
    const uploadFailures: File[] = [];
    const processingFailures: string[] = [];
    let readyDocumentCount = 0;

    for (const [index, file] of files.entries()) {
      setUploadProgress({
        current: index + 1,
        total: files.length,
        fileName: file.name,
        phase: "uploading",
      });

      try {
        const document = await uploadDocument(file);
        setUploadProgress({
          current: index + 1,
          total: files.length,
          fileName: file.name,
          phase: "processing",
        });

        try {
          await processDocument(document.id);
          readyDocumentCount += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : "PDF text extraction failed.";
          processingFailures.push(`${file.name}: ${message}`);
          toast.error(`${file.name}: ${message}`);
        }
      } catch (error) {
        uploadFailures.push(file);
        toast.error(error instanceof Error ? error.message : `Could not upload ${file.name}.`);
      }
    }

    setUploadProgress(null);
    setFiles(uploadFailures);

    if (uploadFailures.length > 0 || processingFailures.length > 0) {
      if (readyDocumentCount > 0) {
        toast.success(`${readyDocumentCount} document(s) uploaded and processed successfully.`);
      }

      const errorSummary = [
        uploadFailures.length > 0
          ? `${uploadFailures.length} upload(s) failed and remain selected so you can retry.`
          : null,
        processingFailures.length > 0
          ? `${processingFailures.length} PDF(s) uploaded but could not be processed: ${processingFailures.join(" ")}`
          : null,
      ].filter(Boolean).join(" ");

      setWorkflowError(errorSummary);
      return;
    }

    toast.success(`${readyDocumentCount} document(s) uploaded and processed successfully.`);
    navigate("/chat");
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <Navbar />
      
      <div className="container px-4 py-12">
        <div className="mx-auto max-w-3xl">
          <div className="mb-8 text-center">
            <h1 className="mb-3 text-3xl font-bold sm:text-4xl">
              Upload Your Study Materials
            </h1>
            <p className="text-lg text-muted-foreground">
              Add your textbooks, lecture notes, and research papers to get started
            </p>
          </div>

          <Card className="border-2">
            <CardHeader>
              <CardTitle>PDF Documents</CardTitle>
              <CardDescription>
                Upload one or more PDF files to analyze with AI
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`
                  rounded-lg border-2 border-dashed p-12 text-center transition-all
                  ${isDragging 
                    ? "border-primary bg-primary/5" 
                    : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50"
                  }
                `}
              >
                <UploadIcon className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
                <h3 className="mb-2 text-lg font-semibold">
                  Drag and drop your PDFs here
                </h3>
                <p className="mb-4 text-sm text-muted-foreground">
                  or click the button below to browse
                </p>
                <label htmlFor="file-input">
                  <Button variant="outline" asChild>
                    <span className="cursor-pointer">
                      <File className="mr-2 h-4 w-4" />
                      Choose Files
                    </span>
                  </Button>
                </label>
                <input
                  id="file-input"
                  type="file"
                  accept=".pdf"
                  multiple
                  className="hidden"
                  onChange={handleFileInput}
                  disabled={isUploading}
                />
              </div>

              {files.length > 0 && (
                <div className="mt-6 space-y-2">
                  <h4 className="font-semibold">Selected Files ({files.length})</h4>
                  {files.map((file, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between rounded-lg border bg-card p-3"
                    >
                      <div className="flex items-center space-x-3">
                        <File className="h-5 w-5 text-primary" />
                        <div>
                          <p className="text-sm font-medium">{file.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {(file.size / 1024 / 1024).toFixed(2)} MB
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeFile(index)}
                        disabled={isUploading}
                        aria-label={`Remove ${file.name}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-6 flex justify-end">
                {uploadProgress && (
                  <p className="mr-auto self-center text-sm text-muted-foreground" role="status">
                    {uploadProgress.phase === "uploading" ? "Uploading" : "Extracting text from"}{" "}
                    {uploadProgress.current} of {uploadProgress.total}: {uploadProgress.fileName}
                  </p>
                )}
                <Button
                  variant="hero"
                  size="lg"
                  onClick={handleUpload}
                  disabled={files.length === 0 || isUploading}
                >
                  <UploadIcon className="mr-2 h-5 w-5" />
                  {isUploading
                    ? uploadProgress.phase === "uploading"
                      ? "Uploading..."
                      : "Processing..."
                    : "Upload & Start Chatting"}
                </Button>
              </div>
              {workflowError && (
                <p className="mt-4 text-sm text-destructive" role="alert">
                  {workflowError}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default Upload;
