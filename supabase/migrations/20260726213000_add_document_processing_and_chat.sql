-- StudyMate PDF processing and grounded chat schema.
-- The Edge Functions use the service_role database role; browser clients do not
-- receive direct access to extracted chunks or chat messages.

create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  content text not null check (length(trim(content)) > 0),
  page_number integer not null check (page_number > 0),
  chunk_index integer not null check (chunk_index >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  unique (document_id, page_number, chunk_index)
);

create index if not exists document_chunks_document_id_idx
  on public.document_chunks (document_id);

create index if not exists document_chunks_search_idx
  on public.document_chunks
  using gin (to_tsvector('english', content));

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (length(trim(content)) > 0),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists messages_document_created_at_idx
  on public.messages (document_id, created_at, id);

alter table public.document_chunks enable row level security;
alter table public.messages enable row level security;

revoke all on table public.document_chunks from anon, authenticated;
revoke all on table public.messages from anon, authenticated;

-- Temporary unauthenticated-prototype policy model:
-- No anon/authenticated table policies are created. Only the Edge Functions,
-- which hold the service-role key as a server-side secret, may access these rows.
-- Once authentication is added, associate documents with auth.users and enforce
-- ownership in every function before allowing authenticated users to process,
-- search, or read a document and its messages.

create or replace function public.search_document_chunks(
  target_document_id uuid,
  search_query text,
  match_count integer default 6
)
returns table (
  id uuid,
  content text,
  page_number integer,
  chunk_index integer,
  rank real
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with parsed_query as (
    select websearch_to_tsquery('english', trim(search_query)) as query
  )
  select
    chunks.id,
    chunks.content,
    chunks.page_number,
    chunks.chunk_index,
    ts_rank_cd(
      to_tsvector('english', chunks.content),
      parsed_query.query
    )::real as rank
  from public.document_chunks as chunks
  cross join parsed_query
  where chunks.document_id = target_document_id
    and to_tsvector('english', chunks.content) @@ parsed_query.query
  order by rank desc, chunks.page_number, chunks.chunk_index
  limit least(greatest(match_count, 1), 10);
$$;

revoke all on function public.search_document_chunks(uuid, text, integer) from public;
grant execute on function public.search_document_chunks(uuid, text, integer) to service_role;
