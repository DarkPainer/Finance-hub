/* Finance Hub — crypto price history with your buys marked on it.
   Daily EUR closes come from Binance's public market data (up to ~5 years), with CoinGecko
   (last 365 days) as fallback. They are cached on this device and topped up at most every 6 hours.
   Your buys live in hub.investing.buys = [{ id, coin, date:'YYYY-MM-DD', qty, eur }] and are
   for display only: they never change your holdings. Trades logged in the ledger are shown too. */
(function(){
const DAY = 864e5, TTL = 6 * 36e5;
const LSK = id => 'fh-cx:' + id;
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch(e){ return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} };

async function binance(sym){
  const pair = sym.toUpperCase() + 'EUR'; let end = null; const out = [];
  for (let page = 0; page < 2; page++) {
    const u = `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=1d&limit=1000` + (end ? `&endTime=${end}` : '');
    const r = await fetch(u); if (!r.ok) break;
    const j = await r.json(); if (!Array.isArray(j) || !j.length) break;
    out.unshift(...j.map(k => [k[0], +k[4]]));
    if (j.length < 1000) break; end = j[0][0] - 1;
  }
  return out;
}
async function gecko(id){
  const r = await fetch(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=eur&days=365&interval=daily`);
  if (!r.ok) return [];
  const j = await r.json().catch(() => null);
  return (j && j.prices || []).map(([t, p]) => [Math.floor(t / DAY) * DAY, p]);
}
// daily closes [[ms, eur]], cached; force = ignore the cache age
async function history(id, sym, force){
  const c = lsGet(LSK(id));
  if (c && !force && Date.now() - c.at < TTL) return c;
  let pts = [], src = '';
  try { pts = await binance(sym); src = 'Binance'; } catch(e){}
  if (pts.length < 30) { try { const g = await gecko(id); if (g.length > pts.length) { pts = g; src = 'CoinGecko'; } } catch(e){} }
  if (!pts.length) return c ? { ...c, stale: true } : { at: 0, pts: [], src: '', failed: true };
  const v = { at: Date.now(), pts, src }; lsSet(LSK(id), v); return v;
}

// buys for one coin: your list + crypto buys from the trade ledger (skipping exact duplicates)
function buysFor(inv, ledger, id){
  const own = (inv.buys || []).filter(b => b.coin === id).map(b => ({ ...b, src: 'list' }));
  const seen = new Set(own.map(b => `${b.date}|${(+b.qty).toPrecision(6)}`));
  for (const t of ledger || []) {
    if (t.cls !== 'Crypto' || t.asset !== id || !(t.qty > 0) || !(t.eur > 0)) continue;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : (() => { const x = new Date(t.date); return isNaN(x) ? null : x.toISOString().slice(0,10); })();
    if (!d || seen.has(`${d}|${(+t.qty).toPrecision(6)}`)) continue;
    own.push({ id: 'L' + d + t.qty, coin: id, date: d, qty: +t.qty, eur: +t.eur, src: 'ledger' });
  }
  return own.sort((a, b) => a.date.localeCompare(b.date));
}

// "2025-03-12, BTC, 0.01, 750" (also 12-03-2025, ; or tab separated, € and decimal commas)
function parseLines(text, symToId){
  const ok = [], bad = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const parts = line.split(/\s*[;\t]\s*|\s*,\s+|\s{2,}/).filter(Boolean);
    if (parts.length < 4) { bad.push(line); continue; }
    let [d, s, q, e] = parts;
    const m1 = d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/), m2 = d.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    const date = m1 ? `${m1[1]}-${m1[2].padStart(2,'0')}-${m1[3].padStart(2,'0')}` : m2 ? `${m2[3]}-${m2[2].padStart(2,'0')}-${m2[1].padStart(2,'0')}` : null;
    const coin = symToId[s.toUpperCase()] || (Object.values(symToId).includes(s.toLowerCase()) ? s.toLowerCase() : null);
    const num = t => { t = String(t).replace(/[€\s]/g,''); if (t.includes(',') && t.includes('.')) t = t.replace(/\./g,'').replace(',','.'); else t = t.replace(',','.'); return parseFloat(t); };
    const qty = num(q), eur = num(e);
    if (!date || !coin || !(qty > 0) || !(eur > 0)) { bad.push(line); continue; }
    ok.push({ coin, date, qty, eur });
  }
  return { ok, bad };
}

window.CryptoChart = { history, buysFor, parseLines, DAY };
})();
