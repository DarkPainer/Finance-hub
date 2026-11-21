/* Finance Hub — crypto candles with your buys and sells marked on them.
   Daily EUR candles come from Binance's public market data (up to ~5 years), with CoinGecko
   (last 365 days, closes only) as fallback. They are cached on this device and topped up at most every 6 hours.
   Your trades live in hub.investing.buys = [{ id, coin, date:'YYYY-MM-DD', qty, eur, side?:'sell' }] (qty and eur
   always positive; side 'sell' for sells) and are for display only: they never change your holdings.
   Trades logged in the ledger are shown too. */
(function(){
const DAY = 864e5, TTL = 6 * 36e5;
const LSK = id => 'fh-cx2:' + id;
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch(e){ return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} };
const r6 = v => +(+v).toPrecision(7);

async function binance(sym){
  const pair = sym.toUpperCase() + 'EUR'; let end = null; const out = [];
  for (let page = 0; page < 2; page++) {
    const u = `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=1d&limit=1000` + (end ? `&endTime=${end}` : '');
    const r = await fetch(u); if (!r.ok) break;
    const j = await r.json(); if (!Array.isArray(j) || !j.length) break;
    out.unshift(...j.map(k => [k[0], r6(k[1]), r6(k[2]), r6(k[3]), r6(k[4])]));
    if (j.length < 1000) break; end = j[0][0] - 1;
  }
  return out;
}
async function gecko(id){
  const r = await fetch(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=eur&days=365&interval=daily`);
  if (!r.ok) return [];
  const j = await r.json().catch(() => null);
  const cl = (j && j.prices || []).map(([t, p]) => [Math.floor(t / DAY) * DAY, p]);
  return cl.map(([t, c], i) => { const o = i ? cl[i-1][1] : c; return [t, r6(o), r6(Math.max(o, c)), r6(Math.min(o, c)), r6(c)]; });
}
// daily candles [[ms, open, high, low, close]] in EUR, cached; force = ignore the cache age
async function history(id, sym, force){
  const c = lsGet(LSK(id));
  if (c && !force && Date.now() - c.at < TTL) return c;
  let pts = [], src = '';
  try { pts = await binance(sym); src = 'Binance'; } catch(e){}
  if (pts.length < 30) { try { const g = await gecko(id); if (g.length > pts.length) { pts = g; src = 'CoinGecko'; } } catch(e){} }
  if (!pts.length) return c ? { ...c, stale: true } : { at: 0, pts: [], src: '', failed: true };
  const v = { at: Date.now(), pts, src }; lsSet(LSK(id), v); return v;
}
// daily → weekly candles (weeks start on Monday)
function weekly(pts){
  const out = [];
  for (const [t, o, h, l, c] of pts) {
    const d = new Date(t), wk = t - ((d.getUTCDay() + 6) % 7) * DAY;
    const last = out[out.length-1];
    if (last && last[0] === wk) { last[2] = Math.max(last[2], h); last[3] = Math.min(last[3], l); last[4] = c; }
    else out.push([wk, o, h, l, c]);
  }
  return out;
}

// buys for one coin: your list + crypto buys from the trade ledger (skipping exact duplicates)
function buysFor(inv, ledger, id){
  const own = (inv.buys || []).filter(b => b.coin === id).map(b => ({ ...b, src: 'list' }));
  const seen = new Set(own.map(b => `${b.date}|${(+b.qty).toPrecision(6)}`));
  for (const t of ledger || []) {
    if (t.cls !== 'Crypto' || t.asset !== id || !t.qty || !t.eur || (t.qty > 0) !== (t.eur > 0)) continue;
    const sell = t.qty < 0;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : (() => { const x = new Date(t.date); return isNaN(x) ? null : x.toISOString().slice(0,10); })();
    if (!d || seen.has(`${d}|${Math.abs(t.qty).toPrecision(6)}`)) continue;
    own.push({ id: 'L' + d + t.qty, coin: id, date: d, qty: Math.abs(t.qty), eur: Math.abs(t.eur), src: 'ledger', ...(sell ? { side: 'sell' } : {}) });
  }
  return own.sort((a, b) => a.date.localeCompare(b.date) || (a.side === 'sell') - (b.side === 'sell'));
}
// average-cost bookkeeping: what's left, what it cost, and the gain locked in by sells
function position(trades){
  let qty = 0, cost = 0, realised = 0, bought = 0, paid = 0, nb = 0, ns = 0;
  for (const t of trades) {
    if (t.side === 'sell') { const avg = qty > 0 ? cost / qty : 0, q = Math.min(t.qty, qty); realised += t.eur - q * avg; cost -= q * avg; qty -= q; ns++; }
    else { qty += t.qty; cost += t.eur; bought += t.qty; paid += t.eur; nb++; }
  }
  return { qty, cost, avg: qty > 1e-12 ? cost / qty : null, realised, bought, paid, nb, ns };
}

// "2025-03-12, BTC, 0.01, 750" (also 12-03-2025, ; or tab separated, € and decimal commas).
// A sell: negative amount and/or €, or a 5th column "sell".
function parseLines(text, symToId){
  const ok = [], bad = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[\u2212\u2012\u2013\u2014\uFE63\uFF0D]/g, '-').replace(/[\u00A0\u202F]/g, ' ').trim(); if (!line) continue;
    const parts = line.split(/\s*[;\t]\s*|\s*,\s+|\s{2,}/).filter(Boolean);
    if (parts.length < 4) { bad.push(line); continue; }
    let [d, s, q, e, kind] = parts;
    const m1 = d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/), m2 = d.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    const date = m1 ? `${m1[1]}-${m1[2].padStart(2,'0')}-${m1[3].padStart(2,'0')}` : m2 ? `${m2[3]}-${m2[2].padStart(2,'0')}-${m2[1].padStart(2,'0')}` : null;
    const coin = symToId[s.toUpperCase()] || (Object.values(symToId).includes(s.toLowerCase()) ? s.toLowerCase() : null);
    const num = t => { t = String(t).replace(/[€\s]/g,'').replace(/^-?(.*?)-$/, '-$1'); if (t.includes(',') && t.includes('.')) t = t.replace(/\./g,'').replace(',','.'); else t = t.replace(',','.'); return parseFloat(t); };
    const q0 = num(q), e0 = num(e), qty = Math.abs(q0), eur = Math.abs(e0);
    const sell = q0 < 0 || e0 < 0 || /^s(ell|old|ale)?$|^verkoop/i.test(kind || '');
    if (!date || !coin || !(qty > 0) || !(eur > 0)) { bad.push(line); continue; }
    ok.push({ coin, date, qty, eur, ...(sell ? { side: 'sell' } : {}) });
  }
  return { ok, bad };
}


/* ---- candle chart on a canvas: drag to move, pinch or scroll to zoom, tap for details.
   The price axis always fits the candles (and trades) in view. */
function CandleChart(canvas, opts){
  const ctx = canvas.getContext('2d'), S = { candles: [], marks: [], avg: null, last: null, n: 90, end: 0, info: null, vx: 0, step: DAY };
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const PR = 56, PB = 22, PT = 8;
  let W = 0, H = 0, dpr = 1, raf = 0;
  const fmtP = v => { const a = Math.abs(v); return '€' + (a >= 10000 ? Math.round(v).toLocaleString('nl-NL') : v.toLocaleString('nl-NL', { maximumFractionDigits: a < 1 ? 4 : a < 100 ? 2 : 0, minimumFractionDigits: a < 1 ? 3 : a < 10 ? 2 : 0 })); };
  function size(){ const r = canvas.getBoundingClientRect(); dpr = window.devicePixelRatio || 1; W = r.width; H = r.height; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); draw(); }
  const plotW = () => W - PR;
  const cw = () => plotW() / S.n;
  const clampEnd = () => { const N = S.candles.length; S.n = Math.max(12, Math.min(S.n, Math.max(12, N + 4))); S.end = Math.max(Math.min(S.n, N) - 1, Math.min(S.end, N - 1 + S.n * 0.25)); };
  function visible(){ const a = Math.max(0, Math.floor(S.end - S.n + 1)), b = Math.min(S.candles.length - 1, Math.ceil(S.end)); return [a, b]; }
  const xOf = i => plotW() - (S.end - i + 0.5) * cw();
  const idxAt = x => Math.round(S.end - (plotW() - x) / cw() + 0.5);
  function nice(span, target){ const raw = span / target, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p; return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p; }
  function draw(){
    raf = 0; if (!W) return;
    const C = { up: css('--good'), dn: css('--bad'), line: css('--line'), ink: css('--text'), ink2: css('--text-2'), bg: css('--surface'), acc: css('--c-crypto') };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const N = S.candles.length; if (!N) return;
    clampEnd();
    const [a, b] = visible();
    const t0 = S.candles[a][0], t1 = S.candles[b][0] + S.step;
    const vm = S.marks.filter(m => m.t >= t0 && m.t < t1);
    let lo = Infinity, hi = -Infinity;
    for (let i = a; i <= b; i++) { lo = Math.min(lo, S.candles[i][3]); hi = Math.max(hi, S.candles[i][2]); }
    for (const m of vm) { lo = Math.min(lo, m.price); hi = Math.max(hi, m.price); }
    const pad = (hi - lo) * 0.08 || hi * 0.05; lo -= pad; hi += pad;
    const y = v => PT + (H - PT - PB) * (hi - v) / (hi - lo);
    // grid + price axis
    const st = nice(hi - lo, 5); ctx.font = '11px -apple-system,BlinkMacSystemFont,Roboto,sans-serif'; ctx.textBaseline = 'middle';
    for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) { const yy = Math.round(y(v)) + .5; ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW(), yy); ctx.stroke(); ctx.fillStyle = C.ink2; ctx.textAlign = 'left'; ctx.fillText(fmtP(v), plotW() + 6, yy); }
    // date axis
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = C.ink2;
    const spanDays = (t1 - t0) / DAY, every = spanDays > 900 ? 'y' : spanDays > 150 ? 'q' : spanDays > 50 ? 'm' : 'w';
    let lastLab = -1e9;
    for (let i = a; i <= b; i++) {
      const d = new Date(S.candles[i][0]), prev = i ? new Date(S.candles[i-1][0]) : null; let lab = null;
      if (every === 'y' && (!prev || prev.getUTCFullYear() !== d.getUTCFullYear())) lab = String(d.getUTCFullYear());
      else if ((every === 'q' || every === 'm') && (!prev || prev.getUTCMonth() !== d.getUTCMonth()) && (every === 'm' || d.getUTCMonth() % 3 === 0)) lab = d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
      else if (every === 'w' && d.getUTCDay() === 1) lab = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
      const x = xOf(i); if (lab && x > 14 && x < plotW() - 14 && x - lastLab > 44) { ctx.fillText(lab, x, H - 6); lastLab = x; }
    }
    // candles
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, plotW(), H - PB); ctx.clip();
    const w = cw(), bw = Math.max(1, Math.min(w * 0.7, 14));
    for (let i = a; i <= b; i++) {
      const [, o, h, l, c] = S.candles[i], x = xOf(i), up = c >= o; ctx.strokeStyle = ctx.fillStyle = up ? C.up : C.dn;
      ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, y(h)); ctx.lineTo(Math.round(x) + .5, y(l)); ctx.stroke();
      const top = y(Math.max(o, c)), bh = Math.max(1, Math.abs(y(o) - y(c))); ctx.fillRect(x - bw / 2, top, bw, bh);
    }
    // average price of what you hold
    if (S.avg && S.avg > lo && S.avg < hi) { const yy = Math.round(y(S.avg)) + .5; ctx.setLineDash([5, 4]); ctx.strokeStyle = C.ink2; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW(), yy); ctx.stroke(); ctx.setLineDash([]); }
    // trades
    const maxE = Math.max(1, ...S.marks.map(m => m.eur));
    for (const m of vm) {
      const i = a + Math.floor((m.t - t0) / S.step); let x = null;
      for (let k = Math.max(a, i - 1); k <= Math.min(b, i + 1); k++) if (m.t >= S.candles[k][0] && m.t < S.candles[k][0] + S.step) x = xOf(k);
      if (x == null) continue;
      const r = 4 + 4 * Math.sqrt(m.eur / maxE), yy = y(m.price); m._x = x; m._y = yy; m._r = r;
      ctx.lineWidth = 2; ctx.strokeStyle = C.bg;
      if (m.side === 'sell') { ctx.fillStyle = C.dn; ctx.beginPath(); ctx.moveTo(x, yy - r - 1.5); ctx.lineTo(x + r + 1.5, yy); ctx.lineTo(x, yy + r + 1.5); ctx.lineTo(x - r - 1.5, yy); ctx.closePath(); ctx.fill(); ctx.stroke(); }
      else { ctx.fillStyle = C.up; ctx.beginPath(); ctx.arc(x, yy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    }
    ctx.restore();
    // last price tag + avg tag on the axis
    const tag = (v, bg, fg) => { if (v == null || v < lo || v > hi) return; const yy = y(v), t = fmtP(v); ctx.font = '600 11px -apple-system,BlinkMacSystemFont,Roboto,sans-serif'; const tw = ctx.measureText(t).width + 8; ctx.fillStyle = bg; ctx.fillRect(plotW() + 2, yy - 9, Math.max(tw, PR - 4), 18); ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(t, plotW() + 6, yy); };
    if (S.avg) tag(S.avg, C.ink2, C.bg);
    const lc = S.candles[N - 1]; if (lc) tag(lc[4], lc[4] >= lc[1] ? C.up : C.dn, '#fff');
    // crosshair
    if (S.info != null && S.info >= a && S.info <= b) { const x = Math.round(xOf(S.info)) + .5; ctx.strokeStyle = C.ink2; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, PT); ctx.lineTo(x, H - PB); ctx.stroke(); ctx.setLineDash([]); }
  }
  const redraw = () => { if (!raf) raf = requestAnimationFrame(draw); };
  function emitInfo(x, yPos){
    if (x == null) { S.info = null; opts.onInfo && opts.onInfo(null); redraw(); return; }
    let hit = null, best = 22;
    for (const m of S.marks) if (m._x != null) { const d = Math.hypot(m._x - x, m._y - yPos); if (d < best) { best = d; hit = m; } }
    const i = Math.max(0, Math.min(S.candles.length - 1, idxAt(x)));
    S.info = i; redraw(); opts.onInfo && opts.onInfo({ candle: S.candles[i], trade: hit, step: S.step });
  }
  // gestures
  const pts = new Map(); let drag = null, pinch = null, moved = false, lastT = 0, lastX = 0;
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY }); S.vx = 0; moved = false;
    if (pts.size === 1) { drag = { x: e.offsetX, end: S.end }; lastT = performance.now(); lastX = e.offsetX; }
    else if (pts.size === 2) { const [p, q] = [...pts.values()]; pinch = { d: Math.abs(p.x - q.x) || 1, n: S.n, end: S.end, cx: (p.x + q.x) / 2 }; drag = null; } });
  canvas.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) { if (e.pointerType === 'mouse') emitInfo(e.offsetX, e.offsetY); return; }
    pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pinch && pts.size === 2) { const [p, q] = [...pts.values()], d = Math.abs(p.x - q.x) || 1; const n = Math.max(12, Math.min(S.candles.length + 4, pinch.n * pinch.d / d));
      const iAt = pinch.end - (plotW() - pinch.cx) / (plotW() / pinch.n); S.n = n; S.end = iAt + (plotW() - pinch.cx) / (plotW() / n); moved = true; redraw(); return; }
    if (drag) { const dx = e.offsetX - drag.x; if (Math.abs(dx) > 4) moved = true; if (!moved) return;
      S.end = drag.end - dx / cw(); const now = performance.now(), dt = now - lastT; if (dt > 0) S.vx = (e.offsetX - lastX) / dt; lastT = now; lastX = e.offsetX;
      if (S.info != null) { S.info = null; opts.onInfo && opts.onInfo(null); } redraw(); } });
  const up = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
    if (drag && !moved && pts.size === 0) emitInfo(e.offsetX, e.offsetY);
    else if (drag && moved && Math.abs(S.vx) > 0.15) { let v = S.vx; const step = () => { if (Math.abs(v) < 0.02 || pts.size) return; S.end -= v * 16 / cw(); v *= 0.93; draw(); requestAnimationFrame(step); }; requestAnimationFrame(step); }
    if (!pts.size) drag = null; };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !pts.size) emitInfo(null); });
  canvas.addEventListener('wheel', e => { e.preventDefault(); const f = Math.exp(e.deltaY * 0.0015), iAt = S.end - (plotW() - e.offsetX) / cw(); S.n = Math.max(12, Math.min(S.candles.length + 4, S.n * f)); S.end = iAt + (plotW() - e.offsetX) / cw(); redraw(); }, { passive: false });
  new ResizeObserver(size).observe(canvas);
  return {
    set(d){ const keep = d.keepView && S.candles.length; S.candles = d.candles; S.marks = d.marks; S.avg = d.avg; S.step = d.step || DAY;
      if (!keep) { S.n = Math.min(d.n || 90, Math.max(12, d.candles.length)); S.end = d.candles.length - 1 + Math.min(3, S.n * 0.04); }
      S.info = null; size(); },
    zoom(n){ S.n = n; S.end = S.candles.length - 1 + Math.min(3, n * 0.04); redraw(); },
    clearInfo(){ emitInfo(null); },
  };
}

window.CryptoChart = { history, weekly, buysFor, position, parseLines, CandleChart, DAY };
})();
