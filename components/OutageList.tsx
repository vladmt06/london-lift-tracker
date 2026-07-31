import Link from "next/link";
import { Duration } from "@/components/Duration";
import { formatLondonDateTime, londonTimeZoneAbbreviation } from "@/lib/metrics/duration";
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

              <p className="mt-0.5 text-sm font-medium text-ink">
                {item.liftName ?? "Lift not identified in the feed"}
                <span aria-hidden="true"> · </span>
                {item.ongoingAtCollectionStart ? (
                  // This outage predates collection. We know it is ongoing; we do
                  // NOT know for how long, so no duration is claimed here.
                  <span className="text-outage">Ongoing</span>
                ) : (
                  <span className="text-outage">
                    Disrupted for <Duration ms={item.durationMs} />
                  </span>
                )}
              </p>

              <p className="mt-2 text-sm text-ink">{item.message}</p>

              <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
                <div className="flex gap-1">
                  <dt className="font-semibold">First observed:</dt>
                  <dd>
                    <time dateTime={item.firstSeenAtIso}>
                      {formatLondonDateTime(firstSeen)} {londonTimeZoneAbbreviation(firstSeen)}
                    </time>
                  </dd>
                </div>
                {item.ongoingAtCollectionStart ? (
                  <div className="flex gap-1">
                    <dt className="font-semibold">How long:</dt>
                    <dd>
                      {"unknown — this lift was already disrupted when collection began, so it "}
                      {"has been out longer than the "}
                      <Duration ms={item.durationMs} />
                      {" we have been watching it. Check TfL’s message above for their own dates."}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </article>
          </li>
        );
      })}
    </ul>
  );
}

export default OutageList;
