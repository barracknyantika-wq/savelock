-- Gates the Withdraw button to a single account (the developer's own, for
-- personal testing with real money) while STK Push deposits stay open to
-- everyone. Defaults false for every existing and future row, on purpose:
-- nobody becomes able to withdraw by accident, this has to be flipped by
-- hand, directly in the database, for one specific user.

alter table public.profiles
  add column if not exists is_owner boolean not null default false;
