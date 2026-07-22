-- Server-side functions the Edge Functions call via the service_role key.
-- Marking a deposit/withdrawal completed and adjusting the linked goal's
-- saved amount happen inside a single Postgres function so both writes
-- commit together, a crash between "mark completed" and "credit the goal"
-- can never leave one done without the other.
--
-- Every completion/failure function is guarded by `where status = 'pending'`
-- as part of the same atomic UPDATE, not a separate check-then-write, so a
-- duplicate callback retry from Safaricom (the same CheckoutRequestID or
-- ConversationID arriving twice) finds zero matching rows the second time
-- and does nothing further, it can never double-credit or double-debit a
-- goal. All four are SECURITY INVOKER (the default), deliberately not
-- SECURITY DEFINER: if a client somehow called one of these directly, the
-- UPDATE inside still runs as that caller for RLS purposes, and neither
-- table has an update policy for anyone but service_role, so the write
-- would simply match zero rows. The EXECUTE grants below are an explicit
-- second layer on top of that, not the only one.

create or replace function public.complete_deposit(
  p_checkout_request_id text,
  p_mpesa_receipt_number text,
  p_confirmed_amount numeric,
  p_result_code int,
  p_result_desc text
) returns public.deposits
language plpgsql
as $$
declare
  v_row public.deposits;
begin
  update public.deposits
    set status = 'completed',
        mpesa_receipt_number = p_mpesa_receipt_number,
        result_code = p_result_code,
        result_desc = p_result_desc,
        completed_at = now()
    where checkout_request_id = p_checkout_request_id
      and status = 'pending'
    returning * into v_row;

  if v_row.id is not null then
    update public.goals set saved = saved + p_confirmed_amount, updated_at = now()
      where id = v_row.goal_id;
  end if;

  return v_row;
end;
$$;

create or replace function public.fail_deposit(
  p_checkout_request_id text,
  p_result_code int,
  p_result_desc text
) returns public.deposits
language plpgsql
as $$
declare
  v_row public.deposits;
begin
  update public.deposits
    set status = 'failed', result_code = p_result_code, result_desc = p_result_desc, completed_at = now()
    where checkout_request_id = p_checkout_request_id and status = 'pending'
    returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.complete_withdrawal(
  p_conversation_id text,
  p_mpesa_transaction_id text,
  p_confirmed_amount numeric,
  p_result_code int,
  p_result_desc text
) returns public.withdrawals
language plpgsql
as $$
declare
  v_row public.withdrawals;
begin
  update public.withdrawals
    set status = 'completed',
        mpesa_transaction_id = p_mpesa_transaction_id,
        result_code = p_result_code,
        result_desc = p_result_desc,
        completed_at = now()
    where conversation_id = p_conversation_id
      and status = 'pending'
    returning * into v_row;

  if v_row.id is not null then
    update public.goals set saved = saved - p_confirmed_amount, updated_at = now()
      where id = v_row.goal_id;
  end if;

  return v_row;
end;
$$;

create or replace function public.fail_withdrawal(
  p_conversation_id text,
  p_result_code int,
  p_result_desc text
) returns public.withdrawals
language plpgsql
as $$
declare
  v_row public.withdrawals;
begin
  update public.withdrawals
    set status = 'failed', result_code = p_result_code, result_desc = p_result_desc, completed_at = now()
    where conversation_id = p_conversation_id and status = 'pending'
    returning * into v_row;
  return v_row;
end;
$$;

-- Read-only ledger balance for a goal: completed deposits minus
-- (completed + still-pending) withdrawals, both through this app's M-Pesa
-- flow specifically. Deliberately not goals.saved, that column also carries
-- whatever a user last typed into "Update saved" by hand, which has nothing
-- to do with how much this feature is actually safe to pay out again.
create or replace function public.goal_mpesa_balance(p_goal_id uuid)
returns numeric
language sql
stable
as $$
  select
    coalesce((select sum(amount) from public.deposits where goal_id = p_goal_id and status = 'completed'), 0)
    - coalesce((select sum(amount) from public.withdrawals where goal_id = p_goal_id and status in ('completed', 'pending')), 0);
$$;

revoke all on function public.complete_deposit from public;
revoke all on function public.fail_deposit from public;
revoke all on function public.complete_withdrawal from public;
revoke all on function public.fail_withdrawal from public;
revoke all on function public.goal_mpesa_balance from public;

grant execute on function public.complete_deposit to service_role;
grant execute on function public.fail_deposit to service_role;
grant execute on function public.complete_withdrawal to service_role;
grant execute on function public.fail_withdrawal to service_role;
grant execute on function public.goal_mpesa_balance to service_role;
