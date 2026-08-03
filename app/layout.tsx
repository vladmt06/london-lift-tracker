import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: {
    default: "London Lift Reliability Tracker",
    template: "%s — London Lift Reliability Tracker",
  },
  description:
    "Current lift disruptions reported by TfL at London rail and Underground stations, " +
    "with observed outage history collected since launch.",
  openGraph: {
    title: "London Lift Reliability Tracker",
    description:
      "Current lift disruptions reported by TfL, and observed outage history since collection began.",
    type: "website",
  },
  robots: { index: true, follow: true },
};

const NAV_LINKS = [
  { href: "/", label: "Overview" },
  { href: "/stations", label: "Stations" },
  { href: "/methodology", label: "Methodology" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body className="min-h-screen bg-canvas text-ink">
        <a className="skip-link" href="#main">
          Skip to main content
        </a>

        <header className="border-b border-rule bg-paper">
          <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <Link href="/" className="text-lg font-bold tracking-tight text-ink no-underline">
                London Lift Reliability Tracker
              </Link>
              <p className="text-sm text-ink-muted">
                Lift disruptions reported by Transport for London
              </p>
            </div>

            <nav aria-label="Primary">
              <ul className="flex flex-wrap gap-4 text-sm font-medium">
                {NAV_LINKS.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className="text-link underline underline-offset-4">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </header>

        <main id="main" className="mx-auto max-w-6xl px-4 py-6">
          {children}
        </main>

        <footer className="mt-12 border-t border-rule bg-paper">
          <div className="mx-auto max-w-6xl space-y-2 px-4 py-6 text-sm text-ink-muted">
            <p>
              Powered by TfL Open Data. Contains OS data © Crown copyright and database rights
              2016 and Geomni UK Map data © and database rights 2019.
            </p>
            <p>
              <strong className="font-semibold text-ink">
                This service is not affiliated with, endorsed by, or operated by Transport for
                London.
              </strong>{" "}
              It records what the public lift-disruption feed reported, and nothing more.
            </p>
            <p>
              Map tiles ©{" "}
              <a
                className="text-link underline underline-offset-4"
                href="https://www.openstreetmap.org/copyright"
                rel="noreferrer noopener"
                target="_blank"
              >
                OpenStreetMap contributors
              </a>
              . Read the <Link href="/methodology" className="text-link underline underline-offset-4">methodology</Link>{" "}
              before quoting any number from this site.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
