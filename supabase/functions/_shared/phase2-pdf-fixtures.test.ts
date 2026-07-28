import { PDFDocument, StandardFonts } from "npm:pdf-lib@1.17.1";
import { extractText, getDocumentProxy } from "npm:unpdf@1.8.0";
import { rankChunksWithinPages } from "./page-retrieval.ts";
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
