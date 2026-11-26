/* Finance Hub — weekly profit & loss for stocks and crypto, rebuilt from your trades.
   Stocks: DEGIRO "Transactions" CSV export, stored as hub.investing.stockTrades; each instrument (ISIN) is linked
   to one of your positions (hub.investing.isinMap) so its weekly price history can be fetched with the same
   source as its live quote (Twelve Data or Alpha Vantage). Instruments without a feed are valued by drawing a
   straight line between the prices you traded at.
   Crypto: your trades list (hub.investing.buys + ledger), holdings worked back from the baseline.
   Weekly P&L = value at the end of the week − value at the end of the week before − money put in that week. */
(function(){
const DAY = 864e5, WEEK = 7 * DAY;
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch(e){ return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} };
// Monday 00:00 UTC of the week containing t
const weekOf = t => { const d = Math.floor(t / DAY) * DAY, wd = (new Date(d).getUTCDay() + 6) % 7; return d - wd * DAY; };
const dayMs = s => Date.UTC(+s.slice(0,4), +s.slice(5,7) - 1, +s.slice(8,10));

/* ---- DEGIRO CSV ---- */
function csvRows(text){
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i+1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
const num = s => { s = String(s || '').trim().replace(/\s/g, ''); if (!s) return null;
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  if (lc > ld) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, '');
  const n = parseFloat(s); return isFinite(n) ? n : null; };
function parseDegiro(text){
  const rows = csvRows(text.replace(/^﻿/, ''));
  if (!rows.length) throw new Error('The file is empty.');
  const h = rows[0].map(x => x.trim().toLowerCase());
  if (!(h[0] === 'datum' || h[0] === 'date') || !h.includes('isin')) throw new Error('This doesn’t look like a DEGIRO Transactions export.');
  const out = [], seen = {};
  for (const r of rows.slice(1)) {
    const m = (r[0] || '').trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/); if (!m) continue;
    const qty = num(r[6]), price = num(r[7]), total = num(r[15]) ?? num(r[11]);
    if (!qty || price == null || total == null || !r[3]) continue;
    const date = `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    let id = `${(r[16] || date + r[1]).trim()}|${qty}|${price}`; seen[id] = (seen[id] || 0) + 1; if (seen[id] > 1) id += '#' + seen[id];
    out.push({ id, date, time: (r[1] || '').trim(), name: r[2].trim(), isin: r[3].trim(), venue: (r[4] || '').trim(), qty, price, ccy: (r[8] || 'EUR').trim() || 'EUR', fx: (num(r[12]) > 0 ? +(1 / num(r[12])).toFixed(6) : 1), eur: -total });   // eur > 0 = money in (a buy)
  }
  if (!out.length) throw new Error('No trades found in this file.');
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}
// instruments in the trade list, with a running position; ones that go below zero started before the export, so they're left out
function instruments(trades){
  const by = {};
  for (const t of trades) { const i = by[t.isin] ||= { isin: t.isin, name: t.name, ccy: t.ccy, trades: [], qty: 0, broken: false }; i.trades.push(t); i.qty += t.qty; i.name = t.name; if (i.qty < -1e-9) i.broken = true; }
  for (const i of Object.values(by)) i.qty = Math.round(i.qty * 1e6) / 1e6;
  return by;
}
// guess which of your positions an instrument is: same number of shares on the baseline date, and/or similar name
const toks = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !/^(the|inc|corp|corporation|plc|ucits|etf|acc|usd|eur|class|holdings|limited|n\.?v)$/.test(w)));
function guessLinks(ins, stockMeta, baseline, baseDay){
  const map = {}, used = new Set();
  const cand = Object.values(ins).filter(i => !i.broken).map(i => {
    const qB = i.trades.filter(t => dayMs(t.date) <= baseDay).reduce((a, t) => a + t.qty, 0);
    const scores = (stockMeta || []).map(s => { const a = toks(i.name), b = toks(s.name + ' ' + s.sym); let k = 0; for (const w of a) if (b.has(w) || [...b].some(x => x.length > 3 && (w.startsWith(x) || x.startsWith(w)))) k++;
      const nameS = a.size ? k / Math.min(a.size, b.size || 1) : 0, qtyS = (baseline.stocks || {})[s.sym] != null && Math.abs(baseline.stocks[s.sym] - qB) < 1e-6 && qB > 0 ? 1 : 0;
      return { sym: s.sym, score: nameS + qtyS * 0.9, nameS }; }).sort((x, y) => y.score - x.score);
    return { i, scores };
  }).sort((x, y) => (y.scores[0] ? y.scores[0].score : 0) - (x.scores[0] ? x.scores[0].score : 0));
  for (const { i, scores } of cand) { const best = scores.find(s => !used.has(s.sym) && (s.score >= 1 || s.nameS >= 0.6)); if (best) { map[i.isin] = best.sym; used.add(best.sym); } }
  return map;
}

/* ---- weekly price history (cached on this device) ---- */
async function tdWeekly(sym, key){
  const r = await fetch('https://api.twelvedata.com/time_series?' + new URLSearchParams({ symbol: sym, interval: '1week', outputsize: '160', apikey: key }));
  const j = await r.json(); if (!j || j.status === 'error' || !j.values) throw new Error(j && j.message || 'no data');
  return j.values.map(v => [weekOf(dayMs(v.datetime)), +v.close]).filter(p => isFinite(p[1])).reverse();
}
async function avWeekly(sym, key){
  const r = await fetch('https://www.alphavantage.co/query?' + new URLSearchParams({ function: 'TIME_SERIES_WEEKLY', symbol: sym, apikey: key }));
  const j = await r.json(), s = j && j['Weekly Time Series'];
  if (!s) throw new Error(String(j && (j.Note || j.Information || j['Error Message']) || 'no data').slice(0, 120));
  return Object.entries(s).map(([d, v]) => [weekOf(dayMs(d)), +v['4. close']]).filter(p => isFinite(p[1])).sort((a, b) => a[0] - b[0]);
}
async function fxWeekly(from){
  const r = await fetch(`https://api.frankfurter.app/${new Date(from).toISOString().slice(0,10)}..?from=EUR&to=USD,GBP`);
  const j = await r.json(); if (!j || !j.rates) throw new Error('no FX');
  const out = {}; for (const [d, v] of Object.entries(j.rates)) out[weekOf(dayMs(d))] = { USD: 1 / v.USD, GBP: 1 / v.GBP };   // 1 USD/GBP in EUR, last day of each week wins
  return out;
}
const AV_DAY = () => new Date().toISOString().slice(0, 10);
// fetch what's missing or old. Past weeks never change, so a series is refreshed only once a week, and only while you still hold it.
async function ensureHistory({ ins, map, meta, keys, held, onStep }){
  const jobs = [];
  for (const i of Object.values(ins)) {
    const sym = map[i.isin], m = sym && (meta || []).find(s => s.sym === sym); if (!m) continue;
    const src = m.src === 'av' ? 'av' : 'td', ticker = src === 'av' ? m.av : m.sym, k = `fh-ph:${src}:${ticker}`, c = lsGet(k);
    const stale = !c || (held(sym) && Date.now() - c.at > 6.5 * DAY) || (c.err && Date.now() - c.at > 6 * 36e5);
    if (stale) jobs.push({ k, src, ticker });
  }
  const fxK = 'fh-ph:fx', fx = lsGet(fxK);
  if (!fx || Date.now() - fx.at > 6.5 * DAY) jobs.unshift({ k: fxK, src: 'fx' });
  let n = 0, avUsed = lsGet('fh-ph:avday'); if (!avUsed || avUsed.d !== AV_DAY()) avUsed = { d: AV_DAY(), n: 0 };
  for (const j of jobs) {
    onStep && onStep(++n, jobs.length);
    try {
      let pts;
      if (j.src === 'fx') pts = await fxWeekly(Date.now() - 3 * 365 * DAY);
      else if (j.src === 'td') { if (!keys.twelveData) continue; pts = await tdWeekly(j.ticker, keys.twelveData); await new Promise(r => setTimeout(r, 8000)); }
      else { if (!keys.alphaVantage || avUsed.n >= 12) continue; avUsed.n++; lsSet('fh-ph:avday', avUsed); pts = await avWeekly(j.ticker, keys.alphaVantage); await new Promise(r => setTimeout(r, 1300)); }
      lsSet(j.k, { at: Date.now(), pts });
    } catch (e) { const c = lsGet(j.k); lsSet(j.k, { ...(c || { pts: [] }), at: Date.now(), err: String(e.message || e) }); }
  }
  return jobs.length;
}
const cached = (meta, sym) => { const m = (meta || []).find(s => s.sym === sym); if (!m) return null; const c = lsGet(`fh-ph:${m.src === 'av' ? 'av' : 'td'}:${m.src === 'av' ? m.av : m.sym}`); return c && c.pts && c.pts.length ? c.pts : null; };

/* ---- the weekly series ---- */
function lastAtOrBefore(pts, w){ let lo = 0, hi = pts.length - 1, r = null; while (lo <= hi) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= w) { r = pts[mid]; lo = mid + 1; } else hi = mid - 1; } return r; }
function median(a){ const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; }

