/* Finance Hub — investing calculations (ported from the Investing Dashboard).
   Pure functions, no UI. Used by the Hub (KPIs, net worth) and investing.html.
   Personal data (holdings, history, API keys) is NOT in this file: it lives in
   the user's Supabase `hub` row and is imported once from a private file. */
(function(){
const CLASSES = ["Crypto","Stocks","Vinyl","Silver"];
const LABEL = { Silver:"Metal" };                       // stored as "Silver", shown as "Metal"
const classLabel = c => LABEL[c] || c;
const GRAMS_PER_TROY_OZ = 31.1034768;
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseDate(s){
  s = String(s ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if(m) return new Date(+m[1], +m[2]-1, +m[3]);
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})/);
  if(m){ const i = MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase()); if(i >= 0) return new Date(+m[3], i, +m[1]); }
  const d = new Date(s);
  return isNaN(d) ? d : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
const monthKey = d => MONTHS[d.getMonth()] + " " + d.getFullYear();
const fmtDay = d => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

/* ---- holdings = baseline + ledger trades dated after the baseline ---- */
function derive(inv, ledgerIn){
  const B = inv.baseline, baseDay = parseDate(B.date);
  const LEDGER = [], warnings = [];
  for(const t of (ledgerIn || [])){
    const d = parseDate(t.date);
    if(isNaN(d)) warnings.push(`Ledger entry ${t.asset} ${t.date} has an unreadable date — ignored.`);
    else if(d <= baseDay) warnings.push(`Ledger entry ${t.asset} ${t.date} is on or before the baseline (${B.date}) — ignored.`);
    else LEDGER.push(t);
  }
  const q = (cls, asset) => LEDGER.filter(t => t.cls === cls && t.asset === asset).reduce((s,t) => s + (Number(t.qty)||0), 0);
  const CRYPTO = {};
  for(const [id, units] of Object.entries(B.crypto || {})){ const n = units + q("Crypto", id); if(n > 0) CRYPTO[id] = n; }
  for(const t of LEDGER) if(t.cls === "Crypto" && !(t.asset in CRYPTO)){ const n = q("Crypto", t.asset); if(n > 0) CRYPTO[t.asset] = n; }
  const SILVER_GRAMS = (B.silverGrams || 0) + q("Silver", "silver");
  const BROKER_CASH = B.cashEur || 0;
  const STOCKS = (inv.stockMeta || []).map(s => ({ ...s, qty: ((B.stocks||{})[s.sym] || 0) + q("Stocks", s.sym) })).filter(s => s.qty > 0);
  const byMonth = {};
  for(const t of LEDGER){
    const d = parseDate(t.date), key = monthKey(d);
    byMonth[key] ||= { month:key, sort:new Date(d.getFullYear(), d.getMonth(), 1).getTime(), Crypto:0, Stocks:0, Vinyl:0, Silver:0 };
    if(t.cls in byMonth[key]) byMonth[key][t.cls] += Number(t.eur) || 0;
  }
  const invested = (inv.investedHistory || []).map(r => ({ ...r }));
  for(const { sort, ...row } of Object.values(byMonth).sort((a,b) => a.sort - b.sort)){
    const h = invested.find(r => r.month === row.month);
    if(h) for(const c of CLASSES) h[c] += row[c]; else invested.push(row);
  }
  return { LEDGER, CRYPTO, STOCKS, SILVER_GRAMS, BROKER_CASH, invested, warnings, baseDay };
}

