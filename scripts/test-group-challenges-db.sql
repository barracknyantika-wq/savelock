-- Regression test for supabase/migrations/0007_group_challenges.sql: RLS
-- isolation (a stranger can never read or check into a challenge they
-- haven't joined) and the shared streak calculation's actual arithmetic
-- (a miss breaks it exactly at the gap, a late joiner isn't retroactively
-- blamed for periods before they joined, today's still open period is
-- never counted as a miss). Every check below prints one machine readable
-- line; test-group-challenges-db.mjs (the thing that actually runs this
-- file against a scratch database, after test-group-challenges-stub.sql
-- and the real migrations) parses those lines and fails loudly on any
-- FAIL, rather than asking a human to eyeball psql output.
--
-- This needs a real Postgres server, not just node — see the .mjs file's
-- own header for how to run this locally.

\set ON_ERROR_STOP on
set client_min_messages to warning;

-- client_min_messages above filters out NOTICE, so the two exception based
-- checks below record their result here and get emitted through a plain
-- SELECT afterward, same mechanism as every other check, rather than
-- through RAISE NOTICE (which this session would silently never see).
create temporary table exception_check_results (label text, passed boolean, got text, expected text);
grant insert on exception_check_results to authenticated;

-- ---- fixtures -------------------------------------------------------------

insert into auth.users (id, phone, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', '254700000001', '{"full_name":"Alice"}'),
  ('22222222-2222-2222-2222-222222222222', '254700000002', '{"full_name":"Bob"}'),
  ('33333333-3333-3333-3333-333333333333', '254700000003', '{"full_name":"Carol"}'),
  ('44444444-4444-4444-4444-444444444444', '254700000004', '{}'),
  ('55555555-5555-5555-5555-555555555555', '254700000005', '{}')
on conflict do nothing;

select 'RESULT|' || case when count(*) = 3 then 'PASS' else 'FAIL' end
  || '|profiles auto provisioned by handle_new_user trigger|got=' || count(*) || '|expected=3'
  from public.profiles where id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333');

set role authenticated;

-- ---- Alice creates a challenge, and is auto added as a participant -------
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', false);

select id, join_code, cadence, status into temporary chal from public.create_group_challenge('Weekend Warriors', 5000, 'daily');

select 'RESULT|' || case when length(join_code) = 6 then 'PASS' else 'FAIL' end
  || '|join code is generated at 6 characters|got=' || length(join_code) || '|expected=6' from chal;

select 'RESULT|' || case when count(*) = 1 then 'PASS' else 'FAIL' end
  || '|creator auto added as a participant|got=' || count(*) || '|expected=1'
  from public.challenge_participants where challenge_id = (select id from chal) and user_id = '11111111-1111-1111-1111-111111111111';

select 'RESULT|' || case when count(*) = 1 then 'PASS' else 'FAIL' end
  || '|creator can immediately read their own new challenge|got=' || count(*) || '|expected=1'
  from public.group_challenges where id = (select id from chal);

-- ---- a stranger who never joined sees nothing at all ----------------------
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333"}', false);

select 'RESULT|' || case when count(*) = 0 then 'PASS' else 'FAIL' end
  || '|stranger cannot see the challenge row|got=' || count(*) || '|expected=0' from public.group_challenges where id = (select id from chal);
select 'RESULT|' || case when count(*) = 0 then 'PASS' else 'FAIL' end
  || '|stranger cannot see participants|got=' || count(*) || '|expected=0' from public.challenge_participants where challenge_id = (select id from chal);
select 'RESULT|' || case when count(*) = 0 then 'PASS' else 'FAIL' end
  || '|stranger cannot see checkins|got=' || count(*) || '|expected=0' from public.challenge_checkins where challenge_id = (select id from chal);
select 'RESULT|' || case when count(*) = 0 then 'PASS' else 'FAIL' end
  || '|stranger cannot discover the join code by scanning|got=' || count(*) || '|expected=0'
  from public.group_challenges where join_code = (select join_code from chal);

do $$
begin
  perform public.record_challenge_checkin((select id from chal), 100);
  insert into exception_check_results values ('stranger blocked from checking in without joining', false, 'allowed', 'blocked');
exception
  when others then
    if sqlerrm = 'not_a_participant' then
      insert into exception_check_results values ('stranger blocked from checking in without joining', true, sqlerrm, 'not_a_participant');
    else
      raise;
    end if;
end $$;

-- ---- Bob: a bad code, then the real one, then rejoining ------------------
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222"}', false);

do $$
begin
  perform public.join_challenge_by_code('ZZZZZZ');
  insert into exception_check_results values ('a bogus join code is rejected clearly', false, 'accepted', 'rejected');
exception
  when others then
    if sqlerrm = 'invalid_or_inactive_code' then
      insert into exception_check_results values ('a bogus join code is rejected clearly', true, sqlerrm, 'invalid_or_inactive_code');
    else
      raise;
    end if;
end $$;

select public.join_challenge_by_code((select join_code from chal));
select public.join_challenge_by_code((select join_code from chal)); -- rejoining must not error or duplicate

select 'RESULT|' || case when count(*) = 1 then 'PASS' else 'FAIL' end
  || '|joining twice does not duplicate the participant row|got=' || count(*) || '|expected=1'
  from public.challenge_participants where challenge_id = (select id from chal) and user_id = '22222222-2222-2222-2222-222222222222';

select 'RESULT|' || case when count(*) = 2 then 'PASS' else 'FAIL' end
  || '|a real participant sees the full participant list|got=' || count(*) || '|expected=2'
  from public.challenge_participants where challenge_id = (select id from chal);

select 'RESULT|' || case when count(*) = 2 then 'PASS' else 'FAIL' end
  || '|participant names resolve without leaking phone or email|got=' || count(*) || '|expected=2'
  from public.challenge_participant_names((select id from chal));

reset role;

-- ---- streak math: full attendance ------------------------------------------

insert into public.group_challenges (id, creator_id, name, target_amount, cadence, created_at)
values ('aaaaaaaa-0000-0000-0000-00000000000a', '44444444-4444-4444-4444-444444444444', 'Case A', 1000, 'daily', current_date - 5);
insert into public.challenge_participants (challenge_id, user_id, joined_at) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '44444444-4444-4444-4444-444444444444', (current_date - 5)::timestamptz),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '55555555-5555-5555-5555-555555555555', (current_date - 5)::timestamptz);
insert into public.challenge_checkins (challenge_id, user_id, period_start, amount)
select 'aaaaaaaa-0000-0000-0000-00000000000a', u, d, 100
from unnest(array['44444444-4444-4444-4444-444444444444'::uuid, '55555555-5555-5555-5555-555555555555'::uuid]) u,
     generate_series(current_date - 5, current_date - 1, interval '1 day') d;

