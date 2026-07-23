-- One time onboarding tour, shown exactly once right after the very first
-- successful sign in for a brand new account — never on a returning
-- user's sign in, and never again on a second device or after a
-- reinstall for an existing account. That durability is exactly why this
-- is a column on profiles rather than something kept in localStorage: a
-- flag on this device would reappear the moment the same account signs
-- in somewhere else.
--
-- The default is false, so every new profiles row the handle_new_user
-- trigger creates from this point forward (see 0001_init.sql/
-- 0002_google_auth.sql) starts out "not yet seen" — that is what makes a
-- brand new account detectable at all, see reconcile() in app.js. Every
-- row that already exists at the moment this migration runs belongs to an
-- account that was signing in long before this feature existed, so those
-- are explicitly backfilled to true here, in the same migration, so
-- nobody already using the app is retroactively shown a first time tour.

alter table public.profiles add column if not exists tour_seen boolean not null default false;

update public.profiles set tour_seen = true where tour_seen = false;
