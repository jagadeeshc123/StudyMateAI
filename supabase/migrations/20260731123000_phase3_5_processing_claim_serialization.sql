-- Phase 3.5 release correction: serialize processing-capacity decisions per
-- user so concurrent claims for different documents cannot exceed the active
-- job ceiling. This migration is additive and leaves the original migration
-- history unchanged.

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

  -- The capacity check and subsequent state transition must be one serialized
  -- decision for this user, even when callers target different document rows.
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
