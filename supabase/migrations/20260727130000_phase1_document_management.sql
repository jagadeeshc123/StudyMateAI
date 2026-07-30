-- Phase 1: owner-scoped document management, processing diagnostics, and stats.

alter table public.documents
  add column if not exists display_name text,
  add column if not exists page_count integer,
  add column if not exists processing_error text;

alter table public.documents
  drop constraint if exists documents_processing_status_check;

alter table public.documents
  add constraint documents_processing_status_check
  check (processing_status in ('uploaded', 'processing', 'ready', 'failed', 'deleting'));

alter table public.documents
  drop constraint if exists documents_display_name_check;

alter table public.documents
  add constraint documents_display_name_check
  check (
    display_name is null
    or (
      display_name = regexp_replace(display_name, '^[[:space:]]+|[[:space:]]+$', '', 'g')
      and length(display_name) between 1 and 150
      and display_name !~ '[[:cntrl:]]'
    )
  );

alter table public.documents
  drop constraint if exists documents_page_count_check;

alter table public.documents
  add constraint documents_page_count_check
  check (page_count is null or page_count > 0);

-- Preserve useful statistics for documents processed before this migration.
update public.documents as documents
set page_count = existing.max_page_number
from (
  select document_id, max(page_number)::integer as max_page_number
  from public.document_chunks
  group by document_id
) as existing
where documents.id = existing.document_id
  and documents.page_count is null;

create index if not exists documents_user_status_created_at_idx
  on public.documents (user_id, processing_status, created_at desc);

create or replace function public.list_user_documents()
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
    documents.created_at
  from public.documents
  left join (
    select document_id, count(*)::bigint as chunk_count
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

create or replace function public.clear_user_history(target_document_id uuid default null)
returns void
language sql
volatile
security invoker
set search_path = public, pg_temp
as $$
  delete from public.messages
  where (target_document_id is null or messages.document_id = target_document_id)
    and exists (
      select 1
      from public.documents
      where documents.id = messages.document_id
        and documents.user_id = (select auth.uid())
    );
$$;

revoke all on function public.clear_user_history(uuid) from public, anon;
grant execute on function public.clear_user_history(uuid) to authenticated;
