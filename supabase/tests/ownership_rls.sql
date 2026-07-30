-- Run against a local Supabase database after `supabase db reset`:
--   supabase test db supabase/tests/ownership_rls.sql
-- Everything is generated at runtime and rolled back.

begin;

create extension if not exists pgtap with schema extensions;
select plan(33);

create temporary table phase1_test_context on commit drop as
with generated as (
  select
    gen_random_uuid() as user_a_id,
    gen_random_uuid() as user_b_id,
    gen_random_uuid() as document_a_id,
    gen_random_uuid() as document_b_id,
    gen_random_uuid() as forbidden_document_id,
    (10 + floor(random() * 20))::integer as page_a_number,
    (40 + floor(random() * 20))::integer as page_b_number
)
select
  generated.*,
  format('document-%s.pdf', generated.document_a_id) as file_name_a,
  format('document-%s.pdf', generated.document_b_id) as file_name_b,
  format('content-%s', generated.document_a_id) as content_a,
  format('content-%s', generated.document_b_id) as content_b,
  format('duplicate-%s.pdf', generated.forbidden_document_id) as shared_storage_file_name
from generated;

grant select on phase1_test_context to authenticated;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  '00000000-0000-0000-0000-000000000000'::uuid,
  user_a_id,
  'authenticated',
  'authenticated',
  format('rls+%s@studymate.test', user_a_id),
  '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
from phase1_test_context
union all
select
  '00000000-0000-0000-0000-000000000000'::uuid,
  user_b_id,
  'authenticated',
  'authenticated',
  format('rls+%s@studymate.test', user_b_id),
  '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
from phase1_test_context;

insert into public.documents (
  id, user_id, original_file_name, storage_path, file_size, mime_type,
  processing_status, page_count
)
select
  document_a_id,
  user_a_id,
  file_name_a,
  format('%s/%s.pdf', user_a_id, document_a_id),
  100,
  'application/pdf',
  'ready',
  page_a_number
from phase1_test_context
union all
select
  document_b_id,
  user_b_id,
  file_name_b,
  format('%s/%s.pdf', user_b_id, document_b_id),
  100,
  'application/pdf',
  'ready',
  page_b_number
from phase1_test_context;

insert into public.document_chunks (
  document_id, content, page_number, chunk_index, content_hash
)
select document_a_id, content_a, page_a_number, 0, md5(content_a) from phase1_test_context
union all
select document_b_id, content_b, page_b_number, 0, md5(content_b) from phase1_test_context;

insert into public.messages (document_id, role, content)
select document_a_id, 'user', format('question-%s', document_a_id) from phase1_test_context
union all
select document_b_id, 'user', format('question-%s', document_b_id) from phase1_test_context;

insert into storage.objects (bucket_id, name, owner, owner_id, metadata)
select
  'documents',
  format('%s/%s', user_a_id, shared_storage_file_name),
  user_a_id,
  user_a_id::text,
  '{}'::jsonb
from phase1_test_context
union all
select
  'documents',
  format('%s/%s', user_b_id, shared_storage_file_name),
  user_b_id,
  user_b_id::text,
  '{}'::jsonb
from phase1_test_context
union all
select
  'documents',
  format('%s/%s.pdf', user_a_id, document_a_id),
  user_a_id,
  user_a_id::text,
  '{}'::jsonb
from phase1_test_context
union all
select
  'documents',
  format('%s/%s.pdf', user_b_id, document_b_id),
  user_b_id,
  user_b_id::text,
  '{}'::jsonb
from phase1_test_context;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (select user_a_id from phase1_test_context),
    'role', 'authenticated'
  )::text,
  true
);

select is((select count(*) from public.documents), 1::bigint, 'User A reads only User A documents');
select is((select count(*) from public.document_chunks), 1::bigint, 'User A reads only User A chunks');
select is((select count(*) from public.messages), 1::bigint, 'User A reads only User A messages');
select is(
  (select count(*) from public.documents where id = (select document_b_id from phase1_test_context)),
  0::bigint,
  'A guessed foreign document UUID cannot bypass document RLS'
);
select is(
  (select count(*) from storage.objects where bucket_id = 'documents'),
  2::bigint,
  'User A reads only User A Storage folder when filenames are duplicated between users'
);

