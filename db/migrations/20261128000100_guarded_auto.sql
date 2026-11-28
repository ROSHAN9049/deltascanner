begin;

alter table public.dd_settings
  add column if not exists guarded_auto_enabled boolean not null default false,
  add column if not exists momentum_enabled boolean not null default false,
  add column if not exists scalping_enabled boolean not null default false,
  add column if not exists guarded_estop_active boolean not null default false,
  add column if not exists guarded_estop_activated_at timestamptz;

update public.dd_settings
set guarded_auto_enabled = false,
    momentum_enabled = false,
    scalping_enabled = false,
    guarded_estop_active = emergency_stop,
    auto_trade = false,
    options_enabled = false,
    options_execution_enabled = false,
    grid_enabled = false,
    max_open_positions = 1
where id = 1;

create table if not exists public.dd_guarded_auto_reservations (
  id uuid primary key default gen_random_uuid(),
  strategy text not null check (strategy in ('MOMENTUM','SCALPING')),
  symbol text not null check (symbol in ('XAUTUSD','PAXGUSD')),
  client_order_id text not null unique,
  state text not null default 'ACTIVE' check (state in ('ACTIVE','RELEASED','FAILED')),
  exchange_order_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  released_at timestamptz
);

-- One active reservation for the entire account, not one per symbol/strategy.
create unique index if not exists dd_guarded_auto_one_active_reservation_uq
  on public.dd_guarded_auto_reservations ((state))
  where state = 'ACTIVE';

create index if not exists dd_guarded_auto_reservations_created_idx
  on public.dd_guarded_auto_reservations (created_at desc);

create or replace function public.reserve_guarded_auto_entry(
  p_strategy text,
  p_symbol text,
  p_client_order_id text,
  p_metadata jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.dd_settings%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('dealdost-guarded-auto-global-entry'));
  select * into s from public.dd_settings where id = 1 for update;
  if not found
     or s.enabled is distinct from true
     or s.auto_trade is distinct from true
     or s.emergency_stop is distinct from false
     or s.guarded_auto_enabled is distinct from true
     or s.guarded_estop_active is distinct from false
     or upper(coalesce(p_symbol,'')) not in ('XAUTUSD','PAXGUSD')
     or upper(coalesce(p_strategy,'')) not in ('MOMENTUM','SCALPING')
     or (upper(p_strategy) = 'MOMENTUM' and s.momentum_enabled is distinct from true)
     or (upper(p_strategy) = 'SCALPING' and s.scalping_enabled is distinct from true)
     or coalesce(p_client_order_id,'') = '' then
    return false;
  end if;

  if exists (select 1 from public.dd_delta_positions where status = 'OPEN') then
    return false;
  end if;
  if exists (
    select 1 from public.dd_guarded_auto_reservations where state = 'ACTIVE'
  ) then
    return false;
  end if;

  insert into public.dd_guarded_auto_reservations
    (strategy, symbol, client_order_id, state, metadata)
  values
    (upper(p_strategy), upper(p_symbol), p_client_order_id, 'ACTIVE',
     coalesce(p_metadata, '{}'::jsonb))
  on conflict do nothing;

  return found;
end;
$$;

create or replace function public.release_guarded_auto_entry(
  p_client_order_id text,
  p_state text default 'RELEASED',
  p_exchange_order_id text default null,
  p_metadata jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if upper(coalesce(p_state,'')) not in ('RELEASED','FAILED') then
    raise exception 'Invalid guarded reservation terminal state';
  end if;
  update public.dd_guarded_auto_reservations
  set state = upper(p_state),
      exchange_order_id = coalesce(p_exchange_order_id, exchange_order_id),
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb),
      updated_at = now(),
      released_at = now()
  where client_order_id = p_client_order_id
    and state = 'ACTIVE';
  return found;
end;
$$;

revoke all on function public.reserve_guarded_auto_entry(text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.release_guarded_auto_entry(text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.reserve_guarded_auto_entry(text,text,text,jsonb) to service_role;
grant execute on function public.release_guarded_auto_entry(text,text,text,jsonb) to service_role;
alter table public.dd_guarded_auto_reservations enable row level security;
revoke all on public.dd_guarded_auto_reservations from anon, authenticated;
grant all on public.dd_guarded_auto_reservations to service_role;

commit;
