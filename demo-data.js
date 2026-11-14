/* Finance Hub — made-up sample data for the demo (…/Finance-hub/?demo).
   Nothing here is real; the demo never talks to a database. */
(function(){
const pad = n => String(n).padStart(2,'0');
const now = new Date();
const mk = (y, m) => `${y}-${pad(m)}`;
const months = []; for (let i = 3; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth()-i, 1); months.push([d.getFullYear(), d.getMonth()+1]); }
let seq = 0, seed = 7;
const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
const tx = [];
const add = (y, m, d, type, cat, eur, note) => {
  const last = new Date(y, m, 0).getDate(), day = Math.min(d, last);
  const date = `${y}-${pad(m)}-${pad(day)}`;
  if (new Date(date) > now) return;
  tx.push({ id: 'demo_' + (++seq), type, cat, amount: Math.round(eur * 100), date, note, src: 'import', created: seq });
};
for (const [y, m] of months) {
  add(y, m, 25, 'income', 'salary', 2650, 'Acme Logistics BV · Salary');
  add(y, m, 1, 'expense', 'fixed', 925, 'Woonstede Housing · Rent');
  add(y, m, 3, 'expense', 'fixed', 132.40, 'ZorgPlus Insurance · Health insurance');
  add(y, m, 5, 'expense', 'fixed', 89, 'GreenPower Energy · Monthly instalment');
  add(y, m, 8, 'expense', 'fixed', 42.50, 'FiberNet · Internet');
  add(y, m, 12, 'expense', 'fixed', 18, 'MobiTel · Phone');
  add(y, m, 14, 'expense', 'subs', 13.99, 'StreamFlix · Subscription');
  add(y, m, 16, 'expense', 'subs', 11.99, 'TuneBox · Music');
  add(y, m, 2, 'expense', 'invest', 300, 'Broker Bank · Deposit');
  add(y, m, 20, 'expense', 'invest', 150, 'CryptoXchange · Deposit');
  for (let w = 0; w < 5; w++) {
    add(y, m, 3 + w*6, 'expense', 'groceries', 35 + rnd()*40, ['FreshMart', 'BudgetFoods', 'CornerShop'][w % 3] + ' · Groceries');
    if (rnd() > .35) add(y, m, 5 + w*6, 'expense', 'eatout', 9 + rnd()*30, ['Pizza Roma', 'Noodle Bar', 'Café Central', 'Burger Spot'][w % 4] + ' · Eating out');
    if (rnd() > .5) add(y, m, 4 + w*6, 'expense', 'transport', 4 + rnd()*20, 'City Transit · Travel');
  }
  add(y, m, 18, 'expense', 'shopping', 25 + rnd()*90, 'Webshop.nl · Order');
  add(y, m, 22, 'expense', 'leisure', 15 + rnd()*40, 'Cinema Plaza · Tickets');
  if (rnd() > .5) add(y, m, 27, 'expense', 'health', 12.5, 'Pharmacy · Drugstore');
  add(y, m, 26, 'expense', 'savings', 200, 'Own savings account · Transfer to savings');
  add(y, m, 10, 'income', 'pokesale', 80 + rnd()*200, 'Card marketplace · Payout');
}

const holdings = [];
const base = { Crypto: 1800, Stocks: 5200, Vinyl: 900, Silver: 1400 };
months.forEach(([y, m], i) => holdings.push({ date: `1 ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1]} ${y}`,
  Crypto: Math.round(base.Crypto * (1 + i*.06)), Stocks: Math.round(base.Stocks * (1 + i*.03)), Vinyl: base.Vinyl + i*40, Silver: Math.round(base.Silver * (1 + i*.02)) }));
const histMonths = months.slice(0, 3).map(([y, m]) => ({ month: `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1]} ${y}`, Crypto: 150, Stocks: 300, Vinyl: 40, Silver: 0 }));
const lastSnap = holdings[holdings.length - 1];
const baseDate = (() => { const d = new Date(now.getFullYear(), now.getMonth(), 1); d.setDate(0); return `${d.getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]} ${d.getFullYear()}`; })();
const todayKey = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`;

const investing = {
  baseline: { date: baseDate, stocks: { VWRL: 30, ASML: 2, MSFT: 4 }, crypto: { bitcoin: 0.025, ethereum: 0.6 }, silverGrams: 900, cashEur: 64.20 },
  stockMeta: [
    { sym:'VWRL', name:'World ETF (sample)', src:'av', av:'VWRL.AMS', ccy:'EUR', manual: 118.4 },
    { sym:'ASML', name:'Chip maker (sample)', src:'av', av:'ASML.AMS', ccy:'EUR', manual: 690 },
    { sym:'MSFT', name:'Software co. (sample)', src:'td', mic:'XNAS', ccy:'USD', manual: 430 },
  ],
  cryptoLabel: { bitcoin:'BTC', ethereum:'ETH' },
  vinylEstimate: 1050,
  investedHistory: histMonths,
  holdings,
};
const prices = { day: todayKey, at: Date.now(), complete: true, demo: true,
  cryptoEur: { bitcoin: 88000, ethereum: 3150 }, quotes: { VWRL:{price:121.3,ccy:'EUR'}, ASML:{price:702,ccy:'EUR'}, MSFT:{price:441,ccy:'USD'} },
  rates: { EUR:1, USD:0.91, GBP:1.17 }, xagUsd: 48.2, log: [], feedWarnings: [] };

const pkItems = [
  ['Pikachu','SVI','063',3,12.5],['Charizard ex','OBF','125',1,38],['Eevee','PRE','074',2,9.8],['Gengar','TWM','104',1,6.4],
  ['Snorlax','SCR','143',1,22],['Mew ex','MEW','151',1,31],['Lucario','SSP','114',2,7.2],['Umbreon ex','PRE','060',1,55],
  ['Booster bundle (sealed)','SSP','',2,48],['Elite Trainer Box (sealed)','PRE','',1,64],
].map(([name,set,num,qty,unit]) => ({ name, set, num, lang:'EN', rar:'', qty, cost: Math.round(qty*unit*100)/100 }));
const pkPrices = {};
pkItems.forEach((it, i) => { if (it.num) pkPrices[`${it.set}|${it.num}|${it.name.toLowerCase().replace(/[^a-z0-9]/g,'')}|n`] = { p: Math.round(it.cost/it.qty * (0.9 + (i%5)*0.15) * 100)/100, id: 'demo', name: it.name, src: i % 3 ? 'Cardmarket' : 'TCGplayer' }; });
const pkCost = pkItems.reduce((s,i)=>s+i.cost,0);
const pokemon = { at: Date.now() - 3*3600e3, source:'demo', items: pkItems, setNames:{},
  kpi: { stockQty: pkItems.reduce((s,i)=>s+i.qty,0), stockCost: Math.round(pkCost*100)/100, netProfit: 642.18, revenue: 2310.5 } };
const pkHistory = {}; months.forEach(([y, m], i) => { pkHistory[mk(y, m)] = Math.round(pkCost * (1.05 + i*.04)); });
const pokemon_prices = { day: todayKey, at: Date.now() - 3600e3, v: 2, sets:{}, ids:{}, miss:{}, prices: pkPrices, history: pkHistory,
  stats: { priced: Object.keys(pkPrices).length, noPrice:0, notInSet:0, nameMismatch:0, noSet:0, errors:0, us: 3 }, samples:{}, unknownSets:[] };

const bank = {};
let bal = 1450;
months.slice(0, 3).forEach(([y, m]) => { const last = new Date(y, m, 0).getDate(); bal += 180 + Math.round(rnd()*120); bank[`${y}-${pad(m)}-${pad(last)}`] = bal * 100; });

investing.accounts = [{ id: 'a_demo', name: 'Savings', start: 600000, startDate: `${months[0][0]}-${pad(months[0][1])}-01` }];

window.DEMO_DATA = {
  tx,
  hub: { investing, ledger: [], overrides: {}, prices, api_keys: null, bank, pokemon, pokemon_prices },
};
})();
