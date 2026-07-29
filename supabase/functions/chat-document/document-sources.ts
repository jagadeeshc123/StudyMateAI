import type { ResponseMode } from "../_shared/chat-controls.ts";

export interface SourceChunk {
  id: string;
  content: string;
  page_number: number;
}

export interface SourceCitation {
  chunkId: string;
  pageNumber: number;
  excerpt: string;
  fullExcerpt: string;
}

export function buildPlainChunkContext(chunks: SourceChunk[]): string {
  return chunks.map((chunk, index) =>
    `[DOCUMENT CHUNK ${index + 1}]\n${chunk.content}`
  ).join("\n\n---\n\n");
}

export function buildPlainSectionContext(sections: string[]): string {
  return sections.map((section, index) =>
    `[DOCUMENT SECTION ${index + 1}]\n${section}`
  ).join("\n\n---\n\n");
}

function uniquePageChunks(chunks: SourceChunk[]): SourceChunk[] {
  const seenPages = new Set<number>();
  return chunks.filter((chunk) => {
    if (seenPages.has(chunk.page_number)) return false;
    seenPages.add(chunk.page_number);
    return true;
  });
}

const SUPPORT_STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "answer",
  "because",
  "before",
  "being",
  "between",
  "could",
  "document",
  "does",
  "from",
  "have",
  "into",
  "only",
  "other",
  "selected",
  "source",
  "such",
  "than",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "through",
  "using",
  "were",
  "which",
  "while",
  "with",
  "would",
]);

function supportTokens(value: string): Set<string> {
  return new Set(
    value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((token) =>
      (token.length > 2 || /^\d+$/.test(token)) &&
      !SUPPORT_STOP_WORDS.has(token)
    ) ?? [],
  );
}

function answerClaims(answer: string): Set<string>[] {
  return answer
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((claim) => supportTokens(claim))
    .filter((tokens) => tokens.size >= 2);
}

function claimSupportScore(
  claimTokens: Set<string>,
  chunkTokens: Set<string>,
): number {
  let sharedTokens = 0;

  for (const token of claimTokens) {
    if (chunkTokens.has(token)) sharedTokens += 1;
  }

  if (sharedTokens < 2) return 0;
  const claimCoverage = sharedTokens / claimTokens.size;
  return claimCoverage >= 0.5 ? sharedTokens + claimCoverage : 0;
}

/**
 * Select only database chunks that materially support the generated answer.
 * Every substantive answer claim must match a retrieved chunk; otherwise the
 * answer is rejected by returning no citation IDs. This deliberately favors a
 * safe not-found response over attaching a merely related citation.
 */
export function selectAnswerSupportingCitationIds(
  answer: string,
  chunks: SourceChunk[],
  mode: ResponseMode,
): string[] {
  const claims = answerClaims(answer);
  if (claims.length === 0 || chunks.length === 0) return [];

  const chunkTokens = chunks.map((chunk) => supportTokens(chunk.content));
  const supportingIds: string[] = [];

  for (const claim of claims) {
    let bestIndex = -1;
    let bestScore = 0;

    for (let index = 0; index < chunks.length; index += 1) {
      const score = claimSupportScore(claim, chunkTokens[index]);
      if (score > bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    if (bestIndex < 0) return [];
    supportingIds.push(chunks[bestIndex].id);
  }

  const limit = mode === "concise" ? 3 : mode === "balanced" ? 6 : 8;
  const uniqueIds = [...new Set(supportingIds)];
  const selected: string[] = [];
  const seenPages = new Set<number>();

  for (const id of uniqueIds) {
    const chunk = chunks.find((candidate) => candidate.id === id);
    if (!chunk || seenPages.has(chunk.page_number)) continue;
    selected.push(id);
    seenPages.add(chunk.page_number);
    if (selected.length === limit) return selected;
  }

  for (const id of uniqueIds) {
    if (selected.includes(id)) continue;
    selected.push(id);
    if (selected.length === limit) break;
  }

  return selected;
}

export function selectStrongestCitationIds(
  chunks: SourceChunk[],
  mode: ResponseMode,
): string[] {
  const minimum = mode === "concise" ? 2 : mode === "balanced" ? 3 : 5;
  const limit = mode === "concise" ? 3 : mode === "balanced" ? 6 : 8;
  const selected = uniquePageChunks(chunks).slice(0, limit);
  const selectedIds = new Set(selected.map((chunk) => chunk.id));

  if (selected.length < minimum) {
    for (const chunk of chunks) {
      if (selectedIds.has(chunk.id)) continue;
      selected.push(chunk);
      selectedIds.add(chunk.id);
      if (selected.length === Math.min(minimum, chunks.length)) break;
    }
  }

  return selected.map((chunk) => chunk.id);
}

export function selectRepresentativeCitationIds(
  chunks: SourceChunk[],
  mode: ResponseMode,
): string[] {
  const candidates = uniquePageChunks(chunks);
  const limit = mode === "concise" ? 3 : mode === "balanced" ? 6 : 8;
  const count = Math.min(limit, candidates.length);

  if (count === 0) return [];
  if (count === 1) return [candidates[0].id];

  const selected = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    selected.add(Math.round(index * (candidates.length - 1) / (count - 1)));
  }

  return [...selected].map((index) => candidates[index].id);
}

function makeExcerpt(
  content: string,
  question: string,
): { excerpt: string; fullExcerpt: string } {
  const normalized = content.replace(/\s+/g, " ").trim();
  const keywords = question
    .toLowerCase()
    .match(/[a-z0-9]{4,}/g)
    ?.filter((word) =>
      ![
        "what",
        "when",
        "where",
        "which",
        "with",
        "from",
        "that",
        "this",
        "does",
        "about",
      ].includes(word)
    ) ?? [];
  const lowerContent = normalized.toLowerCase();
  const matchPosition = keywords
    .map((keyword) => lowerContent.indexOf(keyword))
    .find((position) => position >= 0) ?? 0;
  const start = Math.max(0, matchPosition - 80);
  const end = Math.min(normalized.length, start + 280);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < normalized.length ? "…" : "";

  return {
    excerpt: `${prefix}${normalized.slice(start, end).trim()}${suffix}`,
    fullExcerpt: normalized,
  };
}

export function citationsFromIds(
  citedChunkIds: string[],
  chunks: SourceChunk[],
  question: string,
  maxSources: number,
): SourceCitation[] {
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const citations: SourceCitation[] = [];

  for (const id of citedChunkIds) {
    const chunk = chunksById.get(id);

    if (!chunk) continue;

    const excerpts = makeExcerpt(chunk.content, question);
    citations.push({
      chunkId: chunk.id,
      pageNumber: chunk.page_number,
      ...excerpts,
    });

    if (citations.length === maxSources) break;
  }

  return citations;
}
