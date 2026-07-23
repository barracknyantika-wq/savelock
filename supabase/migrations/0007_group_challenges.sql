-- Group savings challenges: a shared streak/commitment feature, not shared
-- money. One person creates a challenge, shares a join code, and everyone
-- who joins is tracked as a "current participant." A check in is a
-- behavioral log entry (I did my saving for this period, here's roughly how
-- much), the same shape as the existing solo weekly challenge in store.js
-- (target_extra/start_date), never a transfer of real funds. Every
-- participant's own goals and M-Pesa deposits stay entirely their own,
-- completely unrelated to anything in this migration.
--
-- Naming note: the task that asked for this called the main table
-- "challenges", but that name is already taken by the solo weekly challenge
-- table added in 0001_init.sql (public.challenges, keyed by user_id,
-- target_extra, start_date — a single-user feature, unrelated to this one).
-- Reusing that name would either collide outright or silently conflate two
-- unrelated features sharing one table. This migration uses
-- group_challenges/challenge_participants/challenge_checkins instead, and
-- nothing here touches public.challenges.
--
-- This is the first genuinely multi-user, shared-visibility feature in the
-- app. Every other table so far is "own rows only." Here, a participant
-- must be able to see OTHER participants' check in status and the shared
-- streak, which is new: RLS below is built around a single SECURITY
-- DEFINER helper, is_challenge_member(), rather than three separate
-- policies that would otherwise each need to re-derive the same "does this
-- user belong to this challenge" check by querying each other's tables —
-- including group_challenges' own SELECT policy querying
-- challenge_participants, and vice versa. A SECURITY DEFINER function is
-- what makes that safe: its internal queries run as the function's owner
-- (which bypasses RLS, same as every other SECURITY DEFINER function in
-- this schema), so there is no policy-evaluating-itself recursion, just a
-- plain membership lookup. Every USING clause below calls the same
-- function, so "who can see this challenge" is defined in exactly one
-- place, not reimplemented three times with room to drift apart.
--
-- Join codes and check ins are deliberately NOT plain client inserts.
-- challenge_participants and challenge_checkins have zero INSERT policy for
-- the authenticated role (same "no policy at all" pattern 0003 already
-- uses for deposits/withdrawals never getting an update policy) — the only
-- way to join is join_challenge_by_code(), and the only way to check in is
-- record_challenge_checkin(), both SECURITY DEFINER. That is what makes the
-- join code the actual access control, not a UI nicety: nobody can add
-- themselves as a participant by guessing or reading a challenge_id, only
-- by presenting a valid code to the one function that checks it.

-- ---- group_challenges -------------------------------------------------

create table public.group_challenges (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  target_amount numeric not null check (target_amount > 0),
  cadence text not null check (cadence in ('daily', 'weekly')),
  join_code text not null unique,
  status text not null default 'active' check (status in ('active', 'ended')),
  created_at timestamptz not null default now()
);

-- Every period boundary (both here and in the streak calculation below) is
-- anchored to created_at::date rather than a separate start_date column —
-- the task's own column list for this table didn't include one, and the
-- creation date already is the moment the challenge starts.

alter table public.group_challenges enable row level security;

-- ---- challenge_participants ---------------------------------------------

