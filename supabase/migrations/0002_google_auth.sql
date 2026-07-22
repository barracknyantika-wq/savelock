-- Adds Google Sign-In as a second auth method alongside phone OTP.
--
-- profiles.phone was already nullable in 0001_init.sql (a user should get
-- exactly one profile row regardless of which method they signed up with),
-- so the only real schema change needed is somewhere to put the fields
-- Google actually gives us: email and a display name. Both are optional,
-- same as phone — nothing here is required to have an account.

alter table public.profiles
  add column if not exists email text,
  add column if not exists display_name text;

-- Replaces the 0001_init.sql version: same trigger, now also captures
-- email/display name when they're present (Google sign-up) instead of
-- only phone (phone OTP sign-up). Whichever fields the auth method didn't
-- provide are simply left null.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, phone, email, display_name)
  values (
    new.id,
    new.phone,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
  );
  insert into public.settings (user_id) values (new.id);
  return new;
end;
$$;
