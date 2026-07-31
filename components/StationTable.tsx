"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { Duration } from "@/components/Duration";
import { DAY_MS, formatLondonDateTime } from "@/lib/metrics/duration";
import type { StationRow } from "@/lib/utils/view-types";

/**
 * Station rankings.
 *
 * A real table with a caption and column headers, sortable from the keyboard,
 * with an aria-live summary so that filtering is announced rather than silently
 * changing the page under a screen-reader user.
 */

type SortKey =
  | "name"
  | "activeOutages"
  | "observedOutageCount"
  | "observedDowntimeMs"
  | "medianResolvedMs"
  | "longestResolvedMs"
  | "lastObserved";

type Direction = "asc" | "desc";

type PeriodFilter = "all" | "7d" | "24h";

const COLUMNS: Array<{ key: SortKey; label: string; numeric: boolean; help?: string }> = [
  { key: "name", label: "Station", numeric: false },
  { key: "activeOutages", label: "Active outages", numeric: true },
  { key: "observedOutageCount", label: "Observed outages", numeric: true },
  { key: "observedDowntimeMs", label: "Observed downtime", numeric: true },
  { key: "medianResolvedMs", label: "Median resolved", numeric: true },
  { key: "longestResolvedMs", label: "Longest resolved", numeric: true },
  { key: "lastObserved", label: "Last disruption", numeric: false },
];

function compareNullableDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