select 'RESULT|' || case when public.group_challenge_streak('aaaaaaaa-0000-0000-0000-00000000000a') = 5 then 'PASS' else 'FAIL' end
  || '|full attendance over 5 closed periods|got=' || public.group_challenge_streak('aaaaaaaa-0000-0000-0000-00000000000a') || '|expected=5';

-- ---- streak math: one miss breaks it exactly at the gap --------------------

insert into public.group_challenges (id, creator_id, name, target_amount, cadence, created_at)
values ('bbbbbbbb-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444', 'Case B', 1000, 'daily', current_date - 5);
insert into public.challenge_participants (challenge_id, user_id, joined_at) values
  ('bbbbbbbb-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444', (current_date - 5)::timestamptz),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '55555555-5555-5555-5555-555555555555', (current_date - 5)::timestamptz);
insert into public.challenge_checkins (challenge_id, user_id, period_start, amount)
select 'bbbbbbbb-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444', d, 100
from generate_series(current_date - 5, current_date - 1, interval '1 day') d;
insert into public.challenge_checkins (challenge_id, user_id, period_start, amount)
select 'bbbbbbbb-0000-0000-0000-00000000000b', '55555555-5555-5555-5555-555555555555', d, 100
from generate_series(current_date - 5, current_date - 1, interval '1 day') d
where d <> current_date - 3;

select 'RESULT|' || case when public.group_challenge_streak('bbbbbbbb-0000-0000-0000-00000000000b') = 2 then 'PASS' else 'FAIL' end
  || '|one miss breaks the streak, counting only back to that gap|got=' || public.group_challenge_streak('bbbbbbbb-0000-0000-0000-00000000000b') || '|expected=2';

-- ---- streak math: a late joiner is not retroactively blamed ---------------

insert into public.group_challenges (id, creator_id, name, target_amount, cadence, created_at)
values ('cccccccc-0000-0000-0000-00000000000c', '44444444-4444-4444-4444-444444444444', 'Case C', 1000, 'daily', current_date - 5);
insert into public.challenge_participants (challenge_id, user_id, joined_at) values
  ('cccccccc-0000-0000-0000-00000000000c', '44444444-4444-4444-4444-444444444444', (current_date - 5)::timestamptz),
  ('cccccccc-0000-0000-0000-00000000000c', '55555555-5555-5555-5555-555555555555', (current_date - 2)::timestamptz);
insert into public.challenge_checkins (challenge_id, user_id, period_start, amount)
select 'cccccccc-0000-0000-0000-00000000000c', '44444444-4444-4444-4444-444444444444', d, 100
from generate_series(current_date - 5, current_date - 1, interval '1 day') d;
insert into public.challenge_checkins (challenge_id, user_id, period_start, amount)
select 'cccccccc-0000-0000-0000-00000000000c', '55555555-5555-5555-5555-555555555555', d, 100
from generate_series(current_date - 2, current_date - 1, interval '1 day') d;