-- Local Storage schema guards direct SQL deletes even when RLS would return no
-- rows. The Storage API sets this transaction-local flag before its DELETE.
select set_config('storage.allow_delete_query', 'true', true);

with affected as (
  delete from storage.objects
  where bucket_id = 'documents'
    and name = format(
      '%s/%s.pdf',
      (select user_a_id from phase1_test_context),
      (select document_a_id from phase1_test_context)
    )
  returning 1
)
select is((select count(*) from affected), 0::bigint, 'Browser cannot delete a registered private file');

with affected as (
  delete from storage.objects
  where bucket_id = 'documents'
    and name = format(
      '%s/%s',
      (select user_a_id from phase1_test_context),
      (select shared_storage_file_name from phase1_test_context)
    )
  returning 1
)
select is((select count(*) from affected), 1::bigint, 'Browser may clean up only its own unregistered upload');
select is((select count(*) from public.list_documents()), 1::bigint, 'list_documents is caller-scoped');
select is((select count(*) from public.list_user_documents()), 1::bigint, 'list_user_documents is caller-scoped');

select ok(
  not has_function_privilege(
    'authenticated',
    'public.hybrid_search_document_chunks(uuid,extensions.vector,text,integer[],integer,real,real,text)',
    'EXECUTE'
  ),
  'Browser roles cannot execute the privileged hybrid-search function'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.search_document_chunks(uuid,text,integer)',
    'EXECUTE'
  ),
  'Browser roles cannot bypass ownership through keyword-search RPC'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.hybrid_search_document_chunks(uuid,extensions.vector,text,integer[],integer,real,real,text)',
    'EXECUTE'
  ),
  'The secure server role can execute hybrid search after owner verification'
);

select is(
  (
    select concat(page_count, ':', chunk_count, ':', message_count)
    from public.list_user_documents()
  ),
  (
    select concat(page_a_number, ':1:1')
    from phase1_test_context
  ),
  'Document statistics are returned in one owner-scoped result'
);

update public.documents
set display_name = format('display-%s', id)
where id = (select document_a_id from phase1_test_context);

select is(
  (
    select original_file_name
    from public.documents
    where id = (select document_a_id from phase1_test_context)
  ),
  (select file_name_a from phase1_test_context),
  'Renaming preserves the original filename'
);

with affected as (
  update public.documents
  set display_name = format('forbidden-%s', id)
  where id = (select document_b_id from phase1_test_context)
  returning 1
)
select is((select count(*) from affected), 0::bigint, 'User A cannot rename User B documents');

do $$ begin
  begin update public.document_chunks set content = 'forbidden' where true;
    raise exception 'browser chunk UPDATE unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
end $$;
select pass('Browser cannot update server-managed chunks, including another user chunks');

do $$ begin
  begin update public.messages set content = 'forbidden' where true;
    raise exception 'browser message UPDATE unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
end $$;
select pass('Browser cannot update server-managed messages, including another user messages');

do $$ begin
  begin delete from public.document_chunks where true;
    raise exception 'browser chunk DELETE unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
end $$;
select pass('Browser cannot delete server-managed chunks, including another user chunks');

do $$ begin
  begin delete from public.messages where true;
    raise exception 'browser message DELETE unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
end $$;
select pass('Browser cannot delete server-managed messages, including another user messages');

select public.clear_user_history((select document_b_id from phase1_test_context));
reset role;

select is(
  (
    select count(*)
    from public.messages
    where document_id = (select document_b_id from phase1_test_context)
  ),
  1::bigint,
  'User A cannot clear User B history through clear_user_history'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (select user_a_id from phase1_test_context),
    'role', 'authenticated'
  )::text,
  true
);

do $$
begin
  begin
    delete from public.documents
    where id = (select document_b_id from phase1_test_context);
    raise exception 'direct browser document DELETE unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end
$$;

select pass('Browser roles cannot directly delete document rows');

do $$
begin
  begin
    update public.documents
    set processing_status = 'processing'
    where id = (select document_b_id from phase1_test_context);
    raise exception 'cross-user processing retry unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end
$$;

select pass('Browser roles cannot claim processing or retry another user document');

