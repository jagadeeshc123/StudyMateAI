-- Phase 3: normalized owner-scoped chat sessions and server-only
-- multi-document retrieval. Existing single-document messages are backfilled
-- without copying any document content into session rows.

create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  mode text not null default 'single_document'
    check (mode in ('single_document', 'multi_document', 'comparison')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint chat_sessions_title_check check (
    title = regexp_replace(title, '^[[:space:]]+|[[:space:]]+$', '', 'g')
    and length(title) between 1 and 150
    and title !~ '[[:cntrl:]]'
  )
);

create index chat_sessions_user_updated_at_idx
  on public.chat_sessions (user_id, updated_at desc, id);

create table public.chat_session_documents (
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  position smallint not null check (position between 1 and 5),
  added_at timestamptz not null default timezone('utc', now()),
  primary key (session_id, document_id),
  unique (session_id, position)
);

create index chat_session_documents_document_id_idx
  on public.chat_session_documents (document_id, session_id);

create or replace function public.validate_chat_session_document()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_owner uuid;
  document_owner uuid;
  document_status text;
begin
  select user_id into session_owner
  from public.chat_sessions
  where id = new.session_id;

  select user_id, processing_status into document_owner, document_status
  from public.documents
  where id = new.document_id;

  if session_owner is null or document_owner is null or session_owner <> document_owner then
    raise exception 'chat session and document ownership must match'
      using errcode = '23514';
  end if;

  if document_status <> 'ready' then
    raise exception 'only ready documents may be attached to chat sessions'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.validate_chat_session_document()
  from public, anon, authenticated;

alter table public.messages
  add column chat_session_id uuid references public.chat_sessions(id) on delete cascade,
  add column retrieval_mode text not null default 'single_document',
  add column selected_document_count smallint not null default 1;

alter table public.messages
  add constraint messages_retrieval_mode_check
    check (retrieval_mode in ('single_document', 'multi_document', 'comparison')),
  add constraint messages_selected_document_count_check
    check (selected_document_count between 1 and 5);

-- A document UUID is also a safe deterministic session UUID because the tables
-- have independent namespaces. This gives every legacy document conversation
-- exactly one stable session without a temporary mapping table.
insert into public.chat_sessions (id, user_id, title, mode, created_at, updated_at)
select
  documents.id,
  documents.user_id,
  left(coalesce(
    nullif(regexp_replace(trim(coalesce(documents.display_name, documents.original_file_name)), '[[:cntrl:]]', '', 'g'), ''),
    'Untitled document'
  ), 150),
  'single_document',
  min(messages.created_at),
  max(messages.created_at)
from public.documents
join public.messages on messages.document_id = documents.id
group by documents.id, documents.user_id, documents.display_name, documents.original_file_name
on conflict (id) do nothing;

insert into public.chat_session_documents (session_id, document_id, position)
select distinct messages.document_id, messages.document_id, 1
from public.messages
on conflict (session_id, document_id) do nothing;

update public.messages
set chat_session_id = document_id
where chat_session_id is null;

-- Enforce ready-state and same-owner selection for all new/changed
-- associations after the backward-compatible data migration is complete.
create trigger validate_chat_session_document_trigger
before insert or update on public.chat_session_documents
for each row execute function public.validate_chat_session_document();

alter table public.messages
  alter column chat_session_id set not null;

alter table public.messages
  drop constraint if exists messages_document_id_fkey;

alter table public.messages
  alter column document_id drop not null;

alter table public.messages
  add constraint messages_document_id_fkey
  foreign key (document_id) references public.documents(id) on delete set null;

create index messages_session_created_at_idx
  on public.messages (chat_session_id, created_at, id);

create or replace function public.set_chat_session_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

revoke all on function public.set_chat_session_updated_at()
  from public, anon, authenticated;

create trigger set_chat_session_updated_at_trigger
before update on public.chat_sessions
for each row execute function public.set_chat_session_updated_at();

-- Preserve the Phase 1/2 chat-document insert contract. A legacy single-
-- document message insert that omits chat_session_id is normalized into the
-- deterministic per-document session before the NOT NULL check is enforced.
create or replace function public.ensure_message_chat_session()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  owner_id uuid;
  session_title text;
begin
  if new.chat_session_id is not null then
    return new;
  end if;

  if new.document_id is null then
    raise exception 'a message must identify a chat session'
      using errcode = '23502';
  end if;

  select
    documents.user_id,
    left(coalesce(
      nullif(regexp_replace(trim(coalesce(documents.display_name, documents.original_file_name)), '[[:cntrl:]]', '', 'g'), ''),
      'Untitled document'
    ), 150)
  into owner_id, session_title
  from public.documents
  where documents.id = new.document_id;

  if owner_id is null then
    raise exception 'message document is unavailable'
      using errcode = '23503';
  end if;

  insert into public.chat_sessions (id, user_id, title, mode)
  values (new.document_id, owner_id, session_title, 'single_document')
  on conflict (id) do nothing;

  insert into public.chat_session_documents (session_id, document_id, position)
  values (new.document_id, new.document_id, 1)
  on conflict (session_id, document_id) do nothing;

  new.chat_session_id := new.document_id;
  new.retrieval_mode := 'single_document';
  new.selected_document_count := 1;
  return new;
