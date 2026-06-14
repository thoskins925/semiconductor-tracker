#!/usr/bin/env python3
"""
make_sample.py  —  Generate a deterministic SAMPLE history.json for local testing.

This is NOT the live fetch. It exists so the PWA renders something real-looking
*before* the first GitHub Actions cron run, and so you can test the app with no
API key. The live data is produced by scripts/fetch.js (Twelve Data).

Output schema matches exactly what fetch.js writes, so the app can't tell the
difference:

{
  "generated_at": "<ISO timestamp>",   # when this file was written
  "as_of": "YYYY-MM-DD",               # date of the most recent bar
  "source": "SAMPLE (deterministic mock)",
  "tickers": [...],
  "series": {
     "INTC": [ {"date","open","high","low","close","volume"}, ... ],  # oldest -> newest
     ...
  }
}
"""
import json, math, datetime as dt

TICKERS = ["INTC", "MU", "LRCX", "NVDA", "AMD", "TSM", "ASML", "SMH"]

# Rough, plausible starting points + per-ticker character (drift, volatility).
# Values are illustrative only — this is mock data.
SEED = {
    "INTC": dict(price=21.0,  drift=-0.0006, vol=0.022, base_vol=42_000_000),
    "MU":   dict(price=98.0,  drift=0.0011,  vol=0.028, base_vol=20_000_000),
    "LRCX": dict(price=78.0,  drift=0.0008,  vol=0.024, base_vol=8_000_000),
    "NVDA": dict(price=118.0, drift=0.0014,  vol=0.030, base_vol=240_000_000),
    "AMD":  dict(price=112.0, drift=0.0006,  vol=0.029, base_vol=38_000_000),
    "TSM":  dict(price=176.0, drift=0.0010,  vol=0.021, base_vol=12_000_000),
    "ASML": dict(price=720.0, drift=0.0007,  vol=0.023, base_vol=1_400_000),
    "SMH":  dict(price=248.0, drift=0.0009,  vol=0.017, base_vol=6_000_000),
}

N_DAYS = 180  # trading days of history to synthesize


def trading_days(end_date, n):
    """Return n weekday dates ending at end_date (oldest -> newest)."""
    days = []
    d = end_date
    while len(days) < n:
        if d.weekday() < 5:  # Mon-Fri
            days.append(d)
        d -= dt.timedelta(days=1)
    return list(reversed(days))


def lcg(seed):
    """Tiny deterministic PRNG (no numpy dependency). Returns floats in [0,1)."""
    state = seed & 0xFFFFFFFF
    while True:
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        yield state / 0x7FFFFFFF


def gen_series(ticker, dates, rng):
    cfg = SEED[ticker]
    price = cfg["price"]
    bars = []
    for d in dates:
        # daily log return = drift + vol * (uniform-centered shock)
        shock = (next(rng) - 0.5) * 2.0
        ret = cfg["drift"] + cfg["vol"] * shock
        close = max(0.5, price * math.exp(ret))
        # intraday range around open->close
        op = price * (1 + (next(rng) - 0.5) * 0.004)
        hi = max(op, close) * (1 + next(rng) * 0.012)
        lo = min(op, close) * (1 - next(rng) * 0.012)
        vol = int(cfg["base_vol"] * (0.6 + next(rng) * 0.9))
        bars.append({
            "date": d.isoformat(),
            "open": round(op, 2),
            "high": round(hi, 2),
            "low": round(lo, 2),
            "close": round(close, 2),
            "volume": vol,
        })
        price = close
    return bars


def main():
    end = dt.date(2026, 6, 12)  # last completed trading day before "today" (2026-06-13 is a Sat)
    dates = trading_days(end, N_DAYS)
    series = {}
    for i, t in enumerate(TICKERS):
        rng = lcg(1000 + i * 7919)  # distinct deterministic stream per ticker
        series[t] = gen_series(t, dates, rng)

    out = {
        "generated_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "as_of": end.isoformat(),
        "source": "SAMPLE (deterministic mock)",
        "tickers": TICKERS,
        "series": series,
    }
    with open("history.json", "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"Wrote history.json — {len(dates)} bars/ticker, as_of {end.isoformat()}")


if __name__ == "__main__":
    main()
