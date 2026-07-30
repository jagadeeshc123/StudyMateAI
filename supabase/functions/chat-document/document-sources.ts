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

export function completeDocumentContextIsSafe(
  chunks: SourceChunk[],
  maxChunks: number,
  maxCharacters: number,
): boolean {
  return chunks.length <= maxChunks &&
    buildPlainChunkContext(chunks).length <= maxCharacters;
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
  "can",
  "document",
  "does",
  "from",
  "have",
  "how",
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

interface SupportTerms {
  tokens: Set<string>;
  numbers: Set<string>;
  negated: boolean;
}

function canonicalSupportToken(token: string): string {
  const aliases: Record<string, string> = {
    sunlight: "light",
    converts: "convert",
    converted: "convert",
    converting: "convert",
    turns: "convert",
    transformed: "convert",
    generated: "generate",
    generates: "generate",
    produced: "produce",
    produces: "produce",
    computers: "computer",
    predictions: "prediction",
    decisions: "decision",
  };
  if (aliases[token]) return aliases[token];
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ies")) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function supportTokens(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase();
  const rawTokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(
    rawTokens.filter((token) =>
      (token.length > 2 || /^\d+(?:\.\d+)?$/.test(token)) &&
      !SUPPORT_STOP_WORDS.has(token)
    ).map(canonicalSupportToken),
  );
}

function createSupportTerms(value: string): SupportTerms {
  const tokens = supportTokens(value);
  return {
    tokens,
    numbers: new Set(
      [...tokens].filter((token) => /^\d+(?:\.\d+)?$/.test(token)),
    ),
    negated: /\b(?:no|not|never|cannot|can't|doesn't|isn't|aren't|didn't)\b/i
      .test(value),
  };
}

function answerClaims(answer: string): SupportTerms[] {
  return answer
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((claim) => createSupportTerms(claim))
    .filter((terms) => terms.tokens.size >= 2);
}

function claimSupportScore(
  claim: SupportTerms,
  chunk: SupportTerms,
): number {
  if (claim.negated !== chunk.negated) return 0;
  for (const number of claim.numbers) {
    if (!chunk.numbers.has(number)) return 0;
  }
  let sharedTokens = 0;

  for (const token of claim.tokens) {
    if (chunk.tokens.has(token)) sharedTokens += 1;
  }

  if (sharedTokens < 2) return 0;
  const claimCoverage = sharedTokens / claim.tokens.size;
  return claimCoverage >= 0.5 ? sharedTokens + claimCoverage : 0;
}

export type CitationSupportStatus =
  | "supported"
  | "uncertain"
  | "failed"
  | "no_evidence";

export interface CitationSupportEvaluation {
  status: CitationSupportStatus;
  citationIds: string[];
}

export interface CitationResolution extends CitationSupportEvaluation {
  answer: string;
  initialStatus: CitationSupportStatus;
  regenerated: boolean;
  usedExtractiveFallback: boolean;
}

export function evaluateAnswerCitationSupport(
  answer: string,
  chunks: SourceChunk[],
  mode: ResponseMode,
): CitationSupportEvaluation {
  const claims = answerClaims(answer);
  if (chunks.length === 0) return { status: "no_evidence", citationIds: [] };
  if (claims.length === 0) return { status: "uncertain", citationIds: [] };

  const chunkTerms = chunks.map((chunk) => createSupportTerms(chunk.content));
  const supportingIds: string[] = [];
  let uncertain = false;

  for (const claim of claims) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const score = claimSupportScore(claim, chunkTerms[index]);
      if (score > bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }
    if (bestIndex >= 0) {
      supportingIds.push(chunks[bestIndex].id);
      continue;
    }

    const eligibleIndexes = chunkTerms.map((terms, index) => ({ terms, index }))
      .filter(({ terms }) => {
        if (terms.negated !== claim.negated) return false;
        return [...claim.numbers].every((number) => terms.numbers.has(number));
      });
    const combinedTokens = new Set<string>();
    const contributingIndexes: number[] = [];
    for (const { terms, index } of eligibleIndexes) {
      const overlaps = [...claim.tokens].some((token) =>
        terms.tokens.has(token)
      );
      if (!overlaps) continue;
      contributingIndexes.push(index);
      for (const token of terms.tokens) combinedTokens.add(token);
    }
    const shared = [...claim.tokens].filter((token) =>
      combinedTokens.has(token)
    );
    const coverage = shared.length / claim.tokens.size;
    if (shared.length >= 2 && coverage >= 0.5) {
      supportingIds.push(
        ...contributingIndexes.map((index) => chunks[index].id),
      );
    } else if (shared.length >= 2 && coverage >= 0.25) {
      uncertain = true;
    } else {
      return { status: "failed", citationIds: [] };
    }
  }

  if (uncertain) return { status: "uncertain", citationIds: [] };
  const limit = mode === "concise" ? 3 : mode === "balanced" ? 6 : 8;
  return {
    status: "supported",
    citationIds: [...new Set(supportingIds)].slice(0, limit),
  };
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
  const evaluation = evaluateAnswerCitationSupport(answer, chunks, mode);
  if (evaluation.status !== "supported") return [];
  const supportingIds = evaluation.citationIds;
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

export function buildExtractiveFallback(
  chunks: SourceChunk[],
  question: string,
  mode: ResponseMode,
): { answer: string; citationIds: string[] } | null {
  const questionTerms = createSupportTerms(question).tokens;
  if (questionTerms.size === 0) return null;
  const minimumScore = Math.min(2, questionTerms.size);
  const candidates = chunks.flatMap((chunk) =>
    chunk.content.split(/(?<=[.!?])\s+|\n+/u).map((sentence) => {
      const normalized = sentence.replace(/\s+/g, " ").trim();
      const terms = createSupportTerms(normalized);
      const score = [...questionTerms].filter((token) =>
        terms.tokens.has(token)
      ).length;
      return { chunk, sentence: normalized, score };
    })
  ).filter((candidate) =>
    candidate.sentence.length > 0 && candidate.score >= minimumScore
  )
    .sort((first, second) =>
      second.score - first.score ||
      first.chunk.page_number - second.chunk.page_number
    );
  if (candidates.length === 0) return null;
  const sentenceLimit = mode === "concise" ? 1 : 2;
  const selected = candidates.slice(0, sentenceLimit);
  return {
    answer: selected.map((candidate) => candidate.sentence).join(" "),
    citationIds: [...new Set(selected.map((candidate) => candidate.chunk.id))],
  };
}

export async function resolveCitationSupport(
  generatedAnswer: string,
  chunks: SourceChunk[],
  question: string,
  mode: ResponseMode,
  unsupportedAnswer: string,
  regenerate: () => Promise<string>,
): Promise<CitationResolution> {
  let answer = generatedAnswer.trim();
  let evaluation = evaluateAnswerCitationSupport(answer, chunks, mode);
  const initialStatus = evaluation.status;
  let regenerated = false;

  if (answer !== unsupportedAnswer && evaluation.status === "uncertain") {
    answer = (await regenerate()).trim();
    regenerated = true;
    evaluation = evaluateAnswerCitationSupport(answer, chunks, mode);
  }

  if (evaluation.status === "supported") {
    return {
      ...evaluation,
      answer,
      initialStatus,
      regenerated,
      usedExtractiveFallback: false,
    };
  }

  if (answer !== unsupportedAnswer) {
    const extractive = buildExtractiveFallback(chunks, question, mode);
    if (extractive) {
      return {
        answer: extractive.answer,
        citationIds: extractive.citationIds,
        status: "supported",
        initialStatus,
        regenerated,
        usedExtractiveFallback: true,
      };
    }
  }

  return {
    ...evaluation,
    answer,
    initialStatus,
    regenerated,
    usedExtractiveFallback: false,
  };
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