/* inputs:
   stockTrades, isinMap, stockMeta, live: { stocks:{sym:eurPerShare}, crypto:{id:eur} }
   cryptoTrades: { id: [{date, qty, eur, side}] }, cryptoBase: {id: qty} as of baseDay, cryptoCandles: {id: [[ms,o,h,l,c]]} */
function compute(o){
  const now = Date.now(), thisWeek = weekOf(now);
  const fxC = lsGet('fh-ph:fx'), FX = (fxC && fxC.pts) || {}, fxWeeks = Object.keys(FX).map(Number).sort((a, b) => a - b);
  const fxAt = (ccy, w, fallback) => { if (ccy === 'EUR') return 1; const c = ccy === 'GBp' || ccy === 'GBX' ? 'GBP' : ccy; let best = null; for (const k of fxWeeks) { if (k <= w) best = k; else break; }
    const r = best != null ? FX[best][c] : null; return (r || fallback || null) * (ccy === 'GBp' || ccy === 'GBX' ? 0.01 : 1); };
  const series = { Stocks: {}, Crypto: {} }, notes = [];
  // stocks
  const ins = instruments(o.stockTrades || []);
  let sStart = null;
  for (const i of Object.values(ins)) {
    if (i.broken) continue;
    const w0 = weekOf(dayMs(i.trades[0].date)); if (sStart == null || w0 < sStart) sStart = w0;
  }
  const sym = isin => (o.isinMap || {})[isin];
  const priceFns = {};
  for (const i of Object.values(ins)) {
    if (i.broken) continue;
    const tp = i.trades.map(t => [weekOf(dayMs(t.date)), t.price, t.fx || null]);   // week, local price, EUR per local unit at that trade
    const tFx = tp.find(x => x[2]) ? tp.filter(x => x[2]).slice(-1)[0][2] : null;
    let hist = sym(i.isin) ? cached(o.stockMeta, sym(i.isin)) : null, scale = 1;
    if (hist) {
      const r = tp.map(([w, p]) => { const h = lastAtOrBefore(hist, w); return h && h[1] ? p / h[1] : null; }).filter(x => x);
      const m = median(r);
      if (m == null) hist = null; else if (m < 0.85 || m > 1.18) { if (m > 0.004 && m < 250) scale = m; else hist = null; }
    }
    if (!hist && i.qty > 0) notes.push(i.name);
    const live = sym(i.isin) && o.live.stocks[sym(i.isin)];
    priceFns[i.isin] = w => {   // EUR per share at the end of week w
      if (w >= thisWeek && live) return live;
      if (hist) { const h = lastAtOrBefore(hist, w); if (h) return h[1] * scale * fxAt(i.ccy, w, tFx); }
      // straight line between the prices you traded at
      let a = null, b = null; for (const p of tp) { if (p[0] <= w) a = p; else { b = p; break; } }
      const p = !a ? b[1] : !b ? a[1] : a[1] + (b[1] - a[1]) * (w - a[0]) / ((b[0] - a[0]) || 1);
      return p * fxAt(i.ccy, w, tFx);
    };
  }
  // crypto: holdings worked back from the baseline
  let cStart = null;
  const cIds = new Set([...Object.keys(o.cryptoBase || {}), ...Object.keys(o.cryptoTrades || {})].filter(id => !/^(usd-coin|tether)$/.test(id)));
  for (const id of cIds) for (const t of o.cryptoTrades[id] || []) { const w = weekOf(dayMs(t.date)); if (cStart == null || w < cStart) cStart = w; }
  const cPrice = (id, w) => { if (w >= thisWeek && o.live.crypto[id]) return o.live.crypto[id]; const c = o.cryptoCandles[id]; if (!c || !c.length) return null; const p = lastAtOrBefore(c, w + WEEK - 1); return p ? p[4] : null; };
  const cQty = (id, end) => { let q = (o.cryptoBase || {})[id] || 0; for (const t of o.cryptoTrades[id] || []) { const d = dayMs(t.date), s = t.side === 'sell' ? -1 : 1;
      if (d > o.baseDay && d <= end) q += s * t.qty; else if (d > end && d <= o.baseDay) q -= s * t.qty; } return Math.max(0, q); };
  // walk the weeks
  const start = Math.min(...[sStart, cStart].filter(x => x != null)); if (!isFinite(start)) return { weeks: [], notes };
  const weeks = [];
  for (let w = start - WEEK; w <= thisWeek; w += WEEK) {
    const end = w + WEEK - 1, row = { w, v: {}, f: {} };
    // stocks
    if (sStart != null && w >= sStart - WEEK) { let v = 0, f = 0;
      for (const i of Object.values(ins)) { if (i.broken) continue; let q = 0; for (const t of i.trades) { const d = dayMs(t.date); if (d <= end) q += t.qty; if (d >= w && d <= end) f += t.eur; }
        if (Math.abs(q) > 1e-9) { const p = priceFns[i.isin](w); if (p != null) v += q * p; } }
      row.v.Stocks = v; row.f.Stocks = f; }
    // crypto
    if (cStart != null && w >= cStart - WEEK) { let v = 0, f = 0, miss = false;
      for (const id of cIds) { const q = cQty(id, end); if (q > 1e-12) { const p = cPrice(id, w); if (p == null) miss = true; else v += q * p; }
        for (const t of o.cryptoTrades[id] || []) { const d = dayMs(t.date); if (d >= w && d <= end) f += (t.side === 'sell' ? -1 : 1) * t.eur; } }
      row.v.Crypto = miss ? null : v; row.f.Crypto = f; }
    weeks.push(row);
  }
  // P&L per week; the first week of each class only sets the starting value
  const prev = {}, cum = { Stocks: 0, Crypto: 0 }, cap = { Stocks: 0, Crypto: 0 };
  for (const r of weeks) {
    r.p = {}; r.c = {}; r.cap = {};
    for (const k of ['Stocks', 'Crypto']) {
      if (r.v[k] === undefined) continue;
      if (r.v[k] === null) { r.v[k] = prev[k] != null ? prev[k] + r.f[k] : null; }   // missing price: assume flat
      if (prev[k] === undefined) { cap[k] += r.v[k] || 0; r.p[k] = 0; }
      else { r.p[k] = r.v[k] - prev[k] - r.f[k]; cap[k] += Math.max(0, r.f[k]); }
      cum[k] += r.p[k]; r.c[k] = cum[k]; r.cap[k] = cap[k]; prev[k] = r.v[k];
    }
    const ks = Object.keys(r.p);
    r.v.Total = ks.reduce((a, k) => a + (r.v[k] || 0), 0); r.p.Total = ks.reduce((a, k) => a + r.p[k], 0); r.c.Total = ks.reduce((a, k) => a + r.c[k], 0); r.cap.Total = ks.reduce((a, k) => a + r.cap[k], 0);
  }
  return { weeks: weeks.slice(1), notes, ins };
}

window.PnL = { parseDegiro, instruments, guessLinks, ensureHistory, compute, weekOf, WEEK };
})();
