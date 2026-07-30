-- Phase 3.5 release correction: avoid PostgreSQL's reserved CURRENT_TIME
-- identifier in PL/pgSQL expressions. The previous functions compiled, but
-- plpgsql_check resolved the identifier as time with time zone instead of the
-- intended timestamptz variable.

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
  request_time timestamptz := timezone('utc', clock_timestamp());
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
    floor(extract(epoch from request_time) / 60) * 60
  );
  hour_start := to_timestamp(
    floor(extract(epoch from request_time) / 3600) * 3600
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
      ceil(extract(epoch from minute_start + interval '1 minute' - request_time))::integer
    );
  end if;

  if hour_count >= hour_limit then
    retry_seconds := greatest(
      retry_seconds,
      ceil(extract(epoch from hour_start + interval '1 hour' - request_time))::integer
    );
  end if;

  if retry_seconds > 0 then
    return query select false, least(greatest(retry_seconds, 1), 3600);
    return;
  end if;

  insert into public.rate_limit_buckets as buckets (
    user_id, operation, window_kind, window_started_at, request_count, updated_at
  ) values
    (target_user_id, target_operation, 'minute', minute_start, 1, request_time),
    (target_user_id, target_operation, 'hour', hour_start, 1, request_time)
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
  request_time timestamptz := timezone('utc', clock_timestamp());
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

  perform pg_advisory_xact_lock(
    hashtextextended(target_user_id::text || ':processing-jobs', 0)
  );

  select * into candidate
  from public.documents
  where id = target_document_id and user_id = target_user_id
  for update;

  if not found then
    return query select 'not_found'::text, false, 0, 0;
    return;
  end if;

  if candidate.processing_status = 'processing'
    and candidate.processing_heartbeat_at > request_time - make_interval(secs => stale_after_seconds)
  then
    remaining := ceil(extract(epoch from (
      candidate.processing_heartbeat_at + make_interval(secs => stale_after_seconds) - request_time
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
    and candidate.processing_started_at > request_time - make_interval(secs => retry_delay_seconds)
  then
    remaining := ceil(extract(epoch from (
      candidate.processing_started_at + make_interval(secs => retry_delay_seconds) - request_time
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
    and processing_heartbeat_at > request_time - make_interval(secs => stale_after_seconds);

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
    processing_started_at = request_time,
    processing_lease_id = requested_lease_id,
    processing_heartbeat_at = request_time,
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
