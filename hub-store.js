/* Finance Hub — the per-user `hub` row (investing data, prices, bank balances).
   Shared by index.html (Hub tab) and investing.html. */
(function(){
const COLS = 'investing,ledger,overrides,prices,api_keys,bank';
const COLS_PK = COLS + ',pokemon,pokemon_prices';
const COLS_ALL = COLS_PK + ',vinyl';
const VINYL_SQL = 'alter table public.hub add column if not exists vinyl jsonb;';
const POKEMON_SQL = `alter table public.hub add column if not exists pokemon jsonb;
alter table public.hub add column if not exists pokemon_prices jsonb;`;
const LSK = 'fh-hub';
const SETUP_SQL = `-- Finance Hub database. Paste this whole file into Supabase → SQL Editor → Run.

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
grant select, insert, update, delete on table public.transactions, public.settings, public.hub to authenticated;`;

const isMissingTable = e => !!e && (e.code === '42P01' || e.code === 'PGRST205' || (e.code === '42501' && /table hub/i.test(e.message||'')) || /could not find the table|relation .*hub.* does not exist/i.test(e.message || ''));

const HubStore = {
  SETUP_SQL, POKEMON_SQL, VINYL_SQL, row: null, missing: false, pokemonMissing: false, vinylMissing: false, uid: null, sb: null,
  cached(){ try { const c = JSON.parse(localStorage.getItem(LSK) || 'null'); return c && c.uid === this.uid ? c.row : null; } catch(e){ return null; } },
  keep(){ try { localStorage.setItem(LSK, JSON.stringify({uid: this.uid, row: this.row})); } catch(e){} },
  demo: false,
  initDemo(row){ this.demo = true; this.uid = 'demo'; this.row = row; this.missing = false; this.pokemonMissing = false; return row; },
  init(sb, uid){ this.sb = sb; this.uid = uid; this.row = this.cached(); return this.row; },
  async load(){
    if (this.demo) return this.row;
    const colErr = e => e && (e.code === '42703' || /column .* does not exist/i.test(e.message||''));
    let { data, error } = await this.sb.from('hub').select(COLS_ALL).maybeSingle();
    this.vinylMissing = false;
    if (colErr(error)) { this.vinylMissing = true; ({ data, error } = await this.sb.from('hub').select(COLS_PK).maybeSingle()); }   // vinyl column not added yet
    if (colErr(error)) { this.pokemonMissing = true; ({ data, error } = await this.sb.from('hub').select(COLS).maybeSingle()); }    // Pokémon columns not added yet
    else if (!error) this.pokemonMissing = false;
    if (error) { if (isMissingTable(error)) { this.missing = true; return null; } throw error; }
    this.missing = false;
    this.row = data || { investing:null, ledger:[], overrides:{}, prices:null, api_keys:null, bank:{} };
    this.keep(); return this.row;
  },
  async save(patch){
    if (this.demo) { this.row = { ...(this.row || {}), ...patch }; return; }
    if (this.missing) throw new Error('The investing table isn’t set up yet.');
    const body = { user_id: this.uid, ...patch, updated_at: new Date().toISOString() };
    const { error } = await this.sb.from('hub').upsert(body, { onConflict: 'user_id' });
    if (error) { if (isMissingTable(error)) this.missing = true; throw error; }
    this.row = { ...(this.row || {}), ...patch }; this.keep();
  },
  hasInvesting(){ return !!(this.row && this.row.investing && this.row.investing.baseline); },
  latestBank(){
    const b = (this.row && this.row.bank) || {}; const ds = Object.keys(b).sort();
    return ds.length ? { date: ds[ds.length-1], cents: b[ds[ds.length-1]] } : null;
  },
  // turn an import file into a row patch (validates the shape)
  fromImportFile(j){
    if (!j || j.format !== 'finance-hub-investing-v1' || !j.investing || !j.investing.baseline) throw new Error('This isn’t a Finance Hub investing file.');
    const patch = { investing: j.investing, ledger: Array.isArray(j.ledger) ? j.ledger : [] };
    if (j.api_keys) patch.api_keys = j.api_keys;
    if (j.overrides) patch.overrides = j.overrides;
    if (j.bank) patch.bank = { ...((this.row && this.row.bank) || {}), ...j.bank };
    return patch;
  },
  exportFile(){
    const r = this.row || {};
    return { format:'finance-hub-investing-v1', exported: new Date().toISOString().slice(0,10), investing:r.investing, ledger:r.ledger||[], overrides:r.overrides||{}, api_keys:r.api_keys||null, bank:r.bank||{} };
  },
};
window.HubStore = HubStore;
})();
