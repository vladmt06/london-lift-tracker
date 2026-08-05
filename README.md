# London Lift Reliability Tracker

Transport for London publishes which station lifts are broken **right now**, but no history: when a
lift is fixed, its entry disappears and the event is gone. So there is no public way to ask "how
often does this lift fail, and for how long?"

This service polls that feed every few minutes and keeps what it saw. From launch onward, lift
outages accumulate a record — visible on a map, in a list, and per station.

**It reports lift outages and observed downtime. It does not claim a station is inaccessible**, and
it never presents inferred data as fact.

Live: <https://london-lift-tracker.vercel.app>

![Homepage: feed status, headline metrics, map and current outage list](docs/screenshots/homepage.png)

---

## What it can and cannot say

The single constraint running through the whole design: history exists only from the moment
collection started, and restoration times are inferred rather than reported.

| Claimed | Not claimed |
| --- | --- |
| Current lift disruptions reported by TfL | Every historical TfL outage |
| Observed outages since a stated date | Official repair durations |
| Observed downtime by station | "This station is inaccessible" |
| Restoration inferred from the feed | Reliability over the past year |
| The polling cadence actually achieved, published on the site | A fixed "every five minutes", which the schedule does not always deliver |
| "TfL reports no disruption here" | "Every lift at this station works" |

Station availability percentages are deliberately absent: they would need a verified inventory of
every lift and an honest observation denominator.

---

## What the live feed actually contains

Verified against `GET https://api.tfl.gov.uk/Disruptions/Lifts/v2` before any adapter was written
(`npm run inspect:tfl` reproduces this). Each record has exactly three fields:

```json
{
  "stationUniqueId": "940GZZLUWYP",
  "disruptedLiftUniqueIds": ["940GZZLUWYP-Lift-5"],
  "message": "WEMBLEY PARK STATION: From Monday 10 March until Autumn 2026, no lift service…"
}
```

Three consequences shape everything else:

1. **No timestamps.** The structured feed carries no start time, so an outage's start is when *we
   first saw it*. Where TfL states a date in its own prose ("From Monday 10 March"), that is parsed
   and used instead, because it is better evidence than our arrival time. Where it does not, and
   the outage predates collection, the duration is shown as a floor: `≥ 4d 16h`.
2. **One record can list several lifts.** Bank has listed four at once. Each lift is a separate
   physical asset with its own history, so a record is fanned out into one outage per lift.
3. **No names or coordinates.** Those come from TfL's StopPoint API, looked up once per station and
   cached — so the steady state is zero extra API calls per poll.

The feed covers Underground, Overground, Elizabeth line, DLR and rail interchanges — not just the
Tube.

### Why the live list looks so long-running

A snapshot of what is broken *now* is inherently weighted towards slow repairs: a lift fixed within
the hour leaves the feed almost immediately, while one waiting on parts sits there for weeks. TfL's
own current messages quote end dates months away. This surprises people into thinking the data is
wrong, so the site explains it rather than leaving it to be inferred.

---

## Architecture

```
external cron (every 5 min)  +  GitHub Actions (cron)  +  any page view with stale data
  └─> POST /api/internal/poll-lifts        Authorization: Bearer CRON_SECRET
        └─> lib/tfl/poll.ts  runPoll()
              1. fetch feed + validate           network, 15s timeout, ≤2 retries
              2. normalise, fan out per lift      pure
              3. resolve unknown stations         network, StopPoint, DB-cached
              4. ONE transaction                  advisory lock → upserts → state machine
```

**Three triggers, because one is not reliable.** GitHub's scheduler throttles frequent workflows
hard — measured in production, a five-minute cron was delivering a median gap of 62 minutes and a
worst gap of 216. An external cron service is therefore the workhorse, GitHub Actions is a free
backstop, and a page view tops the data up when the newest successful poll is over four minutes
old. Overlapping triggers are safe: the advisory lock means the loser writes nothing and gets a 409.

Network calls happen **before** the transaction opens. The spec this was built from puts the fetch
inside it; holding a Postgres transaction across a 15-second network timeout starves the connection
pool and will eventually deadlock a hosted pooler. Every guarantee is preserved: writes are atomic,
only one poll runs at a time, a concurrent caller gets HTTP 409, and a failed fetch is recorded as a
`FAILED` PollRun that closes nothing.

Serverless functions are pinned to the same region as the database (`dub1`). They defaulted to
US-East against an EU-West database, which put ~150 queries per poll across the Atlantic and took a
poll from 1.8s to 26.8s — past the collector's timeout.

