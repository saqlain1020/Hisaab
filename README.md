# Hisaab

An offline-first PWA for splitting trip expenses among friends. One friend pays for dinner, another pays for breakfast, and not everyone is included every time. People who weren't included are never charged for it. At the end, Hisaab shows who owes whom and the fewest payments needed to settle up.

- Installs to the home screen on Android (Chrome) and iPhone (Safari).
- Works fully offline. Everything is saved on the phone first (IndexedDB via Dexie).
- Syncs with Supabase when online. The newest edit wins, and deletes sync too.

## Commands

This project uses [Bun](https://bun.sh) as its package manager and script runner.

```bash
bun install
```

```bash
bun run dev       # dev server on http://localhost:5173
```

```bash
bun run build     # type-check + production build into dist/
```

```bash
bun run preview   # serve dist/ (service worker active) on http://localhost:4173
```

```bash
bun run test      # Vitest unit tests (calculations + sync engine)
```

To change the app icon, edit `public/icon.svg`, then run `bun run icons` to regenerate the PNGs.

## 1. Supabase setup

1. Create a free project at <https://supabase.com>.
2. Open **SQL Editor**, paste all of [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates the four tables, the last-write-wins trigger, row-level security, and a `balances` view you can query from the dashboard.
3. Go to **Authentication → Users → Add user → Create new user**. Add each friend's email and a password, and tick **Auto Confirm User**.
4. Go to **Authentication → Sign In / Providers** and turn off **Allow new users to sign up**. Only the users you added can sign in, and every signed-in user can see every trip, so this is how you keep strangers out.
5. Go to **Project Settings → API** and copy the **Project URL** and the **anon public** key.

## 2. `.env.local`

```bash
cp .env.example .env.local
```

Then fill it in:

```
VITE_SUPABASE_URL=https://abcdefghijklm.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

The anon key is meant to be public. Security comes from RLS plus disabled sign-ups. Without these two variables, the app still runs but keeps data on the phone only.

## 3. Deploy (free)

Service workers only run over HTTPS (or on `localhost`), so the app has to be deployed to an HTTPS host before you can install it on a phone. Routing uses `#/…` URLs, so no SPA rewrite rules are needed. `public/_headers` makes sure `sw.js` and `index.html` are always revalidated, which is what makes the "Update available" prompt appear after a deploy.

### Cloudflare Pages

1. Push this folder to a GitHub repo.
2. In Cloudflare, go to **Workers & Pages → Create → Pages → Connect to Git** and pick the repo.
3. Set **Build command** to `bun run build` and **Build output directory** to `dist`.
4. Under **Environment variables**, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. They are baked in at build time.
5. Deploy. You get an `https://<name>.pages.dev` URL.

### Netlify

1. In Netlify, go to **Add new site → Import an existing project** and pick the repo.
2. Set **Build command** to `bun run build` and **Publish directory** to `dist`. Netlify detects `bun.lock`.
3. Under **Site configuration → Environment variables**, add the two `VITE_…` variables, then redeploy.

Or deploy straight from your machine:

```bash
bun run build && bunx netlify-cli deploy --prod --dir=dist
```

## 4. Install on phones

Do this **before the trip, while online.** Open the link once so the app downloads and caches itself, then sign in once.

**Android (Chrome):** open the URL. Tap **Install app** when it's offered, or use **⋮ → Add to Home screen / Install app**.

**iPhone (Safari):** open the URL in **Safari** (not Chrome). Tap **Share → Add to Home Screen → Add**, then open Hisaab from the home screen and sign in there. A home-screen app keeps its own storage, separate from Safari's.

After that, the app opens and works with no signal. Expenses you add offline show as "N to upload" in the header and sync the next time the app is open and online.

## Settling up

- **Suggested payments** show the fewest transfers that settle everyone. Tap **Mark paid** to record one. The amount starts at the full figure, and you can lower it to record a partial payment (for example 400 of 1,000). The suggestion then drops to what's left. Recording more than is owed is rejected.
- **Record a payment** logs any payment between two friends for any amount, for example Bilal handing Sara cash. Balances and suggestions update straight away.
- Every payment appears under **Payments made** and can be undone.

## How sync works

- Every row has a UUID made on the phone, an `updated_at` (this phone's last edit), a soft-delete `deleted` flag, and a local-only `dirty` flag.
- **Push:** dirty rows are upserted to PostgREST in parent → child order (trips, members, expenses, settlements), 200 per chunk. `dirty` is cleared only if the row wasn't edited again during the upload. Afterwards the pushed ids are re-read, so if the server kept a newer edit from another phone, this phone picks it up straight away.
- **Pull:** each table is read in pages of 500 where `server_updated_at` is after a saved cursor, minus 60 seconds to catch rows that committed out of order. Rows with unpushed local edits are skipped.
- **Conflicts:** the `hisaab_on_write` trigger ignores an update whose `updated_at` is older than the stored one. Local saves use `max(now, previous + 1ms)`, so a phone whose clock is behind still moves a row forward.
- **When sync runs:** on app start, when the phone comes back online, when the app returns to the foreground, 2 seconds after an edit, every 60 seconds while the app is open, and when you tap the status in the header. Only one sync runs at a time. On Android Chrome, Background Sync is registered as a bonus: it nudges an open app to sync when the connection returns.
- Login tokens are kept in `localStorage` and refreshed within 60 seconds of expiry. Refresh tokens rotate, so the new one is saved each time. A 4xx refresh error other than 429 signs you out. Your local data is kept and uploads after you sign in again.

## Known limits

- **iOS can't sync in the background.** On iPhone, sync only happens while Hisaab is open. Open it for a moment when you're back online.
- **Free Supabase projects pause after about a week with no activity.** Unpause it from the dashboard before the trip. While it's paused, the app keeps working offline and shows a sync error.
- Every signed-in user can see and edit every trip. This is meant for a single group of friends sharing one Supabase project.
- Amounts assume 2 decimal places (minor units ÷ 100) for every currency.
- iOS may clear a home-screen app's storage if it goes unused for weeks. Data that has synced is safe on the server.

## Project layout

```
src/
  lib/calc.ts        pure money maths: equal split, balances, settle-up, parsing (tested)
  lib/sync.ts        push / pull / reconcile against PostgREST (tested with a fake server)
  lib/syncEngine.ts  triggers, single-flight, status for the header
  lib/auth.ts        Supabase email+password and token refresh via fetch
  lib/db.ts          Dexie schema and nextStamp()
  lib/repo.ts        all local writes (sets dirty, bumps updated_at)
  screens/           Login, TripsList, TripScreen (tabs), Friends, ExpenseForm
  sw.ts              Workbox precache + navigation fallback + background-sync ping
supabase/schema.sql
```
