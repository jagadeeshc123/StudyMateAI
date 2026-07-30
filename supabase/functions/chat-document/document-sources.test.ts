import { assertEquals } from "jsr:@std/assert@1";
import {
  buildExtractiveFallback,
  citationsFromIds,
  completeDocumentContextIsSafe,
  evaluateAnswerCitationSupport,
  resolveCitationSupport,
  selectAnswerSupportingCitationIds,
  type SourceChunk,
} from "./document-sources.ts";

const chunks: SourceChunk[] = [
  {
    id: "astronomy",
    page_number: 4,
    content:
      "Stars release energy through nuclear fusion in their cores, converting hydrogen into helium.",
  },
  {
    id: "biology",
    page_number: 9,
    content:
      "Plants convert light energy into chemical energy during photosynthesis.",
  },
];

Deno.test("small-document fallback requires the complete ordered context", () => {
  assertEquals(completeDocumentContextIsSafe(chunks, 2, 1_000), true);
  assertEquals(completeDocumentContextIsSafe(chunks, 1, 1_000), false);
  assertEquals(completeDocumentContextIsSafe(chunks, 2, 20), false);
});

Deno.test("citations are selected only from chunks that support every answer claim", () => {
  assertEquals(
    selectAnswerSupportingCitationIds(
      "Stars release energy through nuclear fusion. Their cores convert hydrogen into helium.",
      chunks,
      "balanced",
    ),
    ["astronomy"],
  );
});

Deno.test("citation uncertainty is distinct from unsupported evidence", () => {
  const machineLearningChunks: SourceChunk[] = [{
    id: "machine-learning",
    page_number: 1,
    content:
      "Machine learning is a branch of artificial intelligence that enables computers to learn patterns from data and make predictions or decisions without being explicitly programmed.",
  }];

  assertEquals(
    evaluateAnswerCitationSupport(
      "Machine learning lets computer systems discover patterns in examples and use them for predictive decisions.",
      machineLearningChunks,
      "balanced",
    ).status,
    "uncertain",
  );
  assertEquals(
    evaluateAnswerCitationSupport(
      "Quantum entanglement allows faster-than-light communication.",
      machineLearningChunks,
      "balanced",
    ).status,
    "failed",
  );
});

Deno.test("extractive fallback is an exact sentence from a selected database chunk", () => {
  const machineLearningChunks: SourceChunk[] = [{
    id: "machine-learning",
    page_number: 1,
    content:
      "Machine learning is a branch of artificial intelligence that enables computers to learn patterns from data. It can support predictions and decisions.",
  }];
  const fallback = buildExtractiveFallback(
    machineLearningChunks,
    "What is machine learning?",
    "balanced",
  );

  assertEquals(fallback, {
    answer:
      "Machine learning is a branch of artificial intelligence that enables computers to learn patterns from data.",
    citationIds: ["machine-learning"],
  });
  assertEquals(
    buildExtractiveFallback(
      machineLearningChunks,
      "What is quantum entanglement?",
      "balanced",
    ),
    null,
  );
});

Deno.test("validator uncertainty regenerates once with evidence-close wording", async () => {
  const machineLearningChunks: SourceChunk[] = [{
    id: "machine-learning",
    page_number: 1,
    content:
      "Machine learning is a branch of artificial intelligence that enables computers to learn patterns from data and make predictions or decisions without being explicitly programmed.",
  }];
  let regenerationCount = 0;
  const resolution = await resolveCitationSupport(
    "Machine learning lets computer systems discover patterns in examples and use them for predictive decisions.",
    machineLearningChunks,
    "What is machine learning?",
    "balanced",
    "I could not find that information in the selected document.",
    () => {
      regenerationCount += 1;
      return Promise.resolve(
        "Machine learning is a branch of artificial intelligence that enables computers to learn patterns from data.",
      );
    },
  );

  assertEquals(regenerationCount, 1);
  assertEquals(resolution.status, "supported");
  assertEquals(resolution.initialStatus, "uncertain");
  assertEquals(resolution.citationIds, ["machine-learning"]);
  assertEquals(resolution.regenerated, true);
  assertEquals(resolution.usedExtractiveFallback, false);
});

