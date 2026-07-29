-- Run after `supabase db reset`:
--   supabase test db supabase/tests/phase3_multi_document.sql

begin;

create extension if not exists pgtap with schema extensions;
select plan(22);

create temporary table phase3_test_context on commit drop as
select
  gen_random_uuid() as user_a_id,
  gen_random_uuid() as user_b_id,
  gen_random_uuid() as document_a1_id,
  gen_random_uuid() as document_a2_id,
  gen_random_uuid() as document_b_id,
  gen_random_uuid() as session_a_id,
  gen_random_uuid() as session_b_id;

grant select on phase3_test_context to authenticated;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select '00000000-0000-0000-0000-000000000000'::uuid, user_a_id, 'authenticated',
  'authenticated', format('phase3-a-%s@studymate.test', user_a_id), '', now(),
  '{}'::jsonb, '{}'::jsonb, now(), now()
from phase3_test_context
union all
select '00000000-0000-0000-0000-000000000000'::uuid, user_b_id, 'authenticated',
  'authenticated', format('phase3-b-%s@studymate.test', user_b_id), '', now(),
  '{}'::jsonb, '{}'::jsonb, now(), now()
from phase3_test_context;

insert into public.documents (
  id, user_id, original_file_name, storage_path, file_size, mime_type,
  processing_status, page_count
)
select document_a1_id, user_a_id, 'astronomy.pdf', format('%s/%s.pdf', user_a_id, document_a1_id),
  100, 'application/pdf', 'ready', 1 from phase3_test_context
union all
select document_a2_id, user_a_id, 'biology.pdf', format('%s/%s.pdf', user_a_id, document_a2_id),
  100, 'application/pdf', 'ready', 2 from phase3_test_context
union all
select document_b_id, user_b_id, 'private.pdf', format('%s/%s.pdf', user_b_id, document_b_id),
  100, 'application/pdf', 'ready', 1 from phase3_test_context;

insert into public.document_chunks (
  document_id, content, page_number, chunk_index, content_hash, embedding_status
)
select document_a1_id, 'Stars release energy through nuclear fusion.', 1, 0,
  md5('a1-energy'), 'failed' from phase3_test_context
union all
select document_a2_id, 'Plants store energy during photosynthesis.', 2, 0,
  md5('a2-energy'), 'failed' from phase3_test_context
union all
select document_b_id, 'Private energy evidence belonging to User B.', 1, 0,
  md5('b-energy'), 'failed' from phase3_test_context;

insert into public.chat_sessions (id, user_id, title, mode)
select session_a_id, user_a_id, 'A comparison', 'comparison' from phase3_test_context
union all
select session_b_id, user_b_id, 'B private session', 'multi_document' from phase3_test_context;

insert into public.chat_session_documents (session_id, document_id, position)
select session_a_id, document_a1_id, 1 from phase3_test_context
union all
select session_a_id, document_a2_id, 2 from phase3_test_context
union all
select session_b_id, document_b_id, 1 from phase3_test_context;

insert into public.messages (
  document_id, chat_session_id, retrieval_mode, selected_document_count, role, content
)
select document_a1_id, session_a_id, 'comparison', 2, 'assistant',
  '{"answer":"grounded","sources":[{"documentName":"biology.pdf","excerpt":"Plants store energy"}]}'
from phase3_test_context
union all
select document_b_id, session_b_id, 'multi_document', 1, 'assistant',
  '{"answer":"private","sources":[{"documentName":"private.pdf","excerpt":"Private energy"}]}'
from phase3_test_context;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object(
  'sub', (select user_a_id from phase3_test_context), 'role', 'authenticated'
)::text, true);

select is((select count(*) from public.chat_sessions), 1::bigint, 'User A reads only User A sessions');
select is((select count(*) from public.chat_session_documents), 2::bigint, 'User A reads only associations in User A sessions');
select is((select count(*) from public.messages), 1::bigint, 'User A reads only messages in User A sessions');
select is((select count(*) from public.chat_sessions where id = (select session_b_id from phase3_test_context)), 0::bigint, 'A guessed foreign session UUID is hidden by RLS');
with affected as (
  update public.chat_sessions set title = 'forbidden'
  where id = (select session_b_id from phase3_test_context)
  returning 1
)
select is((select count(*) from affected), 0::bigint, 'User A cannot rename User B sessions');
with affected as (
  delete from public.chat_sessions
  where id = (select session_b_id from phase3_test_context)
  returning 1
)
select is((select count(*) from affected), 0::bigint, 'User A cannot delete User B sessions');
select ok(not has_table_privilege('authenticated', 'public.chat_sessions', 'INSERT'), 'Browser roles cannot forge chat sessions');
select ok(not has_table_privilege('authenticated', 'public.chat_session_documents', 'INSERT'), 'Browser roles cannot forge session-document associations');
select ok(not has_function_privilege('authenticated', 'public.hybrid_search_multi_document_chunks(uuid[],extensions.vector,text,text,integer,integer[])', 'EXECUTE'), 'Browser roles cannot execute multi-document retrieval');
select ok(has_function_privilege('service_role', 'public.hybrid_search_multi_document_chunks(uuid[],extensions.vector,text,text,integer,integer[])', 'EXECUTE'), 'Service role can execute multi-document retrieval after ownership verification');

