/**
 * A single headline number. Deliberately plain: a label, a number, and the
 * caveat that applies to it — never a number floating without its context.
 */
export function MetricCard({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "neutral" | "outage" | "ok";
}) {
  const toneClasses =
    tone === "outage"
      ? "border-outage/40 bg-outage-tint"
      : tone === "ok"
        ? "border-ok/40 bg-ok-tint"
        : "border-rule bg-paper";

  const valueClasses = tone === "outage" ? "text-outage" : "text-ink";

  return (
    <div className={`rounded border px-4 py-3 ${toneClasses}`}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</h3>
      <p className={`mt-1 text-2xl font-bold tabular-nums leading-tight ${valueClasses}`}>
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-ink-muted">{hint}</p> : null}
    </div>
  );
}

export default MetricCard;
