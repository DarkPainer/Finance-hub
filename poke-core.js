/* Finance Hub — Pokémon stock valuation.
   Stock list comes from the Pokémon dashboard (synced to hub.pokemon).
   Prices: TCGdex (free, no key) which carries Cardmarket's daily price guide.
   Anything that can't be matched to a card counts at what was paid. */
(function(){
const API = 'https://api.tcgdex.net/v2/en';
// Set codes → TCGdex set ids (checked against the card name on every lookup, so a wrong
// entry just falls back to the name match / paid price, never a wrong value).
const KNOWN = { SVI:'sv01', PAL:'sv02', OBF:'sv03', MEW:'sv03.5', PAR:'sv04', PAF:'sv04.5', TEF:'sv05', TWM:'sv06',
  SFA:'sv06.5', SCR:'sv07', SSP:'sv08', PRE:'sv08.5', JTG:'sv09', DRI:'sv10', BLK:'sv10.5b', WHT:'sv10.5w', SVP:'svp',
  CRZ:'swsh12.5', BRS:'swsh9', ASR:'swsh10', LOR:'swsh11', SIT:'swsh12', SWSH:'swshp', CPA:'swsh3.5', VIV:'swsh4',
  BST:'swsh5', CRE:'swsh6', EVS:'swsh7', FST:'swsh8', CEL:'cel25', SUM:'sm1', UNM:'sm11', CEC:'sm12', SM:'smp',
  EVO:'xy12', FCO:'xy10', ROS:'xy6', HS:'hgss1', MEG:'me01', PFL:'me02' };
const ALIAS = { WF:'WHT', XDRI:'DRI' };
const SET_NAME = { POR:'Perfect Order', PBL:'Pitch Black', ASC:'Ascended Heroes', PFL:'Phantasmal Flames', MEG:'Mega Evolution', CRI:'Chaos Rising' };
const codeOf = it => { const c = String(it.set||'').toUpperCase(); return ALIAS[c] || c; };
const norm = s => String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
const firstWord = s => norm(String(s||'').split(/[\s-]/)[0]);
const todayKey = () => { const n = new Date(); return `${n.getFullYear()}-${n.getMonth()+1}-${n.getDate()}`; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const itemKey = it => `${codeOf(it)}|${String(it.num||'').toUpperCase()}|${norm(it.name)}|${/rh|rev|holo/i.test(it.rar||'')?'h':'n'}`;

async function getJSON(url, tries = 4){
  // retries rate limits and hiccups; 404 = not there
  for (let attempt = 0; attempt < tries; attempt++) {
    let r;
    try { r = await fetch(url); }
    catch(e) { if (attempt === tries-1) throw new Error('network: ' + e.message); await sleep(2500 * (attempt+1)); continue; }   // a rate limit without CORS headers shows up as a network error
    if (r.status === 404) return null;
    if (r.status === 429 || r.status >= 500) { if (attempt === tries-1) throw new Error('HTTP ' + r.status); await sleep(2500 * (attempt+1)); continue; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
}
const numKey = n => String(n||'').trim().toUpperCase().replace(/^0+(?=[0-9])/, '');

// does this stock item look like a single card we can look up?
function priceable(it){
  if (!it.set || !it.num) return false;
  if (it.lang && !/^en/i.test(it.lang)) return false;          // English price guide only
  if (/sealed|booster|box|bundle|tin|collection|deck/i.test(it.name||'') && !/\d/.test(it.num)) return false;
  return true;
}

const PTCG = 'https://api.pokemontcg.io/v2/cards';
// promos are listed under PR-xx codes with a prefix in the number on pokemontcg.io
const PROMO = { SM:['PR-SM','SM'], SWSH:['PR-SW','SWSH'], SVP:['PR-SV',''], XY:['PR-XY','XY'] };
function ptcgRef(it){
  const c = codeOf(it); let n = String(it.num).trim().toUpperCase().replace(/^0+(?=\d)/,'');
  if (PROMO[c]) { const [code, pre] = PROMO[c]; if (pre && !n.startsWith(pre)) n = pre + n; return { code, n }; }
  return { code: c, n };
}
const nameOK = (a, b) => { const fa = firstWord(a), fb = firstWord(b); return !fa || !fb || norm(a).includes(fb) || norm(b).includes(fa); };
// Cardmarket (EUR) first — that's where the stock is sold; TCGplayer (USD → EUR) when Cardmarket has nothing
function ptcgPrice(card, holo, usdToEur){
  const p = card && card.cardmarket && card.cardmarket.prices;
  if (p) { const v = holo ? (p.reverseHoloTrend ?? p.trendPrice ?? p.avg30) : (p.trendPrice ?? p.avg30 ?? p.averageSellPrice); if (typeof v === 'number' && v > 0) return { p: v, src: 'Cardmarket' }; }
  const t = card && card.tcgplayer && card.tcgplayer.prices;
  if (t && usdToEur) {
    const order = holo ? ['reverseHolofoil','holofoil','normal'] : ['normal','holofoil','reverseHolofoil','1stEditionHolofoil','unlimitedHolofoil'];
    for (const k of [...order, ...Object.keys(t)]) { const m = t[k] && (t[k].market ?? t[k].mid); if (typeof m === 'number' && m > 0) return { p: Math.round(m * usdToEur * 100) / 100, src: 'TCGplayer' }; }
  }
  return null;
}
// look up many cards per request by set code + number (pokemontcg.io, Cardmarket prices included)
const RAR = { IR:'Illustration Rare', SIR:'Special Illustration Rare', AR:'Illustration Rare', SAR:'Special Illustration Rare', UR:'Hyper Rare', HR:'Hyper Rare', FA:'Ultra Rare', ACE:'ACE SPEC Rare', DR:'Double Rare' };
const rarityInNum = it => RAR[String(it.num||'').trim().toUpperCase()] || null;
async function ptcgByName(todo, cache, stats, note, say, usdToEur){
  for (let i = 0; i < todo.length; i++) {
    const [k, it] = todo[i], want = rarityInNum(it);
    say(`Cards without a number ${i+1} of ${todo.length}…`);
    const sc = codeOf(it), q = `${SET_NAME[sc] ? `(set.ptcgoCode:"${sc}" OR set.name:"${SET_NAME[sc]}")` : `set.ptcgoCode:"${sc}"`} name:"${String(it.name).replace(/"/g,'')}"`;
    let res; try { res = await getJSON(`${PTCG}?pageSize=50&select=id,name,number,rarity,set,cardmarket,tcgplayer&q=${encodeURIComponent(q)}`); }
    catch(e) { stats.errors++; note('errors', `pokemontcg.io (${it.name}): ${e.message}`); continue; }
    const cards = ((res && res.data) || []).filter(c => nameOK(c.name, it.name));
    const c = cards.find(c => c.rarity === want) || (cards.length ? cards.sort((a,b) => (parseInt(b.number)||0) - (parseInt(a.number)||0))[0] : null);
    const price = c && ptcgPrice(c, false, usdToEur);
    if (price) { cache.prices[k] = { p: price.p, id: c.id, name: c.name, src: price.src }; stats.priced++; if (price.src === 'TCGplayer') stats.us = (stats.us||0) + 1; }
    await sleep(400);
  }
}
async function ptcgPhase(todo, cache, stats, note, say, usdToEur){
  const byName = todo.filter(([k, it]) => rarityInNum(it)); todo = todo.filter(([k, it]) => !rarityInNum(it));
  const groups = []; const BATCH = 8;
  for (let i = 0; i < todo.length; i += BATCH) groups.push(todo.slice(i, i+BATCH));
  for (let g = 0; g < groups.length; g++) {
    say(`Pricing cards ${Math.min((g+1)*BATCH, todo.length)} of ${todo.length}…`);
    const q = groups[g].map(([k, it]) => { const { code, n } = ptcgRef(it); return SET_NAME[code] ? `((set.ptcgoCode:"${code}" OR set.name:"${SET_NAME[code]}") number:"${n}")` : `(set.ptcgoCode:"${code}" number:"${n}")`; }).join(' OR ');
    let res;
    const url = `${PTCG}?pageSize=250&select=id,name,number,set,cardmarket,tcgplayer&q=${encodeURIComponent(q)}`;
    try { res = await getJSON(url); }
    catch(e) { await sleep(4000); try { res = await getJSON(url); } catch(e2) { stats.errors++; note('errors', `pokemontcg.io: ${e2.message}`); continue; } }
    const cards = (res && res.data) || [];
    for (const [k, it] of groups[g]) {
      const { code, n } = ptcgRef(it);
      const holo = /rh|rev/i.test(it.rar||'');
      const setOK = c => c.set && (String(c.set.ptcgoCode||'').toUpperCase() === code || (SET_NAME[code] && norm(c.set.name) === norm(SET_NAME[code])));
      const c = cards.find(c => String(c.number).toUpperCase().replace(/^0+(?=\d)/,'') === n && setOK(c) && nameOK(c.name, it.name));
      const price = c && ptcgPrice(c, holo, usdToEur);
      if (price) { cache.prices[k] = { p: price.p, id: c.id, name: c.name, src: price.src }; stats.priced++; if (price.src === 'TCGplayer') stats.us = (stats.us||0) + 1; }
    }
    await sleep(400);
  }
  if (byName.length) await ptcgByName(byName, cache, stats, note, say, usdToEur);
}

async function refresh(pk, prev, onProgress, usdToEur, onCheckpoint){
  const say = t => { try { onProgress && onProgress(t); } catch(e){} };
  const cache = { history:{...((prev&&prev.history)||{})}, sets:Object.fromEntries(Object.entries((prev&&prev.sets)||{}).filter(([k,v]) => v)), ids:{...((prev&&prev.ids)||{})}, miss:((prev&&prev.v)||0) < 2 ? {} : {...((prev&&prev.miss)||{})}, prices:{}, day: todayKey(), at: Date.now(), log: [] };
  const items = (pk && pk.items || []).filter(priceable);
  if (!items.length) return cache;
  // 1) set codes → TCGdex set ids
  const codes = [...new Set(items.map(codeOf))].filter(c => !(c in cache.sets));
  if (codes.length) {
    say('Looking up sets…');
    let list = [];
    try { list = await getJSON(`${API}/sets`, 1) || []; } catch(e) { cache.log.push('sets list: ' + e.message); }
    const byName = {}; for (const s of list) byName[norm(s.name)] = s.id;
    const names = { ...SET_NAME, ...((pk && pk.setNames) || {}) };
    for (const c of codes) {
      let id = KNOWN[c] || null;
      if (!id && names[c]) {
        const n = norm(names[c]);
        id = byName[n] || (list.find(s => norm(s.name).includes(n) || n.includes(norm(s.name)) && norm(s.name).length > 4) || {}).id || null;
      }
      cache.sets[c] = id;
    }
  }
  const stats = { priced:0, noPrice:0, notInSet:0, nameMismatch:0, noSet:0, errors:0 };
  const unknownSets = new Set(), samples = { noPrice:[], notInSet:[], nameMismatch:[], errors:[] };
  const note = (k, t) => { if (samples[k] && samples[k].length < 6) samples[k].push(t); };
  // 2) pokemontcg.io first: few requests, finds cards by your own set codes (gallery + promos too)
  const allUniq = new Map(); for (const it of items) allUniq.set(itemKey(it), it);
  await ptcgPhase([...allUniq.entries()], cache, stats, note, say, usdToEur || 0.92);
  if (onCheckpoint) { try { await onCheckpoint({ ...cache, prices:{...cache.prices}, stats:{...stats}, samples, unknownSets:[], v:2, partial:true }); } catch(e){} }
  const left = items.filter(it => !cache.prices[itemKey(it)]);
  // 3) TCGdex as a careful backup for whatever is left
  const setCards = {}; let fails = 0; const down = () => fails >= 3;   // stop using the backup if it keeps failing
  const neededSets = [...new Set(left.map(i => cache.sets[codeOf(i)]).filter(Boolean))];
  for (let i = 0; i < neededSets.length; i++) {
    const id = neededSets[i]; say(`Reading set ${i+1} of ${neededSets.length}…`);
    if (down()) { setCards[id] = undefined; continue; }
    try { const set = await getJSON(`${API}/sets/${encodeURIComponent(id)}`); fails = 0; if (set && Array.isArray(set.cards)) { const m = {}; for (const c of set.cards) m[numKey(c.localId)] = c; setCards[id] = m; } else setCards[id] = null; }
    catch(e) { fails++; setCards[id] = undefined; stats.errors++; note('errors', `TCGdex set ${id}: ${e.message}`); }
    await sleep(400);
  }
  // 3) card details (prices) for every distinct card we hold
  const uniq = new Map(); for (const it of left) uniq.set(itemKey(it), it);
  const todo = [...uniq.entries()];
  async function one([k, it]){
    const code = codeOf(it), setId = cache.sets[code];
    if (!setId) { stats.noSet++; unknownSets.add(code); cache.miss[k] = Date.now(); return; }
    const list = setCards[setId];
    let id = cache.ids[k] || null;
    if (!id) {
      if (list === undefined) return;                       // set list failed this time: try again next run
      let c = list && list[numKey(it.num)];
      if (!c && list && /^(SM|SWSH)$/.test(code)) c = list[numKey(code + String(it.num).replace(/^0+/,''))];
      if (!c) { stats.notInSet++; note('notInSet', `${it.name} ${code} ${it.num} → ${setId}`); cache.miss[k] = Date.now(); return; }
      if (firstWord(c.name) && firstWord(it.name) && !norm(c.name).includes(firstWord(it.name)) && !norm(it.name).includes(firstWord(c.name))) { stats.nameMismatch++; note('nameMismatch', `${code} ${it.num}: bought “${it.name}”, TCGdex has “${c.name}”`); cache.miss[k] = Date.now(); return; }
      id = c.id;
    }
    let card;
    if (down()) return;
    try { card = await getJSON(`${API}/cards/${encodeURIComponent(id)}`); fails = 0; }
    catch(e) { fails++; stats.errors++; note('errors', `TCGdex ${id}: ${e.message}`); return; }
    if (!card) { stats.notInSet++; note('notInSet', `${it.name} → ${id} (404)`); cache.miss[k] = Date.now(); return; }
    cache.ids[k] = id; delete cache.miss[k];
    const cm = card.pricing && card.pricing.cardmarket;
    const holo = /rh|rev|holo/i.test(it.rar||'') || (card.variants && card.variants.normal === false);
    const pick = cm ? (holo ? (cm['trend-holo'] ?? cm['avg30-holo'] ?? cm.trend ?? cm.avg30) : (cm.trend ?? cm.avg30 ?? cm['trend-holo'] ?? cm['avg30-holo'])) : null;
    let tp = null;
    if (!(typeof pick === 'number' && pick > 0) && card.pricing && card.pricing.tcgplayer) {
      const t = card.pricing.tcgplayer; for (const v of Object.values(t)) { const m = v && typeof v === 'object' && (v.marketPrice ?? v.midPrice); if (typeof m === 'number' && m > 0) { tp = Math.round(m * (usdToEur||0.92) * 100) / 100; break; } }
    }
    if (typeof pick === 'number' && pick > 0) { cache.prices[k] = { p: pick, id, name: card.name, src: 'Cardmarket' }; stats.priced++; }
    else if (tp) { cache.prices[k] = { p: tp, id, name: card.name, src: 'TCGplayer' }; stats.priced++; stats.us = (stats.us||0) + 1; }
    else { stats.noPrice++; note('noPrice', `${card.name} (${id})`); }
  }
  for (let i = 0; i < todo.length && !down(); i++) {
    await one(todo[i]);
    say(`Backup source: card ${i+1} of ${todo.length}…`);
    await sleep(350);
  }
  cache.stats = stats; cache.samples = samples; cache.unknownSets = [...unknownSets];
  cache.v = 2;
  return cache;
}

function value(pk, cache){
  const items = (pk && pk.items) || [];
  const prices = (cache && cache.prices) || {};
  let cost = 0, market = 0, pricedCost = 0, pricedMarket = 0, pricedQty = 0, qty = 0;
  const rows = [];
  for (const it of items) {
    const c = Number(it.cost) || 0, q = Number(it.qty) || 0;
    cost += c; qty += q;
    const pr = priceable(it) ? prices[itemKey(it)] : null;
    if (pr) { const m = pr.p * q; market += m; pricedCost += c; pricedMarket += m; pricedQty += q; rows.push({ ...it, price: pr.p, src: pr.src, market: m }); }
    else { market += c; rows.push({ ...it, price: null, market: c }); }
  }
  rows.sort((a,b) => b.market - a.market);
  return { cost, market, gain: market - cost, pricedCost, pricedMarket, pricedQty, qty, rows,
    syncedAt: pk && pk.at, pricedAt: cache && cache.at, kpi: (pk && pk.kpi) || null };
}

window.PokeCore = { refresh, value, priceable, itemKey, todayKey, KNOWN };
})();