Reads are plain Prisma queries in server components; `/api/*` exposes the same data as JSON.

### The outage state machine

- **Identity** is `assetKey`, from TfL's own lift id (`lift:940gzzluwyp-lift-5`) where available,
  falling back through station id + lift name, station name + lift name, and finally a
  date-insensitive message fingerprint. Message text is never the primary key, because TfL rewords
  updates mid-fault.
- **Seen again** → refresh `lastSeenAt` and the message, reset the missing counter, append an
  observation.
- **Missing from a successful poll** → increment the counter and record the first miss.
- **Closed** only after **two consecutive successful** polls without it, dated to the *first* miss,
  with `closureInferred = true`.
- **Never closed on doubt**: failed request, timeout, non-200, unparseable JSON, or more than 20% of
  records failing validation (status `PARTIAL`) all skip the closure pass entirely. An empty array
  is a valid successful poll and does start the countdown.
- A partial unique index (`one_open_outage_per_asset ON "Outage" ("assetKey") WHERE "closedAt" IS
  NULL`) makes "one open outage per lift" a database guarantee, not just application logic.

### Layout

```
app/            pages and API routes
components/     UI (map, list, table, metric cards, feed health, station lookup)
lib/tfl/        client, Zod schema, normaliser, station resolver, poll state machine, refresh
lib/metrics/    durations, medians, interval merging, station aggregates, cadence
lib/utils/      text normalisation, hashing, CSV
prisma/         schema and migrations
scripts/        inspect:tfl, poll:once, import:topology
tests/          unit + integration tests (real PostgreSQL)
```

### Screens

| | |
| --- | --- |
| **Stations** — every station where a disruption has been observed, ranked by downtime, sortable, with `≥` marking figures that are floors<br>![Stations table](docs/screenshots/stations.png) | **Station detail** — current status, observed metrics and a chronological timeline of every outage<br>![Station detail page](docs/screenshots/station-detail.png) |
| **Methodology** — what is measured, what is inferred, what is not claimed, and the cadence actually achieved<br>![Methodology page](docs/screenshots/methodology.png) | **Mobile** — list before map, no horizontal scrolling<br><img src="docs/screenshots/homepage-mobile.png" alt="Homepage on a phone" width="300"> |

### Searching a station that is fine

Only stations that have *had* a disruption exist in the database, so searching a working station
would otherwise return "no results" — which reads as "not found" rather than "nothing is wrong".
`GET /api/lookup?q=…` checks our records first, then TfL's StopPoint search, so any London rail
station resolves and reports its status as of the last successful poll.

The answer is phrased as "TfL reports no lift disruption here", never "all lifts work": an
unreported fault is still possible, and plenty of stations have no lifts at all.

---

## Local setup

Requires Node 20+ and PostgreSQL 14+.

```bash
git clone <this repo> && cd london-lift-tracker
npm install

createdb lift_tracker
createdb lift_tracker_test          # tests truncate every table; keep it separate

cp .env.example .env                # then edit DATABASE_URL / TEST_DATABASE_URL
npx prisma migrate deploy

npm run poll:once                   # collect real data (safe to repeat)
npm run dev                         # http://localhost:3000
```

A `TFL_APP_KEY` is optional: the feed answers anonymously at 50 requests/minute and polling needs
about one. Register at <https://api-portal.tfl.gov.uk/> for the 500/minute plan and the client will
use the key automatically.

The site shows nothing until at least one poll has run — by design. There are no seeded or mock
records anywhere in this repository.

### Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve |
| `npm run inspect:tfl` | Print the live payload's real shape; save `fixtures/tfl-lift-disruptions.json`. No DB writes |
| `npm run poll:once` | Run one collection cycle locally |
| `npm run import:topology -- --download` | Fetch and import TfL's lift inventory |
| `npm run lint` / `npm run typecheck` / `npm test` | Verification |

### Optional topology import

TfL publishes its step-free topology openly, with no key required, at
`api.tfl.gov.uk/stationdata/tfl-stationdata-detailed.zip` — **569 lifts across 509 stations**, plus
platforms, ramps and same-level paths.

```bash
npm run import:topology -- --download                     # enrich stations we already track
npm run import:topology -- --download --create-stations   # import the whole inventory
npm run import:topology -- --file=/absolute/path.zip      # use a local archive instead
```

It prints every CSV and its headers, imports `Lifts.csv`, upserts rather than duplicates, keeps all
source columns in `rawMetadata`, and deletes its temporary directory afterwards. By default it only
enriches stations already known from the feed, so a bulk import cannot flood the rankings with
stations that have never had an observed outage.

