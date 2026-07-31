import { z } from "zod";

/**
 * Server-side environment validation.
 *
 * Validation is lazy and memoised rather than run at module load: `next build`
 * imports server modules while collecting page data, and a build machine should
 * not need production database credentials just to compile.
 */

const EnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required — a PostgreSQL connection string")
    .refine(
      (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "DATABASE_URL must be a PostgreSQL connection string (postgres:// or postgresql://)",
    ),

  // Optional by design: the Lift Disruptions v2 feed answers anonymously at 50
  // requests/minute, and five-minute polling needs about one. A registered key
  // raises the ceiling to 500/minute.
  TFL_APP_KEY: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),

  CRON_SECRET: z
    .string()
    .min(
      16,
      "CRON_SECRET must be at least 16 characters — generate one with `openssl rand -hex 32`",
    ),

  NEXT_PUBLIC_APP_URL: z
    .string()
    .url("NEXT_PUBLIC_APP_URL must be an absolute URL, e.g. https://example.com")
    .optional()
    .transform((value) => (value ?? "http://localhost:3000").replace(/\/+$/, "")),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;
let warnedAboutMissingKey = false;

function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const name = issue.path.join(".") || "(root)";
    return `  • ${name}: ${issue.message}`;
  });

  return [
    "Invalid environment configuration.",
    ...lines,
    "",
    "Copy .env.example to .env and fill in the values.",
  ].join("\n");
}

export function getEnv(): Env {
  if (cached) return cached;

  if (typeof window !== "undefined") {
    throw new Error(
      "getEnv() was called in browser code. Server secrets must never reach the client bundle.",
    );
  }

  const parsed = EnvSchema.safeParse({
    DATABASE_URL: process.env.DATABASE_URL,
    TFL_APP_KEY: process.env.TFL_APP_KEY,
    CRON_SECRET: process.env.CRON_SECRET,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  });

  if (!parsed.success) {
    throw new Error(formatIssues(parsed.error));
  }

  if (!parsed.data.TFL_APP_KEY && !warnedAboutMissingKey) {
    warnedAboutMissingKey = true;
    console.warn(
      "[env] TFL_APP_KEY is not set. Falling back to anonymous TfL API access " +
        "(50 requests/minute). Register at https://api-portal.tfl.gov.uk/ for 500/minute.",
    );
  }

  cached = parsed.data;
  return cached;
}

/** Test-only: forget the memoised value so a new process.env can be read. */
export function resetEnvCache(): void {
  cached = null;
  warnedAboutMissingKey = false;
}
