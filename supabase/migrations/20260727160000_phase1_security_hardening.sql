-- Phase 1 security hardening: prevent browser bypass of managed document flows.

alter table public.documents enable row level security;
alter table public.documents force row level security;
alter table public.document_chunks enable row level security;
alter table public.document_chunks force row level security;
alter table public.messages enable row level security;
alter table public.messages force row level security;

revoke all on table public.documents from anon;
revoke all on table public.document_chunks from anon;
revoke all on table public.messages from anon;

-- Upload metadata is inserted by the browser and display_name is the only
-- document field intentionally editable from the browser. Document deletion
-- must go through delete-document so the private Storage object is removed first.
revoke update, delete on table public.documents from authenticated;
grant select, insert on table public.documents to authenticated;
grant update (display_name) on table public.documents to authenticated;

revoke all on function public.list_user_documents() from public, anon;
grant execute on function public.list_user_documents() to authenticated;

-- This function is server-enforced because browser roles do not choose an owner.
-- It accepts only an optional document UUID and always filters by auth.uid().
create or replace function public.clear_user_history(target_document_id uuid default null)
returns void
language sql
volatile
security definer
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

update storage.buckets set public = false where id = 'documents';

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
