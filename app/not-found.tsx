import Link from "next/link";

export default function NotFound() {
  return (
    <div className="max-w-2xl space-y-3">
      <h1 className="text-2xl font-bold tracking-tight">Page not found</h1>
      <p className="text-ink-muted">
        That page does not exist. A station only has a page once a lift disruption has been observed
        there since collection began.
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <Link href="/" className="text-link underline underline-offset-4">
            Current disruptions
          </Link>
        </li>
        <li>
          <Link href="/stations" className="text-link underline underline-offset-4">
            All observed stations
          </Link>
        </li>
      </ul>
    </div>
  );
}
