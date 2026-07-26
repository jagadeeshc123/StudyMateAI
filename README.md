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

The version-controlled migrations create the private `documents` bucket, `documents`, `document_chunks`, and `messages` tables, relevant indexes, temporary prototype policies, and the server-only text-search function.

Link the Supabase CLI and apply both migrations:

```sh
npx supabase link --project-ref agxarewpwagkrceqfkte
npx supabase db push
```

Alternatively, run these files in timestamp order using **Supabase Dashboard -> SQL Editor**:

1. `supabase/migrations/20260726183000_create_documents.sql`
2. `supabase/migrations/20260726213000_add_document_processing_and_chat.sql`

In **Supabase Dashboard -> Storage**, confirm the `documents` bucket exists and **Public bucket** is disabled. The first migration creates and configures it automatically when run as written.

## Server-only AI secrets

The chat Edge Function uses the Gemini Interactions API. `gemini-3-flash-preview` is the default because it supports structured output and currently has a Gemini API free tier. Set secrets in Supabase, not in frontend code:

```sh
npx supabase secrets set GEMINI_API_KEY="your-real-key" GEMINI_MODEL="gemini-3-flash-preview" --project-ref agxarewpwagkrceqfkte
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically inside hosted Supabase Edge Functions. The service-role key must never be copied into `.env` or a browser file.

## Deploy Edge Functions

Deploy both functions after applying the database migration:

```sh
npx supabase functions deploy process-document --project-ref agxarewpwagkrceqfkte
npx supabase functions deploy chat-document --project-ref agxarewpwagkrceqfkte
```

JWT verification remains enabled. The current unauthenticated frontend invokes the functions with the project's anonymous token.

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
npx tsc --noEmit
npm run build
npm run lint
```

There is no automated test runner yet. Test upload, extraction, chat history, citations, and failure states manually after deploying the migration and functions.

## Current MVP flow

1. The browser validates and uploads a PDF to the private `documents` Storage bucket, then inserts its metadata.
2. The browser invokes `process-document` with the new document ID and waits before opening Chat.
3. The Edge Function downloads the private PDF using its server-only service-role client, extracts per-page text, stores chunks, and marks the document `ready` or `failed`.
4. Chat lists persisted ready documents and loads their saved message history through `chat-document`.
5. For a question, the Edge Function ranks chunks with PostgreSQL full-text search, sends only retrieved text to Gemini, validates cited chunk IDs, saves both messages, and returns the answer with page excerpts.

## Temporary policy warning

This remains an unauthenticated prototype. Anyone who has the public project key can list document display metadata and invoke the Edge Functions for a known document ID. Extracted chunks and messages have RLS enabled with no anonymous table policies, and the Storage bucket has no anonymous read policy, but the functions currently do not have user ownership to enforce.

Before real users or sensitive documents are supported, add authentication and a `user_id` owner to documents, store objects under paths scoped to `auth.uid()`, replace anonymous upload/insert policies with owner-only authenticated policies, and make both Edge Functions verify that the caller owns the requested document.

## MVP limitations

- Image-only/scanned PDFs are rejected because OCR is not implemented.
- Retrieval is keyword/full-text ranking, not semantic vector search.
- One selected document is queried at a time.
- There is no authentication, ownership isolation, rate limiting, automated test suite, or background job queue.
- PDF processing runs synchronously within Edge Function runtime limits; very complex 20 MB PDFs may need a queued worker later.
