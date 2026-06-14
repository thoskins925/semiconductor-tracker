/* End-to-end logic test: runs the REAL app.js inside jsdom against the sample
 * history.json, exercising every view and a buy/sell round trip.
 * Run:  node scripts/test_app.mjs   (needs jsdom on the module path) */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const history = fs.readFileSync(path.join(root, 'history.json'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  ** FAIL:', msg); } };

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.github.io/repo/' });
const { window } = dom;

window.fetch = async () => ({ ok: true, status: 200, json: async () => JSON.parse(history) });
window.CSS = window.CSS || {}; window.CSS.escape = (s) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
window.scrollTo = () => {};
[...window.document.querySelectorAll('script')].forEach((s) => s.remove());

// Re-export script-scoped STATE onto window for the TEST only. The shipped
// app.js never does this; its top-level consts are correctly script-scoped.
const testable = appjs + '\n;window.__test={get STATE(){return STATE;}};';
new window.Function(testable).call(window);

await new Promise((r) => setTimeout(r, 50)); // let async boot() settle

const d = window.document;
const $ = (s) => d.querySelector(s);
const $$ = (s) => [...d.querySelectorAll(s)];

console.log('\n[Header / data load]');
ok(/Data as of 2026-06-12/.test($('#dataAsOf').textContent), 'header shows data-as-of timestamp from history.json');
ok($('#dataDot').classList.contains('ok'), 'data status dot is green (ok)');
ok(/SAMPLE/.test($('#footerSource').textContent), 'footer shows data source');

console.log('\n[View A -- What changed]');
ok($$('#changedGrid .tcard').length === 8, 'renders 8 ticker cards (one per ticker)');
ok($$('#changedGrid .spark').length === 8, 'each card has a sparkline SVG');
ok(/\$/.test($('#changedGrid .tcard .price').textContent), 'card shows a $ price');
ok(/%/.test($('#changedGrid .tcard .chg').textContent), 'card shows a % change');
$$('#windowPicker .pill')[1].dispatchEvent(new window.Event('click'));
ok(/5-day change/.test($('#changedGrid').textContent), 'window switch to 5-day re-renders');
$$('#windowPicker .pill')[2].dispatchEvent(new window.Event('click'));
ok(/1-month change/.test($('#changedGrid').textContent), 'window switch to 1-month re-renders');

console.log('\n[View B -- Practice portfolio]');
ok($('#tradeTicker').options.length === 8, 'trade dropdown lists 8 tickers');
ok(/\$10,000\.00/.test($('#portfolioSummary').textContent), 'starts with $10,000 total value');
ok(/No holdings yet/.test($('#holdingsTableWrap').textContent), 'no holdings before any trade');
ok($$('#signalsAccordion .signal').length === 5, 'shows 5 educational signals');
ok(/Confidence:/.test($('#signalsAccordion').textContent), 'signals include a confidence label');
ok(/How it misleads:/.test($('#signalsAccordion').textContent), 'signals include a failure mode');
ok(/short-term|long-term/i.test($('#gainsCompare').textContent), 'short vs long-term gains comparison renders');

const T = window.__test;
const cash = () => T.STATE.portfolio.cash;
const tick0 = T.STATE.data.tickers[0];

$('#tradeTicker').value = tick0;
$('#tradeDollars').value = '2000';
$('#btnBuy').dispatchEvent(new window.Event('click'));
ok(Math.abs(cash() - 8000) < 1e-6, 'after $2,000 buy, cash is ~$8,000');
ok(/\$8,000\.00/.test($('#portfolioSummary').textContent), 'summary reflects $8,000 cash');
ok($$('#holdingsTableWrap tbody tr').length === 1, 'holdings table now has 1 row');
ok(T.STATE.portfolio.positions[tick0].shares > 0, 'position has fractional shares');

$('#tradeDollars').value = '1000';
$('#btnSell').dispatchEvent(new window.Event('click'));
ok(cash() > 8999.99 && cash() <= 9000 + 1e-6, 'after $1,000 sell, cash rises to ~$9,000');

$('#btnReset').dispatchEvent(new window.Event('click'));
ok(Math.abs(cash() - 10000) < 1e-6, 'reset returns cash to seed $10,000');

$('#tradeDollars').value = '999999';
$('#btnBuy').dispatchEvent(new window.Event('click'));
ok(Math.abs(cash() - 10000) < 1e-6, 'buying more than cash is rejected (cash unchanged)');

console.log('\n[View C -- Influence web]');
$$('.tab').find((t) => t.dataset.view === 'web').dispatchEvent(new window.Event('click'));
ok($$('#webSvg .web-node').length >= 13, 'web has all stock + driver nodes (>=13)');
ok($$('#webSvg circle').length === 8, 'exactly 8 stock circle nodes');
ok($$('#webSvg .edge-solid').length > 0 && $$('#webSvg .edge-dash').length > 0, 'has both documented (solid) and hypothesized (dashed) edges');
ok(/hypothesized/.test($('#webSvg').innerHTML), 'hypothesized edges are explicitly labeled');
const nvda = $$('#webSvg .web-node').find((g) => g.dataset.node === 'NVDA');
nvda.dispatchEvent(new window.Event('click'));
ok(/Nvidia/.test($('#webInfo').textContent), 'clicking NVDA shows its learn panel');
ok(/Recent trend/.test($('#webInfo').textContent), 'node panel shows real recent trend numbers');

console.log('\n[Disclaimer]');
ok($('#disclaimer').hidden === false, 'disclaimer modal shown on first load');
$('#acceptDisclaimer').dispatchEvent(new window.Event('click'));
ok($('#disclaimer').hidden === true, 'accepting disclaimer dismisses it');

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
