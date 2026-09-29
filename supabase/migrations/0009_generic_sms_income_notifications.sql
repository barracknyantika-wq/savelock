-- 0009: generic (non-M-Pesa) SMS support, income tracking, and the
-- notifications bell. Purely additive — every new column is nullable or
-- defaulted, every existing row stays valid, and nothing here changes the
-- meaning of a column the app already reads. Safe to run against the live
-- database ahead of releasing the app version that uses it.

-- ---- spends: record provider/confidence metadata, and let income share
-- the same table as expenses (type column), rather than a parallel table
-- that would need its own RLS, sync and reporting code paths.

alter table public.spends
  add column if not exists type text not null default 'expense', -- 'expense' | 'income'
  add column if not exists provider text,          -- sender key: 'MPESA', 'EXAMPLEBANK', ...
  add column if not exists confidence numeric,      -- 0..1, null for M-Pesa (always 1, not stored)
  add column if not exists needs_review boolean not null default false,
  add column if not exists currency text,
  add column if not exists account_last4 text,
  add column if not exists reference text,
  add column if not exists income_category text;

alter table public.spends
  drop constraint if exists spends_type_check;
alter table public.spends
  add constraint spends_type_check check (type in ('expense', 'income'));

create index if not exists spends_user_type_idx on public.spends (user_id, type);
create index if not exists spends_needs_review_idx on public.spends (user_id) where needs_review;

-- ---- notifications: backs the bell icon. One row per event the app has
-- ever surfaced to the user, native-detected or in-app, so the bell's
-- history survives even after the underlying transaction is edited.

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null, -- 'expense_detected' | 'income_detected' | 'needs_review' | 'budget_threshold' | 'reconciliation'
  title text not null,
  body text not null,
  spend_id uuid references public.spends (id) on delete set null,
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_created_idx on public.notifications (user_id, created_at desc);
create index notifications_user_unread_idx on public.notifications (user_id) where read_at is null;

alter table public.notifications enable row level security;

-- Users read/update (mark read) their own notifications only. No delete
-- policy for now — the bell's history is meant to persist; add one later
-- if a "clear all" action is wanted.
create policy "select own notifications" on public.notifications
  for select using (auth.uid() = user_id);

create policy "insert own notifications" on public.notifications
  for insert with check (auth.uid() = user_id);

create policy "update own notifications" on public.notifications
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter publication supabase_realtime add table public.notifications;
