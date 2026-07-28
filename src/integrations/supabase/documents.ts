import { supabase } from "@/integrations/supabase/client";
import type { Database, Tables } from "@/integrations/supabase/types";
import { invokeEdgeFunction } from "@/integrations/supabase/edge-functions";

export const DOCUMENTS_BUCKET = "documents";
export const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024;
export const MAX_DISPLAY_NAME_LENGTH = 150;

const PDF_MIME_TYPE = "application/pdf";
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d];

export type DocumentRecord = Tables<"documents">;
export type ManagedDocument = Database["public"]["Functions"]["list_user_documents"]["Returns"][number];
export type DocumentSummary = ManagedDocument;

export interface ProcessDocumentResult {
  documentId: string;
  status: "ready";
  pageCount?: number;
  chunkCount?: number;
  embedding: {
    status: "ready" | "failed" | "skipped";
    totalChunks: number;
    embeddedChunks: number;
    skippedChunks: number;
    failedChunks: number;
    error: string | null;
  };
}

export interface DeleteDocumentResult {
  documentId: string;
  deleted: true;
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

export function validateDisplayName(value: string): string | null {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return "Display name cannot be empty.";
  }

  if (Array.from(trimmedValue).length > MAX_DISPLAY_NAME_LENGTH) {
    return `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`;
  }

  if (/\p{Cc}/u.test(trimmedValue)) {
    return "Display name cannot contain control characters.";
  }

  return null;
}

export async function uploadDocument(file: File): Promise<DocumentRecord> {
  const validationError = await validatePdfFile(file);

  if (validationError) {
    throw new DocumentStorageError(`${file.name}: ${validationError}`);
  }

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const user = sessionData.session?.user;

  if (sessionError || !user) {
    throw new DocumentStorageError("Your session has expired. Log in again before uploading.");
  }

  const documentId = crypto.randomUUID();
  const storagePath = `${user.id}/${documentId}.pdf`;
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

  const documentToInsert: Database["public"]["Tables"]["documents"]["Insert"] = {
    id: documentId,
    user_id: user.id,
    original_file_name: file.name,
    storage_path: storagePath,
    file_size: file.size,
    mime_type: PDF_MIME_TYPE,
    processing_status: "uploaded",
  };

  const { data: document, error: databaseError } = await supabase
    .from("documents")
    .insert(documentToInsert)
    .select()
    .single();

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

  return document;
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  const documents = await listManagedDocuments();
  return documents.filter((document) => document.processing_status === "ready");
}

export async function listManagedDocuments(): Promise<ManagedDocument[]> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const user = sessionData.session?.user;

  if (sessionError || !user) {
    throw new DocumentStorageError("Your session has expired. Log in again to view documents.");
  }

  const { data, error } = await supabase.rpc("list_user_documents");

  if (error) {
    throw new DocumentStorageError(`Could not load uploaded documents: ${error.message}`);
  }

  return data ?? [];
}

export async function renameDocument(documentId: string, displayName: string): Promise<void> {
  const validationError = validateDisplayName(displayName);

  if (validationError) {
    throw new DocumentStorageError(validationError);
  }

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const user = sessionData.session?.user;

  if (sessionError || !user) {
    throw new DocumentStorageError("Your session has expired. Log in again before renaming.");
  }

  const { data, error } = await supabase
    .from("documents")
    .update({ display_name: displayName.trim() })
    .eq("id", documentId)
    .eq("user_id", user.id)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new DocumentStorageError(`Could not rename the document: ${error.message}`);
  }

  if (!data) {
    throw new DocumentStorageError("Document not found or you do not have permission to rename it.");
  }
}

export async function deleteDocument(documentId: string): Promise<DeleteDocumentResult> {
  return invokeEdgeFunction<DeleteDocumentResult>("delete-document", { documentId });
}

export async function processDocument(documentId: string): Promise<ProcessDocumentResult> {
  return invokeEdgeFunction<ProcessDocumentResult>("process-document", { documentId });
}

export async function backfillDocumentEmbeddings(
  documentId: string,
): Promise<ProcessDocumentResult> {
  return invokeEdgeFunction<ProcessDocumentResult>("process-document", {
    action: "backfill_embeddings",
    documentId,
  });
}
