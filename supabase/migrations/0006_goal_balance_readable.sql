-- goal_mpesa_balance (added in 0005) started service_role-only since it was
-- first only needed inside initiate-b2c-withdrawal's authoritative check.
-- The Withdraw button's UI also wants to show/enable against this same
-- number, so it needs to be callable by a signed-in user directly.
--
-- This is safe to open up: the function is SECURITY INVOKER (the default),
-- so when an authenticated user calls it, the SUMs inside still run under
-- their own RLS, a goal_id that isn't theirs simply has no visible
-- deposits/withdrawals rows to sum, and the function returns 0, never
-- another user's real balance.

grant execute on function public.goal_mpesa_balance to authenticated;
