import { createRequestId, requestJsonResponse } from "./request-context.ts";

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