That 569-lift figure is the denominator the site otherwise lacks — the difference between "27 lifts
disrupted" and "27 of 569". **The app runs perfectly well without this.**

---

## Testing

```bash
npm test
```

141 tests. Integration tests run against a **real** PostgreSQL (`TEST_DATABASE_URL`), because the
parts most worth testing — the advisory lock, the partial unique index, transaction rollback — do
not exist in a mock. Migrations are applied automatically; tables are truncated between cases.

The state-machine suite covers the sequences that protect against a false "repaired" claim: an
outage appearing, re-appearing without duplicating, surviving a reworded message, staying open after
one miss, resolving after two, **not** resolving when a request fails between misses, re-opening as a
new outage after a relapse, closing everything after two empty feeds, refusing to close on a partial
poll, and rejecting a second concurrent poll via the advisory lock.

Date parsing out of TfL's prose is tested hard in both directions, since a bad parse would put a
confidently wrong duration on the page: it must read "from Monday 10 March", must ignore an "until"
clause, and must reject impossible dates.

---

## Deployment

Any Postgres and any Node host will do; these steps assume Supabase + Vercel.

1. **Database** — create a Supabase (or Neon/RDS) project and copy its connection strings. Use the
   **session pooler** for migrations and the **transaction pooler** for the app.
2. **Migrate** — with `DATABASE_URL` set to the session-pooler URI:
   ```bash
   npx prisma migrate deploy
   ```
3. **Deploy** to Vercel. Set environment variables:
   - `DATABASE_URL` — the transaction-pooler URI plus `?pgbouncer=true&connection_limit=1`
   - `CRON_SECRET` — `openssl rand -hex 32`
   - `NEXT_PUBLIC_APP_URL` — e.g. `https://your-app.vercel.app`
   - `TFL_APP_KEY` — optional
4. **Pin the region** to match the database. `vercel.json` sets `dub1` for an EU-West database;
   change it if yours lives elsewhere. This is not cosmetic — see Architecture.
5. **Schedule polling.** Add repository secrets `APP_URL` (no trailing slash) and `CRON_SECRET`,
   then run the **Poll TfL lift disruptions** workflow via *workflow_dispatch*. Because GitHub
   throttles frequent schedules, also point a free external cron (cron-job.org, a Cloudflare Worker
   cron trigger, or any uptime monitor) at `/api/internal/poll-lifts` every five minutes with the
   `Authorization: Bearer <CRON_SECRET>` header. Both GET and POST are accepted.
6. **Verify**, in order:
   - `GET /api/health` reports a `lastSuccessfulPoll`
   - the homepage lists current outages on the map **and** in the list
   - a second observation exists for an ongoing outage after the next poll
   - an invalid bearer token returns **401**
   - pausing collection degrades the banner: Live → Delayed (10 min) → Stale (20 min)

---

## Methodology

The full, public version is at `/methodology`. In short:

- Everything is stored in UTC and displayed in `Europe/London` (with BST/GMT shown explicitly).
- Outage start = the date TfL states in its message where it gives one, otherwise our first
  observation, which is an upper bound on the true failure time.
- Outages already running when collection began are shown as floors (`≥`), never as measurements.
- Outage end = inferred from two consecutive successful polls without it, dated to the first miss.
- **Observed downtime** sums each lift separately: two lifts out for an hour is two lift-hours.
  Where wall-clock time is more useful, it is labelled "time with at least one lift disrupted" and
  overlapping intervals are merged first.
- Medians and longest durations use **resolved** outages only; where none have completed, the UI
  says "insufficient data" rather than `0`.
- The polling cadence actually achieved over the last 24 hours is published, because gap length is
  the resolution limit of every other number on the site.
- Raw payloads are stored for every first and latest sighting, so a future parsing fix can be
  replayed over history already collected.

## Accessibility

This service is about disabled passengers, so accessibility is structural rather than cosmetic:
everything on the map also exists as ordinary HTML; status is conveyed by shape and words as well as
colour; the station table is a real `<table>` with sortable headers and `aria-sort`; filter results
are announced via `aria-live`; focus is always visible; and `prefers-reduced-motion` is respected.

## Attribution

Powered by TfL Open Data. Contains OS data © Crown copyright and database rights 2016 and Geomni UK
Map data © and database rights 2019. Map tiles © OpenStreetMap contributors.

**This project is not affiliated with, endorsed by, or operated by Transport for London.** For live
travel advice, use [tfl.gov.uk](https://tfl.gov.uk/).
