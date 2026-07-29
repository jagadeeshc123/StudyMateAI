import { assertEquals } from "jsr:@std/assert@1";
import {
  citationsFromIds,
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
