import type { ResponseMode } from "./chat-controls.ts";

export type ChatSessionMode =
  | "single_document"
  | "multi_document"
  | "comparison";

export interface SessionDocument {
  id: string;
  displayName: string | null;
  originalFileName: string;
  position: number;
  processingStatus: string;
  embeddingStatus?: string | null;
}

export interface MultiDocumentChunk {
  id: string;
  documentId: string;
  documentPosition: number;
  documentName: string;
  pageNumber: number;
  chunkIndex: number;
  content: string;
  combinedScore?: number | null;
}

export type MultiDocumentIntent =
  | "topic"
  | "comparison"
  | "similarity"
  | "difference"
  | "combined_overview"
  | "separate_summaries";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SelectionValidationError =
  | "missing"
  | "too_many"
  | "malformed"
  | "duplicate";

export function validateSelectedDocumentIds(
  value: unknown,
): { ids: string[]; error: SelectionValidationError | null } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ids: [], error: "missing" };
  }
  if (value.length > 5) return { ids: [], error: "too_many" };
  if (value.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
    return { ids: [], error: "malformed" };
  }
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) return { ids: [], error: "duplicate" };
  return { ids, error: null };
}

export function documentTitle(document: SessionDocument): string {
  return document.displayName?.trim() || document.originalFileName;
}

export function classifyMultiDocumentIntent(
  question: string,
  mode: ChatSessionMode,
): MultiDocumentIntent {
  const normalized = question.toLocaleLowerCase();

  if (
    /summari[sz]e\s+(?:each|every)|separate\s+summar|what\s+does\s+each/.test(
      normalized,
    )
  ) return "separate_summaries";

  if (
    /summari[sz]e\s+(?:all|these)|overview\s+of\s+(?:all|every|these)|main\s+themes\s+across|combined\s+overview|all\s+(?:selected\s+)?documents/
      .test(
        normalized,
      )
  ) return "combined_overview";

  if (/similar|common|both\s+say|agree/.test(normalized)) return "similarity";
  if (/differ|difference|contrast|disagree|conflict/.test(normalized)) {
    return "difference";
  }
  if (/compar|versus|\bvs\.?\b/.test(normalized) || mode === "comparison") {
    return "comparison";
  }

  return "topic";
}

export function isCompleteMultiDocumentIntent(
  intent: MultiDocumentIntent,
): boolean {
  return intent === "combined_overview" || intent === "separate_summaries";
}

export interface NamedDocumentResolution {
  document: SessionDocument | null;
  ambiguousMatches: SessionDocument[];
  explicitUnselectedReference: string | null;
}

const ORDINAL_PATTERNS: Array<[RegExp, number]> = [
  [/\b(?:first|1st)\s+(?:document|pdf)\b/i, 1],
  [/\b(?:second|2nd)\s+(?:document|pdf)\b/i, 2],
  [/\b(?:third|3rd)\s+(?:document|pdf)\b/i, 3],
  [/\b(?:fourth|4th)\s+(?:document|pdf)\b/i, 4],
  [/\b(?:fifth|5th)\s+(?:document|pdf)\b/i, 5],
];

function normalizedNames(document: SessionDocument): string[] {
  const names = [documentTitle(document), document.originalFileName]
    .map((name) => name.trim().toLocaleLowerCase())
    .filter(Boolean);

  for (const name of [...names]) {
    if (name.endsWith(".pdf")) names.push(name.slice(0, -4));
  }

  return [...new Set(names)].sort((left, right) => right.length - left.length);
}

