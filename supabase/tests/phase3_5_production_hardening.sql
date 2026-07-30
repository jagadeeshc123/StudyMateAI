-- Run after `supabase db reset`:
--   supabase test db supabase/tests/phase3_5_production_hardening.sql

begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

create temporary table phase35_context on commit drop as
select
  gen_random_uuid() as user_a_id,
  gen_random_uuid() as user_b_id,
  gen_random_uuid() as document_a_id,
  gen_random_uuid() as document_b_id,
  gen_random_uuid() as document_c_id,
  gen_random_uuid() as document_d_id,
  gen_random_uuid() as document_e_id,
  gen_random_uuid() as document_f_id,
  gen_random_uuid() as first_lease_id,
  gen_random_uuid() as recovered_lease_id,
  gen_random_uuid() as request_id;

grant select on phase35_context to authenticated;

select alike(
  pg_get_functiondef(
    'public.claim_document_processing(uuid,uuid,uuid,integer,integer,integer)'::regprocedure
  ),
  '%:processing-jobs%',
  'Processing capacity claims are serialized per user'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select '00000000-0000-0000-0000-000000000000'::uuid, user_a_id, 'authenticated',
  'authenticated', format('phase35-a-%s@studymate.test', user_a_id), '', now(),
  '{}'::jsonb, '{}'::jsonb, now(), now() from phase35_context
union all
select '00000000-0000-0000-0000-000000000000'::uuid, user_b_id, 'authenticated',
  'authenticated', format('phase35-b-%s@studymate.test', user_b_id), '', now(),
  '{}'::jsonb, '{}'::jsonb, now(), now() from phase35_context;

insert into public.documents (
  id, user_id, original_file_name, storage_path, file_size, mime_type,
  processing_status
)
select document_a_id, user_a_id, 'a.pdf', format('%s/%s.pdf', user_a_id, document_a_id),
  100, 'application/pdf', 'uploaded' from phase35_context
union all
select document_b_id, user_b_id, 'b.pdf', format('%s/%s.pdf', user_b_id, document_b_id),
  100, 'application/pdf', 'uploaded' from phase35_context;

select is(
  (select claim_status from public.claim_document_processing(
    (select document_a_id from phase35_context),
    (select user_a_id from phase35_context),
    (select first_lease_id from phase35_context), 900, 2, 60
  )),
  'claimed',
  'An owner can atomically claim uploaded document processing'
);

select is(
  (select processing_attempt_count from public.documents
    where id = (select document_a_id from phase35_context)),
  1,
  'A successful claim increments the processing attempt count'
);

select is(
  (select claim_status from public.claim_document_processing(
    (select document_a_id from phase35_context),
    (select user_b_id from phase35_context),
    gen_random_uuid(), 900, 2, 60
  )),
  'not_found',
  'A foreign processing claim is indistinguishable from a missing document'
);

select is(
  (select claim_status from public.claim_document_processing(
    (select document_a_id from phase35_context),
    (select user_a_id from phase35_context),
    gen_random_uuid(), 900, 2, 60
  )),
  'active',
  'A healthy lease rejects a concurrent worker'
);

select ok(
  (select retry_after_seconds > 0 from public.claim_document_processing(
    (select document_a_id from phase35_context),
    (select user_a_id from phase35_context),
    gen_random_uuid(), 900, 2, 60
  )),
  'Active lease rejection returns a safe retry-after value'
);

update public.documents set processing_heartbeat_at = now() - interval '16 minutes'
where id = (select document_a_id from phase35_context);

select is(
  (select claim_status || ':' || recovered_stale_lease::text
    from public.claim_document_processing(
      (select document_a_id from phase35_context),
      (select user_a_id from phase35_context),
      (select recovered_lease_id from phase35_context), 900, 2, 60
    )),
  'claimed:true',
  'A stale owner-scoped lease is reclaimed'
);

select is(
  public.heartbeat_document_processing(
    (select document_a_id from phase35_context),
    (select user_a_id from phase35_context),
    (select first_lease_id from phase35_context)
  ),
  false,
  'The stale worker cannot refresh its replaced lease'
);

select is(
  public.heartbeat_document_processing(
    (select document_a_id from phase35_context),
    (select user_a_id from phase35_context),
    (select recovered_lease_id from phase35_context)
  ),
  true,
  'The replacement worker can refresh its lease'
);

select is(
  public.complete_document_extraction(
    (select document_a_id from phase35_context),
    (select user_a_id from phase35_context),
    (select recovered_lease_id from phase35_context),
    2,
    31,
    '[{"content":"First page evidence.","page_number":1,"chunk_index":0,"content_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"content":"Second page evidence.","page_number":2,"chunk_index":0,"content_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]'::jsonb
  ),
  2,
  'Extraction completion replaces chunks in one transaction'
);

select is(
  (select processing_status || ':' || page_count::text from public.documents
   where id = (select document_a_id from phase35_context)),
  'ready:2',
  'Atomic completion marks the document ready with its page count'
);

select is(
  (select count(*) from public.document_chunks
   where document_id = (select document_a_id from phase35_context)),
  2::bigint,
  'Atomic completion creates no duplicate chunks'
);

select is(
  (select string_agg(content, ',' order by page_number, chunk_index)
   from public.document_chunks
   where document_id = (select document_a_id from phase35_context)),
  'First page evidence.,Second page evidence.',
  'Atomic completion preserves page order'
);

select is(
  (select claim_status from public.claim_document_processing(
    (select document_a_id from phase35_context),
    (select user_a_id from phase35_context),
    gen_random_uuid(), 900, 2, 60
  )),
  'ineligible',
  'A ready document cannot be reclaimed'
);

select is(
  (select claim_status from public.claim_document_processing(
    gen_random_uuid(), (select user_a_id from phase35_context),
    gen_random_uuid(), 900, 2, 60
  )),
  'not_found',
  'A missing document uses the same safe claim result as a foreign document'
);

insert into public.documents (
  id, user_id, original_file_name, storage_path, file_size, mime_type,
  processing_status, processing_started_at
)
select document_c_id, user_a_id, 'retry.pdf',
  format('%s/%s.pdf', user_a_id, document_c_id), 100, 'application/pdf',
  'failed', now()
from phase35_context;

select is(
  (select claim_status from public.claim_document_processing(
    (select document_c_id from phase35_context),
    (select user_a_id from phase35_context),
    gen_random_uuid(), 900, 2, 60
  )),
  'retry_later',
  'A recently failed document observes the retry delay'
);

insert into public.documents (
  id, user_id, original_file_name, storage_path, file_size, mime_type,
  processing_status
)
select document_d_id, user_a_id, 'active-one.pdf',
  format('%s/%s.pdf', user_a_id, document_d_id), 100, 'application/pdf', 'uploaded'
from phase35_context
union all
select document_e_id, user_a_id, 'active-two.pdf',
  format('%s/%s.pdf', user_a_id, document_e_id), 100, 'application/pdf', 'uploaded'
from phase35_context
union all
select document_f_id, user_a_id, 'active-three.pdf',
  format('%s/%s.pdf', user_a_id, document_f_id), 100, 'application/pdf', 'uploaded'
from phase35_context;

select is(
  (select claim_status from public.claim_document_processing(
    (select document_d_id from phase35_context),
    (select user_a_id from phase35_context),
    gen_random_uuid(), 900, 2, 60
  )),
  'claimed',
  'The first active processing slot can be claimed'
);

select is(
  (select claim_status from public.claim_document_processing(
    (select document_e_id from phase35_context),
    (select user_a_id from phase35_context),
    gen_random_uuid(), 900, 2, 60
  )),
  'claimed',
  'The second active processing slot can be claimed'
);

select is(
  (select claim_status from public.claim_document_processing(
    (select document_f_id from phase35_context),
    (select user_a_id from phase35_context),
    gen_random_uuid(), 900, 2, 60
  )),
  'too_many_active',
  'A third healthy processing job is rejected'
);

select is(
  (select allowed from public.consume_user_rate_limit(
    (select user_a_id from phase35_context), 'chat', 2, 10
  )), true, 'A request below the rate limit is allowed'
);
select is(
  (select allowed from public.consume_user_rate_limit(
    (select user_a_id from phase35_context), 'chat', 2, 10
  )), true, 'A request exactly at the rate limit is allowed'
);
select is(
  (select allowed from public.consume_user_rate_limit(
    (select user_a_id from phase35_context), 'chat', 2, 10
  )), false, 'A request above the rate limit is rejected'
);
select ok(
  (select retry_after_seconds between 1 and 3600 from public.consume_user_rate_limit(
    (select user_a_id from phase35_context), 'chat', 2, 10
  )), 'A rate rejection includes a bounded retry-after value'
);
select is(
  (select allowed from public.consume_user_rate_limit(
    (select user_b_id from phase35_context), 'chat', 2, 10
  )), true, 'Another user has an independent rate limit'
);
select is(
  (select allowed from public.consume_user_rate_limit(
    (select user_a_id from phase35_context), 'complete_summary', 1, 1
  )), true, 'Summary limits use an independent operation bucket'
);

insert into public.chat_sessions (id, user_id, title, mode)
select document_a_id, user_a_id, 'a.pdf', 'single_document' from phase35_context;
insert into public.chat_session_documents (session_id, document_id, position)
select document_a_id, document_a_id, 1 from phase35_context;

select is(
  (select already_saved from public.persist_chat_message_pair(
    (select user_a_id from phase35_context),
    (select document_a_id from phase35_context),
    (select document_a_id from phase35_context),
    'single_document', 1, (select request_id from phase35_context),
    'What is covered?', '{"answer":"Two pages","sources":[]}'
  )), false, 'A message pair is saved transactionally on first submission'
);
select is(
  (select count(*) from public.messages
   where request_id = (select request_id from phase35_context)),
  2::bigint,
  'Transactional persistence creates exactly one user/assistant pair'
);
select is(
  (select already_saved from public.persist_chat_message_pair(
    (select user_a_id from phase35_context),
    (select document_a_id from phase35_context),
    (select document_a_id from phase35_context),
    'single_document', 1, (select request_id from phase35_context),
    'What is covered?', '{"answer":"Two pages","sources":[]}'
  )), true, 'Retrying the same request ID is idempotent'
);
select is(
  (select count(*) from public.messages
   where request_id = (select request_id from phase35_context)),
  2::bigint,
  'An idempotent retry does not duplicate the pair'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object(
  'sub', (select user_a_id from phase35_context), 'role', 'authenticated'
)::text, true);

select is(
  has_table_privilege('authenticated', 'public.rate_limit_buckets', 'select'),
  false,
  'Browser roles cannot inspect rate-limit state'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.consume_user_rate_limit(uuid,text,integer,integer)',
    'execute'
  ),
  false,
  'Browser roles cannot bypass rate-limit RPCs'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.claim_document_processing(uuid,uuid,uuid,integer,integer,integer)',
    'execute'
  ),
  false,
  'Browser roles cannot claim or modify processing leases'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.persist_chat_message_pair(uuid,uuid,uuid,text,integer,uuid,text,text)',
    'execute'
  ),
  false,
  'Browser roles cannot call privileged message persistence directly'
);

select * from finish();
rollback;