reset role;

do $$ begin
  begin
    insert into public.chat_session_documents (session_id, document_id, position)
    select session_a_id, document_b_id, 3 from phase3_test_context;
    raise exception 'cross-owner association unexpectedly succeeded';
  exception when check_violation then null; end;
end $$;
select pass('Database trigger rejects a cross-owner session-document association');

do $$ begin
  begin
    insert into public.chat_session_documents (session_id, document_id, position)
    select session_a_id, gen_random_uuid(), 6 from phase3_test_context;
    raise exception 'sixth position unexpectedly succeeded';
  exception when check_violation then null; end;
end $$;
select pass('Database constraints enforce the five-document maximum');

select is(
  (select count(*) from public.hybrid_search_multi_document_chunks(
    array[(select document_a1_id from phase3_test_context), (select document_a2_id from phase3_test_context)],
    null::extensions.vector(768), 'energy', 'gemini-embedding-2', 8, null
  )),
  2::bigint,
  'Keyword fallback returns bounded candidates from both selected documents'
);

select is(
  (select count(*) from public.hybrid_search_multi_document_chunks(
    array[(select document_a1_id from phase3_test_context), (select document_a2_id from phase3_test_context)],
    null::extensions.vector(768), 'energy', 'gemini-embedding-2', 8, null
  ) where document_id = (select document_b_id from phase3_test_context)),
  0::bigint,
  'Multi-document retrieval never returns an unselected document'
);

select is(
  (select count(*) from public.hybrid_search_multi_document_chunks(
    array[(select document_a1_id from phase3_test_context), (select document_a2_id from phase3_test_context)],
    null::extensions.vector(768), 'energy', 'gemini-embedding-2', 8, array[2]
  ) where document_id = (select document_a2_id from phase3_test_context) and page_number = 2),
  1::bigint,
  'Page filters are applied within each selected document before ranking'
);

select is(
  (select count(*) from public.hybrid_search_multi_document_chunks(
    array[(select document_a1_id from phase3_test_context), (select document_a1_id from phase3_test_context)],
    null::extensions.vector(768), 'energy', 'gemini-embedding-2', 8, null
  )),
  0::bigint,
  'The privileged RPC rejects duplicate document IDs defensively'
);

select is(
  (select count(*) from public.hybrid_search_multi_document_chunks(
    array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()],
    null::extensions.vector(768), 'energy', 'gemini-embedding-2', 8, null
  )),
  0::bigint,
  'The privileged RPC rejects more than five document IDs defensively'
);

with affected as (
  delete from public.documents where id = (select document_a2_id from phase3_test_context)
  returning 1
)
select is((select count(*) from affected), 1::bigint, 'Managed deletion removes a selected document');

select is((select count(*) from public.chat_sessions where id = (select session_a_id from phase3_test_context)), 1::bigint, 'Deleting one selected document preserves the remaining session');
select is((select count(*) from public.chat_session_documents where session_id = (select session_a_id from phase3_test_context)), 1::bigint, 'Deleting one document removes only its session association');
select is((select count(*) from public.messages where chat_session_id = (select session_a_id from phase3_test_context)), 0::bigint, 'Deleting selected content purges session answers and excerpts');

insert into public.messages (document_id, role, content)
select document_b_id, 'user', 'legacy single-document question' from phase3_test_context;

select is(
  (select concat(
    (select count(*) from public.chat_sessions where id = context.document_b_id), ':',
    (select count(*) from public.chat_session_documents where session_id = context.document_b_id), ':',
    (select count(*) from public.messages where document_id = context.document_b_id and chat_session_id = context.document_b_id)
  ) from phase3_test_context as context),
  '1:1:1',
  'Legacy single-document message inserts are normalized into a backward-compatible session'
);

select * from finish();
rollback;
