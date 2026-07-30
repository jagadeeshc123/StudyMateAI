# StudyMate

StudyMate is a React and Supabase MVP for uploading searchable study PDFs, extracting their text on the server, and asking document-grounded questions with page citations.

## Requirements

- Node.js 20 or newer
- npm
- Docker Desktop only if running Supabase locally
- A Supabase project
- A Gemini API key for the server-side chat function

## Browser environment variables

Copy `.env.example` to `.env` and set the browser-safe values from **Supabase Dashboard -> Project Settings -> API**:

```env
VITE_SUPABASE_PROJECT_ID="your-project-ref"
VITE_SUPABASE_URL="https://your-project-ref.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="your-anon-or-publishable-key"
```

Only use the browser-safe publishable/anonymous key. Never put a Supabase service-role key or an AI provider key in a `VITE_*` variable because Vite includes those values in the browser bundle.

## Database and private Storage setup

The version-controlled migrations create the private `documents` bucket, the application tables, authenticated ownership policies, normalized chat sessions, pgvector embedding storage, and server-only single- and multi-document hybrid search functions.

Link the Supabase CLI and apply all migrations:

```sh
npx supabase link --project-ref "$PROJECT_REF"
npx supabase db push
```

Alternatively, run these files in timestamp order using **Supabase Dashboard -> SQL Editor**:

1. `supabase/migrations/20260726183000_create_documents.sql`
2. `supabase/migrations/20260726213000_add_document_processing_and_chat.sql`
3. `supabase/migrations/20260727023000_add_authentication_and_ownership.sql`
4. `supabase/migrations/20260727130000_phase1_document_management.sql`
5. `supabase/migrations/20260727160000_phase1_security_hardening.sql`
6. `supabase/migrations/20260729120000_phase2_pgvector_hybrid_search.sql`
7. `supabase/migrations/20260730120000_phase2_5_integrity_hardening.sql`
8. `supabase/migrations/20260730180000_phase3_multi_document_sessions.sql`
9. `supabase/migrations/20260731120000_phase3_5_production_hardening.sql`

In **Supabase Dashboard -> Storage**, confirm the `documents` bucket exists and **Public bucket** is disabled. The first migration creates and configures it automatically when run as written.

The ownership migration archives all pre-authentication database rows in the API-inaccessible `studymate_legacy_archive` schema, removes them from the live tables, and then makes `documents.user_id` required. It deliberately does not guess an owner. Legacy files under `documents/anonymous/` remain private and inaccessible; after validating the archive, remove that folder through the Storage Dashboard or Storage API. Do not delete rows directly from `storage.objects` with SQL.

## Authentication settings

Email/password authentication is enabled by default in Supabase. In **Authentication -> URL Configuration**, set the Site URL and allowed redirect URLs for the frontend (for example `http://localhost:8080` in development and the production origin after deployment). In **Authentication -> Providers -> Email**, choose whether new accounts must confirm their email. When confirmation is required, the sign-up screen asks the user to confirm before logging in.

## Server-only AI secrets

The chat Edge Function uses the Gemini generateContent API. `gemini-3.1-flash-lite` is the default. Set secrets in Supabase, not in frontend code:

```sh
npx supabase secrets set GEMINI_API_KEY="your-real-key" GEMINI_MODEL="gemini-3.1-flash-lite" --project-ref "$PROJECT_REF"
npx supabase secrets set GEMINI_EMBEDDING_MODEL="gemini-embedding-2" GEMINI_EMBEDDING_DIMENSIONS="768" --project-ref "$PROJECT_REF"
```

StudyMate uses synchronous `gemini-embedding-2:embedContent` requests through the Gemini API Free Tier and has no paid or asynchronous Batch API fallback. It formats questions and document chunks with the model's asymmetric question-answering prefixes and requests 768 dimensions. If embedding quota or availability prevents semantic indexing, extracted documents remain ready and chat automatically uses PostgreSQL keyword retrieval. The Gemini key remains server-only and must never use a `VITE_*` name.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically inside hosted Supabase Edge Functions. The service-role key must never be copied into `.env` or a browser file.

## Deploy Edge Functions

Deploy all functions after applying the database migrations:

```sh
npx supabase functions deploy process-document --project-ref "$PROJECT_REF"
npx supabase functions deploy chat-document --project-ref "$PROJECT_REF"
npx supabase functions deploy delete-document --project-ref "$PROJECT_REF"
npx supabase functions deploy chat-session --project-ref "$PROJECT_REF"
npx supabase functions deploy register-document --project-ref "$PROJECT_REF"
npx supabase functions deploy health-check --no-verify-jwt --project-ref "$PROJECT_REF"
```

JWT verification remains enabled. The frontend explicitly sends the current user's access token, and each function calls `auth.getUser()`, checks document ownership, and only then performs service-role operations.

