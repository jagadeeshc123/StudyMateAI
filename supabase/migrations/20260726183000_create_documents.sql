-- First StudyMate MVP storage schema.
-- The anonymous policies in this migration are TEMPORARY development policies.
-- Replace them with per-user policies before adding authentication or real user data.

create extension if not exists pgcrypto;

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  original_file_name text not null check (length(trim(original_file_name)) > 0),
  storage_path text not null unique check (storage_path like 'anonymous/%'),
  file_size bigint not null check (file_size > 0 and file_size <= 20971520),
  mime_type text not null default 'application/pdf' check (mime_type = 'application/pdf'),
  processing_status text not null default 'uploaded'
    check (processing_status in ('uploaded', 'processing', 'ready', 'failed')),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists documents_created_at_idx
  on public.documents (created_at desc);

alter table public.documents enable row level security;

revoke all on table public.documents from anon, authenticated;
grant insert on table public.documents to anon;

drop policy if exists "Temporary anonymous document reads" on public.documents;
drop policy if exists "Temporary anonymous document inserts" on public.documents;
create policy "Temporary anonymous document inserts"
  on public.documents
  for insert
  to anon
  with check (
    storage_path like 'anonymous/%'
    and file_size > 0
    and file_size <= 20971520
    and mime_type = 'application/pdf'
    and processing_status = 'uploaded'
  );

create or replace function public.list_documents()
returns table (
  id uuid,
  original_file_name text,
  file_size bigint,
  mime_type text,
  processing_status text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    documents.id,
    documents.original_file_name,
    documents.file_size,
    documents.mime_type,
    documents.processing_status,
    documents.created_at
  from public.documents
  order by documents.created_at desc;
$$;

revoke all on function public.list_documents() from public;
grant execute on function public.list_documents() to anon;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents',
  'documents',
  false,
  20971520,
  array['application/pdf']::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Temporary anonymous document uploads" on storage.objects;
create policy "Temporary anonymous document uploads"
  on storage.objects
  for insert
  to anon
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = 'anonymous'
  );

drop policy if exists "Temporary anonymous upload rollback" on storage.objects;
create policy "Temporary anonymous upload rollback"
  on storage.objects
  for delete
  to anon
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = 'anonymous'
  );

-- Intentionally no SELECT policy exists on storage.objects. The bucket is private,
-- and anonymous clients cannot list or download stored PDFs.
-- Anonymous clients also cannot select public.documents directly. list_documents()
-- exposes only display metadata and deliberately omits storage_path.
