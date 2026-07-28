-- Run after `supabase db reset`:
--   supabase test db supabase/tests/phase2_hybrid_search.sql

begin;

create extension if not exists pgtap with schema extensions;
select plan(12);

select has_extension('vector', 'pgvector is installed');

select is(
  (
    select format_type(attribute.atttypid, attribute.atttypmod)
    from pg_attribute as attribute
    where attribute.attrelid = 'public.document_chunks'::regclass
      and attribute.attname = 'embedding'
  ),
  'vector(768)',
  'document chunk embeddings use 768 dimensions'
);

create temporary table phase2_test_context on commit drop as
select
  gen_random_uuid() as user_a_id,
  gen_random_uuid() as user_b_id,
  gen_random_uuid() as document_a_id,
  gen_random_uuid() as document_b_id;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  '00000000-0000-0000-0000-000000000000'::uuid,
  user_a_id,
  'authenticated',
  'authenticated',
  format('phase2-a-%s@studymate.test', user_a_id),
  '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
from phase2_test_context
union all
select
  '00000000-0000-0000-0000-000000000000'::uuid,
  user_b_id,
  'authenticated',
  'authenticated',
  format('phase2-b-%s@studymate.test', user_b_id),
  '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
from phase2_test_context;

insert into public.documents (
  id, user_id, original_file_name, storage_path, file_size, mime_type,
  processing_status, page_count
)
select
  document_a_id, user_a_id, 'astronomy.pdf',
  format('%s/%s.pdf', user_a_id, document_a_id), 100,
  'application/pdf', 'ready', 3
from phase2_test_context
union all
select
  document_b_id, user_b_id, 'biology.pdf',
  format('%s/%s.pdf', user_b_id, document_b_id), 100,
  'application/pdf', 'ready', 1
from phase2_test_context;

insert into public.document_chunks (
  document_id, content, page_number, chunk_index, content_hash,
  embedding, embedding_status, embedding_model, embedded_at
)
select
  document_a_id,
  'Stars release energy through stellar fusion in their cores.',
  1,
  0,
  md5('astronomy-fusion'),
  (array[1::real] || array_fill(0::real, array[767]))::extensions.vector(768),
  'ready',
  'gemini-embedding-2',
  now()
from phase2_test_context
union all
select
  document_a_id,
  'Plants convert light energy into chemical energy during photosynthesis.',
  2,
  0,
  md5('plant-energy'),
  (array[0::real, 1::real] || array_fill(0::real, array[766]))::extensions.vector(768),
  'ready',
  'gemini-embedding-2',
  now()
from phase2_test_context
union all
select
  document_a_id,
  'Orbital motion is governed by gravity.',
  3,
  0,
  md5('orbital-gravity'),
  null,
  'failed',
  'gemini-embedding-2',
  null
from phase2_test_context
union all
select
  document_a_id,
  'A legacy vector from an incompatible embedding space.',
  3,
  1,
  md5('legacy-vector'),
  (array[0::real, 0::real, 1::real] || array_fill(0::real, array[765]))::extensions.vector(768),
  'ready',
  'gemini-embedding-001',
  now()
from phase2_test_context
union all
select
  document_b_id,
  'Stars and stellar fusion appear in another user document.',
  1,
  0,
  md5('other-user-stars'),
  (array[1::real] || array_fill(0::real, array[767]))::extensions.vector(768),
  'ready',
  'gemini-embedding-2',
  now()
from phase2_test_context;

select is(
  (
    select count(*)
    from public.hybrid_search_document_chunks(
      (select document_a_id from phase2_test_context),
      (array[1::real] || array_fill(0::real, array[767]))::extensions.vector(768),
      'stellar fusion', null, 20, 1, 1
    )
  ),
  1::bigint,
  'Hybrid search returns matching semantic and keyword candidates from the selected document'
);

select is(
  (
    select count(*)
    from public.hybrid_search_document_chunks(
      (select document_a_id from phase2_test_context),
      (array[1::real] || array_fill(0::real, array[767]))::extensions.vector(768),
      'stellar fusion', null, 20, 1, 1
    ) as results
    where results.document_id <> (select document_a_id from phase2_test_context)
  ),
  0::bigint,
  'Hybrid search never returns another document'
);

select is(
  (
    select count(*)
    from public.hybrid_search_document_chunks(
      (select document_a_id from phase2_test_context),
      (array[0::real, 1::real] || array_fill(0::real, array[766]))::extensions.vector(768),
      'energy', array[2], 20, 1, 1
    ) as results
    where results.page_number <> 2
  ),
  0::bigint,
  'Requested pages constrain semantic and keyword candidates'
);

select is(
  (
    select page_number
    from public.hybrid_search_document_chunks(
      (select document_a_id from phase2_test_context),
      (array[0::real, 1::real] || array_fill(0::real, array[766]))::extensions.vector(768),
      'indirect description', null, 1, 1, 0
    )
  ),
  2,
  'Semantic ranking retrieves paraphrased meaning without an exact phrase'
);

select is(
  (
    select page_number
    from public.hybrid_search_document_chunks(
      (select document_a_id from phase2_test_context),
      (array[1::real] || array_fill(0::real, array[767]))::extensions.vector(768),
      'orbital motion', null, 20, 0, 1
    )
    limit 1
  ),
  3,
  'Keyword retrieval includes chunks whose embeddings are missing or failed'
);

select is(
  (
    select count(*)
    from public.hybrid_search_document_chunks(
      (select document_a_id from phase2_test_context),
      (array[0::real, 0::real, 1::real] || array_fill(0::real, array[765]))::extensions.vector(768),
      'quantum entanglement', null, 20, 1, 1
    )
  ),
  0::bigint,
  'Unsupported topics return no hybrid candidates'
);

select is(
  (
    select count(*)
    from public.hybrid_search_document_chunks(
      (select document_a_id from phase2_test_context),
      (array[0::real, 0::real, 1::real] || array_fill(0::real, array[765]))::extensions.vector(768),
      'no keyword match', null, 20, 1, 0, 'gemini-embedding-2'
    )
  ),
  0::bigint,
  'Hybrid search never compares query vectors with a different stored embedding model'
);

select ok(
  (
    select semantic_score is not null and combined_score is not null
    from public.hybrid_search_document_chunks(
      (select document_a_id from phase2_test_context),
      (array[1::real] || array_fill(0::real, array[767]))::extensions.vector(768),
      'stellar fusion', null, 1, 1, 1
    )
  ),
  'Hybrid search returns semantic and combined scores'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.hybrid_search_document_chunks(uuid,extensions.vector,text,integer[],integer,real,real,text)',
    'EXECUTE'
  ),
  'Authenticated browser clients cannot call hybrid search directly'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.hybrid_search_document_chunks(uuid,extensions.vector,text,integer[],integer,real,real,text)',
    'EXECUTE'
  ),
  'The server-side service role can call hybrid search'
);

select * from finish();
rollback;
