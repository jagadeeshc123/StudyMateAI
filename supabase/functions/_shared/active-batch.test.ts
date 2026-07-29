import {
  clearAllActiveBatches,
  getActiveBatch,
  removeFromActiveBatch,
  setActiveBatch,
} from "../../../src/integrations/supabase/active-batch.ts";
import {
  clearAllActiveSessions,
  getActiveSession,
  removeDocumentFromActiveSession,
  setActiveSession,
} from "../../../src/integrations/supabase/active-session.ts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: new MemoryStorage(),
});

Deno.test("deleting a document prunes only that active selection", () => {
  const userId = crypto.randomUUID();
  const firstDocument = crypto.randomUUID();
  const secondDocument = crypto.randomUUID();

  setActiveBatch(userId, [firstDocument, secondDocument]);
  removeFromActiveBatch(userId, firstDocument);

  if (getActiveBatch(userId).join() !== secondDocument) {
    throw new Error(
      "Deleting one document corrupted the remaining active selection.",
    );
  }
});

Deno.test("active batches are user-scoped, validated, and cleared on account change", () => {
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const documentA = crypto.randomUUID();
  const documentB = crypto.randomUUID();

  setActiveBatch(userA, [documentA, documentA, "not-a-document-id"]);
  setActiveBatch(userB, [documentB]);

  if (getActiveBatch(userA).join() !== documentA) {
    throw new Error("User A batch was not validated and deduplicated.");
  }

  if (getActiveBatch(userB).join() !== documentB) {
    throw new Error("User B batch did not remain isolated.");
  }

  clearAllActiveBatches();

  if (
    getActiveBatch(userA).length !== 0 || getActiveBatch(userB).length !== 0
  ) {
    throw new Error("Account transition did not clear user-specific batches.");
  }
});

Deno.test("multi-document sessions are user-scoped and invalidated by document deletion", () => {
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const sessionA = crypto.randomUUID();
  const sessionB = crypto.randomUUID();
  const documentA = crypto.randomUUID();
  const documentB = crypto.randomUUID();

  setActiveSession(userA, {
    sessionId: sessionA,
    mode: "comparison",
    documentIds: [documentA, documentB],
  });
  setActiveSession(userB, {
    sessionId: sessionB,
    mode: "multi_document",
    documentIds: [documentB],
  });

  if (getActiveSession(userA)?.sessionId !== sessionA) {
    throw new Error("User A active session was not restored independently.");
  }
  removeDocumentFromActiveSession(userA, documentA);
  if (
    getActiveSession(userA) !== null ||
    getActiveSession(userB)?.sessionId !== sessionB
  ) {
    throw new Error(
      "Document deletion did not invalidate only the affected user's session.",
    );
  }

  clearAllActiveSessions();
  if (getActiveSession(userB) !== null) {
    throw new Error("Account transition did not clear active chat sessions.");
  }
});
