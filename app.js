/* Semiconductor Learning Tool — client logic.
 * Loads history.json (same-origin), computes indicators from the real time
 * series, and drives three views: What changed, Practice portfolio, Influence web.
 * Framing throughout: probability & risk, never prediction. Fake money only. */
'use strict';

/* ---------- tiny helpers ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const fmtUSD = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => (n > 0 ? '+' : '') + n.toFixed(2) + '%';
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/* localStorage with graceful fallback (works on GitHub Pages; degrades on file://) */
const store = {
  mem: {},
  get(k) { try { return localStorage.getItem(k); } catch { return this.mem[k] ?? null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { this.mem[k] = v; } },
};

const STATE = {
  data: null,        // parsed history.json
  closes: {},        // ticker -> [close]
  opens: {},         // ticker -> [open]   (falls back to close if absent)
  highs: {},         // ticker -> [high]   (falls back to close if absent)
  lows: {},          // ticker -> [low]    (falls back to close if absent)
  dates: {},         // ticker -> [date]
  vols: {},          // ticker -> [volume]
  window: 1,         // change-view window in trading days
  selectedNode: null,
  portfolio: null,   // {seed, cash, positions:{t:{shares,cost}}}
  orders: [],        // planned orders
  reportEvents: [],  // fills/skips from the most recent replay (the "while away" report)
};

/* ============================================================
 *  INDICATORS  (all computed from the real series)
 * ============================================================ */
function sma(arr, period) {
  if (arr.length < period) return null;
  let s = 0; for (let i = arr.length - period; i < arr.length; i++) s += arr[i];
  return s / period;
}
function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let e = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}
function emaSeries(arr, period) {
  if (arr.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let e = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function rsi(arr, period = 14) {
  if (arr.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = arr.length - period; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}
function macd(arr) {
  if (arr.length < 35) return null;
  const e12 = emaSeries(arr, 12), e26 = emaSeries(arr, 26);
  const line = [];
  for (let i = 0; i < arr.length; i++) {
    if (e12[i] != null && e26[i] != null) line[i] = e12[i] - e26[i];
  }
  const compact = line.filter((x) => x != null);
  const signal = ema(compact, 9);
  const macdVal = line[line.length - 1];
  return { macd: macdVal, signal, hist: macdVal - signal };
}
function supportResistance(closes, lookback = 30) {
  const slice = closes.slice(-lookback);
  return { support: Math.min(...slice), resistance: Math.max(...slice) };
}
/** % change over N trading days (N bars back). */
function pctChange(closes, n) {
  if (closes.length <= n) return null;
  const a = closes[closes.length - 1 - n], b = closes[closes.length - 1];
  return ((b - a) / a) * 100;
}
function latestPrice(t) { const c = STATE.closes[t]; return c[c.length - 1]; }
function trendClass(p) { return p > 0.3 ? 'up' : p < -0.3 ? 'down' : 'flat'; }

/* trend score (-1..1) over ~20 days, for node color */
function trendScore(t) {
  const p = pctChange(STATE.closes[t], 20);
  if (p == null) return 0;
  return clamp(p / 15, -1, 1); // ±15% over a month saturates the color
}
function trendColor(score) {
  // green (#2fbf71) -> grey (#7d8aa6) -> red (#ef5d5d)
  const g = [47, 191, 113], n = [125, 138, 166], r = [239, 93, 93];
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const c = score >= 0 ? mix(n, g, score) : mix(n, r, -score);
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/* ============================================================
 *  DATA LOAD
 * ============================================================ */
async function loadData() {
  const res = await fetch('history.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('history.json HTTP ' + res.status);
  const data = await res.json();
  STATE.data = data;
  for (const t of data.tickers) {
    const s = data.series[t] || [];
    STATE.closes[t] = s.map((b) => b.close);
    STATE.dates[t] = s.map((b) => b.date);
    STATE.vols[t] = s.map((b) => b.volume);
    // Keep OHLC for trigger evaluation. The deployed (Twelve Data) feed has
    // open/high/low; if a slimmed feed lacks them, fall back to close so the
    // app still works (triggers just lose intraday gap/touch nuance).
    STATE.opens[t] = s.map((b) => (b.open != null ? b.open : b.close));
    STATE.highs[t] = s.map((b) => (b.high != null ? b.high : b.close));
    STATE.lows[t] = s.map((b) => (b.low != null ? b.low : b.close));
  }
  // header status
  const asOf = data.as_of || '—';
  $('#dataAsOf').textContent = 'Data as of ' + asOf;
  $('#dataDot').classList.add('ok');
  $('#footerSource').textContent = 'Source: ' + (data.source || 'unknown') + ' · as of ' + asOf;
}

/* ============================================================
 *  VIEW: WHAT CHANGED
 * ============================================================ */
function sparkline(closes, n) {
  const pts = closes.slice(-Math.max(n + 1, 30));
  if (pts.length < 2) return '';
  const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const W = 200, H = 36;
  const d = pts.map((v, i) => {
    const x = (i / (pts.length - 1)) * W;
    const y = H - ((v - min) / span) * (H - 4) - 2;
    return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
  }).join(' ');
  const up = pts[pts.length - 1] >= pts[0];
  const col = up ? 'var(--green)' : 'var(--red)';
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${col}" stroke-width="2"/></svg>`;
}

function renderChanged() {
  const grid = $('#changedGrid');
  const n = STATE.window;
  grid.innerHTML = STATE.data.tickers.map((t) => {
    const price = latestPrice(t);
    const chg = pctChange(STATE.closes[t], n);
    const cls = chg == null ? 'flat' : trendClass(chg);
    const arrow = chg == null ? '' : chg > 0 ? '▲' : chg < 0 ? '▼' : '–';
    const abs = chg == null ? '' : fmtUSD(price - STATE.closes[t][STATE.closes[t].length - 1 - n]);
    const label = { 1: '1-day', 5: '5-day', 21: '1-month' }[n];
    return `<div class="tcard">
      <span class="sym">${t}</span>
      <span class="price">${fmtUSD(price)}</span>
      <span class="chg ${cls}">${arrow} ${chg == null ? 'n/a' : fmtPct(chg)} <span class="meta">(${abs})</span></span>
      <span class="meta">${label} change</span>
      ${sparkline(STATE.closes[t], n)}
    </div>`;
  }).join('');
}

function initWindowPicker() {
  $$('#windowPicker .pill').forEach((b) => b.addEventListener('click', () => {
    $$('#windowPicker .pill').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    STATE.window = parseInt(b.dataset.window, 10);
    renderChanged();
  }));
}

/* ============================================================
 *  VIEW: PRACTICE PORTFOLIO
 * ============================================================ */
function defaultPortfolio(seed) { return { seed, cash: seed, positions: {} }; }
function loadPortfolio() {
  try {
    const raw = store.get('portfolio');
    if (raw) { STATE.portfolio = JSON.parse(raw); return; }
  } catch {}
  STATE.portfolio = defaultPortfolio(10000);
}
function savePortfolio() { store.set('portfolio', JSON.stringify(STATE.portfolio)); }

function positionValue(t) { const p = STATE.portfolio.positions[t]; return p ? p.shares * latestPrice(t) : 0; }
function portfolioValue() {
  let v = STATE.portfolio.cash;
  for (const t in STATE.portfolio.positions) v += positionValue(t);
  return v;
}

function trade(t, dollars, side) {
  const pf = STATE.portfolio;
  const price = latestPrice(t);
  if (!(dollars > 0)) return toast('Enter a dollar amount.');
  if (side === 'buy') {
    if (dollars > pf.cash + 1e-6) return toast('Not enough cash. You have ' + fmtUSD(pf.cash) + '.');
    const shares = dollars / price;
    const pos = pf.positions[t] || { shares: 0, cost: 0 };
    pos.cost += dollars; pos.shares += shares;
    pf.positions[t] = pos; pf.cash -= dollars;
    toast(`Bought ${shares.toFixed(4)} ${t} @ ${fmtUSD(price)}`);
  } else {
    const pos = pf.positions[t];
    if (!pos || pos.shares <= 0) return toast('You hold no ' + t + '.');
    const held = pos.shares * price;
    const sellDollars = Math.min(dollars, held);
    const sharesSold = sellDollars / price;
    const fraction = sharesSold / pos.shares;
    pos.cost -= pos.cost * fraction;       // reduce basis proportionally
    pos.shares -= sharesSold; pf.cash += sellDollars;
    if (pos.shares < 1e-9) delete pf.positions[t];
    toast(`Sold ${sharesSold.toFixed(4)} ${t} @ ${fmtUSD(price)}`);
  }
  savePortfolio();
  renderPortfolio();
}

function renderPortfolio() {
  const pf = STATE.portfolio;
  const total = portfolioValue();
  const invested = total - pf.cash;
  const pl = total - pf.seed;
  const plPct = (pl / pf.seed) * 100;
  $('#portfolioSummary').innerHTML = `
    <div class="stat"><div class="label">Total value</div><div class="value">${fmtUSD(total)}</div></div>
    <div class="stat"><div class="label">Cash</div><div class="value">${fmtUSD(pf.cash)}</div></div>
    <div class="stat"><div class="label">Invested</div><div class="value">${fmtUSD(invested)}</div></div>
    <div class="stat"><div class="label">P&amp;L vs start</div><div class="value ${trendClass(pl)}">${fmtUSD(pl)} <span class="meta">${fmtPct(plPct)}</span></div></div>`;

  const rows = Object.keys(pf.positions).map((t) => {
    const pos = pf.positions[t];
    const price = latestPrice(t);
    const mv = pos.shares * price;
    const avg = pos.cost / pos.shares;
    const upl = mv - pos.cost;
    const uplPct = (upl / pos.cost) * 100;
    return `<tr>
      <td>${t}</td>
      <td>${pos.shares.toFixed(4)}</td>
      <td>${fmtUSD(avg)}</td>
      <td>${fmtUSD(price)}</td>
      <td>${fmtUSD(mv)}</td>
      <td class="${trendClass(upl)}">${fmtUSD(upl)} (${fmtPct(uplPct)})</td>
    </tr>`;
  }).join('');
  $('#holdingsTableWrap').innerHTML = rows
    ? `<div class="table-scroll"><table>
        <thead><tr><th>Ticker</th><th>Shares</th><th>Avg cost</th><th>Last</th><th>Mkt value</th><th>Unrealized P&amp;L</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
    : `<p class="muted">No holdings yet. Pick a ticker, enter a dollar amount, and Buy. It's fake money — experiment freely.</p>`;

  renderSignals($('#tradeTicker').value);
  renderGains($('#tradeTicker').value);
}

/* ---- signals: each with what it reads today + confidence + failure mode ---- */
function renderSignals(t) {
  const closes = STATE.closes[t];
  const price = latestPrice(t);
  const s20 = sma(closes, 20), s50 = sma(closes, 50);
  const r = rsi(closes, 14);
  const m = macd(closes);
  const sr = supportResistance(closes, 30);
  const lastVol = STATE.vols[t][STATE.vols[t].length - 1];
  const avgVol = STATE.vols[t].slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, STATE.vols[t].length);

  const signals = [
    {
      name: 'Moving averages (20 & 50-day)',
      read: s20 && s50 ? (s20 > s50 ? 'Up-bias' : 'Down-bias') : 'n/a',
      conf: 'Medium',
      body: `20-day avg ${s20 ? fmtUSD(s20) : 'n/a'}, 50-day avg ${s50 ? fmtUSD(s50) : 'n/a'}, last ${fmtUSD(price)}. A shorter average above a longer one is often read as a more constructive trend.`,
      fail: 'Averages lag — they describe where price has been, not where it goes. In choppy, sideways markets they "whipsaw," flipping back and forth and generating false signals.',
    },
    {
      name: 'RSI (14)',
      read: r == null ? 'n/a' : r > 70 ? 'Overbought zone' : r < 30 ? 'Oversold zone' : 'Neutral',
      conf: 'Low–Medium',
      body: `RSI is ${r == null ? 'n/a' : r.toFixed(1)}. Above ~70 is often called "overbought", below ~30 "oversold" — a gauge of how stretched recent moves are.`,
      fail: 'A strong stock can stay "overbought" for weeks while it keeps rising; a falling one can stay "oversold." RSI flags stretch, not a turning point.',
    },
    {
      name: 'MACD (12/26/9)',
      read: m == null ? 'n/a' : m.hist > 0 ? 'Momentum up' : 'Momentum down',
      conf: 'Low–Medium',
      body: m == null ? 'Not enough history yet.' : `MACD line ${m.macd.toFixed(2)} vs signal ${m.signal.toFixed(2)} (histogram ${m.hist.toFixed(2)}). The line crossing above its signal is read as improving momentum.`,
      fail: 'MACD is built from lagging moving averages, so its crossings arrive after a move is underway and produce frequent false signals in rangebound markets.',
    },
    {
      name: 'Volume',
      read: lastVol > avgVol * 1.3 ? 'Above average' : lastVol < avgVol * 0.7 ? 'Below average' : 'Normal',
      conf: 'Context only',
      body: `Latest volume ${(lastVol / 1e6).toFixed(1)}M vs 20-day avg ${(avgVol / 1e6).toFixed(1)}M. Big moves on heavy volume are seen as more "convincing" than the same move on light volume.`,
      fail: 'Volume confirms nothing on its own. Spikes happen on index rebalances, options expiry, and news that may not repeat. It is context, not a trigger.',
    },
    {
      name: 'Support & resistance (30-day)',
      read: 'Range',
      conf: 'Low',
      body: `Recent floor ~${fmtUSD(sr.support)}, recent ceiling ~${fmtUSD(sr.resistance)}, last ${fmtUSD(price)}. These are levels where price has recently turned — watched by many traders, which can make them briefly self-fulfilling.`,
      fail: 'Levels are not walls. They break, and the more obvious a level is, the more likely it gets "tested" and blown through. Past turning points do not bind the future.',
    },
  ];

  $('#signalsAccordion').innerHTML = signals.map((s) => `
    <details class="signal">
      <summary><span>${s.name}</span><span class="read ${trendClass(s.read === 'Up-bias' || s.read === 'Momentum up' ? 1 : s.read === 'Down-bias' || s.read === 'Momentum down' ? -1 : 0)}">${s.read}</span></summary>
      <div class="body">
        <p>${s.body}</p>
        <span class="conf">Confidence: ${s.conf}</span>
        <p class="fail"><strong>How it misleads:</strong> ${s.fail}</p>
      </div>
    </details>`).join('');
}

/* ---- short- vs long-term capital gains comparison (illustrative US framing) ---- */
function renderGains(t) {
  const pos = STATE.portfolio.positions[t];
  const price = latestPrice(t);
  // Use the held position's unrealized gain if any, else a $1,000 example gain.
  let gain, basisNote;
  if (pos && pos.cost > 0) {
    gain = pos.shares * price - pos.cost;
    basisNote = `Based on your current ${t} position (unrealized gain ${fmtUSD(gain)}).`;
  } else {
    gain = 1000; basisNote = `Example: a ${fmtUSD(1000)} gain (you hold no ${t}, so this is illustrative).`;
  }
  const shortRate = 0.32;  // ordinary-income bracket (illustrative)
  const longRate = 0.15;   // typical long-term cap-gains rate (illustrative)
  const shortTax = Math.max(0, gain) * shortRate;
  const longTax = Math.max(0, gain) * longRate;
  const saved = shortTax - longTax;
  $('#gainsCompare').innerHTML = `
    <p class="muted">${basisNote}</p>
    <div class="gains-grid">
      <div class="col"><h4 class="down">Sold &lt; 1 year (short-term)</h4>
        <p>Taxed as ordinary income — here ~${(shortRate * 100).toFixed(0)}%.<br>Est. tax: <strong>${fmtUSD(shortTax)}</strong></p></div>
      <div class="col"><h4 class="up">Held &gt; 1 year (long-term)</h4>
        <p>Taxed at the lower long-term rate — here ~${(longRate * 100).toFixed(0)}%.<br>Est. tax: <strong>${fmtUSD(longTax)}</strong></p></div>
    </div>
    <p class="muted">Holding past one year would save about <strong>${fmtUSD(Math.max(0, saved))}</strong> in this example. Real rates depend on your income and change over time — this is not tax advice.</p>`;
}

function initPortfolio() {
  loadPortfolio();
  const sel = $('#tradeTicker');
  sel.innerHTML = STATE.data.tickers.map((t) => `<option value="${t}">${t} — ${fmtUSD(latestPrice(t))}</option>`).join('');
  sel.addEventListener('change', () => { renderSignals(sel.value); renderGains(sel.value); });
  $('#seedBalance').value = STATE.portfolio.seed;

  $('#btnBuy').addEventListener('click', () => trade(sel.value, parseFloat($('#tradeDollars').value), 'buy'));
  $('#btnSell').addEventListener('click', () => trade(sel.value, parseFloat($('#tradeDollars').value), 'sell'));
  $('#btnReset').addEventListener('click', () => { STATE.portfolio = defaultPortfolio(STATE.portfolio.seed); savePortfolio(); renderPortfolio(); toast('Portfolio reset.'); });
  $('#btnApplySeed').addEventListener('click', () => {
    const v = parseFloat($('#seedBalance').value);
    if (!(v >= 100)) return toast('Use a starting balance of at least $100.');
    STATE.portfolio = defaultPortfolio(v); savePortfolio(); renderPortfolio(); toast('Starting balance set to ' + fmtUSD(v) + '.');
  });
  renderPortfolio();
}

/* ============================================================
 *  VIEW: INFLUENCE WEB
 * ============================================================ */
// Stock nodes (positioned), driver/source nodes, and edges.
const WEB = {
  stocks: {
    NVDA: { x: 640, y: 150 }, AMD: { x: 820, y: 230 }, TSM: { x: 470, y: 250 },
    MU: { x: 690, y: 330 }, ASML: { x: 250, y: 180 }, LRCX: { x: 260, y: 330 },
    INTC: { x: 470, y: 470 }, SMH: { x: 640, y: 540 },
  },
  drivers: {
    'AI datacenter capex': { x: 850, y: 80 },
    'Memory cycle (DRAM/HBM)': { x: 880, y: 400 },
    'EUV litho (ASML)': { x: 90, y: 110 },
    'Foundry capacity': { x: 120, y: 420 },
    'Export controls (US–China)': { x: 470, y: 70 },
  },
  // type: 'solid' = well-documented relationship; 'dash' = hypothesized/conditional (labeled)
  edges: [
    { a: 'EUV litho (ASML)', b: 'ASML', type: 'solid' },
    { a: 'ASML', b: 'TSM', type: 'solid', label: 'sells EUV tools' },
    { a: 'LRCX', b: 'TSM', type: 'solid', label: 'etch/deposition tools' },
    { a: 'LRCX', b: 'MU', type: 'solid', label: 'equipment' },
    { a: 'Foundry capacity', b: 'TSM', type: 'solid' },
    { a: 'TSM', b: 'NVDA', type: 'solid', label: 'fabs its chips' },
    { a: 'TSM', b: 'AMD', type: 'solid', label: 'fabs its chips' },
    { a: 'MU', b: 'NVDA', type: 'solid', label: 'HBM supplier' },
    { a: 'Memory cycle (DRAM/HBM)', b: 'MU', type: 'solid' },
    { a: 'AI datacenter capex', b: 'NVDA', type: 'solid', label: 'datacenter demand' },
    { a: 'NVDA', b: 'SMH', type: 'solid', label: 'top ETF holding' },
    { a: 'TSM', b: 'SMH', type: 'solid' },
    { a: 'AMD', b: 'SMH', type: 'solid' },
    { a: 'ASML', b: 'SMH', type: 'solid' },
    { a: 'INTC', b: 'SMH', type: 'solid' },
    // hypothesized / conditional — clearly labeled, no invented certainty
    { a: 'AI datacenter capex', b: 'AMD', type: 'dash', label: 'hypothesized: AI share' },
    { a: 'Export controls (US–China)', b: 'NVDA', type: 'dash', label: 'hypothesized: China rev. risk' },
    { a: 'INTC', b: 'Foundry capacity', type: 'dash', label: 'hypothesized: future foundry rival' },
    { a: 'Memory cycle (DRAM/HBM)', b: 'AI datacenter capex', type: 'dash', label: 'hypothesized: HBM tightness' },
  ],
};

const NODE_INFO = {
  NVDA: 'Nvidia — designs GPUs/accelerators for AI datacenters and gaming. A "fabless" designer: it relies on TSMC to manufacture and on Micron/SK Hynix for high-bandwidth memory. Its results are closely tied to hyperscaler AI spending.',
  AMD: 'Advanced Micro Devices — CPUs and GPUs for PCs, servers, and increasingly AI. Also fabless (manufactured by TSMC). Often discussed as the main challenger to Nvidia in AI accelerators and to Intel in CPUs.',
  TSM: 'TSMC — the world\'s largest contract chip manufacturer (foundry). Makes chips for Nvidia, AMD, Apple and others. A bottleneck node: leading-edge capacity here gates much of the industry.',
  MU: 'Micron — memory maker (DRAM/NAND), including high-bandwidth memory (HBM) used by AI accelerators. Highly cyclical: prices swing with the memory supply/demand cycle.',
  ASML: 'ASML — the only supplier of EUV lithography machines, the tools needed to make the most advanced chips. A genuine monopoly at the leading edge; foundries depend on it.',
  LRCX: 'Lam Research — wafer-fabrication equipment (etch and deposition). Sells tools to foundries and memory makers, so its demand tracks fab build-out and the memory cycle.',
  INTC: 'Intel — integrated designer-and-manufacturer (IDM). Historically the CPU leader; now investing heavily to build a contract foundry business. Its turnaround is widely debated.',
  SMH: 'SMH — the VanEck Semiconductor ETF. A basket of the largest chip names (Nvidia, TSMC, AMD, ASML, etc.), so it moves with the sector overall and is dominated by its biggest holdings.',
  'AI datacenter capex': 'Driver: how much hyperscalers (cloud providers) spend on AI infrastructure. A major demand source for accelerators and the memory/foundry chain behind them.',
  'Memory cycle (DRAM/HBM)': 'Driver: the boom/bust pricing cycle in memory chips. When supply is tight, memory makers’ margins jump; when it floods, they fall.',
  'EUV litho (ASML)': 'Driver: access to extreme-ultraviolet lithography. Because ASML is the sole supplier, this is a structural chokepoint for leading-edge manufacturing.',
  'Foundry capacity': 'Driver: available leading-edge manufacturing capacity (largely TSMC today). Scarce capacity can constrain how many advanced chips reach the market.',
  'Export controls (US–China)': 'Driver: government restrictions on selling advanced chips/tools to China. Policy-dependent and can shift revenue expectations quickly.',
};

function buildWeb() {
  const svg = $('#webSvg');
  const ns = 'http://www.w3.org/2000/svg';
  const pos = (name) => WEB.stocks[name] || WEB.drivers[name];
  let html = '';
  // edges first (under nodes)
  for (const e of WEB.edges) {
    const A = pos(e.a), B = pos(e.b);
    if (!A || !B) continue;
    html += `<path class="${e.type === 'solid' ? 'edge-solid' : 'edge-dash'}" d="M${A.x} ${A.y} L${B.x} ${B.y}"/>`;
    if (e.label) {
      const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
      html += `<text class="edge-label" x="${mx}" y="${my - 4}">${e.label}</text>`;
    }
  }
  // driver nodes (rounded rects)
  for (const name in WEB.drivers) {
    const p = WEB.drivers[name];
    const w = Math.max(96, name.length * 6.6), h = 34;
    html += `<g class="web-node driver" data-node="${name}">
      <rect x="${p.x - w / 2}" y="${p.y - h / 2}" width="${w}" height="${h}" rx="8"/>
      <text x="${p.x}" y="${p.y}">${name}</text></g>`;
  }
  // stock nodes (circles, colored by real trend)
  for (const name in WEB.stocks) {
    const p = WEB.stocks[name];
    const col = trendColor(trendScore(name));
    html += `<g class="web-node" data-node="${name}">
      <circle cx="${p.x}" cy="${p.y}" r="34" fill="${col}"/>
      <text x="${p.x}" y="${p.y}">${name}</text></g>`;
  }
  svg.innerHTML = html;
  $$('.web-node', svg).forEach((g) => g.addEventListener('click', () => selectNode(g.dataset.node)));
}

function selectNode(name) {
  STATE.selectedNode = name;
  $$('#webSvg .web-node circle, #webSvg .web-node rect').forEach((el) => el.classList.remove('node-sel'));
  const g = $(`#webSvg .web-node[data-node="${CSS.escape(name)}"]`);
  if (g) (g.querySelector('circle') || g.querySelector('rect')).classList.add('node-sel');
  const isStock = !!WEB.stocks[name];
  let extra = '';
  if (isStock) {
    const p1 = pctChange(STATE.closes[name], 1), p5 = pctChange(STATE.closes[name], 5), p21 = pctChange(STATE.closes[name], 21);
    extra = `<p class="muted">Recent trend — 1d ${p1 == null ? 'n/a' : fmtPct(p1)}, 5d ${p5 == null ? 'n/a' : fmtPct(p5)}, 1mo ${p21 == null ? 'n/a' : fmtPct(p21)} · last ${fmtUSD(latestPrice(name))}. Node color reflects the ~1-month trend.</p>`;
  }
  $('#webInfo').innerHTML = `<h3>${name}</h3><p>${NODE_INFO[name] || ''}</p>${extra}`;
}

/* ============================================================
 *  VIEW: PLANNED ORDERS  (client-side, daily-bar replay)
 * ============================================================ */
function loadOrders() {
  try { const r = store.get('plannedOrders'); STATE.orders = r ? JSON.parse(r) : []; }
  catch { STATE.orders = []; }
}
function saveOrders() { store.set('plannedOrders', JSON.stringify(STATE.orders)); }
function getLastSeen() { return store.get('lastSeenAsOf'); }
function setLastSeen(d) { store.set('lastSeenAsOf', d); }

/** Full bar for a ticker on a date, or null. Missing OHLC falls back to close. */
function barOn(t, date) {
  const i = STATE.dates[t] ? STATE.dates[t].indexOf(date) : -1;
  if (i < 0) return null;
  const close = STATE.closes[t][i];
  return { open: STATE.opens[t][i] ?? close, high: STATE.highs[t][i] ?? close, low: STATE.lows[t][i] ?? close, close };
}

/** Sorted union of all trading dates strictly after `lastSeen` (and <= as_of). */
function tradingDatesAfter(lastSeen) {
  const set = new Set();
  for (const t of STATE.data.tickers) for (const d of STATE.dates[t]) set.add(d);
  return [...set].sort().filter((d) => (!lastSeen || d > lastSeen));
}

/** Does this order fire on this day's bar? Returns {fire, fillPrice, reason}.
 *  Realistic model: if the day OPENED through your level (a gap), you fill at
 *  the open (slippage); otherwise the price reached your level intraday and you
 *  fill at the level. A date order fills at that day's open. */
function evalTrigger(o, bar, d) {
  if (o.trigger === 'date') {
    return d >= o.date ? { fire: true, fillPrice: bar.open, reason: 'scheduled' } : { fire: false };
  }
  if (o.trigger === 'below') {
    if (bar.low <= o.level) { const gap = bar.open <= o.level; return { fire: true, fillPrice: gap ? bar.open : o.level, reason: gap ? 'gap' : 'touched' }; }
    return { fire: false };
  }
  if (o.trigger === 'above') {
    if (bar.high >= o.level) { const gap = bar.open >= o.level; return { fire: true, fillPrice: gap ? bar.open : o.level, reason: gap ? 'gap' : 'touched' }; }
    return { fire: false };
  }
  return { fire: false };
}

/** Execute a fired order against the fake-money portfolio. Records a report event. */
function executePlanned(o, price, date, reason) {
  const pf = STATE.portfolio;
  let ok = true, detail = '';
  if (o.side === 'buy') {
    if (o.dollars > pf.cash + 1e-6) { ok = false; detail = 'not enough cash'; }
    else {
      const shares = o.dollars / price;
      const pos = pf.positions[o.ticker] || { shares: 0, cost: 0 };
      pos.cost += o.dollars; pos.shares += shares; pf.positions[o.ticker] = pos; pf.cash -= o.dollars;
      detail = `bought ${shares.toFixed(4)} sh`;
    }
  } else {
    const pos = pf.positions[o.ticker];
    if (!pos || pos.shares <= 0) { ok = false; detail = 'no shares to sell'; }
    else {
      const held = pos.shares * price;
      const sellDollars = Math.min(o.dollars, held);
      const sharesSold = sellDollars / price;
      const fraction = sharesSold / pos.shares;
      pos.cost -= pos.cost * fraction; pos.shares -= sharesSold; pf.cash += sellDollars;
      if (pos.shares < 1e-9) delete pf.positions[o.ticker];
      detail = `sold ${sharesSold.toFixed(4)} sh`;
    }
  }
  if (ok) { o.status = 'filled'; o.filledDate = date; o.fillPrice = price; o.fillReason = reason; }
  else { o.status = 'skipped'; o.filledDate = date; o.fillReason = 'skip'; o.skipDetail = detail; }
  STATE.reportEvents.push({ date, ok, side: o.side, dollars: o.dollars, ticker: o.ticker, note: o.note, price, reason: ok ? reason : 'skip', detail });
}

/** Walk every daily bar missed since the last open and fire any triggered orders. */
function replayMissedBars() {
  STATE.reportEvents = [];
  const asOf = STATE.data.as_of;
  const lastSeen = getLastSeen();
  if (!lastSeen) { setLastSeen(asOf); return; }   // first visit ever — nothing was missed
  if (lastSeen >= asOf) return;                    // already current
  for (const d of tradingDatesAfter(lastSeen)) {
    for (const o of STATE.orders) {
      if (o.status !== 'pending') continue;
      if (o.createdAsOf && d <= o.createdAsOf) continue; // only fire on bars after the order was placed
      const bar = barOn(o.ticker, d);
      if (!bar) continue;
      const res = evalTrigger(o, bar, d);
      if (res.fire) executePlanned(o, res.fillPrice, d, res.reason);
    }
  }
  setLastSeen(asOf);
  saveOrders();
  savePortfolio();
}

function reasonText(reason, detail) {
  switch (reason) {
    case 'gap': return '(gapped through your level → filled at the open: slippage)';
    case 'touched': return '(price reached your level that day)';
    case 'scheduled': return '(scheduled date reached → filled at the open)';
    case 'skip': return '(not filled — ' + (detail || 'could not execute') + ')';
    default: return '';
  }
}

function renderAwayReport() {
  const el = $('#awayReport');
  const evs = STATE.reportEvents;
  if (!evs || !evs.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="away-report"><h3>While you were away — ${evs.length} planned order${evs.length > 1 ? 's' : ''} acted</h3>` +
    evs.map((e) => `<div class="ev"><span class="when">${e.date}</span> — <strong>${e.ok ? (e.side === 'buy' ? 'Bought' : 'Sold') : 'Skipped'}</strong> ${fmtUSD(e.dollars)} ${e.ticker}${e.ok ? ` @ ${fmtUSD(e.price)}` : ''} <span class="reason-${e.reason === 'skip' ? 'skip' : e.reason === 'gap' ? 'gap' : 'touched'}">${reasonText(e.reason, e.detail)}</span>${e.note ? `<div class="why">“${e.note}”</div>` : ''}</div>`).join('') +
    `</div>`;
}

function orderRow(o, cancellable) {
  const cond = o.trigger === 'date' ? `on/after ${o.date}` : (o.trigger === 'below' ? `if ≤ ${fmtUSD(o.level)}` : `if ≥ ${fmtUSD(o.level)}`);
  const head = `<strong>${o.side === 'buy' ? 'Buy' : 'Sell'} ${fmtUSD(o.dollars)} ${o.ticker}</strong> <span class="tag">${cond}</span>`;
  let status = '';
  if (o.status === 'filled') status = `<div class="why">Filled ${o.filledDate} @ ${fmtUSD(o.fillPrice)} ${reasonText(o.fillReason)}</div>`;
  else if (o.status === 'skipped') status = `<div class="why reason-skip">Skipped ${o.filledDate} — ${o.skipDetail}</div>`;
  else if (o.status === 'canceled') status = `<div class="why">Canceled.</div>`;
  return `<div class="order-item"><div>${head}${o.note ? `<div class="why">“${o.note}”</div>` : ''}${status}</div>${cancellable ? `<button class="btn-mini" data-id="${o.id}">Cancel</button>` : ''}</div>`;
}

function renderPending() {
  const pend = STATE.orders.filter((o) => o.status === 'pending');
  $('#pendingCount').textContent = pend.length ? `(${pend.length})` : '(none)';
  const badge = $('#ordersBadge');
  if (pend.length) { badge.hidden = false; badge.textContent = pend.length; } else badge.hidden = true;
  $('#pendingList').innerHTML = pend.length
    ? pend.map((o) => orderRow(o, true)).join('')
    : `<p class="muted">No pending orders. Plan one above — it'll fire on a future day's data and report back here.</p>`;
  $$('#pendingList .btn-mini').forEach((b) => b.addEventListener('click', () => cancelOrder(b.dataset.id)));
}

function renderHistory() {
  const done = STATE.orders.filter((o) => o.status !== 'pending');
  $('#orderHistory').innerHTML = done.length
    ? done.slice().reverse().map((o) => orderRow(o, false)).join('')
    : `<p class="muted">No filled, skipped, or canceled orders yet.</p>`;
}

function addOrder() {
  const t = $('#orderTicker').value, side = $('#orderSide').value, trigger = $('#orderTrigger').value;
  const dollars = parseFloat($('#orderDollars').value);
  const note = $('#orderNote').value.trim();
  if (!(dollars > 0)) return toast('Enter a dollar amount.');
  if (!note) return toast('Add a short "why" — committing to a thesis is the point.');
  const o = { id: 'o' + Date.now() + Math.floor(Math.random() * 1000), ticker: t, side, trigger, dollars, note, status: 'pending', createdAsOf: STATE.data.as_of };
  if (trigger === 'date') {
    const dt = $('#orderDate').value;
    if (!dt) return toast('Pick a date.');
    o.date = dt;
  } else {
    const lvl = parseFloat($('#orderLevel').value);
    if (!(lvl > 0)) return toast('Enter a price level.');
    o.level = lvl;
  }
  STATE.orders.push(o); saveOrders();
  $('#orderDollars').value = ''; $('#orderLevel').value = ''; $('#orderNote').value = '';
  renderPending(); renderHistory();
  toast('Planned order added.');
}

function cancelOrder(id) {
  const o = STATE.orders.find((x) => x.id === id);
  if (o) { o.status = 'canceled'; saveOrders(); renderPending(); renderHistory(); toast('Order canceled.'); }
}

function initOrders() {
  loadOrders();
  $('#orderTicker').innerHTML = STATE.data.tickers.map((t) => `<option value="${t}">${t} — ${fmtUSD(latestPrice(t))}</option>`).join('');
  const trig = $('#orderTrigger');
  const syncInputs = () => {
    const isDate = trig.value === 'date';
    $('#orderLevelWrap').hidden = isDate;
    $('#orderDateWrap').hidden = !isDate;
  };
  trig.addEventListener('change', syncInputs); syncInputs();
  $('#btnAddOrder').addEventListener('click', addOrder);

  replayMissedBars();   // fire anything triggered while the app was closed
  renderAwayReport();
  renderPending();
  renderHistory();
  renderPortfolio();    // reflect any fills in the portfolio view
}

/* ============================================================
 *  TABS, TOAST, DISCLAIMER, PWA
 * ============================================================ */
function initTabs() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const view = tab.dataset.view;
    $$('.view').forEach((v) => { v.hidden = true; v.classList.remove('active'); });
    const el = $('#view-' + view);
    el.hidden = false; el.classList.add('active');
    if (view === 'web') buildWeb();
  }));
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function initDisclaimer() {
  const seen = store.get('disclaimerSeen') === '1';
  const modal = $('#disclaimer');
  if (!seen) modal.hidden = false;
  $('#acceptDisclaimer').addEventListener('click', () => {
    if ($('#dontShowAgain').checked) store.set('disclaimerSeen', '1');
    modal.hidden = true;
  });
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
    });
  }
}

/* ---------- boot ---------- */
async function boot() {
  initDisclaimer();
  initTabs();
  initWindowPicker();
  registerSW();
  try {
    await loadData();
    renderChanged();
    initPortfolio();
    initOrders();
    $('#webInfo').textContent = 'Tap any node to read about it.';
  } catch (e) {
    $('#dataAsOf').textContent = 'Could not load data';
    $('#dataDot').classList.add('err');
    $('#changedGrid').innerHTML = `<p class="muted">Couldn't load <code>history.json</code> (${e.message}). If you just deployed, wait for the first data run, or open via a web server rather than double-clicking the file.</p>`;
    console.error(e);
  }
}
boot();
