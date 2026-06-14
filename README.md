# Semiconductor Learning Tool — hosted, installable, live-data

An educational, **fake-money** web app for learning how to read semiconductor stocks
(INTC, MU, LRCX, NVDA, AMD, TSM, ASML, SMH). It always talks in terms of **probability
and risk, never prediction**, and it is **not financial advice**.

It runs entirely on free GitHub services and works from **both your phone and your
desktop**, because the app and its data live on the web:

- **GitHub Actions** runs a small script every weekday after the US market closes.
- The script pulls the latest daily prices from **Twelve Data** and saves them into
  `history.json` in this repo. The history **accrues over time**, so when you open the
  app you see every move — *including the days you were away*. That accrual is the whole
  point of going live.
- **GitHub Pages** serves the app + `history.json` at a public web address you can open
  and "install" on any device.

> The app ships with a small **sample `history.json`** so it renders immediately, before
> your first real data run.

---

## What you'll do (about 10 minutes, one time)

You need two free accounts: a **GitHub** account and a **Twelve Data** account. I can't
create those for you, so follow the steps below. Anywhere it says *click*, just click.

### Read this first — two honest notes

1. **The site will be public.** GitHub Pages on a free account serves your site at a
   public URL. Anyone who has the link can open it. That's fine here — it's public stock
   data and a pretend portfolio — but know it's not private. (Private hosting needs a paid
   plan.) **Your Twelve Data API key stays secret** in GitHub's encrypted settings; it is
   never put in the web page.
2. **Free-tier limits move around.** Twelve Data's free plan and terms change over time.
   Glance at their current limits when you sign up. Pulling 8 tickers once a day is far
   below any free limit, so you won't get close.

---

## Step 1 — Get a free Twelve Data API key

1. Go to **https://twelvedata.com** and click **Sign Up** (the free plan is fine).
2. After signing in, open your **Dashboard**. You'll see an **API key** — a long string
   of letters and numbers.
3. **Copy it** and keep it handy for Step 3. (Treat it like a password.)

## Step 2 — Create the GitHub repository and upload these files

1. Go to **https://github.com** and sign in (or click **Sign up** for a free account).
2. Click the **+** in the top-right → **New repository**.
3. Name it anything, e.g. `semiconductor-tracker`. Set it to **Public**. Click
   **Create repository**.
4. On the new repo page, click **uploading an existing file** (the link in the middle).
5. Drag **all the files and folders from this project** into the upload box. Make sure you
   include the hidden **`.github`** folder (it holds the daily-update automation) and the
   **`icons`** folder. The structure should look like:

   ```
   index.html
   app.js
   styles.css
   manifest.json
   sw.js
   history.json
   .nojekyll
   icons/icon-192.png
   icons/icon-512.png
   icons/icon-maskable-512.png
   scripts/fetch.js
   .github/workflows/update-data.yml
   ```
   > Tip: GitHub's drag-and-drop sometimes skips folders that start with a dot. If the
   > `.github` folder doesn't appear after uploading, use **Add file → Create new file**,
   > type `.github/workflows/update-data.yml` as the name, and paste the contents of that
   > file in. Same trick works for `.nojekyll` (create a file named `.nojekyll`, leave it
   > empty).
6. Click **Commit changes**.

## Step 3 — Add your Twelve Data key as a secret (this keeps it private)

1. In your repo, click **Settings** (top menu).
2. Left sidebar: **Secrets and variables** → **Actions**.
3. Click **New repository secret**.
4. **Name:** type exactly `TWELVE_DATA_API_KEY`
5. **Secret:** paste the API key you copied in Step 1.
6. Click **Add secret**.

## Step 4 — Turn on the daily updates and run the first one

1. Click the **Actions** tab. If GitHub asks you to enable workflows, click the green
   **"I understand my workflows, go ahead and enable them"** button.
2. In the left list, click **Update market data**.
3. Click **Run workflow** → (leave "force backfill" off the first time is fine, but you
   *can* tick it to be thorough) → **Run workflow**.
