import { assertEquals } from "jsr:@std/assert@1";
import {
  buildMultiDocumentContext,
  classifyMultiDocumentIntent,
  type MultiDocumentChunk,
  resolveNamedDocument,
  selectCollectivelySupportingCitationIds,
  selectFairMultiDocumentChunks,
  type SessionDocument,
  validateSelectedDocumentIds,
} from "./multi-document.ts";

const documents: SessionDocument[] = [
  {
    id: "a",
    displayName: "Astronomy Notes",
    originalFileName: "notes.pdf",
    position: 1,
    processingStatus: "ready",
  },
  {
    id: "b",
    displayName: "Biology Guide",
    originalFileName: "biology.pdf",
    position: 2,
    processingStatus: "ready",
  },
  {
    id: "c",
    displayName: null,
    originalFileName: "chemistry.pdf",
    position: 3,
    processingStatus: "ready",
  },
];

Deno.test("multi-document intent classification covers summaries and comparisons", () => {
  assertEquals(
    classifyMultiDocumentIntent(
      "Summarize each PDF separately",
      "multi_document",
    ),
    "separate_summaries",
  );
  assertEquals(
    classifyMultiDocumentIntent(
      "What do they have in common?",
      "multi_document",
    ),
    "similarity",
  );
  assertEquals(
    classifyMultiDocumentIntent("Explain energy", "comparison"),
    "comparison",
  );
});

Deno.test("document selection accepts one through five unique UUIDs only", () => {
  const ids = Array.from({ length: 6 }, () => crypto.randomUUID());
  assertEquals(validateSelectedDocumentIds([ids[0]]).error, null);
  assertEquals(validateSelectedDocumentIds(ids.slice(0, 5)).error, null);
  assertEquals(validateSelectedDocumentIds(ids).error, "too_many");
  assertEquals(
    validateSelectedDocumentIds([ids[0], ids[0]]).error,
    "duplicate",
  );
  assertEquals(validateSelectedDocumentIds([]).error, "missing");
  assertEquals(validateSelectedDocumentIds(["not-a-uuid"]).error, "malformed");
});

Deno.test("named documents resolve only within the selected ordered set", () => {
  assertEquals(
    resolveNamedDocument("What is on page 2 of the second PDF?", documents)
      .document?.id,
    "b",
  );
  assertEquals(
    resolveNamedDocument("Summarize chemistry.pdf", documents).document?.id,
    "c",
  );
  assertEquals(
    resolveNamedDocument("What does Astro say about fusion?", documents)
      .document?.id,
    "a",
  );
  assertEquals(
    resolveNamedDocument("Use private.pdf", documents)
      .explicitUnselectedReference,
    "private.pdf",
  );
});

Deno.test("fair ranking gives each relevant document an early opportunity", () => {
  const candidates = [
    ["a1", "a", 1],
    ["a2", "a", 1],
    ["b1", "b", 2],
    ["c1", "c", 3],
  ].map(([id, documentId, documentPosition], index) => ({
    id: String(id),
    documentId: String(documentId),
    documentPosition: Number(documentPosition),
    documentName: String(documentId),
    pageNumber: index + 1,
    chunkIndex: 0,
    content: `distinct evidence material ${id} topic ${index}`,
  })) as MultiDocumentChunk[];
  assertEquals(
    selectFairMultiDocumentChunks(candidates, 4).map((chunk) => chunk.id),
    ["a1", "b1", "c1", "a2"],
  );
});

Deno.test("multi-document context preserves boundaries and stops at the ceiling", () => {
  const chunks: MultiDocumentChunk[] = [
    {
      id: "a",
      documentId: "a",
      documentPosition: 1,
      documentName: "Astronomy",
      pageNumber: 1,
      chunkIndex: 0,
      content: "fusion evidence",
    },
    {
      id: "b",
      documentId: "b",
      documentPosition: 2,
      documentName: "Biology",
      pageNumber: 2,
      chunkIndex: 0,
      content: "photosynthesis evidence",
    },
  ];
  const firstBlockLength =
    "[DOCUMENT 1: Astronomy]\n[PAGE 1]\nfusion evidence".length;
  const bounded = buildMultiDocumentContext(chunks, firstBlockLength);
  assertEquals(bounded.includedChunks.map((chunk) => chunk.id), ["a"]);
  assertEquals(
    bounded.context,
    "[DOCUMENT 1: Astronomy]\n[PAGE 1]\nfusion evidence",
  );
});

Deno.test("multi-document citations require collective claim support", () => {
  const chunks: MultiDocumentChunk[] = [
    {
      id: "a",
      documentId: "a",
      documentPosition: 1,
      documentName: "Astronomy",
      pageNumber: 1,
      chunkIndex: 0,
      content: "Stars generate energy through nuclear fusion.",
    },
    {
      id: "b",
      documentId: "b",
      documentPosition: 2,
      documentName: "Biology",
      pageNumber: 2,
      chunkIndex: 0,
      content: "Plants store energy through photosynthesis.",
    },
  ];
  assertEquals(
    selectCollectivelySupportingCitationIds(
      "Astronomy describes nuclear fusion, while Biology describes photosynthesis.",
      chunks,
      "balanced",
    ),
    ["a", "b"],
  );
  assertEquals(
    selectCollectivelySupportingCitationIds(
      "Both documents prove that energy is created from nothing.",
      chunks,
      "balanced",
    ),
    [],
  );
});

Deno.test("collective support rejects negation and numerical mismatches", () => {
  const chunks: MultiDocumentChunk[] = [{
    id: "survey",
    documentId: "a",
    documentPosition: 1,
    documentName: "Survey",
    pageNumber: 3,
    chunkIndex: 0,
    content: "The survey included 120 students and reported improved recall.",
  }];
  assertEquals(
    selectCollectivelySupportingCitationIds(
      "The survey did not report improved recall.",
      chunks,
      "balanced",
    ),
    [],
  );
  assertEquals(
    selectCollectivelySupportingCitationIds(
      "The survey included 200 students.",
      chunks,
      "balanced",
    ),
    [],
  );
});

Deno.test("conflicting document clauses can be supported independently", () => {
  const chunks: MultiDocumentChunk[] = [
    {
      id: "supports",
      documentId: "a",
      documentPosition: 1,
      documentName: "Study A",
      pageNumber: 1,
      chunkIndex: 0,
      content: "Study A reports that caffeine improves recall.",
    },
    {
      id: "negates",
      documentId: "b",
      documentPosition: 2,
      documentName: "Study B",
      pageNumber: 2,
      chunkIndex: 0,
      content: "Study B reports that caffeine does not improve recall.",
    },
  ];
  assertEquals(
    selectCollectivelySupportingCitationIds(
      "Study A reports caffeine improves recall, whereas Study B reports caffeine does not improve recall.",
      chunks,
      "balanced",
    ),
    ["supports", "negates"],
  );
});