Deno.test("persistent validator uncertainty falls back to an extractive answer", async () => {
  const machineLearningChunks: SourceChunk[] = [{
    id: "machine-learning",
    page_number: 1,
    content:
      "Machine learning is a branch of artificial intelligence that enables computers to learn patterns from data.",
  }];
  const resolution = await resolveCitationSupport(
    "Machine learning systems discover useful structures in examples.",
    machineLearningChunks,
    "What is machine learning?",
    "balanced",
    "I could not find that information in the selected document.",
    () =>
      Promise.resolve(
        "Machine learning tools discover structures in examples for useful tasks.",
      ),
  );

  assertEquals(resolution, {
    answer:
      "Machine learning is a branch of artificial intelligence that enables computers to learn patterns from data.",
    citationIds: ["machine-learning"],
    status: "supported",
    initialStatus: "uncertain",
    regenerated: true,
    usedExtractiveFallback: true,
  });
});

Deno.test("citation support may be assembled from multiple selected chunks", () => {
  const splitEvidence: SourceChunk[] = [
    {
      id: "definition",
      page_number: 1,
      content: "Machine learning belongs to artificial intelligence.",
    },
    {
      id: "behavior",
      page_number: 2,
      content: "Patterns are learned from data for predictions.",
    },
  ];

  assertEquals(
    evaluateAnswerCitationSupport(
      "Machine learning is an artificial intelligence method where computer systems learn patterns from data to make predictions.",
      splitEvidence,
      "balanced",
    ),
    { status: "supported", citationIds: ["definition", "behavior"] },
  );
});

Deno.test("an unsupported answer cannot receive merely related citations", () => {
  assertEquals(
    selectAnswerSupportingCitationIds(
      "Stars release energy through combustion and contain liquid iron oceans.",
      chunks,
      "balanced",
    ),
    [],
  );
});

Deno.test("citation payloads remain backed by the selected database chunk", () => {
  assertEquals(
    citationsFromIds(
      ["astronomy", "invented"],
      chunks,
      "How do stars release energy?",
      3,
    ),
    [{
      chunkId: "astronomy",
      pageNumber: 4,
      excerpt:
        "Stars release energy through nuclear fusion in their cores, converting hydrogen into helium.",
      fullExcerpt:
        "Stars release energy through nuclear fusion in their cores, converting hydrogen into helium.",
    }],
  );
});

Deno.test("short grounded answers and conservative paraphrases keep support", () => {
  assertEquals(
    selectAnswerSupportingCitationIds(
      "Nuclear fusion releases energy.",
      chunks,
      "concise",
    ),
    ["astronomy"],
  );
  assertEquals(
    selectAnswerSupportingCitationIds(
      "Plants convert light into chemical energy.",
      chunks,
      "balanced",
    ),
    ["biology"],
  );
});

Deno.test("partially supported detailed answers are rejected as a whole", () => {
  assertEquals(
    selectAnswerSupportingCitationIds(
      "Stars use nuclear fusion. Stars also contain oceans of liquid iron.",
      chunks,
      "detailed",
    ),
    [],
  );
});

Deno.test("negated and incorrect numerical claims cannot borrow related citations", () => {
  assertEquals(
    selectAnswerSupportingCitationIds(
      "Stars do not release energy through nuclear fusion.",
      chunks,
      "balanced",
    ),
    [],
  );
  const numbered: SourceChunk[] = [{
    id: "planets",
    page_number: 2,
    content: "The solar system contains 8 planets in orbit around the Sun.",
  }];
  assertEquals(
    selectAnswerSupportingCitationIds(
      "The solar system contains 9 planets.",
      numbered,
      "balanced",
    ),
    [],
  );
  assertEquals(
    selectAnswerSupportingCitationIds(
      "The solar system contains 8 planets.",
      numbered,
      "balanced",
    ),
    ["planets"],
  );
});
