import {
  clearAllActiveBatches,
  getActiveBatch,
  setActiveBatch,
} from "../../../src/integrations/supabase/active-batch.ts";

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

  if (getActiveBatch(userA).length !== 0 || getActiveBatch(userB).length !== 0) {
    throw new Error("Account transition did not clear user-specific batches.");
  }
});