create table public.challenge_participants (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.group_challenges (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  unique (challenge_id, user_id)
);

create index challenge_participants_challenge_idx on public.challenge_participants (challenge_id);

alter table public.challenge_participants enable row level security;

-- ---- challenge_checkins ---------------------------------------------------

create table public.challenge_checkins (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.group_challenges (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  period_start date not null,
  amount numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (challenge_id, user_id, period_start)
);

create index challenge_checkins_challenge_period_idx on public.challenge_checkins (challenge_id, period_start);

alter table public.challenge_checkins enable row level security;

-- ---- membership check, shared by every policy below ------------------------
--
-- True if the caller created this challenge or has an existing participant
-- row for it. SECURITY DEFINER so its own lookups bypass RLS (same reason
-- goal_mpesa_balance-style helpers elsewhere in this schema are safe): no
-- recursion, and it never leaks anything beyond a boolean.

create or replace function public.is_challenge_member(p_challenge_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    exists (select 1 from public.group_challenges where id = p_challenge_id and creator_id = auth.uid())
    or exists (select 1 from public.challenge_participants where challenge_id = p_challenge_id and user_id = auth.uid());
$$;

revoke all on function public.is_challenge_member from public;
grant execute on function public.is_challenge_member to authenticated;

-- ---- RLS: every table below uses the same membership check -----------------

-- A challenge is visible only to its creator and its current participants —
-- never discoverable by anyone else, including by knowing its id or join
-- code. Deliberately no INSERT/UPDATE policy for authenticated: creation
-- and ending both go through SECURITY DEFINER functions below instead.
create policy "challenge members can view" on public.group_challenges
  for select using (public.is_challenge_member(id));

-- The participant list (who's in, and since when) is visible only to
-- fellow members of that same challenge — never a global directory, never
-- visible to someone who hasn't joined. No INSERT policy for authenticated:
-- see join_challenge_by_code() below, the only way a row here is created.
create policy "challenge members can view participants" on public.challenge_participants
  for select using (public.is_challenge_member(challenge_id));

-- Check ins are visible to fellow members only, same as the participant
-- list. No INSERT policy for authenticated: see record_challenge_checkin()
-- below, the only way a row here is created.
create policy "challenge members can view checkins" on public.challenge_checkins
  for select using (public.is_challenge_member(challenge_id));

-- ---- period bucketing, shared by check ins and the streak read ------------
--
-- Daily cadence: every calendar date is its own period. Weekly cadence:
-- fixed 7 day windows anchored to the challenge's own created_at date, not
-- calendar Mon/Sun — so "this week" always means "7 days since this
-- challenge started", regardless of which day of the week it began on.
-- Both the check in function and the streak calculation below call this
-- same function, so "which period is today" can never drift between the
-- two — there is exactly one definition of a period boundary in this whole
-- feature.

create or replace function public.challenge_period_start(p_created_date date, p_cadence text, p_at date default current_date)
returns date
language sql
stable
as $$
  select case
    when p_cadence = 'daily' then p_at
    else p_created_date + (((p_at - p_created_date) / 7) * 7)
  end;
$$;

revoke all on function public.challenge_period_start from public;
grant execute on function public.challenge_period_start to authenticated;

-- ---- join code generation, collision checked --------------------------

-- Excludes 0/O/1/I/L on purpose: this code gets read aloud or typed off a
-- phone screen by a friend, and those pairs are the ones people actually
-- misread. Loops on collision, vanishingly unlikely at this app's scale but
-- checked for real rather than assumed away.
create or replace function public.generate_challenge_join_code()
returns trigger
language plpgsql
as $$
declare
  v_alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text;
begin
  if new.join_code is not null then
    return new;
  end if;
  loop
    v_code := (
      select string_agg(substr(v_alphabet, (floor(random() * length(v_alphabet)))::int + 1, 1), '')
      from generate_series(1, 6)
    );
    exit when not exists (select 1 from public.group_challenges where join_code = v_code);
  end loop;
  new.join_code := v_code;
  return new;
end;
$$;

create trigger set_challenge_join_code
  before insert on public.group_challenges
  for each row execute procedure public.generate_challenge_join_code();

-- ---- creating a challenge: creator_id and the first participant row -------
--
-- Both writes (the challenge row and the creator's own participant row)
-- happen inside one function so they commit together, same reasoning as
-- complete_deposit bundling a deposit's completion with its goal credit in
-- 0005. creator_id is derived from auth.uid() here, never accepted as a
-- client-supplied argument, so nobody can create a challenge "as" someone
-- else. Deliberately no plain client INSERT policy on group_challenges —
-- this function is the only way a row is created.

create or replace function public.create_group_challenge(p_name text, p_target_amount numeric, p_cadence text)
returns public.group_challenges
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.group_challenges;
begin
  if p_cadence not in ('daily', 'weekly') then
    raise exception 'invalid_cadence' using errcode = 'P0001';
  end if;
  if p_target_amount is null or p_target_amount <= 0 then
    raise exception 'invalid_target_amount' using errcode = 'P0001';
  end if;

  insert into public.group_challenges (creator_id, name, target_amount, cadence)
    values (auth.uid(), trim(p_name), p_target_amount, p_cadence)
    returning * into v_row;

  insert into public.challenge_participants (challenge_id, user_id)
    values (v_row.id, auth.uid());

  return v_row;
end;
$$;

revoke all on function public.create_group_challenge from public;
grant execute on function public.create_group_challenge to authenticated;

-- Lets a creator close out their own challenge (status -> 'ended'). Ended
-- challenges stop accepting new joins (see join_challenge_by_code below)
-- but stay fully visible/readable to whoever already joined — this is
-- deliberately scoped to status only, not a general purpose edit, since
-- nothing in this feature asks for renaming or retargeting a challenge
-- after people have already joined it.
create or replace function public.end_group_challenge(p_challenge_id uuid)
returns public.group_challenges
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.group_challenges;
begin
  update public.group_challenges
    set status = 'ended'
    where id = p_challenge_id and creator_id = auth.uid()
    returning * into v_row;
  return v_row;
end;
$$;

revoke all on function public.end_group_challenge from public;
grant execute on function public.end_group_challenge to authenticated;

-- ---- joining by code -----------------------------------------------------
--
-- The only path that ever creates a challenge_participants row for someone
-- other than a challenge's own creator. Looks up an ACTIVE challenge by
-- code; a code that doesn't exist and a code whose challenge already ended
-- both raise the same invalid_or_inactive_code error, so the client can
-- show one clear message ("that code isn't valid") instead of a generic
-- failure, without distinguishing "wrong code" from "this challenge is
-- over" — the join code stops working the moment its challenge ends,
-- exactly like the wording "already used code" implies. Already being a
-- participant is not an error: on conflict do nothing, so tapping join
-- again on a code you've already used just lands you back in the
-- challenge.
create or replace function public.join_challenge_by_code(p_code text)
returns public.group_challenges
language plpgsql
security definer
set search_path = public
as $$
declare
  v_challenge public.group_challenges;
begin
  select * into v_challenge
    from public.group_challenges
    where join_code = upper(trim(p_code)) and status = 'active';

  if v_challenge.id is null then
    raise exception 'invalid_or_inactive_code' using errcode = 'P0001';
  end if;

  insert into public.challenge_participants (challenge_id, user_id)
    values (v_challenge.id, auth.uid())
    on conflict (challenge_id, user_id) do nothing;

  return v_challenge;
end;
$$;

revoke all on function public.join_challenge_by_code from public;
grant execute on function public.join_challenge_by_code to authenticated;

-- ---- checking in ---------------------------------------------------------
--
-- Validates real membership server side (not just an RLS insert check),
-- computes period_start through the one shared bucketing function above so
-- it can never disagree with the streak calculation's own idea of "which
-- period is this", and upserts rather than errors on a repeat check in for
-- the same period — tapping check in twice just updates the logged amount
-- instead of surfacing a confusing unique-constraint failure.
create or replace function public.record_challenge_checkin(p_challenge_id uuid, p_amount numeric)
returns public.challenge_checkins
language plpgsql
security definer
set search_path = public
as $$
declare
  v_challenge public.group_challenges;
  v_period date;
  v_row public.challenge_checkins;
begin
  select * into v_challenge from public.group_challenges where id = p_challenge_id;

  if v_challenge.id is null or not public.is_challenge_member(p_challenge_id) then
    raise exception 'not_a_participant' using errcode = 'P0001';
  end if;

  v_period := public.challenge_period_start(v_challenge.created_at::date, v_challenge.cadence, current_date);

  insert into public.challenge_checkins (challenge_id, user_id, period_start, amount)
    values (p_challenge_id, auth.uid(), v_period, coalesce(p_amount, 0))
    on conflict (challenge_id, user_id, period_start) do update set amount = excluded.amount
    returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.record_challenge_checkin from public;
grant execute on function public.record_challenge_checkin to authenticated;

-- ---- shared streak: a read, never a stored counter ------------------------
--
-- Walks backward from the most recently CLOSED period (today's own period
-- is still open — it may yet be checked into before it ends, so it never
-- counts as a miss) toward the challenge's start, counting consecutive
-- periods where every participant who had already joined by that period
-- checked in. The first gap stops the count entirely, same as a real
-- streak: a miss breaks it, it does not resume crediting older periods
-- past the gap.
--
-- "Every participant who had already joined by that period" (via
-- joined_at::date <= the period) rather than literally every participant
-- in the group today is a deliberate reading of "every current
-- participant": applying today's full roster retroactively to periods
-- before some of them had even joined would make the streak collapse to
-- zero the instant anyone joins late, which cannot be the intent of a
-- feature meant to welcome friends into an already running challenge. From
-- the period each person joins onward, though, they count exactly like
-- everyone else — their own miss breaks the shared streak same as anyone's.
create or replace function public.group_challenge_streak(p_challenge_id uuid)
returns int
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_challenge public.group_challenges;
  v_step int;
  v_period date;
  v_streak int := 0;
  v_required int;
  v_checked int;
begin
  select * into v_challenge from public.group_challenges where id = p_challenge_id;
  if v_challenge.id is null then
    return 0;
  end if;

  v_step := case when v_challenge.cadence = 'daily' then 1 else 7 end;
  v_period := public.challenge_period_start(v_challenge.created_at::date, v_challenge.cadence, current_date) - v_step;

  while v_period >= v_challenge.created_at::date loop
    select count(*) into v_required
      from public.challenge_participants
      where challenge_id = p_challenge_id and joined_at::date <= v_period;

    exit when v_required = 0;

    select count(distinct cc.user_id) into v_checked
      from public.challenge_checkins cc
      where cc.challenge_id = p_challenge_id
        and cc.period_start = v_period
        and cc.user_id in (
          select user_id from public.challenge_participants
          where challenge_id = p_challenge_id and joined_at::date <= v_period
        );

    exit when v_checked < v_required;
    v_streak := v_streak + 1;
    v_period := v_period - v_step;
  end loop;

  return v_streak;
end;
$$;

revoke all on function public.group_challenge_streak from public;
grant execute on function public.group_challenge_streak to authenticated;

-- Today's period for this specific challenge, so the client never has to
-- derive created_at's calendar date itself (a timestamptz-to-date slice
-- done client side risks a timezone mismatch against what the server means
-- by current_date) — it just asks "what period is today, for this
-- challenge" directly.
create or replace function public.challenge_current_period(p_challenge_id uuid)
returns date
language sql
security definer
set search_path = public
stable
as $$
  select public.challenge_period_start(created_at::date, cadence, current_date)
  from public.group_challenges where id = p_challenge_id;
$$;

revoke all on function public.challenge_current_period from public;
grant execute on function public.challenge_current_period to authenticated;

-- ---- participant display names, deliberately minimal ----------------------
--
-- The challenge view needs some way to tell participants apart in the
-- list, but profiles' own RLS ("own profile" only, see 0001) stays exactly
-- as it is — this does not widen access to the profiles table itself, and
-- a fellow participant gets a display name only, never phone, email, or
-- anything else about them. Falls back to a neutral label for whoever
-- never set a display name (phone sign in without Google, for instance)
-- rather than exposing their phone number as a stand in identifier.
create or replace function public.challenge_participant_names(p_challenge_id uuid)
returns table (user_id uuid, display_name text)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.is_challenge_member(p_challenge_id) then
    return;
  end if;
  return query
    select p.id, coalesce(p.display_name, 'Member')
    from public.challenge_participants cp
    join public.profiles p on p.id = cp.user_id
    where cp.challenge_id = p_challenge_id;
end;
$$;

revoke all on function public.challenge_participant_names from public;
grant execute on function public.challenge_participant_names to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: lets the challenge view update the instant a fellow participant
-- checks in or someone new joins, instead of needing a manual refresh —
-- the one place in this feature where "shared" should feel genuinely live.
-- Same as deposits/withdrawals in 0003, RLS still applies per subscriber,
-- so this doesn't widen access: a subscriber only ever receives events for
-- challenges their own SELECT policy already lets them read.

alter publication supabase_realtime add table public.challenge_checkins;
alter publication supabase_realtime add table public.challenge_participants;