end;
$$;

revoke all on function public.ensure_message_chat_session()
  from public, anon, authenticated;

create trigger ensure_message_chat_session_trigger
before insert on public.messages
for each row execute function public.ensure_message_chat_session();

create or replace function public.touch_chat_session_from_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.chat_sessions
  set updated_at = greatest(updated_at, new.created_at)
  where id = new.chat_session_id;
  return new;
end;
$$;

revoke all on function public.touch_chat_session_from_message()
  from public, anon, authenticated;

create trigger touch_chat_session_from_message_trigger
after insert on public.messages
for each row execute function public.touch_chat_session_from_message();

-- Privacy wins over historical-source retention. If any selected document is
-- deleted or detached, remove the session messages that may contain its answer
-- text or excerpts. Other associations and the session row remain available.
create or replace function public.purge_messages_for_detached_document()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.messages where chat_session_id = old.session_id;
  update public.chat_sessions
  set updated_at = timezone('utc', now())
  where id = old.session_id;
  return old;
end;
$$;

revoke all on function public.purge_messages_for_detached_document()
  from public, anon, authenticated;

create trigger purge_messages_for_detached_document_trigger
after delete on public.chat_session_documents
for each row execute function public.purge_messages_for_detached_document();

alter table public.chat_sessions enable row level security;
alter table public.chat_sessions force row level security;
alter table public.chat_session_documents enable row level security;
alter table public.chat_session_documents force row level security;

revoke all on table public.chat_sessions from public, anon, authenticated;
revoke all on table public.chat_session_documents from public, anon, authenticated;
grant select, delete on table public.chat_sessions to authenticated;
grant update (title) on table public.chat_sessions to authenticated;
grant select on table public.chat_session_documents to authenticated;

create policy "Users can read own chat sessions"
  on public.chat_sessions for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can rename own chat sessions"
  on public.chat_sessions for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "Users can delete own chat sessions"
  on public.chat_sessions for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can read documents in own chat sessions"
  on public.chat_session_documents for select to authenticated
  using (exists (
    select 1 from public.chat_sessions
    where chat_sessions.id = chat_session_documents.session_id
      and chat_sessions.user_id = (select auth.uid())
  ));

drop policy if exists "Users can read messages of own documents" on public.messages;
create policy "Users can read messages in own chat sessions"
  on public.messages for select to authenticated
  using (exists (
    select 1 from public.chat_sessions
    where chat_sessions.id = messages.chat_session_id
      and chat_sessions.user_id = (select auth.uid())
  ));

create or replace function public.clear_user_history(target_document_id uuid default null)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  delete from public.messages
  where exists (
    select 1
    from public.chat_sessions
    where chat_sessions.id = messages.chat_session_id
      and chat_sessions.user_id = (select auth.uid())
  )
  and (
    target_document_id is null
    or exists (
      select 1
      from public.chat_session_documents
      where chat_session_documents.session_id = messages.chat_session_id
        and chat_session_documents.document_id = target_document_id
    )
  );
$$;

revoke all on function public.clear_user_history(uuid) from public, anon;
grant execute on function public.clear_user_history(uuid) to authenticated;

create or replace function public.hybrid_search_multi_document_chunks(
  target_document_ids uuid[],
  query_embedding extensions.vector(768),
  keyword_query text,
  target_embedding_model text default 'gemini-embedding-2',
  per_document_count integer default 8,
  requested_page_numbers integer[] default null
)
returns table (
  id uuid,
  document_id uuid,
  document_position integer,
  display_name text,
  original_file_name text,
  page_number integer,
  chunk_index integer,
  content text,
  semantic_score real,
  keyword_score real,
  combined_score real
)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  with input_documents as (
    select input.document_id, input.position::integer
    from unnest(target_document_ids) with ordinality as input(document_id, position)
    where cardinality(target_document_ids) between 1 and 5
      and (
        select count(distinct candidate)
        from unnest(target_document_ids) as candidate
      ) = cardinality(target_document_ids)
  )
  select
    results.id,
    documents.id,
    input_documents.position,
    documents.display_name,
    documents.original_file_name,
    results.page_number,
    results.chunk_index,
    results.content,
    results.semantic_score,
    results.keyword_score,
    results.combined_score
  from input_documents
  join public.documents on documents.id = input_documents.document_id
  cross join lateral public.hybrid_search_document_chunks(
    input_documents.document_id,
    query_embedding,
    keyword_query,
    requested_page_numbers,
    least(greatest(per_document_count, 1), 20),
    1.0,
    1.0,
    target_embedding_model
  ) as results
  order by input_documents.position, results.combined_score desc,
    results.page_number, results.chunk_index;
$$;

revoke all on function public.hybrid_search_multi_document_chunks(
  uuid[], extensions.vector, text, text, integer, integer[]
) from public, anon, authenticated;

grant execute on function public.hybrid_search_multi_document_chunks(
  uuid[], extensions.vector, text, text, integer, integer[]
) to service_role;

comment on function public.hybrid_search_multi_document_chunks(
  uuid[], extensions.vector, text, text, integer, integer[]
) is 'Service-role-only bounded hybrid retrieval across one to five previously owner-verified documents, ranked independently per document.';