4. Wait ~1 minute and refresh. A green check ✓ means it pulled ~180 days of history and
   committed it. After this, it runs **automatically every weekday** — you don't touch it
   again.

## Step 5 — Turn on GitHub Pages (the public web address)

1. **Settings** → **Pages** (left sidebar).
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. **Branch:** pick `main` and folder **`/ (root)`**. Click **Save**.
4. Wait 1–2 minutes. The page will show your live URL, which looks like:

   ```
   https://YOUR-USERNAME.github.io/semiconductor-tracker/
   ```

That URL is your app. Open it on your computer and on your phone.

## Step 6 — Install it on your phone and desktop

**Android (Chrome):** open the URL → tap the **⋮** menu → **Add to Home screen** →
**Install**. It now opens like a normal app, full-screen.

**iPhone (Safari):** open the URL → tap the **Share** icon → **Add to Home Screen**.

**Desktop (Chrome/Edge):** open the URL → click the **install icon** in the address bar
(a small monitor/▽ icon) → **Install**.

Once installed, it caches itself and still opens (showing the last data it saw) even with
no signal. When you're online it quietly refreshes to the latest `history.json`.

---

## Using the app

- **What changed** — per-ticker move over 1 day / 5 days / 1 month. This is the view that
  shows you everything that happened while you were away.
- **Practice portfolio** — start with fake $10,000 (editable). Buy/sell at the latest
  daily close, fractional shares allowed. Expand each signal (moving averages, RSI, MACD,
  volume, support/resistance) to learn what it suggests, **how confident** that read is,
  and **how it misleads you**. There's also a short- vs long-term capital-gains reminder.
- **Influence web** — the 8 stocks as nodes, colored by their **real** recent trend, wired
  to the forces that move them. **Solid lines = documented relationships**; **dashed lines
  = hypothesized** (and labeled as such — no invented causation). Tap a node to learn.

A one-time disclaimer appears on first load. Deliberately **not** built (on purpose):
options, short selling, position sizing.

---

## How it works under the hood (for the curious)

| Piece | File | What it does |
|---|---|---|
| The app | `index.html`, `app.js`, `styles.css` | Loads `history.json` same-origin, computes indicators from the real series, renders the three views. |
| Installability | `manifest.json`, `sw.js`, `icons/` | Makes it a PWA: add-to-home-screen, offline caching. |
| Daily fetch | `scripts/fetch.js` | Node script. First run backfills ~180 daily bars per ticker via Twelve Data's `time_series` endpoint; later runs append the newest bar. Dedupes by date (re-runs change nothing). On weekends/holidays there's no new bar, so it does nothing. |
| Automation | `.github/workflows/update-data.yml` | Cron at 21:30 UTC, Mon–Fri. Runs the script using your secret key, commits `history.json` only if it changed. |
| Sample data | `history.json` | Ships with deterministic mock data so the app renders before your first real run. The first workflow run replaces it with real data. |

### Test it locally without a key
- **App:** open `semiconductor-tool-OFFLINE-PREVIEW.html` (in the parent folder) — it's the
  full app with sample data baked in, no server needed.
- **Fetch logic:** `TWELVE_DATA_MOCK=1 node scripts/fetch.js` exercises the whole
  backfill/append/dedupe path with synthetic data and no API key.

### If the daily updates stop
GitHub disables scheduled workflows after ~60 days of **no repo activity**. If you go
quiet that long, open **Actions → Update market data → Run workflow** once to wake it up.
The script pulls a 30-bar buffer each run (and re-backfills if it sees a long gap), so
short outages backfill themselves.

### Later: moving to Cloudflare
This is built for GitHub today, but it's portable. The same `fetch.js` logic can run as a
**Cloudflare Worker** on a cron trigger writing to KV/R2, with the static app on
**Cloudflare Pages**, if you ever prefer that stack.

---

*Educational use only. Not financial advice. Probability and risk — never prediction.*
