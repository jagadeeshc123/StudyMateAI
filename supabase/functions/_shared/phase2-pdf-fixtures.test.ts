import { PDFDocument, StandardFonts } from "npm:pdf-lib@1.17.1";
import { extractText, getDocumentProxy } from "npm:unpdf@1.8.0";
import {
  extractSearchKeywords,
  normalizeKeywordQuery,
  rankChunksWithinPages,
} from "./page-retrieval.ts";
import { chunkExtractedPages } from "./text.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function createSubjectPdf(pageTexts: string[]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);

  for (const text of pageTexts) {
    const page = document.addPage([612, 792]);
    page.drawText(text, { x: 48, y: 720, size: 12, font, maxWidth: 516 });
  }

  return await document.save();
}

async function extractFixtureChunks(pdfBytes: Uint8Array) {
  const proxy = await getDocumentProxy(pdfBytes);
  const extracted = await extractText(proxy, { mergePages: false });
  const pages = Array.isArray(extracted.text)
    ? extracted.text
    : [extracted.text];
  return chunkExtractedPages(pages).map((chunk, index) => ({
    ...chunk,
    id: `fixture-${index}`,
  }));
}

async function createLargeTextPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);

  for (let pageIndex = 0; pageIndex < 260; pageIndex += 1) {
    const page = document.addPage([612, 792]);
    for (let lineIndex = 0; lineIndex < 55; lineIndex += 1) {
      page.drawText(
        `Machine learning study material page ${pageIndex + 1} line ${
          lineIndex + 1
        } ${crypto.randomUUID()} preserves searchable evidence.`,
        {
          x: 28,
          y: 758 - lineIndex * 13,
          size: 8,
          font,
          maxWidth: 556,
        },
      );
    }
  }

  return await document.save({ useObjectStreams: false });
}

Deno.test("two PDF subjects retain exact keyword and page-aware retrieval", async () => {
  const astronomyPdf = await createSubjectPdf([
    "Stellar fusion converts hydrogen into helium inside the cores of stars.",
    "Orbital motion is governed by gravity and angular momentum.",
  ]);
  const biologyPdf = await createSubjectPdf([
    "Photosynthesis converts light energy into chemical energy in chloroplasts.",
    "Mitochondria release energy from nutrients during cellular respiration.",
  ]);
  const astronomyChunks = await extractFixtureChunks(astronomyPdf);
  const biologyChunks = await extractFixtureChunks(biologyPdf);

  assert(
    astronomyChunks.length >= 2,
    "Astronomy PDF pages were not extracted.",
  );
  assert(biologyChunks.length >= 2, "Biology PDF pages were not extracted.");
  assert(
    rankChunksWithinPages(astronomyChunks, "stellar fusion", 3)[0]
      ?.page_number === 1,
    "Exact astronomy keyword retrieval did not return page 1.",
  );
  assert(
    rankChunksWithinPages(biologyChunks, "mitochondria", 3)[0]
      ?.page_number === 2,
    "Page-aware biology keyword retrieval did not return page 2.",
  );
});

Deno.test("machine-learning questions use normalized lexical retrieval", async () => {
  const pdf = await createSubjectPdf([
    "Machine learning is a branch of artificial intelligence that enables computers to learn patterns from data and make predictions or decisions without being explicitly programmed.",
  ]);
  const fixtureChunks = await extractFixtureChunks(pdf);
  const supportedQuestions = [
    "What is machine learning?",
    "Explain machine learning.",
    "How can computers learn from data?",
    "What does page 1 say about machine learning?",
  ];

  assert(
    normalizeKeywordQuery("What is machine learning?") === "machine learn",
    "The keyword query was not normalized consistently.",
  );
  assert(
    extractSearchKeywords("What is machine learning?").length === 2,
    "Stopwords were not removed from the machine-learning question.",
  );
  for (const question of supportedQuestions) {
    assert(
      rankChunksWithinPages(fixtureChunks, question, 3)[0]?.page_number === 1,
      `Lexical retrieval missed supported question: ${question}`,
    );
  }
  assert(
    rankChunksWithinPages(
      fixtureChunks,
      "What does the document say about quantum computing?",
      3,
    ).length === 0,
    "An unsupported question should not return unrelated chunks.",
  );
});

Deno.test("pending or failed embeddings leave keyword-only retrieval active", () => {
  for (const embeddingStatus of ["pending", "failed"]) {
    const selectedDocumentChunks = [{
      id: `machine-learning-${embeddingStatus}`,
      content:
        "Machine learning systems learn patterns from data to make predictions.",
      page_number: 1,
      chunk_index: 0,
      embedding_status: embeddingStatus,
    }];
    assert(
      rankChunksWithinPages(
        selectedDocumentChunks,
        "Explain machine learning.",
        3,
      ).length === 1,
      `Keyword retrieval stopped when embeddings were ${embeddingStatus}.`,
    );
  }
});

Deno.test("bounded lexical fallback sees only supplied document chunks", () => {
  const selectedDocumentChunks = [{
    id: "selected-document",
    content: "Machine learning uses patterns from data.",
    page_number: 1,
    chunk_index: 0,
  }];
  const foreignDocumentChunk = {
    id: "foreign-document",
    content: "Quantum computing uses qubits and superposition.",
    page_number: 1,
    chunk_index: 0,
  };

  assert(
    rankChunksWithinPages(
      selectedDocumentChunks,
      "What is quantum computing?",
      3,
    ).length === 0,
    "Lexical fallback returned evidence absent from the selected document.",
  );
  assert(
    rankChunksWithinPages(
      [...selectedDocumentChunks, foreignDocumentChunk],
      "What is quantum computing?",
      3,
    )[0]?.id === "foreign-document",
    "The scope regression fixture is not discriminating.",
  );
});

Deno.test("a 1-2 MB text PDF extracts within synchronous safety bounds", async () => {
  const pdf = await createLargeTextPdf();
  assert(
    pdf.byteLength >= 1_000_000 && pdf.byteLength <= 2_000_000,
    `Expected a 1-2 MB fixture, received ${pdf.byteLength} bytes.`,
  );

  const chunks = await extractFixtureChunks(pdf);
  assert(
    chunks.length >= 1_000,
    "The large fixture did not produce enough chunks.",
  );
  assert(chunks.length <= 2_500, "The large fixture exceeded the chunk limit.");
});
