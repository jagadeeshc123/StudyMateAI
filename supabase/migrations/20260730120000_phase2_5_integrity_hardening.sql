-- Phase 2.5: keep browser access owner-scoped while protecting server-managed
-- document state, extracted evidence, messages, and registered Storage objects.

-- Browsers may create only the initial upload metadata state. Processing fields
-- remain controlled by authenticated Edge Functions using the service role.
drop policy if exists "Users can insert own documents" on public.documents;
create policy "Users can insert own uploaded documents"
  on public.documents for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and processing_status = 'uploaded'
    and processing_error is null
    and page_count is null
    and display_name is null
    and mime_type = 'application/pdf'
  );

-- Extracted chunks and saved messages are readable by their owner through RLS,
-- but only server-managed flows may create, alter, or remove them.
revoke insert, update, delete on table public.document_chunks from authenticated;
revoke insert, update, delete on table public.messages from authenticated;
grant select on table public.document_chunks to authenticated;
grant select on table public.messages to authenticated;

-- A browser may clean up a just-uploaded object only while no document row
-- references it. Registered files must go through delete-document so Storage and
-- database cascades are coordinated.
drop policy if exists "Users can delete own documents" on storage.objects;
drop policy if exists "Users can delete unregistered document uploads" on storage.objects;
create policy "Users can delete unregistered document uploads"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and not exists (
      select 1
      from public.documents
      where documents.user_id = (select auth.uid())
        and documents.storage_path = storage.objects.name
    )
  );

