export interface PageChunk {
  id: string;
  content: string;
  page_number: number;
  chunk_index: number;
  rank?: number;
}

const MAX_REQUESTED_PAGES = 50;
const PAGE_REFERENCE_PATTERN =
  /\bpages?\s+((?:(?:\d+)|(?:and|to)|[,&;–—-]|\s)+)/gi;
const PAGE_TOKEN_PATTERN = /\d+|and|to|[-–—]/gi;
const SEARCH_STOP_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "can",
  "describe",
  "document",
  "does",
  "explain",
  "for",
  "from",
  "how",
  "in",
  "is",
  "me",
  "of",
  "on",
  "page",
  "pages",
  "please",
  "say",
  "summarize",
  "summary",
  "tell",
  "the",
  "these",
  "this",
  "to",
  "what",
  "why",
]);

function normalizeSearchToken(token: string): string {
  const normalized = token.normalize("NFKC").toLocaleLowerCase();
  if (normalized.length > 5 && normalized.endsWith("ing")) {
    return normalized.slice(0, -3);
  }
  if (normalized.length > 4 && normalized.endsWith("ies")) {
    return `${normalized.slice(0, -3)}y`;
  }
  if (
    normalized.length > 3 && normalized.endsWith("s") &&
    !normalized.endsWith("ss")
  ) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

export class PageReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageReferenceError";
  }
}

function addPage(pageNumbers: Set<number>, pageNumber: number): void {
  pageNumbers.add(pageNumber);

  if (pageNumbers.size > MAX_REQUESTED_PAGES) {
    throw new PageReferenceError(
      `Request no more than ${MAX_REQUESTED_PAGES} pages at a time.`,
    );
  }
}

export function parseRequestedPageNumbers(question: string): number[] {
  const pageNumbers = new Set<number>();

  for (const match of question.matchAll(PAGE_REFERENCE_PATTERN)) {
    const tokens = match[1].match(PAGE_TOKEN_PATTERN) ?? [];
    let previousPage: number | null = null;
    let rangeFollows = false;

    for (const token of tokens) {
      if (/^\d+$/.test(token)) {
        const currentPage = Number.parseInt(token, 10);

        if (rangeFollows && previousPage !== null) {
          const direction = currentPage >= previousPage ? 1 : -1;

          for (
            let pageNumber = previousPage + direction;
            pageNumber !== currentPage + direction;
            pageNumber += direction
          ) {
            addPage(pageNumbers, pageNumber);
          }
        } else {
          addPage(pageNumbers, currentPage);
        }

        previousPage = currentPage;
        rangeFollows = false;
      } else if (token.toLowerCase() === "to" || /^[-–—]$/.test(token)) {
        rangeFollows = true;
      }
    }
  }

  return [...pageNumbers].sort((first, second) => first - second);
}

export function extractSearchKeywords(question: string): string[] {
  const keywords = question
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((word) =>
      !/^\d+$/.test(word) && word.length > 1 && !SEARCH_STOP_WORDS.has(word)
    ) ?? [];

  return [...new Set(keywords.map(normalizeSearchToken))];
}

export function normalizeKeywordQuery(question: string): string {
  return extractSearchKeywords(question).join(" ");
}

export function rankChunksWithinPages(
  chunks: PageChunk[],
  question: string,
  limit: number,
): PageChunk[] {
  const keywords = extractSearchKeywords(question);

  if (keywords.length === 0) {
    return [];
  }

  return chunks
    .map((chunk) => {
      const normalizedContent = (chunk.content.toLocaleLowerCase().match(
        /[\p{L}\p{N}]+/gu,
      ) ?? []).map(normalizeSearchToken);
      const score = keywords.reduce(
        (total, keyword) => {
          return total +
            normalizedContent.filter((token) => token === keyword).length;
        },
        keywords.length > 1 &&
          normalizedContent.join(" ").includes(keywords.join(" "))
          ? keywords.length * 2
          : 0,
      );

      return { chunk, score };
    })
    .filter(({ score }) => score > 0)
    .sort((first, second) =>
      second.score - first.score ||
      first.chunk.page_number - second.chunk.page_number ||
      first.chunk.chunk_index - second.chunk.chunk_index
    )
    .slice(0, limit)
    .map(({ chunk, score }) => ({ ...chunk, rank: score }));
}

export function selectRepresentativeChunks(
  chunks: PageChunk[],
  requestedPages: number[],
  limit: number,
): PageChunk[] {
  const chunksByPage = new Map<number, PageChunk[]>();

  for (const pageNumber of requestedPages) {
    chunksByPage.set(
      pageNumber,
      chunks
        .filter((chunk) => chunk.page_number === pageNumber)
        .sort((first, second) => first.chunk_index - second.chunk_index),
    );
  }

  const selected: PageChunk[] = [];
  let chunkOffset = 0;
  let addedChunk = true;

  while (selected.length < limit && addedChunk) {
    addedChunk = false;

    for (const pageNumber of requestedPages) {
      const chunk = chunksByPage.get(pageNumber)?.[chunkOffset];

      if (chunk) {
        selected.push(chunk);
        addedChunk = true;

        if (selected.length === limit) {
          break;
        }
      }
    }

    chunkOffset += 1;
  }

  return selected;
}
