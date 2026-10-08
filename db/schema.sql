create extension if not exists pgcrypto;

create table if not exists public.dd_settings (
  id bigint primary key default 1,
  enabled boolean not null default true,
  auto_trade boolean not null default true,
  emergency_stop boolean not null default false,
  continuous_mode boolean not null default true,
  max_open_positions integer not null default 20,
  risk_pct numeric not null default 1,
  max_leverage numeric not null default 3,
  momentum_sl_min_pct numeric not null default 0.95,
  scalping_sl_min_pct numeric not null default 0.75,
  momentum_rr numeric not null default 2.5,
  scalping_rr numeric not null default 2.5,
  tp1_r numeric not null default 1,
  tp1_pct numeric not null default 33,
  max_hold_minutes integer not null default 240,
  trail_r numeric not null default 1,
  score_min integer not null default 80,
  options_enabled boolean not null default true,
  options_buy_enabled boolean not null default true,
  options_sell_enabled boolean not null default true,
  options_buy_min_delta numeric not null default 0.45,
  options_buy_max_delta numeric not null default 0.65,
  options_sell_min_delta numeric not null default 0.20,
  options_sell_max_delta numeric not null default 0.35,
  options_min_oi numeric not null default 50,
  options_min_volume numeric not null default 1,
  options_max_spread_pct numeric not null default 1.50,
  options_min_days_to_expiry integer not null default 2,
  options_max_days_to_expiry integer not null default 14,
  options_buy_stop_pct numeric not null default 25,
  options_buy_tp1_pct numeric not null default 30,
  options_buy_tp_pct numeric not null default 60,
  options_max_risk_pct numeric not null default 0.30,
  options_max_open_positions integer not null default 1,
  options_sell_defined_risk_only boolean not null default true,
  options_execution_enabled boolean not null default false,
  options_updated_at timestamptz not null default now(),
  equity numeric not null default 0,
  available_balance numeric not null default 0,
  realized_pnl numeric not null default 0,
  unrealized_pnl numeric not null default 0,
  fees_today numeric not null default 0,
  last_tick_at timestamptz,
  worker_started_at timestamptz,
  idle_reason text not null default 'Starting',
  updated_at timestamptz not null default now()
);
insert into public.dd_settings(id) values (1) on conflict (id) do nothing;

create table if not exists public.dd_engine_lease (
  id bigint primary key default 1,
  lease_id text,
  worker_id text,
  expires_at timestamptz,
  heartbeat_at timestamptz
);
insert into public.dd_engine_lease(id) values (1) on conflict (id) do nothing;

