-- Stores one statement snapshot per user and month. The report JSON
-- includes its saved PDF data so it remains viewable without regeneration.
create table public.monthly_reports (
  user_id uuid not null references auth.users (id) on delete cascade,
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  report jsonb not null,
  email_sent_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, month)
);

alter table public.monthly_reports enable row level security;

create policy "own monthly reports" on public.monthly_reports
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
