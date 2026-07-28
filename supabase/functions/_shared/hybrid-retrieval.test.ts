import { selectDiversifiedChunks } from "./hybrid-retrieval.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }.`,
    );
  }
}

Deno.test("hybrid candidates preserve rank while diversifying pages", () => {
  const candidates = [
    {
      id: "astronomy-1",
      content: "Stars generate energy through nuclear fusion in their cores.",
      page_number: 1,
      chunk_index: 0,
    },
    {
      id: "astronomy-2",
      content: "Galaxies contain stars, gas, dust, and dark matter.",
      page_number: 1,
      chunk_index: 1,
    },
    {
      id: "biology-1",
      content: "Cells use mitochondria to release energy from nutrients.",
      page_number: 4,
      chunk_index: 0,
    },
  ];

  assertEquals(
    selectDiversifiedChunks(candidates, 3).map((chunk) => chunk.id),
    ["astronomy-1", "biology-1", "astronomy-2"],
  );
});

Deno.test("overlapping chunks do not dominate hybrid context", () => {
  const candidates = [
    {
      id: "first",
      content:
        "Photosynthesis uses sunlight water and carbon dioxide to produce glucose and oxygen in plant cells.",
      page_number: 2,
      chunk_index: 0,
    },
    {
      id: "overlap",
      content:
        "Plant cells use sunlight water and carbon dioxide during photosynthesis to produce glucose and oxygen.",
      page_number: 2,
      chunk_index: 1,
    },
    {
      id: "different",
      content: "Chlorophyll absorbs red and blue wavelengths of visible light.",
      page_number: 3,
      chunk_index: 0,
    },
  ];

  assertEquals(
    selectDiversifiedChunks(candidates, 3).map((chunk) => chunk.id),
    ["first", "different"],
  );
});
