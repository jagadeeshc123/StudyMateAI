import type { PageChunk } from "./page-retrieval.ts";

export interface HybridChunk extends PageChunk {
  document_id?: string;
  semantic_score?: number | null;
  keyword_score?: number | null;
  combined_score?: number | null;
}

function contentTokens(content: string): Set<string> {
  return new Set(
    content.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((token) =>
      token.length > 2
    ) ?? [],
  );
}

function overlapRatio(first: Set<string>, second: Set<string>): number {
  if (first.size === 0 || second.size === 0) return 0;
  let intersection = 0;

  for (const token of first) {
    if (second.has(token)) intersection += 1;
  }

  return intersection / Math.min(first.size, second.size);
}

function removeDuplicateCandidates(candidates: HybridChunk[]): HybridChunk[] {
  const seenIds = new Set<string>();
  const acceptedTokens: Set<string>[] = [];
  const accepted: HybridChunk[] = [];

  for (const candidate of candidates) {
    if (seenIds.has(candidate.id)) continue;

    const tokens = contentTokens(candidate.content);
    if (
      acceptedTokens.some((existing) => overlapRatio(tokens, existing) >= 0.9)
    ) {
      continue;
    }

    seenIds.add(candidate.id);
    acceptedTokens.push(tokens);
    accepted.push(candidate);
  }

  return accepted;
}

export function selectDiversifiedChunks(
  candidates: HybridChunk[],
  limit: number,
): HybridChunk[] {
  const boundedLimit = Math.max(0, Math.trunc(limit));
  if (boundedLimit === 0) return [];

  const deduplicated = removeDuplicateCandidates(candidates);
  const selected: HybridChunk[] = [];
  const selectedIds = new Set<string>();
  const seenPages = new Set<number>();

  // Preserve ranking while giving each represented page a first opportunity.
  for (const candidate of deduplicated) {
    if (seenPages.has(candidate.page_number)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.id);
    seenPages.add(candidate.page_number);
    if (selected.length === boundedLimit) return selected;
  }

  // Fill remaining context slots by original fused rank.
  for (const candidate of deduplicated) {
    if (selectedIds.has(candidate.id)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.id);
    if (selected.length === boundedLimit) break;
  }

  return selected;
}
