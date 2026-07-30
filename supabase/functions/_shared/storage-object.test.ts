import { assertEquals } from "jsr:@std/assert@1";
import { verifiedPdfFromListing } from "./storage-object.ts";

const userId = "3b0637cb-85f6-41b2-b9d4-b0de12d69314";
const documentId = "7719b13b-0fb8-4a69-86af-a54d9802ffbc";

Deno.test("an exact owner-namespaced PDF listing is verified", () => {
  assertEquals(
    verifiedPdfFromListing(userId, documentId, [{
      name: `${documentId}.pdf`,
      metadata: { size: 1024, mimetype: "application/pdf" },
    }]),
    {
      path: `${userId}/${documentId}.pdf`,
      size: 1024,
      mimeType: "application/pdf",
    },
  );
});

Deno.test("missing and foreign Storage registrations fail indistinguishably", () => {
  assertEquals(verifiedPdfFromListing(userId, documentId, []), null);
  assertEquals(
    verifiedPdfFromListing(userId, documentId, [{
      name: "foreign-document.pdf",
      metadata: { size: 1024, mimetype: "application/pdf" },
    }]),
    null,
  );
});

Deno.test("Storage size and MIME metadata are authoritative", () => {
  assertEquals(
    verifiedPdfFromListing(userId, documentId, [{
      name: `${documentId}.pdf`,
      metadata: { size: 1024, mimetype: "text/plain" },
    }]),
    null,
  );
  assertEquals(
    verifiedPdfFromListing(userId, documentId, [{
      name: `${documentId}.pdf`,
      metadata: { size: 21 * 1024 * 1024, mimetype: "application/pdf" },
    }]),
    null,
  );
});
