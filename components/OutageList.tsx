import Link from "next/link";
import { Duration } from "@/components/Duration";
import {
  formatLondonDate,
  formatLondonDateTime,
  londonTimeZoneAbbreviation,
} from "@/lib/metrics/duration";
import type { OutageListItem } from "@/lib/utils/view-types";

/**
 * The text equivalent of the map, and the primary way to read this data.
 *
 * Everything a marker can tell you is here in ordinary HTML: station, lift,
 * message, when it was first observed, and how long it has been running.
 */
export function OutageList({
  items,
  emptyMessage = "No lift disruptions are currently reported.",
  headingId,
}: {
  items: OutageListItem[];
  emptyMessage?: string;
  headingId?: string;
}) {
  if (items.length === 0) {
    return (
      <p className="rounded border border-rule bg-paper px-4 py-6 text-ink-muted">{emptyMessage}</p>
    );
  }

  return (
    <ul className="space-y-3" aria-labelledby={headingId}>
      {items.map((item) => {
        const firstSeen = new Date(item.firstSeenAtIso);

        return (
          <li key={item.id}>
            <article className="rounded border border-rule border-l-4 border-l-outage bg-paper px-4 py-3">
              <h3 className="text-base font-bold leading-snug">
                <Link
                  href={`/stations/${item.stationSlug}`}
                  className="text-link underline underline-offset-4"
                >
                  {item.stationName}
                </Link>
              </h3>

              {/* Always give a length. Best available, in order: the start TfL
                  states in its own message; our measurement when we watched it
                  begin; otherwise how long we have seen it, marked as a floor. */}
              <p className="mt-0.5 text-sm font-medium text-ink">
                {item.liftName ?? "Lift not identified in the feed"}
                <span aria-hidden="true"> · </span>
                <span className="text-outage">
                  {"Disrupted for "}
                  {item.statedDurationMs !== null ? (
                    <Duration ms={item.statedDurationMs} />
                  ) : item.ongoingAtCollectionStart ? (
                    <>
                      <span aria-hidden="true">≥ </span>
                      <span className="sr-only">at least </span>
                      <Duration ms={item.durationMs} />
                    </>
                  ) : (
                    <Duration ms={item.durationMs} />
                  )}
                </span>
              </p>

              <p className="mt-2 text-sm text-ink">{item.message}</p>

              {/* One compact line. The full explanation of why a pre-existing
                  outage has no duration belongs once, above the list — not
                  repeated on all thirty cards, where it buried the message. */}
              <p className="mt-2 text-xs text-ink-muted">
                {item.statedDurationMs !== null && item.statedStartAtIso ? (
                  <>
                    {"Out since "}
                    <time dateTime={item.statedStartAtIso}>
                      {formatLondonDate(new Date(item.statedStartAtIso))}
                    </time>
                    {", the start date given in TfL’s message."}
                  </>
                ) : item.ongoingAtCollectionStart ? (
                  <>
                    {"At least that long: it was already broken when we started watching on "}
                    <time dateTime={item.firstSeenAtIso}>{formatLondonDate(firstSeen)}</time>
                    {", so it began earlier."}
                  </>
                ) : (
                  <>
                    {"Timed from when we first saw it, "}
                    <time dateTime={item.firstSeenAtIso}>
                      {formatLondonDateTime(firstSeen)} {londonTimeZoneAbbreviation(firstSeen)}
                    </time>
                    {"."}
                  </>
                )}
              </p>
            </article>
          </li>
        );
      })}
    </ul>
  );
}

export default OutageList;
