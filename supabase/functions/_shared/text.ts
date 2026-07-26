export interface DocumentChunk {
  content: string;
  page_number: number;
  chunk_index: number;
}

const MAX_CHUNK_LENGTH = 1_200;
const CHUNK_OVERLAP = 180;
const MIN_BREAK_POSITION = 700;

export function normalizeExtractedText(value: string): string {
  return value
    .split(String.fromCharCode(0)).join("")
    .replace(/[\t\f\v]+/g, " ")
    .replace(/ +/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findChunkEnd(text: string, start: number): number {
  const maximumEnd = Math.min(start + MAX_CHUNK_LENGTH, text.length);

  if (maximumEnd === text.length) {
    return maximumEnd;
  }

  const minimumEnd = Math.min(start + MIN_BREAK_POSITION, maximumEnd);
  const candidate = text.slice(minimumEnd, maximumEnd);
  const paragraphBreak = candidate.lastIndexOf("\n\n");

  if (paragraphBreak >= 0) {
    return minimumEnd + paragraphBreak;
  }

  const sentenceBreak = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("? "),
    candidate.lastIndexOf("! "),
  );

  if (sentenceBreak >= 0) {
    return minimumEnd + sentenceBreak + 1;
  }

  const whitespaceBreak = candidate.lastIndexOf(" ");
  return whitespaceBreak >= 0 ? minimumEnd + whitespaceBreak : maximumEnd;
}

export function chunkExtractedPages(pages: string[]): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];

  pages.forEach((rawPage, pageIndex) => {
    const pageText = normalizeExtractedText(rawPage);
    let start = 0;
    let chunkIndex = 0;

    while (start < pageText.length) {
      const end = findChunkEnd(pageText, start);
      const content = pageText.slice(start, end).trim();

      if (content) {
        chunks.push({
          content,
          page_number: pageIndex + 1,
          chunk_index: chunkIndex,
        });
        chunkIndex += 1;
      }

      if (end >= pageText.length) {
        break;
      }

      const nextStart = Math.max(end - CHUNK_OVERLAP, start + 1);
      const nextWhitespace = pageText.indexOf(" ", nextStart);
      start = nextWhitespace >= 0 && nextWhitespace < end ? nextWhitespace + 1 : nextStart;
    }
  });

  return chunks;
}