Apply the Phase 2.5 migration before deploying these function versions. It prevents browsers from mutating extracted chunks/messages or deleting registered Storage objects outside the managed deletion function.

## Install and run the frontend

```sh
npm ci
npm run dev
```

The development server runs at `http://localhost:8080`.

For a production build and preview:

```sh
npm run build
npm run preview
```

## Verification commands

```sh
npx tsc -p tsconfig.app.json --noEmit
npx -y deno check --config supabase/functions/deno.json supabase/functions/process-document/index.ts supabase/functions/chat-document/index.ts supabase/functions/chat-session/index.ts supabase/functions/delete-document/index.ts
npx -y deno test --config supabase/functions/deno.json --allow-env supabase/functions
npm run build
npm run lint
npx supabase db reset
npx supabase db lint --local
npx supabase test db supabase/tests/ownership_rls.sql
npx supabase test db supabase/tests/phase2_hybrid_search.sql
npx supabase test db supabase/tests/phase3_multi_document.sql
npx supabase test db supabase/tests/phase3_5_production_hardening.sql
git diff --check
```

The SQL test checks cross-user RLS for documents, chunks, messages, document statistics, rename behavior, display-name validation, and history clearing against a local Supabase database. Also perform the two-account browser test after deploying the migration and functions.

## Current MVP flow

1. Supabase restores the persisted session; `/upload`, `/documents`, `/chat`, and `/history` redirect to `/login` if no authenticated user exists.
2. The browser validates and uploads a PDF under `<auth.uid()>/<document-id>.pdf`. `register-document` then verifies the object, authoritative Storage size/MIME, and exact owner namespace before creating metadata. Browser roles cannot register rows directly.
3. The browser invokes `process-document` with the access token and waits before opening Chat.
4. The Edge Function authenticates the caller, verifies ownership and Storage registration, then atomically claims a fenced 15-minute extraction lease. A healthy lease rejects competing workers. A stale lease may be reclaimed by the owner; old workers can no longer heartbeat, replace chunks, finalize readiness, or record failure.
5. Extraction enforces the synchronous limits below. Chunk replacement and the `ready` transition happen in one database transaction, so a crash cannot expose partial replacement chunks. Embeddings begin only after extraction is ready and remain independently retryable; embedding failures never disable keyword chat.
6. Documents lists owner-scoped extraction and semantic-search status, errors, and statistics in one request. A stale job exposes a safe recovery action. Owners can retry semantic backfill for one ready document; rename changes only the display name, and deletion runs through the authenticated `delete-document` function.
7. History lists owner-scoped normalized sessions, their mode and selected document names, and saved Q&A. Sessions can be reopened, renamed, or deleted without deleting PDFs.
8. Chat supports single-document, multi-document, and comparison modes with one to five server-revalidated ready documents. User/assistant pairs are persisted transactionally and are idempotent for the same request ID. Active session UUIDs and selections are user-keyed in session storage and never contain document text.
9. Multi-document retrieval generates at most one query embedding, searches each selected document independently, merges candidates fairly by document and page, and falls back to keyword retrieval when semantic indexing is unavailable.
10. Complete multi-document summaries traverse each document in order before cross-document synthesis. Citations are server-selected only when retrieved database chunks materially support the generated answer, and include database-derived document identity, page, and expandable excerpts.

## Phase 3.5 runtime safeguards

### Processing leases and retries

Extraction uses an atomic, owner-scoped database claim with `processing_started_at`, a private lease ID, an attempt count, and a heartbeat. The lease becomes reclaimable after 15 minutes without a heartbeat. Retry of a recently failed document is delayed for 60 seconds, at most two healthy extraction jobs may be active per user, and the retry path is idempotent. Ready documents are never reclaimed. There is no background worker.

The function records only safe failure text. It never logs filenames, document IDs, PDF text, chunks, prompts, questions, answers, citations, vectors, provider payloads, tokens, or raw database/Storage errors.

### Durable rate limits

Limits are checked after authentication in service-role-only database RPCs and apply across browsers and sessions. Browser roles cannot read or mutate rate state.

| Operation | Per minute | Per hour |
| --- | ---: | ---: |
| Upload registration | 5 | 20 |
| PDF processing | 5 | 20 |
| Embedding backfill | 1 | 6 |
| Chat | 10 | 100 |
| Complete summary (additional) | 2 | 10 |
| Document deletion | 5 | 30 |
| Session creation | 5 | 20 |

Rate rejections return HTTP 429, a bounded `Retry-After` header, a safe user message, and a request ID. Registration also caps abandoned `uploaded`/`processing` rows at ten per user; the UI accepts five files per batch.

### Synchronous resource limits

- Upload: 20 MiB, verified again from Storage metadata.
- PDF pages: 500.
- Extracted text: 2,000,000 characters.
- Extracted chunks: 2,500.
- Selected documents: five.
- Multi-document complete-summary input: 350,000 characters and 1,500 chunks.
- Single-document complete-summary input: 250,000 characters and 1,500 chunks.
- Retrieval candidates: 20 for single-document and eight per selected document for multi-document retrieval.
- Final model context: 24,000 characters; answer budgets remain server-clamped by response mode.

