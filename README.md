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
git diff --check
```

The SQL test checks cross-user RLS for documents, chunks, messages, document statistics, rename behavior, display-name validation, and history clearing against a local Supabase database. Also perform the two-account browser test after deploying the migration and functions.

## Current MVP flow

1. Supabase restores the persisted session; `/upload`, `/documents`, `/chat`, and `/history` redirect to `/login` if no authenticated user exists.
2. The browser validates and uploads a PDF under `<auth.uid()>/<document-id>.pdf`, then inserts metadata with the authenticated user's ID.
3. The browser invokes `process-document` with the access token and waits before opening Chat.
4. The Edge Function authenticates the caller, verifies ownership, downloads the private PDF, extracts per-page text, stores chunks, and marks extraction `ready` before attempting free-tier semantic indexing. Embedding failures never disable keyword chat.
5. Documents lists owner-scoped extraction and semantic-search status, errors, and statistics in one request. Owners can retry semantic backfill for one ready document; rename changes only the display name, and deletion runs through the authenticated `delete-document` function.
6. History lists owner-scoped normalized sessions, their mode and selected document names, and saved Q&A. Sessions can be reopened, renamed, or deleted without deleting PDFs.
7. Chat supports single-document, multi-document, and comparison modes with one to five server-revalidated ready documents. Active session UUIDs and selections are user-keyed in session storage and never contain document text.
8. Multi-document retrieval generates at most one query embedding, searches each selected document independently, merges candidates fairly by document and page, and falls back to keyword retrieval when semantic indexing is unavailable.
9. Complete multi-document summaries traverse each document in order before cross-document synthesis. Citations are server-selected only when retrieved database chunks materially support the generated answer, and include database-derived document identity, page, and expandable excerpts.

## MVP limitations

- Image-only/scanned PDFs are rejected because OCR is not implemented.
- Semantic retrieval depends on Gemini Free Tier embedding availability; keyword retrieval remains available when embeddings are pending or failed.
- There is no password-reset UI, rate limiting, browser E2E test suite, or background job queue.
- PDF processing runs synchronously within Edge Function runtime limits; very complex 20 MB PDFs may need a queued worker later.

The reviewed staged-worker design is documented in `docs/large-pdf-worker-architecture.md`. The 20 MB limit remains unchanged because the current PDF library loads and extracts the complete PDF within one Edge Function request; batched inserts alone do not make that operation resumable.
