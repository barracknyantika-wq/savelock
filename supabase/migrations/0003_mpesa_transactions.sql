-- Real money movement: M-Pesa STK Push deposits into a goal, and B2C
-- withdrawals out of one, via Safaricom's Daraja API. Both tables only ever
-- get a status flip from 'pending' to 'completed'/'failed' via Safaricom's
-- callback, handled server-side by the stk-callback/b2c-callback Edge
-- Functions using the service_role key, never by the client. RLS below
-- enforces that split at the database level, not just in application code:
-- a signed-in user can create their own pending row and read it, full stop.
--
-- goals.saved is the actual balance a goal displays. This migration doesn't
-- touch that column directly; the callback functions increment/decrement it
-- once a transaction is confirmed, same table, same column, already synced
-- to the local store like every other goal field.

create table public.deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  goal_id uuid not null references public.goals (id) on delete cascade,
  phone_number text not null,
  amount numeric not null check (amount > 0),
  merchant_request_id text,
  checkout_request_id text not null unique,
  mpesa_receipt_number text unique,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  result_code int,
  result_desc text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index deposits_user_idx on public.deposits (user_id);
create index deposits_goal_idx on public.deposits (goal_id);

alter table public.deposits enable row level security;

-- Users can read their own deposits, of any status.
create policy "select own deposits" on public.deposits
  for select using (auth.uid() = user_id);

-- Users can create only their own row, and only in the 'pending' state.
-- There is deliberately no update/delete policy for the authenticated role
-- at all, so no combination of client-side calls can ever move a deposit
-- out of 'pending' — only the service_role key (used exclusively by
-- stk-callback, never shipped to the app) can do that, since service_role
-- bypasses RLS entirely rather than needing a policy of its own.
create policy "insert own pending deposit" on public.deposits
  for insert with check (auth.uid() = user_id and status = 'pending');

-- ---------------------------------------------------------------------------

create table public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  goal_id uuid not null references public.goals (id) on delete cascade,
  phone_number text not null,
  amount numeric not null check (amount > 0),
  conversation_id text not null unique,
  originator_conversation_id text,
  mpesa_transaction_id text unique,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  result_code int,
  result_desc text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index withdrawals_user_idx on public.withdrawals (user_id);
create index withdrawals_goal_idx on public.withdrawals (goal_id);

alter table public.withdrawals enable row level security;

create policy "select own withdrawals" on public.withdrawals
  for select using (auth.uid() = user_id);

-- Same reasoning as deposits above: no update/delete policy for the
-- authenticated role, so only the service_role-driven b2c-callback function
-- can ever flip status away from 'pending'.
create policy "insert own pending withdrawal" on public.withdrawals
  for insert with check (auth.uid() = user_id and status = 'pending');

-- ---------------------------------------------------------------------------
-- Realtime: the app watches its own just-created deposit/withdrawal row for
-- the status flip instead of polling. Supabase's realtime still applies each
-- table's RLS policies per-subscriber, so this doesn't widen access, a user
-- only ever receives change events for rows their own "select" policy above
-- would let them read.

alter publication supabase_realtime add table public.deposits;
alter publication supabase_realtime add table public.withdrawals;
