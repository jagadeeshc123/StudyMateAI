import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Upload as UploadIcon, File, X } from "lucide-react";
import { toast } from "sonner";

const Upload = () => {
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const navigate = useNavigate();

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const droppedFiles = Array.from(e.dataTransfer.files).filter(
      file => file.type === "application/pdf"
    );
    
    if (droppedFiles.length > 0) {
      setFiles(prev => [...prev, ...droppedFiles]);
      toast.success(`Added ${droppedFiles.length} PDF file(s)`);
    } else {
      toast.error("Please upload PDF files only");
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []).filter(
      file => file.type === "application/pdf"
    );
    
    if (selectedFiles.length > 0) {
      setFiles(prev => [...prev, ...selectedFiles]);
      toast.success(`Added ${selectedFiles.length} PDF file(s)`);
    }
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
    toast.info("File removed");
  };

  const handleUpload = () => {
    if (files.length === 0) {
      toast.error("Please add at least one PDF file");
      return;
    }
    
    toast.success("PDFs uploaded successfully!");
    // Store files in sessionStorage for demo purposes
    sessionStorage.setItem("uploadedPDFs", JSON.stringify(files.map(f => f.name)));
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
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-6 flex justify-end">
                <Button
                  variant="hero"
                  size="lg"
                  onClick={handleUpload}
                  disabled={files.length === 0}
                >
                  <UploadIcon className="mr-2 h-5 w-5" />
                  Upload & Start Chatting
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
