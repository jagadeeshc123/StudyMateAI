const ACTIVE_BATCH_PREFIX = "studymate.active-batch.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BATCH_DOCUMENTS = 50;

function storageKey(userId: string): string {
  return `${ACTIVE_BATCH_PREFIX}${userId}`;
}

export function getActiveBatch(userId: string): string[] {
  try {
    const stored = sessionStorage.getItem(storageKey(userId));
    if (!stored) return [];

    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [];

    return [...new Set(parsed.filter(
      (value): value is string => typeof value === "string" && UUID_PATTERN.test(value),
    ))].slice(0, MAX_BATCH_DOCUMENTS);
  } catch {
    return [];
  }
}

export function setActiveBatch(userId: string, documentIds: string[]): void {
  const safeIds = [...new Set(documentIds.filter((id) => UUID_PATTERN.test(id)))]
    .slice(0, MAX_BATCH_DOCUMENTS);
  sessionStorage.setItem(storageKey(userId), JSON.stringify(safeIds));
}

export function removeFromActiveBatch(userId: string, documentId: string): void {
  setActiveBatch(
    userId,
    getActiveBatch(userId).filter((id) => id !== documentId),
  );
}

export function clearAllActiveBatches(): void {
  for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = sessionStorage.key(index);
    if (key?.startsWith(ACTIVE_BATCH_PREFIX)) sessionStorage.removeItem(key);
  }
}
