-- Finance Hub database. Paste this whole file into Supabase → SQL Editor → Run.

create table if not exists public.transactions (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  id         text not null,
  type       text not null check (type in ('expense','income')),
  cat        text not null,
  amount     integer not null check (amount > 0),   -- in cents
  date       date not null,
  note       text not null default '',
  src        text not null default 'manual',          -- manual | import
  h          text,                                    -- duplicate check for bank imports
  created    bigint,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists transactions_user_date on public.transactions (user_id, date desc);

create table if not exists public.settings (
  user_id    uuid primary key default auth.uid() references auth.users on delete cascade,
  categories jsonb,
  rules      jsonb,
  updated_at timestamptz not null default now()
);

-- Only you can see and change your own rows.
alter table public.transactions enable row level security;
alter table public.settings     enable row level security;

drop policy if exists "own transactions" on public.transactions;
create policy "own transactions" on public.transactions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own settings" on public.settings;
create policy "own settings" on public.settings
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Added 3 Nov 2026: investing + net worth (one row per user).
create table if not exists public.hub (
  user_id    uuid primary key default auth.uid() references auth.users on delete cascade,
  investing  jsonb,                         -- baseline, stocks, history, monthly snapshots
  ledger     jsonb not null default '[]',   -- buys and sells after the baseline
  overrides  jsonb not null default '{}',   -- manual prices
  prices     jsonb,                         -- last price run (shared cache, max ~1/day)
  api_keys   jsonb,                         -- Twelve Data / Alpha Vantage keys
  bank       jsonb not null default '{}',   -- closing balance per statement: {"2026-01-31": 123456}
  updated_at timestamptz not null default now()
);
alter table public.hub enable row level security;
drop policy if exists "own hub" on public.hub;
create policy "own hub" on public.hub
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Supabase stopped exposing new tables to the app automatically (30 Oct 2026),
-- so grant the signed-in role access explicitly. Row-level security above still
-- limits every row to its owner.
grant select, insert, update, delete on table public.transactions, public.settings, public.hub to authenticated;

-- Added 3 Nov 2026: Pokémon stock (sent by the Pokémon dashboard) and its daily prices.
alter table public.hub add column if not exists pokemon jsonb;
alter table public.hub add column if not exists pokemon_prices jsonb;