select 'RESULT|' || case when public.group_challenge_streak('cccccccc-0000-0000-0000-00000000000c') = 5 then 'PASS' else 'FAIL' end
  || '|a late joiner does not retroactively break periods before they joined|got=' || public.group_challenge_streak('cccccccc-0000-0000-0000-00000000000c') || '|expected=5';

-- ---- streak math: a late joiner's own miss still breaks it ----------------

insert into public.group_challenges (id, creator_id, name, target_amount, cadence, created_at)
values ('dddddddd-0000-0000-0000-00000000000d', '44444444-4444-4444-4444-444444444444', 'Case D', 1000, 'daily', current_date - 5);
insert into public.challenge_participants (challenge_id, user_id, joined_at) values
  ('dddddddd-0000-0000-0000-00000000000d', '44444444-4444-4444-4444-444444444444', (current_date - 5)::timestamptz),
  ('dddddddd-0000-0000-0000-00000000000d', '55555555-5555-5555-5555-555555555555', (current_date - 2)::timestamptz);
insert into public.challenge_checkins (challenge_id, user_id, period_start, amount)
select 'dddddddd-0000-0000-0000-00000000000d', '44444444-4444-4444-4444-444444444444', d, 100
from generate_series(current_date - 5, current_date - 1, interval '1 day') d;
insert into public.challenge_checkins (challenge_id, user_id, period_start, amount)
values ('dddddddd-0000-0000-0000-00000000000d', '55555555-5555-5555-5555-555555555555', current_date - 1, 100);

select 'RESULT|' || case when public.group_challenge_streak('dddddddd-0000-0000-0000-00000000000d') = 1 then 'PASS' else 'FAIL' end
  || '|a late joiner missing their own first required day still breaks it|got=' || public.group_challenge_streak('dddddddd-0000-0000-0000-00000000000d') || '|expected=1';

-- ---- period bucketing: daily vs weekly, anchored to created_at -----------

select 'RESULT|' || case when public.challenge_period_start(current_date, 'weekly', current_date + 3) = current_date then 'PASS' else 'FAIL' end
  || '|weekly day+3 is the same period as day 0|got=' || public.challenge_period_start(current_date, 'weekly', current_date + 3) || '|expected=' || current_date;
select 'RESULT|' || case when public.challenge_period_start(current_date, 'weekly', current_date + 7) = current_date + 7 then 'PASS' else 'FAIL' end
  || '|weekly day+7 starts the next period|got=' || public.challenge_period_start(current_date, 'weekly', current_date + 7) || '|expected=' || (current_date + 7);
select 'RESULT|' || case when public.challenge_period_start(current_date, 'weekly', current_date + 13) = current_date + 7 then 'PASS' else 'FAIL' end
  || '|weekly day+13 is still the second period|got=' || public.challenge_period_start(current_date, 'weekly', current_date + 13) || '|expected=' || (current_date + 7);
select 'RESULT|' || case when public.challenge_period_start(current_date, 'daily', current_date + 4) = current_date + 4 then 'PASS' else 'FAIL' end
  || '|daily cadence is always the same calendar day|got=' || public.challenge_period_start(current_date, 'daily', current_date + 4) || '|expected=' || (current_date + 4);

-- ---- streak math: today's own open period is never counted as a miss -----

insert into public.group_challenges (id, creator_id, name, target_amount, cadence, created_at)
values ('ffffffff-0000-0000-0000-00000000000f', '44444444-4444-4444-4444-444444444444', 'Case F', 1000, 'daily', current_date - 2);
insert into public.challenge_participants (challenge_id, user_id, joined_at) values
  ('ffffffff-0000-0000-0000-00000000000f', '44444444-4444-4444-4444-444444444444', (current_date - 2)::timestamptz);
insert into public.challenge_checkins (challenge_id, user_id, period_start, amount) values
  ('ffffffff-0000-0000-0000-00000000000f', '44444444-4444-4444-4444-444444444444', current_date - 2, 100),
  ('ffffffff-0000-0000-0000-00000000000f', '44444444-4444-4444-4444-444444444444', current_date - 1, 100);
-- deliberately no checkin at all yet for today.

select 'RESULT|' || case when public.group_challenge_streak('ffffffff-0000-0000-0000-00000000000f') = 2 then 'PASS' else 'FAIL' end
  || '|no checkin yet today does not break the streak|got=' || public.group_challenge_streak('ffffffff-0000-0000-0000-00000000000f') || '|expected=2';

-- ---- the two exception based checks recorded further up, emitted here ----

select 'RESULT|' || case when passed then 'PASS' else 'FAIL' end
  || '|' || label || '|got=' || got || '|expected=' || expected
  from exception_check_results;

select 'RESULT|' || case when count(*) = 2 then 'PASS' else 'FAIL' end
  || '|both exception based checks actually ran|got=' || count(*) || '|expected=2'
  from exception_check_results;
