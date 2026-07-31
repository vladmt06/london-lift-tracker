import { formatDuration, formatDurationLong } from "@/lib/metrics/duration";

/**
 * A length of time. The compact form is shown; the spoken form is what a screen
 * reader announces, because "3d 4h" is not useful read aloud.
 */
export function Duration({
  ms,
  className,
  emptyLabel = "insufficient data",
}: {
  ms: number | null;
  className?: string;
  emptyLabel?: string;
}) {
  if (ms === null) {
    return (
      <span className={className ?? "text-ink-muted"} data-empty="true">
        {emptyLabel}
      </span>
    );
  }

  return (
    <span className={className}>
      <span aria-hidden="true">{formatDuration(ms)}</span>
      <span className="sr-only">{formatDurationLong(ms)}</span>
    </span>
  );
}

export default Duration;
