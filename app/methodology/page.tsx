import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatLondonDate, formatLondonDateTime } from "@/lib/metrics/duration";
import { getCollectionCadence, getFeedHealth } from "@/lib/metrics/station-metrics";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Methodology",
  description:
    "How this service collects TfL lift-disruption data, what it can honestly claim, and what it cannot.",
};

export default async function MethodologyPage() {
  const now = new Date();
  const [health, cadence] = await Promise.all([
    getFeedHealth(prisma, now),
    getCollectionCadence(prisma, now),
  ]);

  const collectionStartedLabel = health.collectionStartedAt
    ? formatLondonDate(health.collectionStartedAt)
    : null;

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Methodology</h1>
        <p className="text-ink-muted">
          What this service measures, how it measures it, and — just as importantly — what it does
          not know.
        </p>
      </header>

      <section aria-labelledby="source-heading" className="space-y-2">
        <h2 id="source-heading" className="text-xl font-bold">
          Data source
        </h2>
        <p>
          Every figure on this site derives from Transport for London&rsquo;s public{" "}
          <a
            className="text-link underline underline-offset-4"
            href="https://api.tfl.gov.uk/Disruptions/Lifts/v2"
            rel="noreferrer noopener"
            target="_blank"
          >
            Lift Disruptions v2
          </a>{" "}
          feed. That feed is a snapshot of what is disrupted <em>right now</em>: each entry gives a
          station identifier, the identifiers of the affected lifts, and a message written for
          passengers. It contains no timestamps, no station names and no coordinates.
        </p>
        <p>
          Station names, coordinates and line information come from TfL&rsquo;s StopPoint API,
          looked up once per station and then cached.
        </p>
      </section>

      <section aria-labelledby="collection-heading" className="space-y-2">
        <h2 id="collection-heading" className="text-xl font-bold">
          Collection
        </h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Collection began on{" "}
            <strong className="font-semibold">
              {collectionStartedLabel ?? "a date not yet recorded"}
            </strong>
            . Nothing before that date is known to this service.
          </li>
          <li>
            Collection <em>targets</em> one poll every five minutes, from a scheduled job, plus a
            poll whenever someone loads a page and the last successful one is over four minutes
            old.
          </li>
          <li>
            {"In practice it is less frequent than that, and the real figure is published here "}
            {"rather than the target. Over the last 24 hours there "}
            {cadence.pollsLast24h === 1 ? "was " : "were "}
            <strong className="font-semibold">{cadence.pollsLast24h}</strong>
            {cadence.pollsLast24h === 1 ? " successful poll" : " successful polls"}
            {cadence.medianGapMinutes !== null ? (
              <>
                {", a typical gap of "}
                <strong className="font-semibold">{cadence.medianGapMinutes} minutes</strong>
                {cadence.worstGapMinutes !== null ? (
                  <>
                    {" between them, and a longest gap of "}
                    <strong className="font-semibold">{cadence.worstGapMinutes} minutes</strong>
                  </>
                ) : null}
              </>
            ) : null}
            {". Any lift that failed and was fixed inside one of those gaps was never seen, and "}
            {"restoration times are only ever as precise as the gap they fall in."}
          </li>
          <li>
            The gaps exist because the free scheduler this runs on throttles frequent jobs; it is a
            limitation of the collector, not of TfL&rsquo;s feed.
          </li>
          <li>
            {health.successfulPollCount.toLocaleString("en-GB")} successful polls have been recorded
            so far.
          </li>
          <li>
            Every attempt is stored, including failures, so gaps in the record are visible rather
            than silently filled in.
          </li>
          {health.lastSuccessfulPollAt ? (
            <li>
              Most recent successful poll:{" "}
              <time dateTime={health.lastSuccessfulPollAt.toISOString()}>
                {formatLondonDateTime(health.lastSuccessfulPollAt)}
              </time>
              .
            </li>
          ) : null}
        </ul>
      </section>

      <section aria-labelledby="lifecycle-heading" className="space-y-2">
        <h2 id="lifecycle-heading" className="text-xl font-bold">
          How an outage begins and ends
        </h2>
        <p>
          When a lift appears in the feed and we have no open outage for it, a new outage is opened
          and stamped with the time of that poll. When it appears again, the existing outage is
          updated — including when TfL rewrites the message, which happens often during a single
          fault. Identity is tracked by TfL&rsquo;s own lift identifier (for example{" "}
          <code className="font-mono text-xs">940GZZLUWYP-Lift-5</code>), not by message text.
        </p>
        <p>
          <strong className="font-semibold">Restoration is inferred.</strong> TfL never tells us a
          lift is fixed; the entry simply stops appearing. An outage is closed only after it has
          been absent from <strong className="font-semibold">two consecutive successful polls</strong>
          , and the end time recorded is the first poll in which it was missing. Requiring two polls
          protects against a single anomalous response briefly dropping entries.
        </p>
        <p>
          If a poll fails — a network error, a timeout, a non-200 response, unparseable JSON, or
          more than 20% of records failing validation — no outage is closed. Absence of evidence is
          not treated as evidence of repair.
        </p>
      </section>

      <section aria-labelledby="limits-heading" className="space-y-2">
        <h2 id="limits-heading" className="text-xl font-bold">
          What these numbers are not
        </h2>

        <h3 className="font-bold">First observed is not the failure time</h3>
        <p>
          The feed carries no start timestamps, so an outage&rsquo;s recorded start is when this
          service first saw it — up to five minutes after it appeared in the feed, and potentially
          much later than the lift actually failed. Outages that were already running when
          collection began are labelled as such: their true duration is longer than shown.
        </p>

        <h3 className="font-bold">Why the current list looks so long-running</h3>
        <p>
          The list of what is broken <em>right now</em> is inherently weighted towards slow
          repairs, and this trips people up. A lift restored within an hour is in the feed briefly
          and then gone; one waiting on a part sits there for weeks. So at any moment the
          disruptions on display are mostly the stubborn ones, and a station that has had five
          quick faults can look better than one with a single long fault. TfL&rsquo;s messages
          often say so themselves — current entries quote end dates months ahead. This is a
          property of snapshots, not an error, and it is why the per-station history matters more
          than the live count.
        </p>

        <h3 className="font-bold">Short outages can be missed entirely</h3>
        <p>
          A fault that appears and clears between two polls leaves no trace here. This service
          records what it observed, and does not claim to record every outage that occurred.
        </p>

        <h3 className="font-bold">A disrupted lift is not an inaccessible station</h3>
        <p>
          Many stations have more than one lift, and step-free access often survives one of them
          failing — via another lift, a ramp, or a level route. Establishing that a station has
          genuinely lost step-free access requires traversing its full topology of lifts, ramps,
          passages and platforms, which this service does not do. So we report{" "}
          <strong className="font-semibold">lift outages</strong>, never station accessibility.
        </p>

        <h3 className="font-bold">No availability percentages</h3>
        <p>
          Reporting &ldquo;X% availability&rdquo; would require a complete inventory of every lift
          in London and a reliable observation denominator. Until that is imported and verified,
          this site reports observed counts and durations only.
        </p>

        <h3 className="font-bold">Downtime is summed per lift</h3>
        <p>
          Station downtime adds up each lift&rsquo;s outage separately: two lifts out for an hour is
          two hours of lift downtime. Where the wall-clock figure is more useful, it is labelled
          &ldquo;time with at least one lift disrupted&rdquo; and overlapping periods are merged
          first.
        </p>

        <h3 className="font-bold">Medians exclude anything still running</h3>
        <p>
          Median and longest resolved durations count only outages seen from first observation to
          inferred restoration. Where no outage has completed yet, the figure reads
          &ldquo;insufficient data&rdquo; rather than zero.
        </p>
      </section>

      <section aria-labelledby="staleness-heading" className="space-y-2">
        <h2 id="staleness-heading" className="text-xl font-bold">
          Feed failures and stale data
        </h2>
        <p>
          Polling runs on a scheduled GitHub Actions workflow. Scheduled runs on that platform are
          best-effort: they are regularly delayed and are sometimes dropped altogether, so the
          schedule alone cannot be trusted to keep this site current. Page views therefore top the
          data up as described above, and the collector can also be triggered manually.
        </p>
        <p>
          The site never assumes it is up to date. The feed status banner shows the actual time of
          the last successful poll and degrades from <em>Live</em> (under 10 minutes) to{" "}
          <em>Delayed</em> (10–20 minutes) to <em>Stale</em> (over 20 minutes). If you see Delayed
          or Stale, treat every &ldquo;current&rdquo; figure as being that old.
        </p>
        <p>
          One consequence worth stating plainly: during a quiet period with no visitors and a
          stalled schedule, no polling happens at all, and a short outage in that window would be
          missed entirely. Gaps are visible rather than hidden — every poll attempt, including
          every failure, is recorded.
        </p>
      </section>

      <section aria-labelledby="attribution-heading" className="space-y-2">
        <h2 id="attribution-heading" className="text-xl font-bold">
          Attribution
        </h2>
        <p>
          Powered by TfL Open Data. Contains OS data © Crown copyright and database rights 2016 and
          Geomni UK Map data © and database rights 2019. Map tiles ©{" "}
          <a
            className="text-link underline underline-offset-4"
            href="https://www.openstreetmap.org/copyright"
            rel="noreferrer noopener"
            target="_blank"
          >
            OpenStreetMap contributors
          </a>
          .
        </p>
        <p className="font-semibold">
          This service is not affiliated with, endorsed by, or operated by Transport for London.
        </p>
        <p>
          For live travel advice, always use{" "}
          <a
            className="text-link underline underline-offset-4"
            href="https://tfl.gov.uk/"
            rel="noreferrer noopener"
            target="_blank"
          >
            tfl.gov.uk
          </a>
          .
        </p>
      </section>

      <p className="text-sm">
        <Link href="/" className="text-link underline underline-offset-4">
          ← Back to current disruptions
        </Link>
      </p>
    </div>
  );
}