export function StationTable({
  rows,
  collectionStartedLabel,
  nowIso,
  showFilters = true,
  initialSort = "default",
}: {
  rows: StationRow[];
  collectionStartedLabel: string | null;
  /** Server-supplied reference time: keeps filtering pure and hydration stable. */
  nowIso: string;
  showFilters?: boolean;
  initialSort?: SortKey | "default";
}) {
  const [sort, setSort] = useState<SortKey | "default">(initialSort);
  const [direction, setDirection] = useState<Direction>("desc");
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [minOutages, setMinOutages] = useState(0);
  const [period, setPeriod] = useState<PeriodFilter>("all");

  const searchId = useId();
  const activeId = useId();
  const minId = useId();
  const periodId = useId();

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const reference = new Date(nowIso).getTime();
    const cutoff =
      period === "24h" ? reference - DAY_MS : period === "7d" ? reference - 7 * DAY_MS : null;

    return rows.filter((row) => {
      if (activeOnly && row.activeOutages === 0) return false;
      if (row.observedOutageCount < minOutages) return false;
      if (needle.length > 0) {
        const haystack = `${row.name} ${row.lines.join(" ")} ${row.modes.join(" ")}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      if (cutoff !== null) {
        if (!row.lastObservedDisruptionAtIso) return false;
        if (new Date(row.lastObservedDisruptionAtIso).getTime() < cutoff) return false;
      }
      return true;
    });
  }, [rows, search, activeOnly, minOutages, period, nowIso]);

  const sorted = useMemo(() => {
    const list = [...filtered];

    list.sort((a, b) => {
      if (sort === "default") {
        // Active outages first, then the most observed downtime.
        return (
          b.activeOutages - a.activeOutages ||
          b.observedDowntimeMs - a.observedDowntimeMs ||
          a.name.localeCompare(b.name, "en-GB")
        );
      }

      let comparison: number;
      switch (sort) {
        case "name":
          comparison = a.name.localeCompare(b.name, "en-GB");
          return direction === "asc" ? comparison : -comparison;
        case "activeOutages":
          comparison = b.activeOutages - a.activeOutages;
          break;
        case "observedOutageCount":
          comparison = b.observedOutageCount - a.observedOutageCount;
          break;
        case "observedDowntimeMs":
          comparison = b.observedDowntimeMs - a.observedDowntimeMs;
          break;
        case "medianResolvedMs":
          comparison = compareNullableDesc(a.medianResolvedMs, b.medianResolvedMs);
          break;
        case "longestResolvedMs":
          comparison = compareNullableDesc(a.longestResolvedMs, b.longestResolvedMs);
          break;
        case "lastObserved":
          comparison = compareNullableDesc(
            a.lastObservedDisruptionAtIso ? new Date(a.lastObservedDisruptionAtIso).getTime() : null,
            b.lastObservedDisruptionAtIso ? new Date(b.lastObservedDisruptionAtIso).getTime() : null,
          );
          break;
        default:
          comparison = 0;
      }

      if (comparison === 0) return a.name.localeCompare(b.name, "en-GB");
      return direction === "asc" ? -comparison : comparison;
    });

    return list;
  }, [filtered, sort, direction]);

  function toggleSort(key: SortKey): void {
    if (sort === key) {
      setDirection((current) => (current === "desc" ? "asc" : "desc"));
      return;
    }
    setSort(key);
    setDirection("desc");
  }

  function ariaSortFor(key: SortKey): "ascending" | "descending" | "none" {
    if (sort !== key) return "none";
    return direction === "asc" ? "ascending" : "descending";
  }

  return (
    <div className="space-y-3">
      {showFilters ? (
        <div className="grid gap-3 rounded border border-rule bg-paper px-4 py-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor={searchId} className="block text-sm font-medium">
              Search by station
            </label>
            <input
              id={searchId}
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="mt-1 w-full rounded border border-rule-strong bg-paper px-3 py-2 text-sm"
              placeholder="e.g. Canada Water"
            />
          </div>

          <div>
            <label htmlFor={minId} className="block text-sm font-medium">
              Minimum observed outages
            </label>
            <input
              id={minId}
              type="number"
              min={0}
              max={999}
              value={minOutages}
              onChange={(event) => setMinOutages(Math.max(0, Number(event.target.value) || 0))}
              className="mt-1 w-full rounded border border-rule-strong bg-paper px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label htmlFor={periodId} className="block text-sm font-medium">
              Collection period
            </label>
            <select
              id={periodId}
              value={period}
              onChange={(event) => setPeriod(event.target.value as PeriodFilter)}
              className="mt-1 w-full rounded border border-rule-strong bg-paper px-3 py-2 text-sm"
            >
              <option value="all">Everything since collection began</option>
              <option value="7d">Disrupted in the last 7 days</option>
              <option value="24h">Disrupted in the last 24 hours</option>
            </select>
          </div>

          <div className="flex items-end">
            <div className="flex items-center gap-2">
              <input
                id={activeId}
                type="checkbox"
                checked={activeOnly}
                onChange={(event) => setActiveOnly(event.target.checked)}
                className="h-4 w-4"
              />
              <label htmlFor={activeId} className="text-sm font-medium">
                Active outages only
              </label>
            </div>
          </div>
        </div>
      ) : null}

      <p aria-live="polite" className="text-sm text-ink-muted">
        Showing {sorted.length} of {rows.length} station{rows.length === 1 ? "" : "s"}.
      </p>

      {/* `relative` matters: the visually-hidden sort hints are absolutely
          positioned, and a static scroll container does not clip absolutely
          positioned descendants — without it they widen the whole page on
          narrow screens. */}
      <div className="relative overflow-x-auto rounded border border-rule bg-paper">
        <table className="w-full border-collapse text-sm">
          <caption className="px-4 py-3 text-left text-sm text-ink-muted">
            {collectionStartedLabel
              ? `Ranked by observed downtime since ${collectionStartedLabel}.`
              : "Ranked by observed downtime. Collection has not started yet."}{" "}
            Downtime sums each lift separately, so two lifts out for an hour counts as two hours.
          </caption>

          <thead>
            <tr className="border-y border-rule bg-canvas text-left">
              {COLUMNS.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={ariaSortFor(column.key)}
                  className={`px-3 py-2 font-semibold ${column.numeric ? "text-right" : "text-left"}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(column.key)}
                    className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                  >
                    {column.label}
                    <span aria-hidden="true" className="text-ink-muted">
                      {sort === column.key ? (direction === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                    <span className="sr-only">
                      {sort === column.key
                        ? `, sorted ${direction === "asc" ? "ascending" : "descending"}. Activate to reverse.`
                        : ", activate to sort by this column"}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-6 text-center text-ink-muted">
                  No stations match these filters.
                </td>
              </tr>
            ) : (
              sorted.map((row) => (
                <tr key={row.slug} className="border-b border-rule last:border-b-0">
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    <Link
                      href={`/stations/${row.slug}`}
                      className="text-link underline underline-offset-4"
                    >
                      {row.name}
                    </Link>
                    {row.lines.length > 0 ? (
                      <span className="block text-xs font-normal text-ink-muted">
                        {row.lines.join(", ")}
                      </span>
                    ) : null}
                  </th>

                  <td className="px-3 py-2 text-right tabular-nums">
                    {row.activeOutages > 0 ? (
                      <span className="font-semibold text-outage">
                        {row.activeOutages}
                        <span className="sr-only"> active</span>
                      </span>
                    ) : (
                      <span className="text-ink-muted">0</span>
                    )}
                  </td>

                  <td className="px-3 py-2 text-right tabular-nums">{row.observedOutageCount}</td>

                  <td className="px-3 py-2 text-right tabular-nums">
                    <Duration ms={row.observedDowntimeMs} />
                  </td>

                  <td className="px-3 py-2 text-right tabular-nums">
                    <Duration ms={row.medianResolvedMs} />
                  </td>

                  <td className="px-3 py-2 text-right tabular-nums">
                    <Duration ms={row.longestResolvedMs} />
                  </td>

                  <td className="px-3 py-2">
                    {row.lastObservedDisruptionAtIso ? (
                      <time dateTime={row.lastObservedDisruptionAtIso}>
                        {formatLondonDateTime(new Date(row.lastObservedDisruptionAtIso))}
                      </time>
                    ) : (
                      <span className="text-ink-muted">none observed</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default StationTable;
