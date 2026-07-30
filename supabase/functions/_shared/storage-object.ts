import { createSupabaseAdminClient } from "./supabase-admin.ts";

export const DOCUMENT_BUCKET = "documents";
export const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024;
const PDF_MIME_TYPE = "application/pdf";

export interface VerifiedStorageObject {
  path: string;
  size: number;
  mimeType: string;
}

interface StorageMetadata {
  size?: unknown;
  mimetype?: unknown;
}

export interface StorageListEntry {
  name: string;
  metadata?: unknown;
}

export function verifiedPdfFromListing(
  userId: string,
  documentId: string,
  entries: StorageListEntry[],
): VerifiedStorageObject | null {
  const expectedName = `${documentId}.pdf`;
  const expectedPath = `${userId}/${expectedName}`;
  const object = entries.find((entry) => entry.name === expectedName);
  if (!object) return null;

  const metadata = (object.metadata ?? {}) as StorageMetadata;
  const size = typeof metadata.size === "number" ? metadata.size : Number.NaN;
  const mimeType = typeof metadata.mimetype === "string"
    ? metadata.mimetype.toLowerCase()
    : "";
  if (
    !Number.isSafeInteger(size) || size < 1 || size > MAX_PDF_SIZE_BYTES ||
    mimeType !== PDF_MIME_TYPE
  ) {
    return null;
  }
  return { path: expectedPath, size, mimeType };
}

export async function verifyOwnedPdfObject(
  userId: string,
  documentId: string,
): Promise<VerifiedStorageObject | null> {
  const expectedName = `${documentId}.pdf`;
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.storage.from(DOCUMENT_BUCKET).list(
    userId,
    { limit: 2, search: expectedName },
  );

  if (error) {
    throw new Error("Storage object verification failed.");
  }

  return verifiedPdfFromListing(userId, documentId, data ?? []);
}
