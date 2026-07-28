import {
  isCompleteDocumentIntent,
  normalizeResponseMode,
  RESPONSE_MODES,
  responseModeInstruction,
} from "./chat-controls.ts";

Deno.test("response mode is server-clamped to supported values", () => {
  if (normalizeResponseMode("concise") !== "concise") {
    throw new Error("Concise mode was rejected.");
  }
  if (normalizeResponseMode("detailed") !== "detailed") {
    throw new Error("Detailed mode was rejected.");
  }
  if (normalizeResponseMode("untrusted-value") !== "balanced") {
    throw new Error("Invalid mode was not clamped.");
  }
});

Deno.test("complete-document intents bypass keyword-only retrieval", () => {
  const wholeDocumentRequests = [
    "Summarize the complete PDF",
    "What are the main topics?",
    "Give me an overview",
    "Explain this document",
    "Summarize all sections",
  ];

  if (
    wholeDocumentRequests.some((question) =>
      !isCompleteDocumentIntent(question)
    )
  ) {
    throw new Error("A whole-document request was not detected.");
  }

  if (isCompleteDocumentIntent("Define the selected term")) {
    throw new Error(
      "A targeted question was incorrectly treated as a whole-document request.",
    );
  }
});

Deno.test("response modes increase answer, citation, and output budgets", () => {
  const modes = [
    RESPONSE_MODES.concise,
    RESPONSE_MODES.balanced,
    RESPONSE_MODES.detailed,
  ];

  for (let index = 1; index < modes.length; index += 1) {
    const previous = modes[index - 1];
    const current = modes[index];
    if (
      current.minimumWords <= previous.minimumWords ||
      current.maximumWords <= previous.maximumWords ||
      current.maxSources <= previous.maxSources ||
      current.maxOutputTokens <= previous.maxOutputTokens
    ) {
      throw new Error("Response-mode depth budgets must strictly increase.");
    }
  }

  for (const mode of ["concise", "balanced", "detailed"] as const) {
    const guidance = responseModeInstruction(mode);
    if (!guidance.includes(`${RESPONSE_MODES[mode].maximumWords} words`)) {
      throw new Error(`${mode} guidance does not enforce its word ceiling.`);
    }
  }
});

Deno.test("response-mode word targets and API budgets remain independent", () => {
  const expected = {
    concise: { minimumWords: 100, maximumWords: 180, maxOutputTokens: 2_048 },
    balanced: { minimumWords: 250, maximumWords: 400, maxOutputTokens: 4_096 },
    detailed: { minimumWords: 500, maximumWords: 800, maxOutputTokens: 8_192 },
  } as const;

  for (const mode of ["concise", "balanced", "detailed"] as const) {
    const actual = RESPONSE_MODES[mode];
    const wanted = expected[mode];
    if (
      actual.minimumWords !== wanted.minimumWords ||
      actual.maximumWords !== wanted.maximumWords ||
      actual.maxOutputTokens !== wanted.maxOutputTokens
    ) {
      throw new Error(
        `${mode} word targets or API output budget changed unexpectedly.`,
      );
    }
  }
});
