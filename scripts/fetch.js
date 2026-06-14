#!/usr/bin/env node
/**
 * fetch.js — pull daily bars from Twelve Data and maintain history.json.
 *
 * Design goals (see README):
 *   • First run (no/empty history.json) -> BACKFILL ~180 daily bars per ticker.
 *   • Every later run -> fetch the most recent bars and APPEND new dates only.
 *   • DEDUPE by date so re-runs are idempotent (running twice changes nothing).
 *   • Weekend/holiday -> Twelve Data returns the last trading day we already have,
 *     so nothing new is appended and the file is left byte-identical. The workflow
 *     then commits nothing. No errors, graceful no-op.
 *   • API key comes ONLY from the environment (GitHub Actions secret). Never hard-coded.
 *
 * Env vars:
 *   TWELVE_DATA_API_KEY   required for live data
 *   FORCE_BACKFILL=1      force a full 180-bar refetch for every ticker
 *   TWELVE_DATA_MOCK=1    generate synthetic bars instead of calling the API
 *                         (lets you test the whole merge/append path with no key)
 *
 * Usage:  node scripts/fetch.js
 *
 * Output schema (history.json):
 * {
 *   "generated_at": "<ISO>", "as_of": "YYYY-MM-DD", "source": "Twelve Data",
 *   "tickers": [...],
 *   "series": { "INTC": [ {date,open,high,low,close,volume}, ... oldest->newest ], ... }
 * }
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TICKERS = ['INTC', 'MU', 'LRCX', 'NVDA', 'AMD', 'TSM', 'ASML', 'SMH'];
const API_BASE = 'https://api.twelvedata.com/time_series';
const HISTORY_PATH = path.join(__dirname, '..', 'history.json');

const BACKFILL_SIZE = 180;   // bars to pull when a ticker has no history yet
const INCREMENTAL_SIZE = 30; // bars to pull on a normal run (covers up to ~6 weeks of missed runs; deduped)
const STALE_DAYS = 25;       // if newest stored bar is older than this, re-backfill that ticker
const THROTTLE_MS = 8500;    // delay between ticker requests to respect free-tier ~8 req/min

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(aISO, bISO) {
  return Math.round((Date.parse(bISO) - Date.parse(aISO)) / 86400000);
}

function loadHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && data.series) return data;
  } catch (_) { /* missing or unreadable -> start fresh */ }
  return { generated_at: null, as_of: null, source: 'Twelve Data', tickers: TICKERS, series: {} };
}

/** Map Twelve Data "values" rows to our bar shape. */
function normalizeBar(v) {
  const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));
  return {
    date: v.datetime.slice(0, 10),
    open: num(v.open),
    high: num(v.high),
    low: num(v.low),
    close: num(v.close),
    volume: v.volume === undefined ? null : Number(v.volume),
  };
}

/** Merge incoming bars into existing, dedupe by date, sort oldest->newest. */
function mergeBars(existing, incoming) {
  const byDate = new Map();
  for (const b of existing || []) byDate.set(b.date, b);
  for (const b of incoming || []) byDate.set(b.date, b); // incoming wins on collision (fresh values)
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Live call to Twelve Data. Returns array of normalized bars (oldest->newest) or throws. */
async function fetchTimeSeries(symbol, outputsize, apiKey) {
  const url = `${API_BASE}?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=${outputsize}&apikey=${encodeURIComponent(apiKey)}&format=JSON`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
  const json = await res.json();
  // Twelve Data signals errors with status:"error" / a numeric code (e.g. 429 rate limit).
  if (json.status === 'error' || json.code) {
    throw new Error(`Twelve Data error for ${symbol}: ${json.code || ''} ${json.message || JSON.stringify(json)}`);
  }
  if (!Array.isArray(json.values)) throw new Error(`No values array for ${symbol}`);
  return json.values.map(normalizeBar).reverse(); // API is newest-first; we store oldest-first
}

/** Mock generator so the full append/dedupe path can be tested with no API key. */
function mockTimeSeries(symbol, outputsize) {
  const bars = [];
  let price = 50 + (symbol.charCodeAt(0) % 30) * 5;
  const end = new Date();
  const dates = [];
  const d = new Date(end);
  while (dates.length < outputsize) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  dates.reverse();
  let seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rnd = () => { seed = (1103515245 * seed + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (const date of dates) {
    const close = Math.max(1, price * (1 + (rnd() - 0.49) * 0.03));
    bars.push({
      date,
      open: +price.toFixed(2),
      high: +(Math.max(price, close) * 1.01).toFixed(2),
      low: +(Math.min(price, close) * 0.99).toFixed(2),
      close: +close.toFixed(2),
      volume: Math.floor(1e6 + rnd() * 5e6),
    });
    price = close;
  }
  return bars;
}

async function main() {
  const mock = process.env.TWELVE_DATA_MOCK === '1';
  const forceBackfill = process.env.FORCE_BACKFILL === '1';
  const apiKey = process.env.TWELVE_DATA_API_KEY;

  if (!mock && !apiKey) {
    console.error('ERROR: TWELVE_DATA_API_KEY is not set. (Set the GitHub Actions secret, or run with TWELVE_DATA_MOCK=1 to test.)');
    process.exit(1);
  }

  const history = loadHistory();
  history.source = mock ? 'MOCK (fetch.js test mode)' : 'Twelve Data';
  history.tickers = TICKERS;
  if (!history.series) history.series = {};

  let totalAdded = 0;
  for (let i = 0; i < TICKERS.length; i++) {
    const t = TICKERS[i];
    const existing = history.series[t] || [];
    const last = existing.length ? existing[existing.length - 1].date : null;
    const stale = last ? daysBetween(last, todayISO()) >= STALE_DAYS : true;
    const size = forceBackfill || existing.length === 0 || stale ? BACKFILL_SIZE : INCREMENTAL_SIZE;

    try {
      const incoming = mock ? mockTimeSeries(t, size) : await fetchTimeSeries(t, size, apiKey);
      const before = existing.length;
      const merged = mergeBars(existing, incoming);
      history.series[t] = merged;
      const added = merged.length - before;
      totalAdded += Math.max(0, added);
      console.log(`${t}: pulled ${incoming.length} bars (size=${size}), +${Math.max(0, added)} new, total ${merged.length}`);
    } catch (err) {
      console.error(`${t}: SKIPPED — ${err.message}`);
      // keep whatever we already had for this ticker; do not crash the run
    }

    if (!mock && i < TICKERS.length - 1) await sleep(THROTTLE_MS); // respect free-tier rate limit
  }

  // as_of = newest date present across all series
  let asOf = null;
  for (const t of TICKERS) {
    const s = history.series[t];
    if (s && s.length) {
      const d = s[s.length - 1].date;
      if (!asOf || d > asOf) asOf = d;
    }
  }
  history.as_of = asOf;
  history.generated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history));
  console.log(`Done. as_of=${asOf}, new bars this run=${totalAdded}. Wrote ${HISTORY_PATH}`);
  if (totalAdded === 0) console.log('No new bars (weekend/holiday or already up to date) — nothing to commit.');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
