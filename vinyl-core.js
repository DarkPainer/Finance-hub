/* Finance Hub — vinyl collection valuation from Discogs.
   - Collection: /users/{user}/collection/folders/0/releases (title, artist, year, genres, your condition notes)
   - Price per record: /marketplace/price_suggestions/{release} for your recorded media condition (VG+ if none)
     — Discogs' suggestion from recent sales; needs seller settings filled in. Fallback: lowest current listing.
   - Discogs allows ~60 requests a minute, so a full run goes one request every ~1.1 s and saves progress
     as it goes. Runs weekly in the background; the first full run of a month is kept as that month's snapshot.
   Stored in hub.vinyl: { releases, prices, history:{ 'YYYY-MM': {rid: price} }, overrides, lastFull, cursor, ... } */
(function(){
const API = 'https://api.discogs.com';
const DEFAULT_COND = 'Very Good Plus (VG+)';
const CONDS = ['Mint (M)','Near Mint (NM or M-)','Very Good Plus (VG+)','Very Good (VG)','Good Plus (G+)','Good (G)','Fair (F)','Poor (P)'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
const WEEK = 7 * 864e5;

async function dget(path, token, tries = 4){
  for (let a = 0; a < tries; a++) {
    let r;
    try { r = await fetch(API + path, { headers: { Authorization: `Discogs token=${token}` } }); }
    catch(e) { if (a === tries-1) throw new Error('network: ' + e.message); await sleep(3000 * (a+1)); continue; }
    if (r.status === 429 || r.status >= 500) { if (a === tries-1) throw new Error('HTTP ' + r.status); await sleep(6000 * (a+1)); continue; }
    const j = await r.json().catch(() => null);
    if (r.status === 404) { dget.last404 = (j && j.message) || 'not found'; return null; }
    if (!r.ok) throw new Error((j && j.message) || ('HTTP ' + r.status));
    return j;
  }
}

function condOf(item){
  // Discogs collection notes: field 1 = media condition (when filled in)
  const n = (item.notes || []).find(n => n.field_id === 1 && n.value);
  const v = n && String(n.value).trim();
  return CONDS.includes(v) ? v : null;
}
function decadeOf(y){ y = +y; return y > 1900 ? `${Math.floor(y/10)*10}s` : 'Unknown'; }

// 1) the collection (a handful of requests, 100 records each)
async function fetchCollection(user, token, say){
  const out = {}; let page = 1, pages = 1;
  do {
    say && say(`Reading your collection (page ${page}${pages > 1 ? ' of ' + pages : ''})…`);
    const j = await dget(`/users/${encodeURIComponent(user)}/collection/folders/0/releases?per_page=100&page=${page}&sort=added&sort_order=desc`, token);
    if (!j) throw new Error('collection not found — check the Discogs username');
    pages = (j.pagination && j.pagination.pages) || 1;
    for (const it of j.releases || []) {
      const b = it.basic_information || {};
      const key = String(it.instance_id || it.id);
      out[key] = { rid: it.id, key, title: b.title || '', artist: (b.artists || []).map(a => a.name.replace(/\s\(\d+\)$/, '')).join(', '),
        year: b.year || null, genres: b.genres || [], styles: b.styles || [], format: (b.formats || []).map(f => [f.name, ...(f.descriptions||[])].join(' ')).join(', '),
        cond: condOf(it), added: it.date_added || null };
    }
    page++; await sleep(1100);
  } while (page <= pages);
  return out;
}

// 2) one price per record; resumable (cursor) with a checkpoint every 15 records
async function refresh(user, token, prev, say, checkpoint, force){
  const v = { releases:{}, prices:{}, history:{}, overrides:{}, ...(prev || {}) };
  v.prices = { ...(v.prices || {}) }; v.history = { ...(v.history || {}) };
  const resuming = !force && v.partial && v.cursor > 0 && v.releases && Object.keys(v.releases).length;
  if (!resuming) { v.releases = await fetchCollection(user, token, say); v.cursor = 0; v.runStart = Date.now(); v.log = []; v.stats = { suggested:0, lowest:0, none:0, errors:0 }; v.noSuggest = false; v.sugMiss = 0; v.suggestErr = null; }
  v.partial = true;
  const keys = Object.keys(v.releases);
  for (const k of Object.keys(v.prices)) if (!v.releases[k]) delete v.prices[k];          // sold / removed records
  for (let i = v.cursor || 0; i < keys.length; i++) {
    const r = v.releases[keys[i]], cond = r.cond || DEFAULT_COND;
    say && say(`Pricing record ${i+1} of ${keys.length}…`);
    let price = null, src = null;
    try {
      let s = null;
      if (v.noSuggest !== true) {
        try { s = await dget(`/marketplace/price_suggestions/${r.rid}`, token); }
        catch(e) { v.suggestErr = e.message; if (/seller|settings|permission|forbidden|422|403/i.test(e.message)) v.noSuggest = true; }
        if (s === null && !v.suggestErr) v.suggestErr = 'Discogs: ' + (dget.last404 || 'no suggestion');
        if (s && !Object.keys(s).length && !v.suggestErr) v.suggestErr = 'Discogs returned no suggested prices (check Seller Settings → currency)';
      }
      const c = s && (s[cond] || s[DEFAULT_COND]);
      if (c && typeof c.value === 'number' && c.value > 0) { price = c.value; src = 'suggested'; v.currency = c.currency || v.currency; v.suggestErr = null; v.noSuggest = false; }
      // after 5 refusals in a row, stop asking for suggestions this run (saves half the requests)
      if (!c) { v.sugMiss = (v.sugMiss || 0) + 1; if (v.sugMiss >= 5 && !v.stats.suggested) v.noSuggest = true; } else v.sugMiss = 0;
      if (price == null) {
        await sleep(1100);
        const st = await dget(`/marketplace/stats/${r.rid}`, token);
        const lp = st && st.lowest_price;
        if (lp && typeof lp.value === 'number' && lp.value > 0) { price = lp.value; src = 'lowest'; v.currency = lp.currency || v.currency; }
      }
    } catch(e) { v.stats.errors++; if (v.log.length < 8) v.log.push(`${r.artist} – ${r.title}: ${e.message}`); if (/seller settings|authenticat|unauthor|token/i.test(e.message)) { v.error = e.message; break; } }
    if (price != null) { v.prices[r.key] = { p: Math.round(price*100)/100, src, cond, at: Date.now() }; v.stats[src]++; }
    else if (!v.prices[r.key]) v.stats.none++;
    v.cursor = i + 1;
    if (checkpoint && (i % 15 === 14)) { try { await checkpoint({ ...v }); } catch(e){} }
    await sleep(1100);
  }
  if (v.cursor >= keys.length) {
    v.partial = false; v.cursor = 0; v.lastFull = Date.now(); v.error = v.error || null;
    const mk = monthKey();
    if (!v.history[mk]) { v.history[mk] = Object.fromEntries(Object.entries(v.prices).map(([k, x]) => [k, x.p])); v.snapAt = v.snapAt || {}; v.snapAt[mk] = v.lastFull; }
  }
  return v;
}

const due = v => !v || !v.lastFull || v.partial || (Date.now() - v.lastFull > WEEK);

// value of one record: your own price wins, then Discogs
const priceOf = (v, k) => { const o = v.overrides && v.overrides[k]; if (typeof o === 'number') return { p:o, src:'own' }; const x = v.prices && v.prices[k]; return x ? { p:x.p, src:x.src } : null; };

function summary(v){
  if (!v || !v.releases) return null;
  const mk = monthKey(), snapTaken = v.snapAt && v.snapAt[mk];
  let snap = (v.history || {})[mk] && !(snapTaken && v.lastFull && v.lastFull <= snapTaken) ? v.history[mk] : null;   // same check as the snapshot → nothing to compare yet
  // older runs didn't record when the snapshot was taken: if nothing differs from it, there's nothing to compare yet
  if (snap && !snapTaken && Object.entries(v.prices || {}).every(([k, x]) => snap[k] == null || Math.abs(snap[k] - x.p) < 0.005)) snap = null;
  const rows = Object.values(v.releases).map(r => {
    const pr = priceOf(v, r.key), base = snap && snap[r.key];
    const chg = pr && base != null && pr.src !== 'own' ? pr.p - base : null;
    return { ...r, price: pr ? pr.p : null, src: pr ? pr.src : null, chg, chgPct: chg != null && base ? chg / base * 100 : null, genre: (r.genres[0] || 'Unknown'), decade: decadeOf(r.year) };
  });
  const priced = rows.filter(r => r.price != null);
  const total = priced.reduce((s,r) => s + r.price, 0);
  const withChg = priced.filter(r => r.chg != null);
  const base = withChg.reduce((s,r) => s + (r.price - r.chg), 0), chg = withChg.reduce((s,r) => s + r.chg, 0);
  // per group: value now and per monthly snapshot
  const months = Object.keys(v.history || {}).sort();
  function groups(field){
    const g = {};
    for (const r of rows) { const k = r[field]; (g[k] ||= { key:k, n:0, now:0, base:0, chg:0, series:{} }); g[k].n++; if (r.price != null) g[k].now += r.price; if (r.chg != null) { g[k].chg += r.chg; g[k].base += r.price - r.chg; } }
    for (const m of months) { const h = v.history[m]; for (const r of rows) { const p = h[r.key]; if (p != null) { const G = g[r[field]]; G.series[m] = (G.series[m] || 0) + p; } } }
    return Object.values(g).map(x => ({ ...x, pct: x.base ? x.chg / x.base * 100 : null })).sort((a,b) => b.now - a.now);
  }
  const src = { suggested: priced.filter(r => r.src==='suggested').length, lowest: priced.filter(r => r.src==='lowest').length };
  return { src, suggestErr: v.suggestErr || null, rows, total, count: rows.length, pricedCount: priced.length, chg: withChg.length ? chg : null, chgPct: base ? chg / base * 100 : null, snapMonth: snap ? mk : null,
    genres: groups('genre'), decades: groups('decade'), months, currency: v.currency || 'EUR', lastFull: v.lastFull, partial: v.partial, cursor: v.cursor, stats: v.stats, error: v.error, log: v.log || [] };
}

// The collection's value comes from Discogs' own collection value (median of actual sales per record).
// The per-record prices (suggested price for one condition) are for comparing records, genres and decades;
// their sum is only used when the Discogs collection value isn't available.
function applyTo(prices, v){
  if (prices && prices.vinyl && prices.vinyl.median != null && prices.vinyl.src !== 'records') return prices;
  const s = summary(v);
  if (!prices || !s || !s.lastFull || s.pricedCount < s.count * 0.6) return prices;
  const fx = s.currency === 'EUR' ? 1 : (prices.rates && prices.rates[s.currency]) || null;
  if (!fx) return prices;
  return { ...prices, vinyl: { ...(prices.vinyl || {}), median: s.total * fx, src: 'records', records: s.pricedCount } };
}

window.VinylCore = { refresh, due, summary, applyTo, priceOf, monthKey, DEFAULT_COND };
})();