do $$
begin
  begin
    insert into public.documents (user_id, original_file_name, storage_path, file_size)
    select
      user_b_id,
      format('forbidden-%s.pdf', forbidden_document_id),
      format('%s/%s.pdf', user_b_id, forbidden_document_id),
      100
    from phase1_test_context;
    raise exception 'cross-user document INSERT unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.document_chunks (document_id, content, page_number, chunk_index)
    select document_b_id, format('forbidden-%s', forbidden_document_id), page_b_number + 1, 1
    from phase1_test_context;
    raise exception 'cross-user chunk INSERT unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.messages (document_id, role, content)
    select document_b_id, 'user', format('forbidden-%s', forbidden_document_id)
    from phase1_test_context;
    raise exception 'cross-user message INSERT unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end
$$;

select pass('Cross-user document, chunk, and message inserts are rejected');

do $$
begin
  begin
    insert into public.documents (
      user_id, original_file_name, storage_path, file_size, mime_type, processing_status
    )
    select user_a_id, 'forged-ready.pdf', format('%s/%s.pdf', user_a_id, gen_random_uuid()),
      100, 'application/pdf', 'ready'
    from phase1_test_context;
    raise exception 'forged ready document unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end
$$;
select pass('Browser cannot forge a server-managed document processing state');

do $$
begin
  begin
    insert into storage.objects (bucket_id, name, owner, owner_id, metadata)
    select
      'documents',
      format('%s/forbidden-%s.pdf', user_b_id, gen_random_uuid()),
      user_a_id,
      user_a_id::text,
      '{}'::jsonb
    from phase1_test_context;
    raise exception 'cross-user Storage INSERT unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end
$$;

select pass('User A cannot upload into User B Storage folder');

do $$
begin
  begin
    update public.documents
    set display_name = '   '
    where id = (select document_a_id from phase1_test_context);
    raise exception 'blank display name unexpectedly succeeded';
  exception when check_violation then null;
  end;

  begin
    update public.documents
    set display_name = repeat('x', 151)
    where id = (select document_a_id from phase1_test_context);
    raise exception 'overlong display name unexpectedly succeeded';
  exception when check_violation then null;
  end;

  begin
    update public.documents
    set display_name = format('bad%sname', chr(10))
    where id = (select document_a_id from phase1_test_context);
    raise exception 'control-character display name unexpectedly succeeded';
  exception when check_violation then null;
  end;
end
$$;

select pass('Display-name constraints reject blank, overlong, and control-character values');

select public.clear_user_history((select document_a_id from phase1_test_context));

select is(
  (select count(*) from public.documents),
  1::bigint,
  'Clearing history keeps the related document'
);

select is(
  (select count(*) from public.messages),
  0::bigint,
  'Clearing history removes the caller-owned messages'
);

reset role;

insert into public.messages (document_id, role, content)
select document_a_id, 'user', format('cascade-%s', document_a_id)
from phase1_test_context;

with affected as (
  delete from public.documents
  where id = (select document_a_id from phase1_test_context)
  returning 1
)
select is((select count(*) from affected), 1::bigint, 'Managed deletion can remove an owned document row');

select is(
  (
    select concat(
      (select count(*) from public.document_chunks where document_id = context.document_a_id),
      ':',
      (select count(*) from public.messages where document_id = context.document_a_id)
    )
    from phase1_test_context as context
  ),
  '0:0',
  'Deleting a document cascades to its chunks and messages'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (select user_b_id from phase1_test_context),
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (select count(*) from public.documents),
  1::bigint,
  'Switching the simulated session to User B reveals only User B documents'
);

reset role;

insert into public.documents (
  id, user_id, original_file_name, storage_path, file_size, mime_type, processing_status
)
select
  forbidden_document_id,
  user_b_id,
  file_name_b,
  format('%s/%s.pdf', user_b_id, forbidden_document_id),
  100,
  'application/pdf',
  'uploaded'
from phase1_test_context;

select is(
  (
    select count(distinct id)
    from public.documents
    where user_id = (select user_b_id from phase1_test_context)
      and original_file_name = (select file_name_b from phase1_test_context)
  ),
  2::bigint,
  'Same-user duplicate filenames receive different document IDs'
);

select is(
  (
    select count(distinct storage_path)
    from public.documents
    where user_id = (select user_b_id from phase1_test_context)
      and original_file_name = (select file_name_b from phase1_test_context)
  ),
  2::bigint,
  'Same-user duplicate filenames retain independent Storage paths'
);

select * from finish();
rollback;