/* ---- price fetching (free APIs, rate-limited) ---- */
async function fetchPrices(inv, d, keys, onProgress, prev, onPartial){
  const LOG = [], ok = (l, x) => LOG.push({label:l, ok:true, detail:x}), fail = (l, x) => LOG.push({label:l, ok:false, detail:x});
  const feedWarnings = [];
  const say = t => { try { onProgress && onProgress(t); } catch(e){} };
  const TD = keys && keys.twelveData, AV = keys && keys.alphaVantage;
  const label = inv.cryptoLabel || {};

  async function getJSON(url){ const r = await fetch(url); const j = await r.json().catch(() => null); return { r, j }; }
  async function pause(what){ for(let s = 60; s > 0; s--){ say(`Free-plan rate limit — resuming in ${s}s (${what})`); await sleep(1000); } }
  async function waves(jobs, n){ const out = []; for(let i = 0; i < jobs.length; i += n){ if(i) await pause(`${i} of ${jobs.length} quotes done`); say(`Fetching quotes ${i+1}–${Math.min(i+n, jobs.length)} of ${jobs.length}…`); out.push(...await Promise.all(jobs.slice(i, i+n).map(f => f()))); } return out; }

  // crypto
  say("Fetching crypto prices…");
  const cryptoEur = {};
  const ids = Object.keys(d.CRYPTO);
  if(ids.length){
    try{
      const { r, j } = await getJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=eur`);
      if(!r.ok) throw new Error("HTTP " + r.status);
      for(const id of ids){ if(j && j[id] && typeof j[id].eur === "number") cryptoEur[id] = j[id].eur; else feedWarnings.push(`No CoinGecko price for ${label[id]||id}.`); }
      ok("Crypto (CoinGecko)", `${Object.keys(cryptoEur).length} of ${ids.length} coins priced`);
    }catch(e){ fail("Crypto (CoinGecko)", e.message); feedWarnings.push("CoinGecko unreachable: " + e.message); }
  }

  // FX
  say("Fetching exchange rates…");
  const rates = { EUR:1 };
  for(const host of ["api.frankfurter.dev/v1", "api.frankfurter.app"]){
    try{
      const { j } = await getJSON(`https://${host}/latest?base=EUR&symbols=USD,GBP`);
      if(j && j.rates && j.rates.USD && j.rates.GBP){ rates.USD = 1/j.rates.USD; rates.GBP = 1/j.rates.GBP; ok("FX (ECB via " + host + ")", `1 USD = ${rates.USD.toFixed(4)} EUR`); break; }
      fail("FX (" + host + ")", "unexpected response");
    }catch(e){ fail("FX (" + host + ")", "unreachable — " + e.message); }
  }

  async function tdQuote(l, params){
    if(!TD){ fail(l, "no Twelve Data key"); return null; }
    let j;
    try{ ({ j } = await getJSON("https://api.twelvedata.com/quote?" + new URLSearchParams({ ...params, apikey:TD, dp:"4" }))); }
    catch(e){ fail(l, "network failure — " + e.message); return null; }
    if(j && (j.status === "error" || (j.code && j.code !== 200))){ fail(l, `API ${j.code||"error"}: ${j.message||""}`); return null; }
    const px = parseFloat(j && (j.close ?? j.previous_close));
    if(!isFinite(px)){ fail(l, "no price in response"); return null; }
    ok(l, `${px} ${j.currency||"?"}`); return { price:px, ccy:(j.currency||"EUR").trim() };
  }
  async function avQuote(l, s){
    if(!AV){ fail(l, "no Alpha Vantage key"); return null; }
    let j;
    try{ ({ j } = await getJSON("https://www.alphavantage.co/query?" + new URLSearchParams({ function:"GLOBAL_QUOTE", symbol:s.av, apikey:AV }))); }
    catch(e){ fail(l, "network failure — " + e.message); return null; }
    const notice = j && (j.Note || j.Information || j["Error Message"]);
    if(notice){ fail(l, String(notice).slice(0,200)); return null; }
    const px = parseFloat(j && j["Global Quote"] && j["Global Quote"]["05. price"]);
    if(!isFinite(px)){ fail(l, "symbol not found or empty response"); return null; }
    ok(l, `${px} ${s.ccy}`); return { price:px, ccy:s.ccy };
  }

  // silver
  let xagUsd = null;
  {
    try{ const { j } = await getJSON("https://api.gold-api.com/price/XAG"); const px = parseFloat(j && j.price); if(isFinite(px)){ xagUsd = px; ok("Silver spot (gold-api.com)", px + " USD/oz"); } else fail("Silver spot (gold-api.com)", "no price"); }
    catch(e){ fail("Silver spot (gold-api.com)", "unreachable — " + e.message); }
  }

  // stocks
  const quotes = {};
  const td = d.STOCKS.filter(s => s.src === "td"), av = d.STOCKS.filter(s => s.src === "av");
  const first = await waves(td.map(s => () => tdQuote(`${s.sym} (Twelve Data)`, { symbol:s.sym }).then(q => ({ s, q }))), 7);
  for(const { s, q } of first) if(q) quotes[s.sym] = q;
  if(onPartial){ try { await onPartial({ cryptoEur:{...((prev&&prev.cryptoEur)||{}), ...cryptoEur}, quotes:{...((prev&&prev.quotes)||{}), ...quotes}, rates:{...((prev&&prev.rates)||{}), ...rates}, xagUsd: xagUsd ?? (prev&&prev.xagUsd) ?? null, at:Date.now(), day:(prev&&prev.day)||null, complete:false, partial:true, log:[...LOG], feedWarnings:[] }); } catch(e){} }
  for(let i = 0; i < av.length; i++){
    const s = av[i];
    say(`European quotes ${i+1} of ${av.length} (Alpha Vantage allows one per second)…`);
    if(i) await sleep(1300);
    const q = await avQuote(`${s.sym} (${s.av})`, s);
    if(q) quotes[s.sym] = q;
  }

  const complete = Object.keys(cryptoEur).length === ids.length && Object.keys(quotes).length === d.STOCKS.length && xagUsd != null;
  // keep yesterday's value for anything that failed today, marked as old
  const P = prev || {};
  for(const id of ids) if(cryptoEur[id] == null && P.cryptoEur && P.cryptoEur[id] != null){ cryptoEur[id] = P.cryptoEur[id]; feedWarnings.push(`${label[id]||id}: using the last known price.`); }
  for(const s of d.STOCKS) if(!quotes[s.sym] && P.quotes && P.quotes[s.sym] && !P.quotes[s.sym].manual){ quotes[s.sym] = { ...P.quotes[s.sym], stale:true }; }
  if(xagUsd == null && P.xagUsd != null) xagUsd = P.xagUsd;
  if(rates.USD == null && P.rates && P.rates.USD){ rates.USD = P.rates.USD; rates.GBP = P.rates.GBP; }
  for(const s of d.STOCKS) if(!quotes[s.sym] && typeof s.manual === "number"){ quotes[s.sym] = { price:s.manual, ccy:s.ccy, manual:true }; ok(`${s.sym} (manual price)`, `${s.manual} ${s.ccy}`); }
  const now = new Date();
  return { prices:{ cryptoEur, quotes, rates, xagUsd, at:Date.now(), day:`${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`, complete, log:LOG, feedWarnings }, complete };
}
const todayKey = () => { const n = new Date(); return `${n.getFullYear()}-${n.getMonth()+1}-${n.getDate()}`; };