create table if not exists public.dd_positions (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  product_id bigint not null,
  side text not null,
  qty numeric not null,
  entry_price numeric not null,
  current_price numeric,
  stop_price numeric,
  tp1_price numeric,
  tp_price numeric,
  initial_qty numeric not null,
  tp1_done boolean not null default false,
  protection_verified boolean not null default false,
  protection_order_id text,
  tp1_order_id text,
  tp_order_id text,
  entry_order_id text,
  client_order_id text,
  execution_id text unique,
  strategy text not null,
  origin text not null default 'ENGINE',
  requested_exit_reason text,
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists dd_positions_open_symbol_uq on public.dd_positions(symbol) where qty > 0;

create table if not exists public.dd_orders (
  id text primary key,
  product_id bigint,
  symbol text,
  side text,
  order_type text,
  stop_order_type text,
  size numeric,
  unfilled_size numeric,
  limit_price numeric,
  stop_price numeric,
  reduce_only boolean,
  state text,
  client_order_id text unique,
  role text,
  strategy text,
  execution_id text,
  raw jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.dd_trades (
  id uuid primary key default gen_random_uuid(),
  execution_id text not null unique,
  symbol text not null,
  strategy text not null,
  side text not null,
  entry_price numeric not null,
  exit_price numeric,
  qty numeric not null,
  entry_notional numeric,
  exit_notional numeric,
  fees numeric not null default 0,
  gross_pnl numeric not null default 0,
  net_pnl numeric not null default 0,
  pnl_pct numeric,
  r_multiple numeric,
  exit_reason text,
  result text,
  entry_fill_ids jsonb default '[]'::jsonb,
  exit_fill_ids jsonb default '[]'::jsonb,
  opened_at timestamptz,
  closed_at timestamptz
);
create index if not exists dd_trades_closed_idx on public.dd_trades(closed_at desc);

create table if not exists public.dd_fills (
  id text primary key,
  order_id text,
  product_id bigint,
  symbol text,
  side text,
  size numeric,
  price numeric,
  notional numeric,
  commission numeric,
  role text,
  fill_type text,
  created_at timestamptz,
  raw jsonb
);

create table if not exists public.dd_signals (
  id uuid primary key default gen_random_uuid(),
  captured_at timestamptz not null default now(),
  symbol text not null,
  product_id bigint not null,
  rank integer,
  strategy text not null,
  price numeric,
  change_24h numeric,
  turnover_usd numeric,
  spread_pct numeric,
  volume_spike numeric,
  score numeric,
  stage text,
  side text,
  rsi numeric,
  trend text,
  confirm_trend text,
  btc_trend text,
  ema21 numeric,
  atr_5m numeric,
  atr_15m numeric,
  support numeric,
  resistance numeric,
  stop_price numeric,
  tp1_price numeric,
  tp_price numeric,
  qty_contracts numeric,
  notional numeric,
  risk_usd numeric,
  fee_risk_ratio numeric,
  ready boolean,
  blocked_reasons jsonb default '[]'::jsonb,
  details jsonb default '{}'::jsonb
);
create index if not exists dd_signals_time_idx on public.dd_signals(captured_at desc);
create index if not exists dd_signals_symbol_idx on public.dd_signals(symbol);

create table if not exists public.dd_market_cache (
  symbol text primary key,
  product_id bigint not null,
  contract_type text not null,
  state text,
  trading_status text,
  underlying_asset text,
  price numeric,
  mark_price numeric,
  change_24h numeric,
  turnover_usd numeric,
  volume numeric,
  open_interest numeric,
  bid numeric,
  ask numeric,
  spread_pct numeric,
  tick_size numeric,
  contract_value numeric,
  notional_type text,
  max_leverage numeric,
  max_leverage_notional numeric,
  position_notional_limit numeric,
  market_rank integer,
  active boolean not null default true,
  cached_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb
);
create index if not exists dd_market_cache_rank_idx on public.dd_market_cache(market_rank);
create index if not exists dd_market_cache_cached_idx on public.dd_market_cache(cached_at desc);

create table if not exists public.dd_signal_cache (
  cache_key text primary key,
  symbol text not null,
  product_id bigint not null,
  strategy text not null,
  price numeric,
  change_24h numeric,
  turnover_usd numeric,
  spread_pct numeric,
  volume_spike numeric,
  score numeric,
  stage text,
  side text,
  rsi numeric,
  trend text,
  confirm_trend text,
  btc_trend text,
  ema21 numeric,
  atr_5m numeric,
  atr_15m numeric,
  support numeric,
  resistance numeric,
  stop_price numeric,
  tp1_price numeric,
  tp_price numeric,
  qty_contracts numeric,
  notional numeric,
  risk_usd numeric,
  fee_risk_ratio numeric,
  ready boolean,
  blocked_reasons jsonb not null default '[]'::jsonb,
  details jsonb not null default '{}'::jsonb,
  cached_at timestamptz not null default now(),
  unique(symbol, strategy)
);
create index if not exists dd_signal_cache_score_idx on public.dd_signal_cache(strategy, score desc);
create index if not exists dd_signal_cache_cached_idx on public.dd_signal_cache(cached_at desc);

create table if not exists public.dd_option_cache (
  cache_key text primary key,
  underlying text not null,
  strategy text not null,
  symbol text not null,
  product_id bigint,
  option_type text,
  strike numeric,
  expiry_ms bigint,
  dte numeric,
  mark numeric,
  bid numeric,
  ask numeric,
  spread_pct numeric,
  oi numeric,
  volume numeric,
  delta numeric,
  gamma numeric,
  theta numeric,
  vega numeric,
  score numeric,
  stage text,
  side text,
  ready boolean,
  blocked_reasons jsonb not null default '[]'::jsonb,
  details jsonb not null default '{}'::jsonb,
  cached_at timestamptz not null default now(),
  unique(underlying, strategy)
);
create index if not exists dd_option_cache_score_idx on public.dd_option_cache(underlying, strategy, score desc);
create index if not exists dd_option_cache_cached_idx on public.dd_option_cache(cached_at desc);

create table if not exists public.dd_tradetron_events (
  event_id text primary key,
  event_type text not null,
  deployment_id text,
  execution_id text,
  symbol text,
  side text,
  qty numeric,
  price numeric,
  pnl numeric,
  status text,
  event_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists dd_tradetron_events_created_idx on public.dd_tradetron_events(created_at desc);
create index if not exists dd_tradetron_events_execution_idx on public.dd_tradetron_events(execution_id);

alter table public.dd_tradetron_events enable row level security;

create table if not exists public.dd_daily_pnl (
  trade_date date primary key,
  realized numeric not null default 0,
  fees numeric not null default 0,
  wins integer not null default 0,
  losses integer not null default 0,
  trades integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.dd_rotation_ledger (
  id uuid primary key default gen_random_uuid(),
  execution_id text not null unique,
  trade_id uuid,
  profit numeric not null,
  released numeric not null,
  retained numeric not null,
  rotation_id text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.dd_counters (
  id bigint primary key default 1,
  consecutive_losses integer not null default 0,
  last_loss_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.dd_counters(id) values (1) on conflict (id) do nothing;

create table if not exists public.dd_engine_logs (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  level text not null default 'INFO',
  message text not null,
  data jsonb
);
create index if not exists dd_engine_logs_created_idx on public.dd_engine_logs(created_at desc);

create or replace function public.acquire_dd_lease(p_lease_id text, p_worker_id text, p_ttl_seconds integer)
returns boolean
language sql
as $$
  update public.dd_engine_lease
  set lease_id = p_lease_id, worker_id = p_worker_id,
      expires_at = now() + make_interval(secs => p_ttl_seconds), heartbeat_at = now()
  where id = 1 and (expires_at is null or expires_at < now() or lease_id = p_lease_id)
  returning true;
$$;

create or replace function public.release_dd_lease(p_lease_id text)
returns boolean
language sql
as $$
  update public.dd_engine_lease
  set lease_id = null, worker_id = null, expires_at = null, heartbeat_at = now()
  where id = 1 and lease_id = p_lease_id
  returning true;
$$;

alter table public.dd_market_cache enable row level security;
alter table public.dd_signal_cache enable row level security;
alter table public.dd_option_cache enable row level security;
alter table public.dd_settings enable row level security;
alter table public.dd_engine_lease enable row level security;
alter table public.dd_positions enable row level security;
alter table public.dd_orders enable row level security;
alter table public.dd_trades enable row level security;
alter table public.dd_fills enable row level security;
alter table public.dd_signals enable row level security;
alter table public.dd_daily_pnl enable row level security;
alter table public.dd_rotation_ledger enable row level security;
alter table public.dd_counters enable row level security;
alter table public.dd_engine_logs enable row level security;