-- Phase 3.5: synchronous processing recovery, durable abuse controls, and
-- idempotent chat persistence. All privileged functions are service-role-only.

alter table public.documents
  add column processing_started_at timestamptz,
  add column processing_lease_id uuid,
  add column processing_attempt_count integer not null default 0,
  add column processing_heartbeat_at timestamptz;

update public.documents
set
  processing_started_at = coalesce(processing_started_at, created_at),
  processing_lease_id = coalesce(processing_lease_id, gen_random_uuid()),
  processing_attempt_count = greatest(processing_attempt_count, 1),
  processing_heartbeat_at = coalesce(processing_heartbeat_at, created_at)
where processing_status = 'processing';

alter table public.documents
  add constraint documents_processing_attempt_count_check
    check (processing_attempt_count >= 0),
  add constraint documents_processing_lease_state_check
    check (
      (
        processing_status = 'processing'
        and processing_started_at is not null
        and processing_lease_id is not null
        and processing_heartbeat_at is not null
      )
      or (
        processing_status <> 'processing'
        and processing_lease_id is null
        and processing_heartbeat_at is null
      )
    );

create unique index documents_processing_lease_id_idx
  on public.documents (processing_lease_id)
  where processing_lease_id is not null;

create index documents_active_processing_idx
  on public.documents (user_id, processing_heartbeat_at)
  where processing_status = 'processing';

create table public.rate_limit_buckets (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation text not null check (
    operation in (
      'upload_register',
      'process_document',
      'embedding_backfill',
      'chat',
      'complete_summary',
      'delete_document',
      'session_create'
    )
  ),
  window_kind text not null check (window_kind in ('minute', 'hour')),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, operation, window_kind, window_started_at)
);

alter table public.rate_limit_buckets enable row level security;
alter table public.rate_limit_buckets force row level security;
revoke all on table public.rate_limit_buckets from public, anon, authenticated;

create or replace function public.consume_user_rate_limit(
  target_user_id uuid,
  target_operation text,
  minute_limit integer,
  hour_limit integer
)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  current_time timestamptz := timezone('utc', clock_timestamp());
  minute_start timestamptz;
  hour_start timestamptz;
  minute_count integer;
  hour_count integer;
  retry_seconds integer := 0;
begin
  if target_user_id is null
    or target_operation not in (
      'upload_register', 'process_document', 'embedding_backfill', 'chat',
      'complete_summary', 'delete_document', 'session_create'
    )
    or minute_limit < 1 or hour_limit < 1
  then
    raise exception 'invalid rate-limit request' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(target_user_id::text || ':' || target_operation, 0)
  );

  minute_start := to_timestamp(
    floor(extract(epoch from current_time) / 60) * 60
  );
  hour_start := to_timestamp(
    floor(extract(epoch from current_time) / 3600) * 3600
  );

  select coalesce(max(request_count), 0) into minute_count
  from public.rate_limit_buckets
  where user_id = target_user_id
    and operation = target_operation
    and window_kind = 'minute'
    and window_started_at = minute_start;

  select coalesce(max(request_count), 0) into hour_count
  from public.rate_limit_buckets
  where user_id = target_user_id
    and operation = target_operation
    and window_kind = 'hour'
    and window_started_at = hour_start;

  if minute_count >= minute_limit then
    retry_seconds := greatest(
      retry_seconds,
      ceil(extract(epoch from minute_start + interval '1 minute' - current_time))::integer
    );
  end if;

  if hour_count >= hour_limit then
    retry_seconds := greatest(
      retry_seconds,
      ceil(extract(epoch from hour_start + interval '1 hour' - current_time))::integer
    );
  end if;

  if retry_seconds > 0 then
    return query select false, least(greatest(retry_seconds, 1), 3600);
    return;
  end if;

  insert into public.rate_limit_buckets as buckets (
    user_id, operation, window_kind, window_started_at, request_count, updated_at
  ) values
    (target_user_id, target_operation, 'minute', minute_start, 1, current_time),
    (target_user_id, target_operation, 'hour', hour_start, 1, current_time)
  on conflict (user_id, operation, window_kind, window_started_at)
  do update set
    request_count = buckets.request_count + 1,
    updated_at = excluded.updated_at;

  delete from public.rate_limit_buckets
  where user_id = target_user_id
    and operation = target_operation
    and window_started_at < hour_start - interval '2 hours';

  return query select true, 0;
