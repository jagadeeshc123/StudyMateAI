import {
  createRequestId,
  logOperational,
  requestJsonResponse,
} from "./request-context.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.test("request IDs are safe UUIDs and included in JSON responses", async () => {
  const requestId = createRequestId();
  const response = requestJsonResponse(requestId, {
    error: "Safe user-facing message.",
  }, 502);
  const body = await response.json() as Record<string, unknown>;

  assert(response.status === 502, "Response status changed.");
  assert(body.requestId === requestId, "Response omitted its request ID.");
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(requestId),
    "Request ID was not a random UUID.",
  );
  assert(
    !JSON.stringify(body).includes("secret"),
    "Response leaked unexpected sensitive data.",
  );
});

Deno.test("operational logs discard private content even from excess fields", () => {
  const previous = Deno.env.get("OBSERVABILITY_ENABLED");
  const originalInfo = console.info;
  let serialized = "";
  Deno.env.set("OBSERVABILITY_ENABLED", "true");
  console.info = (...values: unknown[]) => {
    serialized = JSON.stringify(values);
  };

  try {
    logOperational("info", {
      requestId: crypto.randomUUID(),
      stage: "safe-stage",
      httpStatus: 200,
      reasonCode: "none",
      chunkCount: 2,
      prompt: "PRIVATE PROMPT",
      filename: "private.pdf",
      vector: [0.1, 0.2],
      apiKey: "PRIVATE KEY",
    } as never);
  } finally {
    console.info = originalInfo;
    if (previous === undefined) Deno.env.delete("OBSERVABILITY_ENABLED");
    else Deno.env.set("OBSERVABILITY_ENABLED", previous);
  }

  assert(serialized.includes("safe-stage"), "Safe diagnostics were removed.");
  assert(!serialized.includes("PRIVATE"), "Private content reached the log.");
  assert(!serialized.includes("private.pdf"), "A filename reached the log.");
  assert(!serialized.includes("vector"), "A vector reached the log.");
});