An over-limit complete summary is rejected rather than silently truncated into a misleading “complete” result.

### Provider resilience and free-tier behavior

The configured `GEMINI_MODEL`, `gemini-embedding-2`, and 768 dimensions remain unchanged. Provider requests have bounded timeouts and retries. Authentication, invalid-request/model, safety, quota, and other non-transient failures are not retried indefinitely. Answer quota failure returns HTTP 429 with a request ID. Embedding quota, timeout, or availability failure records a safe chunk status and leaves PostgreSQL keyword retrieval available. No paid provider, fallback model, billing, or asynchronous Batch API is used.

### Privacy-safe observability

Set the server-only Edge Function secret `OBSERVABILITY_ENABLED=true` to emit structured operational logs. When unset or false, logging is disabled and the application continues normally. `APP_VERSION` may optionally contain a non-secret release or commit identifier. Never prefix either setting with `VITE_`.

Logs contain request/function/operation names, safe reason/status codes, configured model names, durations, and numeric document/chunk/context/rate/recovery/partial-failure counts only. They intentionally exclude identity, content, paths, credentials, raw provider responses, and raw infrastructure errors.

### Health checks

`health-check` has two modes and never calls Gemini:

- `GET /functions/v1/health-check` is anonymous liveness and reports only function availability.
- An authenticated `POST /functions/v1/health-check` (or `GET ?check=readiness` with `Authorization`) reports only configuration presence, database/Storage reachability, configured model names/dimensions, and optional application version.

Because liveness is public, deploy this one function with `--no-verify-jwt`; readiness still validates the bearer token inside the function. Detailed diagnostics expose no URL, secret, user, or document data.

## Dependency security status

As of the Phase 3.5 audit, `npm audit --omit=dev` reports zero Critical/High production advisories and two Moderate React Router advisories. The application is a client-side SPA (the SSR hydration advisory is not reachable), and post-login navigation uses an exact path allowlist; however, the upstream fix requires the React Router 7 major upgrade and is deferred for controlled compatibility testing.

The full audit additionally reports six dev-only High advisories in Vite/ESLint transitive chains. Available fixes require Vite 8 and ESLint 10 major upgrades, so they are not applied automatically. Do not run `npm audit fix --force`; upgrade those toolchains in a dedicated compatibility change.

## Deployment order

1. Back up and review the target project; do not modify earlier migrations.
2. Apply all migrations, ending with `20260731120000_phase3_5_production_hardening.sql`.
3. Set the existing Gemini secrets plus optional `OBSERVABILITY_ENABLED` and `APP_VERSION`.
4. Deploy `register-document`, `process-document`, `chat-document`, `chat-session`, and `delete-document` with JWT verification.
5. Deploy `health-check` with `--no-verify-jwt` so public liveness works; readiness remains application-authenticated.
6. Deploy the frontend only after the functions are available, because browser document insert permission is revoked by the migration.
7. Run the hosted checklist below with two accounts before production traffic.

## Hosted verification checklist

- Two accounts: guessed document/session UUIDs, cross-user session attachment/citations, same-browser account switching, stale Query caches, active document/batch/session clearing.
- Upload/processing: duplicate filenames, missing/foreign registered object, retry, forced stale lease, active lease conflict, partial extraction failure, extraction-ready/embedding-failed keyword fallback.
- Chat: keyword, semantic, fallback, named/page question, unsupported topic, complete summary, multi-summary, comparison, and five-document ceiling.
- Deletion: active document, selected multi-document session, repeated deletion, forced Storage failure, and database failure after Storage deletion.
- Provider: invalid key/model, quota, timeout, 503/unavailable, blocked/empty/malformed responses.
- UI: keyboard navigation, narrow layout, lazy/auth loading and empty states, request IDs/retry timing, source expansion, disabled duplicate actions, route refresh, login redirect allowlist, and logout.

## MVP limitations

- Image-only/scanned PDFs are rejected because OCR is not implemented.
- Semantic retrieval depends on Gemini Free Tier embedding availability; keyword retrieval remains available when embeddings are pending or failed.
- There is no password-reset UI, browser E2E test suite, background job queue, OCR, or image understanding.
- PDF processing runs synchronously within Edge Function runtime limits; very complex 20 MB PDFs may need a queued worker later.
- Rate buckets are database-backed and intentionally conservative for free-tier use; there is no administrator UI for them.
- React Router, Vite, and ESLint major security upgrades remain controlled follow-ups as documented above.

The reviewed staged-worker design is documented in `docs/large-pdf-worker-architecture.md`. The 20 MB limit remains unchanged because the current PDF library loads and extracts the complete PDF within one Edge Function request; batched inserts alone do not make that operation resumable.
