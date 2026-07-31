import {
  formatLondonDateTime,
  formatRelativeToNow,
  londonTimeZoneAbbreviation,
} from "@/lib/metrics/duration";
import type { FeedHealthStatus } from "@/lib/metrics/station-metrics";

/**
 * Feed freshness.
 *
 * The timestamp is always shown, not just a coloured dot: if collection has
 * stalled, every "current" figure on the page is that old, and the reader needs
 * to be able to see exactly how old.
 */

const STATUS_COPY: Record<
  FeedHealthStatus,
  { label: string; symbol: string; explanation: string; className: string }
> = {
  healthy: {
    label: "Live",
    symbol: "●",
    explanation: "Last successful poll under 10 minutes ago.",
    className: "border-ok/40 bg-ok-tint text-ok",
  },
  delayed: {
    label: "Delayed",
    symbol: "▲",
    explanation: "Last successful poll 10–20 minutes ago. Figures may lag reality.",
    className: "border-restored/40 bg-restored-tint text-restored",
  },
  stale: {
    label: "Stale",
    symbol: "■",
    explanation:
      "No successful poll for over 20 minutes. Treat everything below as out of date.",
    className: "border-outage/40 bg-outage-tint text-outage",
  },
  unavailable: {
    label: "No data",
    symbol: "✕",
    explanation: "Collection has not produced a successful poll yet.",
    className: "border-rule-strong bg-canvas text-ink",
  },
};

export function FeedHealth({
  status,
  lastSuccessfulPoll,
  failedPollsLast24h,
  now,
}: {
  status: FeedHealthStatus;
  lastSuccessfulPoll: Date | null;
  failedPollsLast24h: number;
  now: Date;
}) {
  const copy = STATUS_COPY[status];

  return (
    <div
      className={`rounded border px-4 py-3 ${copy.className}`}
      role="status"
      aria-label={`Feed status: ${copy.label}. ${copy.explanation}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {/* Symbol and word, so status never depends on colour alone. */}
        <span aria-hidden="true" className="text-sm">
          {copy.symbol}
        </span>
        <span className="font-semibold">Feed status: {copy.label}</span>
        {lastSuccessfulPoll ? (
          <span className="text-sm text-ink">
            Last successful poll{" "}
            <time dateTime={lastSuccessfulPoll.toISOString()}>
              {formatLondonDateTime(lastSuccessfulPoll)} {londonTimeZoneAbbreviation(lastSuccessfulPoll)}
            </time>{" "}
            ({formatRelativeToNow(lastSuccessfulPoll, now)})
          </span>
        ) : (
          <span className="text-sm text-ink">No successful poll recorded yet.</span>
        )}
      </div>

      <p className="mt-1 text-sm text-ink">
        {copy.explanation} Polling runs every five minutes, and refreshes on page load when the
        data has gone stale.
        {failedPollsLast24h > 0
          ? ` ${failedPollsLast24h} failed poll${failedPollsLast24h === 1 ? "" : "s"} in the last 24 hours.`
          : ""}
      </p>
    </div>
  );
}

export default FeedHealth;
