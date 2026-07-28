-- Phase 2: free-tier Gemini embeddings and owner-gated hybrid retrieval.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;
grant usage on schema extensions to service_role;

alter table public.document_chunks
  add column if not exists embedding extensions.vector(768),
  add column if not exists embedding_status text not null default 'pending',
  add column if not exists embedding_error text,
  add column if not exists embedding_model text,
  add column if not exists embedded_at timestamptz,
  add column if not exists content_hash text;

-- Existing rows remain keyword-searchable while their embeddings are backfilled.
update public.document_chunks
set content_hash = md5(content)
where content_hash is null;

alter table public.document_chunks
  alter column content_hash set not null;

alter table public.document_chunks
  drop constraint if exists document_chunks_embedding_status_check;

alter table public.document_chunks
  add constraint document_chunks_embedding_status_check
  check (embedding_status in ('pending', 'processing', 'ready', 'failed', 'skipped'));

alter table public.document_chunks
  drop constraint if exists document_chunks_embedding_consistency_check;

alter table public.document_chunks
  add constraint document_chunks_embedding_consistency_check
  check (
    (embedding_status = 'ready' and embedding is not null and embedding_model is not null and embedded_at is not null)
    or embedding_status <> 'ready'
  );

alter table public.document_chunks
  drop constraint if exists document_chunks_content_hash_check;

alter table public.document_chunks
  add constraint document_chunks_content_hash_check
  check (length(trim(content_hash)) > 0);

create index if not exists document_chunks_embedding_status_idx
  on public.document_chunks (document_id, embedding_status, page_number, chunk_index);

create index if not exists document_chunks_embedding_identity_idx
  on public.document_chunks (document_id, embedding_model, content_hash)
  where embedding_status = 'ready';

-- pgvector added HNSW in 0.5.0. vector(768) is below its 2,000-dimension
-- vector limit, so create the cosine index only when the installed version can
-- support it. Hybrid search still works without this index on older versions.
do $$
declare
  installed_version text;
  version_major integer;
  version_minor integer;
begin
  select extversion
  into installed_version
  from pg_extension
  where extname = 'vector';

  version_major := split_part(installed_version, '.', 1)::integer;
  version_minor := split_part(installed_version, '.', 2)::integer;

  if version_major > 0 or (version_major = 0 and version_minor >= 5) then
    execute $index$
      create index if not exists document_chunks_embedding_hnsw_idx
      on public.document_chunks
      using hnsw (embedding extensions.vector_cosine_ops)
      where embedding is not null
    $index$;
  else
    raise notice 'Skipping HNSW index because pgvector % is older than 0.5.0', installed_version;
  end if;
end
$$;

-- Preserve keyword retrieval while allowing it to provide the larger candidate
-- pool used before final context diversification.
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
  limit least(greatest(match_count, 1), 100);
$$;

