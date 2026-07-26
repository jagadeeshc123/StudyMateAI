import { supabase } from "@/integrations/supabase/client";
import type { Database, Tables } from "@/integrations/supabase/types";
import { invokeEdgeFunction } from "@/integrations/supabase/edge-functions";

export const DOCUMENTS_BUCKET = "documents";
export const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024;

const PDF_MIME_TYPE = "application/pdf";
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d];

export type DocumentRecord = Tables<"documents">;
export type DocumentSummary = Database["public"]["Functions"]["list_documents"]["Returns"][number];

export interface ProcessDocumentResult {
  documentId: string;
  status: "ready";
  pageCount: number;
  chunkCount: number;
}

export class DocumentStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentStorageError";
  }
}

export async function validatePdfFile(file: File): Promise<string | null> {
  if (file.size === 0) {
    return "The file is empty.";
  }

  if (file.size > MAX_PDF_SIZE_BYTES) {
    return "The file exceeds the 20 MB limit.";
  }

  if (file.type !== PDF_MIME_TYPE || !file.name.toLowerCase().endsWith(".pdf")) {
    return "Only PDF files are allowed.";
  }

  try {
    const signature = new Uint8Array(await file.slice(0, PDF_SIGNATURE.length).arrayBuffer());
    const isPdf = PDF_SIGNATURE.every((byte, index) => signature[index] === byte);

    if (!isPdf) {
      return "The file does not contain a valid PDF signature.";
    }
  } catch {
    return "The file could not be read for validation.";
  }

  return null;
}

export async function uploadDocument(file: File): Promise<DocumentRecord> {
  const validationError = await validatePdfFile(file);

  if (validationError) {
    throw new DocumentStorageError(`${file.name}: ${validationError}`);
  }

  const documentId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const storagePath = `anonymous/${documentId}.pdf`;
  const { error: storageError } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(storagePath, file, {
      cacheControl: "3600",
      contentType: PDF_MIME_TYPE,
      upsert: false,
    });

  if (storageError) {
    throw new DocumentStorageError(`Could not upload ${file.name}: ${storageError.message}`);
  }

  const documentToInsert: DocumentRecord = {
    id: documentId,
    original_file_name: file.name,
    storage_path: storagePath,
    file_size: file.size,
    mime_type: PDF_MIME_TYPE,
    processing_status: "uploaded",
    created_at: createdAt,
  };

  const { error: databaseError } = await supabase
    .from("documents")
    .insert(documentToInsert);

  if (databaseError) {
    const { error: cleanupError } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .remove([storagePath]);

    const cleanupMessage = cleanupError
      ? ` Automatic cleanup also failed: ${cleanupError.message}`
      : " The uploaded file was removed automatically.";

    throw new DocumentStorageError(
      `The file uploaded, but its document record could not be created: ${databaseError.message}.${cleanupMessage}`,
    );
  }

  return documentToInsert;
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  const { data, error } = await supabase.rpc("list_documents");

  if (error) {
    throw new DocumentStorageError(`Could not load uploaded documents: ${error.message}`);
  }

  return data;
}

export async function processDocument(documentId: string): Promise<ProcessDocumentResult> {
  return invokeEdgeFunction<ProcessDocumentResult>("process-document", { documentId });
}