function toEur(price, ccy, rates){
  if(ccy === "EUR") return price;
  if(ccy === "GBp" || ccy === "GBX") return rates.GBP != null ? price/100*rates.GBP : null;
  const r = rates[ccy]; return r != null ? price * r : null;
}

/* ---- values, KPIs and chart series ---- */
function evaluate(inv, d, prices, ov){
  ov = ov || {}; prices = prices || { cryptoEur:{}, quotes:{}, rates:{EUR:1}, xagUsd:null };
  const { cryptoEur = {}, quotes = {}, rates = {EUR:1}, xagUsd = null } = prices;
  const label = inv.cryptoLabel || {};
  const warnings = [...(prices.feedWarnings || []), ...d.warnings];
  const rows = [];
  let cryptoTotal = 0;
  for(const [id, units] of Object.entries(d.CRYPTO)){
    const key = "crypto:" + id, manual = typeof ov[key] === "number";
    const px = manual ? ov[key] : cryptoEur[id];
    const val = px != null ? px * units : null;
    if(val != null) cryptoTotal += val; else warnings.push(`No price for ${label[id]||id} — excluded.`);
    rows.push({ key, unit:"EUR / coin", manual, cls:"Crypto", name:label[id]||id, qty:units, px, ccy:"EUR", val });
  }
  let stockTotal = 0;
  for(const s of d.STOCKS){
    const key = "stock:" + s.sym, manual = typeof ov[key] === "number";
    let q = manual ? { price:ov[key], ccy:s.ccy } : (quotes[s.sym] || null);
    if(!q && typeof s.manual === "number") q = { price:s.manual, ccy:s.ccy, manual:true, fallback:true };
    const pxEur = q ? toEur(q.price, q.ccy, rates) : null;
    const val = pxEur != null ? pxEur * s.qty : null;
    if(val != null) stockTotal += val;
    else if(q) warnings.push(`No ${q.ccy}→EUR rate, so ${s.sym} is excluded.`);
    else warnings.push(`No price for ${s.sym} — excluded. Type one in Manual price.`);
    if(q && q.fallback) warnings.push(`${s.sym}: no live price yet — using the saved price of ${q.price} ${q.ccy}.`);
    rows.push({ key, unit:s.ccy + " / share", manual: manual || !!(q && q.manual && !q.fallback), stale: !!(q && (q.stale || q.fallback)), cls:"Stocks", name:`${s.sym} · ${s.name}`, qty:s.qty, px:q ? q.price : null, ccy:q ? q.ccy : s.ccy, val });
  }
  if(d.BROKER_CASH || typeof ov.cash === "number"){
    const cash = typeof ov.cash === "number" ? ov.cash : d.BROKER_CASH;
    stockTotal += cash;
    rows.push({ key:"cash", unit:"EUR total", manual:typeof ov.cash === "number", cls:"Stocks", name:"DEGIRO cash balance", qty:"—", px:null, ccy:"", val:cash });
  }
  const oz = d.SILVER_GRAMS / GRAMS_PER_TROY_OZ, sMan = typeof ov.silver === "number";
  const spot = sMan ? ov.silver : xagUsd;
  const silverEurOz = (spot != null && rates.USD != null) ? spot * rates.USD : null;
  const silverTotal = silverEurOz != null ? silverEurOz * oz : 0;
  if(silverEurOz == null && d.SILVER_GRAMS) warnings.push("No silver spot price — silver excluded.");
  if(d.SILVER_GRAMS) rows.push({ key:"silver", unit:"USD / troy oz", manual:sMan, cls:"Silver", name:`Silver bullion · ${d.SILVER_GRAMS} g`, qty:+oz.toFixed(3), px:spot, ccy:"USD/oz", val: silverEurOz != null ? silverTotal : null });
  const vinylVal = typeof ov.vinyl === "number" ? ov.vinyl : (inv.vinylEstimate || 0);
  rows.push({ key:"vinyl", unit:"EUR total", manual:typeof ov.vinyl === "number", cls:"Vinyl", name:"Vinyl collection", qty:"—", px:null, ccy:"", val:vinylVal });
  rows.sort((a,b) => (b.val ?? -1) - (a.val ?? -1));

  const live = { Crypto:cryptoTotal, Stocks:stockTotal, Silver:silverTotal, Vinyl:vinylVal };
  const liveTotal = CLASSES.reduce((s,c) => s + live[c], 0);
  const holdings = inv.holdings || [];
  const series = [...holdings, { date:fmtDay(new Date()) + " (live)", ...live }];
  const totals = series.map(h => CLASSES.reduce((s,c) => s + (h[c]||0), 0));
  const invTotal = m => CLASSES.reduce((s,c) => s + (m[c]||0), 0);
  const cum = []; d.invested.reduce((s,m) => { const t = s + invTotal(m); cum.push(t); return t; }, 0);
  const totalInvested = cum.length ? cum[cum.length-1] : 0;
  const prevTotal = totals.length > 1 ? totals[totals.length-2] : liveTotal;
  const momAbs = liveTotal - prevTotal;
  const investedByMonth = Object.fromEntries(d.invested.map(m => [m.month, m]));
  const lastSnap = holdings.length ? holdings[holdings.length-1].date : null;
  const lastSnapDay = lastSnap ? parseDate(lastSnap) : d.baseDay;
  const sinceSnap = { Crypto:0, Stocks:0, Vinyl:0, Silver:0 };
  for(const t of d.LEDGER) if(parseDate(t.date) >= lastSnapDay && t.cls in sinceSnap) sinceSnap[t.cls] += Number(t.eur) || 0;
  const growth = [], glabels = [];
  for(let i = 1; i < series.length; i++){
    glabels.push(series[i].date);
    let added;
    if(i === series.length-1) added = invTotal(sinceSnap);
    else { const dd = parseDate(series[i].date); const pm = investedByMonth[monthKey(new Date(dd.getFullYear(), dd.getMonth()-1, 1))]; added = pm ? invTotal(pm) : 0; }
    growth.push(totals[i] - totals[i-1] - added);
  }
  const totalGrowth = growth.reduce((a,b) => a+b, 0);
  let best = { n:"—", v:-Infinity };
  const lastH = holdings.length ? holdings[holdings.length-1] : {};
  const change = {};   // since the last month-start snapshot, new money left out
  for(const c of CLASSES){ const dv = live[c] - (lastH[c]||0) - sinceSnap[c]; change[c] = { v: dv, pct: lastH[c] ? dv / lastH[c] * 100 : null, added: sinceSnap[c] }; if(dv > best.v) best = { n:classLabel(c), v:dv }; }
  // per position: compare with the unit prices recorded at the first price run of this month
  const ps = inv.posSnap, nowMonth = (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`; })();
  if(ps && ps.month === nowMonth && ps.units) for(const r of rows){
    const u0 = ps.units[r.key]; if(u0 == null || r.val == null) continue;
    const q = typeof r.qty === 'number' ? (r.key === 'silver' ? r.qty : r.qty) : null;
    const u1 = q ? r.val / q : r.val;
    r.chg = q ? (u1 - u0) * q : (u1 - u0); r.chgPct = u0 ? (u1/u0 - 1) * 100 : null; r.chgSince = ps.date;
  }
  return { rows, live, liveTotal, series, totals, cum, totalInvested, prevTotal, momAbs, lastSnap, growth, glabels, totalGrowth, best, warnings, change,
    firstMonth: d.invested.length ? d.invested[0].month : "" };
}

/* A new month and a complete price run → record a snapshot like the hand-typed ones. */
// unit price of every position at the first complete price run of a month
function posSnapIfDue(inv, ev, complete){
  if(!complete) return null;
  const n = new Date(), month = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`;
  if(inv.posSnap && inv.posSnap.month === month) return null;
  const units = {};
  for(const r of ev.rows) if(r.val != null) units[r.key] = typeof r.qty === 'number' && r.qty ? r.val / r.qty : r.val;
  return { month, date: fmtDay(n), units };
}
function snapshotIfDue(inv, ev, complete){
  if(!complete) return null;
  const h = inv.holdings || [], now = new Date();
  const last = h.length ? parseDate(h[h.length-1].date) : null;
  if(last && last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth()) return null;
  const snap = { date: fmtDay(now) };
  for(const c of CLASSES) snap[c] = Math.round(ev.live[c]);
  return snap;
}

/* One-off fixes to stored stock settings (applied once, then saved). Only listing
   symbols here — no quantities or other personal data. */
const FIXUPS = [
  // { sym:"XYZ", when: s => s.av === "OLD.DEX", set:{ av:"NEW.LON", ccy:"GBp" } },
];
function migrate(inv){
  if(!inv || !Array.isArray(inv.stockMeta)) return null;
  let changed = false;
  const stockMeta = inv.stockMeta.map(s => { const f = FIXUPS.find(f => f.sym === s.sym && f.when(s)); if(!f) return s; changed = true; return { ...s, ...f.set }; });
  return changed ? { ...inv, stockMeta } : null;
}

window.InvestCore = { migrate, label: classLabel, posSnapIfDue, CLASSES, parseDate, monthKey, fmtDay, derive, fetchPrices, evaluate, snapshotIfDue, todayKey, toEur };
})();