export function resolveNamedDocument(
  question: string,
  documents: SessionDocument[],
): NamedDocumentResolution {
  for (const [pattern, position] of ORDINAL_PATTERNS) {
    if (pattern.test(question)) {
      return {
        document: documents.find((candidate) =>
          candidate.position === position
        ) ?? null,
        ambiguousMatches: [],
        explicitUnselectedReference: null,
      };
    }
  }

  const normalizedQuestion = question.toLocaleLowerCase();
  const matches = documents.filter((document) =>
    normalizedNames(document).some((name) =>
      name.length >= 3 && normalizedQuestion.includes(name)
    )
  );

  if (matches.length === 1) {
    return {
      document: matches[0],
      ambiguousMatches: [],
      explicitUnselectedReference: null,
    };
  }

  if (matches.length > 1) {
    return {
      document: null,
      ambiguousMatches: matches,
      explicitUnselectedReference: null,
    };
  }

  const shortenedTerms =
    normalizedQuestion.match(/[\p{L}\p{N}]+/gu)?.filter((term) =>
      term.length >= 3 && ![
        "about",
        "compare",
        "document",
        "explain",
        "from",
        "page",
        "please",
        "summarize",
        "summary",
        "what",
        "with",
      ].includes(term)
    ) ?? [];
  const shortenedMatches = documents.filter((document) =>
    normalizedNames(document).some((name) =>
      shortenedTerms.some((term) =>
        name.startsWith(term) && term.length < name.length
      )
    )
  );
  if (shortenedMatches.length === 1) {
    return {
      document: shortenedMatches[0],
      ambiguousMatches: [],
      explicitUnselectedReference: null,
    };
  }
  if (shortenedMatches.length > 1) {
    return {
      document: null,
      ambiguousMatches: shortenedMatches,
      explicitUnselectedReference: null,
    };
  }

  const pdfReference =
    question.match(/(?:in|from|of|about|use)\s+["']?([^"'\n]{2,120}\.pdf)\b/i)
      ?.[1]?.trim() ?? null;
  return {
    document: null,
    ambiguousMatches: [],
    explicitUnselectedReference: pdfReference,
  };
}

function contentTokens(value: string): Set<string> {
  return new Set(
    value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((token) =>
      token.length > 2 || /^\d+$/.test(token)
    ) ?? [],
  );
}

function overlapRatio(first: Set<string>, second: Set<string>): number {
  if (first.size === 0 || second.size === 0) return 0;
  let shared = 0;
  for (const token of first) if (second.has(token)) shared += 1;
  return shared / Math.min(first.size, second.size);
}

export function selectFairMultiDocumentChunks(
  candidates: MultiDocumentChunk[],
  maximumChunks: number,
): MultiDocumentChunk[] {
  const accepted: MultiDocumentChunk[] = [];
  const acceptedTokensByDocument = new Map<string, Set<string>[]>();
  const grouped = new Map<string, MultiDocumentChunk[]>();

  for (const candidate of candidates) {
    const existingTokens = acceptedTokensByDocument.get(candidate.documentId) ??
      [];
    const tokens = contentTokens(candidate.content);
    if (
      existingTokens.some((existing) => overlapRatio(tokens, existing) >= 0.9)
    ) continue;
    existingTokens.push(tokens);
    acceptedTokensByDocument.set(candidate.documentId, existingTokens);
    const documentCandidates = grouped.get(candidate.documentId) ?? [];
    documentCandidates.push(candidate);
    grouped.set(candidate.documentId, documentCandidates);
  }

  const documentIds = [...grouped.keys()].sort((left, right) => {
    const leftPosition = grouped.get(left)?.[0]?.documentPosition ?? 0;
    const rightPosition = grouped.get(right)?.[0]?.documentPosition ?? 0;
    return leftPosition - rightPosition;
  });

  for (let rank = 0; accepted.length < maximumChunks; rank += 1) {
    let added = false;
    for (const documentId of documentIds) {
      const candidate = grouped.get(documentId)?.[rank];
      if (!candidate) continue;
      accepted.push(candidate);
      added = true;
      if (accepted.length === maximumChunks) break;
    }
    if (!added) break;
  }

  return accepted;
}

const CLAIM_STOP_WORDS = new Set([
  "about",
  "also",
  "answer",
  "both",
  "document",
  "documents",
  "each",
  "from",
  "other",
  "selected",
  "source",
  "sources",
  "that",
  "their",
  "these",
  "they",
  "this",
  "which",
  "with",
]);

function claimTokens(value: string): Set<string> {
  return new Set(
    value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((token) =>
      (token.length > 2 || /^\d+$/.test(token)) && !CLAIM_STOP_WORDS.has(token)
    ) ?? [],
  );
}

interface ClaimTerms {
  tokens: Set<string>;
  numbers: Set<string>;
  negated: boolean;
}

function claimTerms(value: string): ClaimTerms {
  const tokens = claimTokens(value);
  return {
    tokens,
    numbers: new Set([...tokens].filter((token) => /^\d+$/.test(token))),
    negated:
      /\b(?:no|not|never|without|cannot|can't|doesn't|isn't|aren't|didn't)\b/i
        .test(value),
  };
}

export function selectCollectivelySupportingCitationIds(
  answer: string,
  chunks: MultiDocumentChunk[],
  mode: ResponseMode,
): string[] {
  const claims = answer
    .split(/(?<=[.!?])\s+|\n+|\b(?:while|whereas|but)\b/iu)
    .map(claimTerms)
    .filter((terms) => terms.tokens.size >= 2);
  if (claims.length === 0 || chunks.length === 0) return [];

  const evidenceTerms = chunks.map((chunk) =>
    claimTerms(`${chunk.documentName} ${chunk.content}`)
  );
  const selectedIds: string[] = [];

  for (const claim of claims) {
    const collective = new Set<string>();
    const scored: Array<{ id: string; shared: number }> = [];

    evidenceTerms.forEach((terms, index) => {
      if (terms.negated !== claim.negated) return;
      for (const number of claim.numbers) {
        if (!terms.numbers.has(number)) return;
      }
      let shared = 0;
      for (const token of claim.tokens) {
        if (terms.tokens.has(token)) {
          shared += 1;
          collective.add(token);
        }
      }
      if (shared >= 2) scored.push({ id: chunks[index].id, shared });
    });

    if (collective.size / claim.tokens.size < 0.5 || scored.length === 0) {
      return [];
    }
    scored.sort((left, right) => right.shared - left.shared);
    selectedIds.push(...scored.slice(0, 2).map((candidate) => candidate.id));
  }

  const limit = mode === "concise" ? 3 : mode === "balanced" ? 6 : 8;
  return [...new Set(selectedIds)].slice(0, limit);
}

export function buildMultiDocumentContext(
  chunks: MultiDocumentChunk[],
  characterLimit: number,
): { context: string; includedChunks: MultiDocumentChunk[] } {
  const blocks: string[] = [];
  const includedChunks: MultiDocumentChunk[] = [];
  let length = 0;

  for (const chunk of chunks) {
    const block =
      `[DOCUMENT ${chunk.documentPosition}: ${chunk.documentName}]\n[PAGE ${chunk.pageNumber}]\n${chunk.content}`;
    const separator = blocks.length > 0 ? "\n\n---\n\n" : "";
    if (length + separator.length + block.length > characterLimit) break;
    blocks.push(block);
    includedChunks.push(chunk);
    length += separator.length + block.length;
  }

  return { context: blocks.join("\n\n---\n\n"), includedChunks };
}
