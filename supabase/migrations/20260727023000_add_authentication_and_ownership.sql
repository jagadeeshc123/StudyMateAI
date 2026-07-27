-- Add authenticated ownership to StudyMate.
--
-- Legacy prototype rows cannot be attributed to a real person. Archive them in a
-- schema that is inaccessible to API roles, then remove them from the live tables
-- before making documents.user_id NOT NULL. Their private Storage objects remain
-- under anonymous/ and become inaccessible when the temporary policies are removed.

create schema if not exists studymate_legacy_archive;
revoke all on schema studymate_legacy_archive from public, anon, authenticated;

create table if not exists studymate_legacy_archive.documents_20260727 as
select *, timezone('utc', now()) as archived_at
from public.documents
with no data;

create table if not exists studymate_legacy_archive.document_chunks_20260727 as
select *, timezone('utc', now()) as archived_at
from public.document_chunks
with no data;

create table if not exists studymate_legacy_archive.messages_20260727 as
select *, timezone('utc', now()) as archived_at
from public.messages
with no data;

insert into studymate_legacy_archive.documents_20260727
select *, timezone('utc', now())
from public.documents;

insert into studymate_legacy_archive.document_chunks_20260727
select chunks.*, timezone('utc', now())
from public.document_chunks as chunks;

insert into studymate_legacy_archive.messages_20260727
select messages.*, timezone('utc', now())
from public.messages as messages;

-- Cascades remove the archived chunks/messages from the live application tables.
delete from public.documents;

alter table public.documents
  add column user_id uuid not null references auth.users(id) on delete cascade;

alter table public.documents
  drop constraint if exists documents_storage_path_check;

alter table public.documents
  add constraint documents_storage_path_matches_owner_check
  check (storage_path like user_id::text || '/%.pdf');

create index if not exists documents_user_id_idx
  on public.documents (user_id);

create index if not exists documents_user_created_at_idx
  on public.documents (user_id, created_at desc);

-- Remove every prototype grant and policy before adding authenticated access.
drop policy if exists "Temporary anonymous document reads" on public.documents;
drop policy if exists "Temporary anonymous document inserts" on public.documents;
revoke all on table public.documents from anon;
revoke all on table public.document_chunks from anon;
revoke all on table public.messages from anon;

grant select, insert, update, delete on table public.documents to authenticated;
grant select, insert, update, delete on table public.document_chunks to authenticated;
grant select, insert, update, delete on table public.messages to authenticated;

alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.messages enable row level security;

drop policy if exists "Users can read own documents" on public.documents;
create policy "Users can read own documents"
  on public.documents for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own documents" on public.documents;
create policy "Users can insert own documents"
  on public.documents for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own documents" on public.documents;
create policy "Users can update own documents"
  on public.documents for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete own documents" on public.documents;
create policy "Users can delete own documents"
  on public.documents for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can read chunks of own documents" on public.document_chunks;
create policy "Users can read chunks of own documents"
  on public.document_chunks for select to authenticated
  using (exists (
    select 1 from public.documents
    where documents.id = document_chunks.document_id
      and documents.user_id = (select auth.uid())
  ));

drop policy if exists "Users can insert chunks for own documents" on public.document_chunks;
create policy "Users can insert chunks for own documents"
  on public.document_chunks for insert to authenticated
  with check (exists (
    select 1 from public.documents
    where documents.id = document_chunks.document_id
      and documents.user_id = (select auth.uid())
  ));

drop policy if exists "Users can update chunks of own documents" on public.document_chunks;
create policy "Users can update chunks of own documents"
  on public.document_chunks for update to authenticated
  using (exists (
    select 1 from public.documents
    where documents.id = document_chunks.document_id
      and documents.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.documents
    where documents.id = document_chunks.document_id
      and documents.user_id = (select auth.uid())
  ));

drop policy if exists "Users can delete chunks of own documents" on public.document_chunks;
create policy "Users can delete chunks of own documents"
  on public.document_chunks for delete to authenticated
  using (exists (
    select 1 from public.documents
    where documents.id = document_chunks.document_id
      and documents.user_id = (select auth.uid())
  ));

drop policy if exists "Users can read messages of own documents" on public.messages;
create policy "Users can read messages of own documents"
  on public.messages for select to authenticated
  using (exists (
    select 1 from public.documents
    where documents.id = messages.document_id
      and documents.user_id = (select auth.uid())
  ));

drop policy if exists "Users can insert messages for own documents" on public.messages;
create policy "Users can insert messages for own documents"
  on public.messages for insert to authenticated
  with check (exists (
    select 1 from public.documents
    where documents.id = messages.document_id
      and documents.user_id = (select auth.uid())
  ));

drop policy if exists "Users can update messages of own documents" on public.messages;
create policy "Users can update messages of own documents"
  on public.messages for update to authenticated
  using (exists (
    select 1 from public.documents
    where documents.id = messages.document_id
      and documents.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.documents
    where documents.id = messages.document_id
      and documents.user_id = (select auth.uid())
  ));

drop policy if exists "Users can delete messages of own documents" on public.messages;
create policy "Users can delete messages of own documents"
  on public.messages for delete to authenticated
  using (exists (
    select 1 from public.documents
    where documents.id = messages.document_id
      and documents.user_id = (select auth.uid())
  ));

-- Keep the existing display RPC, but make it caller-scoped and subject to RLS.
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
security invoker
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
  where documents.user_id = (select auth.uid())
  order by documents.created_at desc;
$$;

revoke all on function public.list_documents() from public, anon;
grant execute on function public.list_documents() to authenticated;

-- The bucket remains private. Folder 1 must exactly match the authenticated UID.
update storage.buckets
set public = false
where id = 'documents';

drop policy if exists "Temporary anonymous document uploads" on storage.objects;
drop policy if exists "Temporary anonymous upload rollback" on storage.objects;
drop policy if exists "Users can upload own documents" on storage.objects;
drop policy if exists "Users can view own documents" on storage.objects;
drop policy if exists "Users can delete own documents" on storage.objects;

create policy "Users can upload own documents"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy "Users can view own documents"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy "Users can delete own documents"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- Do not delete rows directly from storage.objects. After this migration, remove
-- legacy anonymous/ files through the Supabase Storage Dashboard or Storage API.