revoke all on function public.search_document_chunks(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.search_document_chunks(uuid, text, integer)
  to service_role;

create or replace function public.hybrid_search_document_chunks(
  target_document_id uuid,
  query_embedding extensions.vector(768),
  keyword_query text,
  requested_page_numbers integer[] default null,
  match_count integer default 20,
  semantic_weight real default 1.0,
  keyword_weight real default 1.0,
  target_embedding_model text default 'gemini-embedding-2'
)
returns table (
  id uuid,
  document_id uuid,
  page_number integer,
  chunk_index integer,
  content text,
  semantic_score real,
  keyword_score real,
  combined_score real
)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  with parameters as (
    select
      least(greatest(match_count, 1), 100) as result_limit,
      greatest(semantic_weight, 0.0)::real as semantic_weight,
      greatest(keyword_weight, 0.0)::real as keyword_weight,
      case
        when length(trim(coalesce(keyword_query, ''))) = 0 then null::tsquery
        else websearch_to_tsquery('english', trim(keyword_query))
      end as parsed_query
  ),
  eligible as (
    select chunks.*
    from public.document_chunks as chunks
    where chunks.document_id = target_document_id
      and (
        requested_page_numbers is null
        or chunks.page_number = any(requested_page_numbers)
      )
  ),
  semantic_candidates as (
    select
      chunks.id,
      (1.0 - (chunks.embedding <=> query_embedding))::real as score
    from eligible as chunks
    cross join parameters
    where query_embedding is not null
      and chunks.embedding_status = 'ready'
      and chunks.embedding is not null
      and chunks.embedding_model = target_embedding_model
      and (1.0 - (chunks.embedding <=> query_embedding)) >= 0.35
    order by chunks.embedding <=> query_embedding, chunks.page_number, chunks.chunk_index
    limit (select least(result_limit * 4, 100) from parameters)
  ),
  semantic_ranked as (
    select
      candidates.id,
      candidates.score,
      row_number() over (order by candidates.score desc, candidates.id) as rank_position
    from semantic_candidates as candidates
  ),
  keyword_candidates as (
    select
      chunks.id,
      ts_rank_cd(
        to_tsvector('english', chunks.content),
        parameters.parsed_query
      )::real as score
    from eligible as chunks
    cross join parameters
    where parameters.parsed_query is not null
      and to_tsvector('english', chunks.content) @@ parameters.parsed_query
    order by score desc, chunks.page_number, chunks.chunk_index
    limit (select least(result_limit * 4, 100) from parameters)
  ),
  keyword_ranked as (
    select
      candidates.id,
      candidates.score,
      row_number() over (order by candidates.score desc, candidates.id) as rank_position
    from keyword_candidates as candidates
  ),
  fused as (
    select
      coalesce(semantic_ranked.id, keyword_ranked.id) as id,
      semantic_ranked.score as semantic_score,
      keyword_ranked.score as keyword_score,
      (
        parameters.semantic_weight /
          (60.0 + coalesce(semantic_ranked.rank_position, 1000000))
        + parameters.keyword_weight /
          (60.0 + coalesce(keyword_ranked.rank_position, 1000000))
      )::real as combined_score
    from semantic_ranked
    full outer join keyword_ranked using (id)
    cross join parameters
  )
  select
    chunks.id,
    chunks.document_id,
    chunks.page_number,
    chunks.chunk_index,
    chunks.content,
    fused.semantic_score,
    fused.keyword_score,
    fused.combined_score
  from fused
  join eligible as chunks using (id)
  order by fused.combined_score desc, chunks.page_number, chunks.chunk_index
  limit (select result_limit from parameters);
$$;

comment on function public.hybrid_search_document_chunks(
  uuid,
  extensions.vector,
  text,
  integer[],
  integer,
  real,
  real,
  text
) is 'Server-only document-scoped semantic/full-text retrieval using same-model embeddings, a 0.35 cosine-similarity floor, and weighted reciprocal-rank fusion (k=60).';

revoke all on function public.hybrid_search_document_chunks(
  uuid,
  extensions.vector,
  text,
  integer[],
  integer,
  real,
  real,
  text
) from public, anon, authenticated;

grant execute on function public.hybrid_search_document_chunks(
  uuid,
  extensions.vector,
  text,
  integer[],
  integer,
  real,
  real,
  text
) to service_role;

-- Extend the existing owner-scoped document listing with derived semantic
-- readiness. Extraction readiness remains represented by processing_status.
drop function if exists public.list_user_documents();

create function public.list_user_documents()
returns table (
  id uuid,
  display_name text,
  original_file_name text,
  file_size bigint,
  mime_type text,
  processing_status text,
  processing_error text,
  page_count integer,
  chunk_count bigint,
  message_count bigint,
  embedding_status text,
  embedding_error text,
  embedding_model text,
  embedded_chunk_count bigint,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    documents.id,
    documents.display_name,
    documents.original_file_name,
    documents.file_size,
    documents.mime_type,
    documents.processing_status,
    documents.processing_error,
    documents.page_count,
    coalesce(chunk_totals.chunk_count, 0)::bigint,
    coalesce(message_totals.message_count, 0)::bigint,
    case
      when coalesce(chunk_totals.chunk_count, 0) = 0 then 'skipped'
      when chunk_totals.processing_count > 0 then 'processing'
      when chunk_totals.failed_count > 0 then 'failed'
      when chunk_totals.ready_count = chunk_totals.chunk_count then 'ready'
      when chunk_totals.pending_count > 0 then 'pending'
      else 'skipped'
    end as embedding_status,
    chunk_totals.embedding_error,
    chunk_totals.embedding_model,
    coalesce(chunk_totals.ready_count, 0)::bigint as embedded_chunk_count,
    documents.created_at
  from public.documents
  left join (
    select
      document_id,
      count(*)::bigint as chunk_count,
      count(*) filter (where embedding_status = 'pending')::bigint as pending_count,
      count(*) filter (where embedding_status = 'processing')::bigint as processing_count,
      count(*) filter (where embedding_status = 'ready')::bigint as ready_count,
      count(*) filter (where embedding_status = 'failed')::bigint as failed_count,
      max(embedding_error) filter (where embedding_status = 'failed') as embedding_error,
      max(embedding_model) filter (where embedding_status = 'ready') as embedding_model
    from public.document_chunks
    group by document_id
  ) as chunk_totals on chunk_totals.document_id = documents.id
  left join (
    select document_id, count(*)::bigint as message_count
    from public.messages
    group by document_id
  ) as message_totals on message_totals.document_id = documents.id
  where documents.user_id = (select auth.uid())
  order by documents.created_at desc;
$$;

revoke all on function public.list_user_documents() from public, anon;
grant execute on function public.list_user_documents() to authenticated;