end;
$$;

revoke all on function public.consume_user_rate_limit(uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_user_rate_limit(uuid, text, integer, integer)
  to service_role;

create or replace function public.claim_document_processing(
  target_document_id uuid,
  target_user_id uuid,
  requested_lease_id uuid,
  stale_after_seconds integer default 900,
  maximum_active_jobs integer default 2,
  retry_delay_seconds integer default 60
)
returns table (
  claim_status text,
  recovered_stale_lease boolean,
  retry_after_seconds integer,
  processing_attempt_count integer
)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  candidate public.documents%rowtype;
  current_time timestamptz := timezone('utc', clock_timestamp());
  active_jobs integer;
  remaining integer;
begin
  if requested_lease_id is null
    or stale_after_seconds < 600 or stale_after_seconds > 1800
    or maximum_active_jobs < 1 or maximum_active_jobs > 5
    or retry_delay_seconds < 1 or retry_delay_seconds > 3600
  then
    raise exception 'invalid processing claim request' using errcode = '22023';
  end if;

  select * into candidate
  from public.documents
  where id = target_document_id and user_id = target_user_id
  for update;

  if not found then
    return query select 'not_found'::text, false, 0, 0;
    return;
  end if;

  if candidate.processing_status = 'processing'
    and candidate.processing_heartbeat_at > current_time - make_interval(secs => stale_after_seconds)
  then
    remaining := ceil(extract(epoch from (
      candidate.processing_heartbeat_at + make_interval(secs => stale_after_seconds) - current_time
    )))::integer;
    return query select
      'active'::text,
      false,
      least(greatest(remaining, 1), stale_after_seconds),
      candidate.processing_attempt_count;
    return;
  end if;

  if candidate.processing_status not in ('uploaded', 'failed', 'processing') then
    return query select 'ineligible'::text, false, 0, candidate.processing_attempt_count;
    return;
  end if;

  if candidate.processing_status = 'failed'
    and candidate.processing_started_at > current_time - make_interval(secs => retry_delay_seconds)
  then
    remaining := ceil(extract(epoch from (
      candidate.processing_started_at + make_interval(secs => retry_delay_seconds) - current_time
    )))::integer;
    return query select
      'retry_later'::text,
      false,
      least(greatest(remaining, 1), retry_delay_seconds),
      candidate.processing_attempt_count;
    return;
  end if;

  select count(*)::integer into active_jobs
  from public.documents
  where user_id = target_user_id
    and id <> target_document_id
    and processing_status = 'processing'
    and processing_heartbeat_at > current_time - make_interval(secs => stale_after_seconds);

  if active_jobs >= maximum_active_jobs then
    return query select
      'too_many_active'::text,
      false,
      60,
      candidate.processing_attempt_count;
    return;
  end if;

  update public.documents as claimed_documents
  set
    processing_status = 'processing',
    processing_error = null,
    page_count = null,
    processing_started_at = current_time,
    processing_lease_id = requested_lease_id,
    processing_heartbeat_at = current_time,
    processing_attempt_count = claimed_documents.processing_attempt_count + 1
  where id = target_document_id and user_id = target_user_id;

  return query select
    'claimed'::text,
    candidate.processing_status = 'processing',
    0,
    candidate.processing_attempt_count + 1;
end;
$$;

revoke all on function public.claim_document_processing(uuid, uuid, uuid, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_document_processing(uuid, uuid, uuid, integer, integer, integer)
  to service_role;

create or replace function public.heartbeat_document_processing(
  target_document_id uuid,
  target_user_id uuid,
  target_lease_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  update public.documents
  set processing_heartbeat_at = timezone('utc', clock_timestamp())
  where id = target_document_id
    and user_id = target_user_id
    and processing_status = 'processing'
    and processing_lease_id = target_lease_id
  ;
  return found;
end;
$$;

revoke all on function public.heartbeat_document_processing(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.heartbeat_document_processing(uuid, uuid, uuid)
  to service_role;

create or replace function public.complete_document_extraction(
  target_document_id uuid,
  target_user_id uuid,
  target_lease_id uuid,
  extracted_page_count integer,
  extracted_character_count integer,
  extracted_chunks jsonb
)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  inserted_count integer;
begin
  if extracted_page_count < 1 or extracted_page_count > 500 then
    raise exception 'page count is outside the synchronous limit' using errcode = '22023';
  end if;
  if extracted_character_count < 1 or extracted_character_count > 2000000 then
    raise exception 'extracted text is outside the synchronous limit' using errcode = '22023';
  end if;
  if jsonb_typeof(extracted_chunks) <> 'array'
    or jsonb_array_length(extracted_chunks) < 1
    or jsonb_array_length(extracted_chunks) > 2500
  then
    raise exception 'chunk count is outside the synchronous limit' using errcode = '22023';
  end if;

  perform 1 from public.documents
  where id = target_document_id
    and user_id = target_user_id
    and processing_status = 'processing'
    and processing_lease_id = target_lease_id
  for update;
  if not found then
    raise exception 'processing lease is no longer active' using errcode = '40001';
  end if;

  delete from public.document_chunks where document_id = target_document_id;

  insert into public.document_chunks (
    document_id, content, page_number, chunk_index, content_hash, embedding_status
  )
  select
    target_document_id,
    rows.content,
    rows.page_number,
    rows.chunk_index,
    rows.content_hash,
    'pending'
  from jsonb_to_recordset(extracted_chunks) as rows(
    content text,
    page_number integer,
    chunk_index integer,
    content_hash text
  )
  order by rows.page_number, rows.chunk_index;

  get diagnostics inserted_count = row_count;
  if inserted_count <> jsonb_array_length(extracted_chunks) then
    raise exception 'not every extracted chunk was saved' using errcode = '40001';
  end if;

  update public.documents
  set
    processing_status = 'ready',
    processing_error = null,
    page_count = extracted_page_count,
    processing_lease_id = null,
    processing_heartbeat_at = null
  where id = target_document_id
    and user_id = target_user_id
    and processing_lease_id = target_lease_id;

  return inserted_count;
end;
$$;

revoke all on function public.complete_document_extraction(uuid, uuid, uuid, integer, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_document_extraction(uuid, uuid, uuid, integer, integer, jsonb)
  to service_role;

create or replace function public.fail_document_processing(
  target_document_id uuid,
  target_user_id uuid,
  target_lease_id uuid,
  safe_failure_reason text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if safe_failure_reason is null
    or length(safe_failure_reason) < 1
    or length(safe_failure_reason) > 300
    or safe_failure_reason ~ '[[:cntrl:]]'
  then
    raise exception 'invalid safe processing failure' using errcode = '22023';
  end if;

  update public.documents
  set
    processing_status = 'failed',
    processing_error = safe_failure_reason,
    page_count = null,
    processing_lease_id = null,
    processing_heartbeat_at = null
  where id = target_document_id
    and user_id = target_user_id
    and processing_status = 'processing'
    and processing_lease_id = target_lease_id;
  return found;
end;
$$;

revoke all on function public.fail_document_processing(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_document_processing(uuid, uuid, uuid, text)
  to service_role;

-- Registration is now server-managed after Storage has been verified by the
-- register-document function. This closes browser-only metadata registration.
revoke insert on table public.documents from authenticated;
drop policy if exists "Users can insert own uploaded documents" on public.documents;

create or replace function public.register_uploaded_document(
  target_document_id uuid,
  target_user_id uuid,
  target_original_file_name text,
  target_storage_path text,
  verified_file_size bigint,
  verified_mime_type text,
  maximum_pending_documents integer default 10
)
returns public.documents
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  pending_count integer;
  inserted public.documents%rowtype;
begin
  if target_document_id is null or target_user_id is null
    or target_storage_path <> (target_user_id::text || '/' || target_document_id::text || '.pdf')
    or verified_file_size < 1 or verified_file_size > 20971520
    or verified_mime_type <> 'application/pdf'
    or target_original_file_name <> trim(target_original_file_name)
    or length(target_original_file_name) < 1
    or length(target_original_file_name) > 255
    or target_original_file_name ~ '[[:cntrl:]]'
    or maximum_pending_documents < 1 or maximum_pending_documents > 50
  then
    raise exception 'invalid uploaded document registration' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text || ':uploads', 0));
  select count(*)::integer into pending_count
  from public.documents
  where user_id = target_user_id
    and processing_status in ('uploaded', 'processing');
  if pending_count >= maximum_pending_documents then
    raise exception 'too many pending uploaded documents' using errcode = 'P0001';
  end if;

  insert into public.documents (
    id, user_id, original_file_name, storage_path, file_size, mime_type,
    processing_status
  ) values (
    target_document_id, target_user_id, target_original_file_name,
    target_storage_path, verified_file_size, verified_mime_type, 'uploaded'
  ) returning * into inserted;
  return inserted;
end;
$$;

revoke all on function public.register_uploaded_document(uuid, uuid, text, text, bigint, text, integer)
  from public, anon, authenticated;
grant execute on function public.register_uploaded_document(uuid, uuid, text, text, bigint, text, integer)
  to service_role;

alter table public.messages add column request_id uuid;
create unique index messages_request_pair_idx
  on public.messages (chat_session_id, request_id, role)
  where request_id is not null;

create or replace function public.persist_chat_message_pair(
  target_user_id uuid,
  target_session_id uuid,
  target_document_id uuid,
  target_retrieval_mode text,
  target_document_count integer,
  target_request_id uuid,
  user_content text,
  assistant_content text
)
returns table (user_message_id uuid, assistant_message_id uuid, already_saved boolean)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  session_owner uuid;
  document_title text;
  existing_user_id uuid;
  existing_assistant_id uuid;
begin
  if target_request_id is null
    or target_retrieval_mode not in ('single_document', 'multi_document', 'comparison')
    or target_document_count < 1 or target_document_count > 5
    or length(trim(user_content)) < 1 or length(trim(user_content)) > 1000
    or length(trim(assistant_content)) < 1
  then
    raise exception 'invalid chat message pair' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_session_id::text || ':' || target_request_id::text, 0));

  select user_id into session_owner
  from public.chat_sessions where id = target_session_id;

  if session_owner is null and target_retrieval_mode = 'single_document'
    and target_session_id = target_document_id
  then
    select left(coalesce(
      nullif(regexp_replace(trim(coalesce(display_name, original_file_name)), '[[:cntrl:]]', '', 'g'), ''),
      'Untitled document'
    ), 150)
    into document_title
    from public.documents
    where id = target_document_id
      and user_id = target_user_id
      and processing_status = 'ready';
    if document_title is null then
      raise exception 'chat target is unavailable' using errcode = 'P0002';
    end if;
    insert into public.chat_sessions (id, user_id, title, mode)
    values (target_session_id, target_user_id, document_title, 'single_document')
    on conflict (id) do nothing;
    insert into public.chat_session_documents (session_id, document_id, position)
    values (target_session_id, target_document_id, 1)
    on conflict (session_id, document_id) do nothing;
    session_owner := target_user_id;
  end if;

  if session_owner is null or session_owner <> target_user_id then
    raise exception 'chat target is unavailable' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.chat_session_documents
    where session_id = target_session_id and document_id = target_document_id
  ) then
    raise exception 'chat target is unavailable' using errcode = 'P0002';
  end if;

  select id into existing_user_id from public.messages
  where chat_session_id = target_session_id and request_id = target_request_id and role = 'user';
  select id into existing_assistant_id from public.messages
  where chat_session_id = target_session_id and request_id = target_request_id and role = 'assistant';

  if existing_user_id is not null or existing_assistant_id is not null then
    if existing_user_id is null or existing_assistant_id is null then
      raise exception 'incomplete persisted message pair' using errcode = '40001';
    end if;
    return query select existing_user_id, existing_assistant_id, true;
    return;
  end if;

  insert into public.messages (
    document_id, chat_session_id, retrieval_mode, selected_document_count,
    request_id, role, content
  ) values (
    target_document_id, target_session_id, target_retrieval_mode,
    target_document_count, target_request_id, 'user', user_content
  ) returning id into existing_user_id;

  insert into public.messages (
    document_id, chat_session_id, retrieval_mode, selected_document_count,
    request_id, role, content
  ) values (
    target_document_id, target_session_id, target_retrieval_mode,
    target_document_count, target_request_id, 'assistant', assistant_content
  ) returning id into existing_assistant_id;

  return query select existing_user_id, existing_assistant_id, false;
end;
$$;

revoke all on function public.persist_chat_message_pair(uuid, uuid, uuid, text, integer, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.persist_chat_message_pair(uuid, uuid, uuid, text, integer, uuid, text, text)
  to service_role;

-- Expose safe retry metadata to the owner without exposing lease identifiers.
drop function public.list_user_documents();
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
  processing_started_at timestamptz,
  processing_attempt_count integer,
  chunk_count bigint,
  embedded_chunk_count bigint,
  embedding_status text,
  embedding_model text,
  embedding_error text,
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
    documents.processing_started_at,
    documents.processing_attempt_count,
    coalesce(chunk_totals.chunk_count, 0)::bigint,
    coalesce(chunk_totals.embedded_chunk_count, 0)::bigint,
    case
      when coalesce(chunk_totals.chunk_count, 0) = 0 then 'not_started'
      when coalesce(chunk_totals.embedded_chunk_count, 0) = coalesce(chunk_totals.chunk_count, 0) then 'ready'
      when coalesce(chunk_totals.failed_chunk_count, 0) > 0 then 'failed'
      when coalesce(chunk_totals.processing_chunk_count, 0) > 0 then 'processing'
      else 'pending'
    end,
    chunk_totals.embedding_model,
    chunk_totals.embedding_error,
    coalesce(message_totals.message_count, 0)::bigint,
    documents.created_at
  from public.documents
  left join (
    select
      document_id,
      count(*)::bigint as chunk_count,
      count(*) filter (where embedding_status = 'ready')::bigint as embedded_chunk_count,
      count(*) filter (where embedding_status = 'failed')::bigint as failed_chunk_count,
      count(*) filter (where embedding_status = 'processing')::bigint as processing_chunk_count,
      max(embedding_model) filter (where embedding_model is not null) as embedding_model,
      max(embedding_error) filter (where embedding_error is not null) as embedding_error
    from public.document_chunks group by document_id
  ) as chunk_totals on chunk_totals.document_id = documents.id
  left join (
    select document_id, count(*)::bigint as message_count
    from public.messages where document_id is not null group by document_id
  ) as message_totals on message_totals.document_id = documents.id
  where documents.user_id = (select auth.uid())
  order by documents.created_at desc;
$$;

revoke all on function public.list_user_documents() from public, anon;
grant execute on function public.list_user_documents() to authenticated;
