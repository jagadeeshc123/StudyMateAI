# Large-PDF processing decision

StudyMate keeps the existing 20 MB upload limit and synchronous processing path for now. The current `unpdf` implementation downloads the complete private PDF, creates one in-memory PDF proxy, and extracts all pages during one Edge Function request. Database inserts are batched, but extraction itself is not resumable or page-streaming.

Supabase Edge Functions have bounded request duration and memory. Splitting only the database inserts would not make extraction resumable, and recursively invoking more Edge Functions would create fragile leases, duplicate work, and incomplete documents. The upload limit must not be increased on this architecture.

## Recommended worker design

Use a separately deployed private worker with these components:

1. `document_processing_jobs` table:
   - job and document UUIDs
   - owner UUID
   - stage (`queued`, `extracting`, `chunking`, `ready`, `failed`)
   - total and processed pages
   - progress percentage
   - attempt count and retry time
   - lease owner and lease expiry
   - last completed page/checkpoint
   - safe processing error
2. An authenticated enqueue Edge Function verifies document ownership and creates one idempotent job.
3. A private queue consumer uses the service role only in the worker environment.
4. The worker downloads the object from private Storage and processes bounded page ranges.
5. Each page batch is written with deterministic `(document_id, page_number, chunk_index)` keys so retries upsert rather than duplicate chunks.
6. A transaction advances the checkpoint only after its chunk batch commits.
7. Expired leases can be reclaimed; retries resume from the last committed page.
8. The document remains unavailable to Chat until every page is committed and the final page/chunk counts pass validation.
9. Temporary files are deleted after success or failure, and document contents are never written to logs.

Suitable worker targets include a container service or job platform with explicit CPU, memory, execution-time, queue, and retry controls. The worker must use short-lived job leases and remain inaccessible from the public internet except through authenticated queue delivery.

## Migration path

Introduce the job table and worker only when the worker runtime has been selected and integration-tested. Keep the current synchronous path as a small-file fallback during rollout, then route larger files to the queue. Do not mark a document ready until the worker's final consistency transaction succeeds.
