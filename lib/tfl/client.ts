import { getEnv } from "@/lib/env";
import { hashJson } from "@/lib/utils/text";
import {
  StopPointSchema,
  StopPointSearchSchema,
  type StopPoint,
  type StopPointSearch,
} from "@/lib/tfl/schema";

const TFL_BASE_URL = "https://api.tfl.gov.uk";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2; // three attempts in total
const BASE_BACKOFF_MS = 500;

const USER_AGENT =
  "LondonLiftReliabilityTracker/1.0 (public step-free access data; contact via project README)";

export type TflErrorKind = "network" | "timeout" | "http" | "parse";

export class TflRequestError extends Error {
  readonly kind: TflErrorKind;
  readonly httpStatus: number | null;
  readonly attempts: number;

  constructor(
    message: string,
    options: { kind: TflErrorKind; httpStatus?: number | null; attempts: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "TflRequestError";
    this.kind = options.kind;
    this.httpStatus = options.httpStatus ?? null;
    this.attempts = options.attempts;
  }
}

export type TflResponse<T> = {
  payload: T;
  httpStatus: number;
  responseHash: string;
  durationMs: number;
  attempts: number;
};

export type FetchImpl = typeof globalThis.fetch;

export type TflClientOptions = {
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injectable for tests so retry backoff does not really sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  appKey?: string | undefined;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Retry only on transport failures, 429 and 5xx. Never on 4xx (e.g. a bad key). */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Exponential backoff with full jitter, so that several instances retrying at
 * once do not synchronise into a thundering herd.
 */
function backoffDelayMs(attempt: number): number {
  const ceiling = BASE_BACKOFF_MS * 2 ** attempt;
  return Math.round(Math.random() * ceiling);
}

function buildUrl(path: string, appKey: string | undefined, params?: Record<string, string>): string {
  const url = new URL(path.startsWith("/") ? path.slice(1) : path, `${TFL_BASE_URL}/`);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  if (appKey) url.searchParams.set("app_key", appKey);
  return url.toString();
}

async function requestJson(
  path: string,
  options: TflClientOptions & { params?: Record<string, string> } = {},
): Promise<TflResponse<unknown>> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const sleep = options.sleepImpl ?? defaultSleep;
  const appKey = "appKey" in options ? options.appKey : getEnv().TFL_APP_KEY;

  const url = buildUrl(path, appKey, options.params);
  const startedAt = Date.now();
  let lastError: TflRequestError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const attemptNumber = attempt + 1;

    if (attempt > 0) {
      await sleep(backoffDelayMs(attempt - 1));
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (cause) {
      const isTimeout =
        cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
      lastError = new TflRequestError(
        isTimeout
          ? `TfL request timed out after ${timeoutMs}ms: ${path}`
          : `TfL request failed: ${path} (${cause instanceof Error ? cause.message : String(cause)})`,
        { kind: isTimeout ? "timeout" : "network", attempts: attemptNumber, cause },
      );
      continue; // network problems are retryable
    }

    if (!response.ok) {
      const retryable = isRetryableStatus(response.status);
      const body = await response.text().catch(() => "");
      lastError = new TflRequestError(
        `TfL returned HTTP ${response.status} for ${path}${body ? `: ${body.slice(0, 200)}` : ""}`,
        { kind: "http", httpStatus: response.status, attempts: attemptNumber },
      );
      if (!retryable) throw lastError;
      continue;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      // Malformed JSON from a 200 is not worth retrying: it is a source problem.
      throw new TflRequestError(`TfL returned a 200 with unparseable JSON for ${path}`, {
        kind: "parse",
        httpStatus: response.status,
        attempts: attemptNumber,
        cause,
      });
    }

    return {
      payload,
      httpStatus: response.status,
      responseHash: hashJson(payload),
      durationMs: Date.now() - startedAt,
      attempts: attemptNumber,
    };
  }

  throw (
    lastError ??
    new TflRequestError(`TfL request failed for ${path}`, {
      kind: "network",
      attempts: maxRetries + 1,
    })
  );
}

/** GET /Disruptions/Lifts/v2 — the live lift disruption feed. */
export async function fetchLiftDisruptions(
  options: TflClientOptions = {},
): Promise<TflResponse<unknown>> {
  return requestJson("/Disruptions/Lifts/v2", options);
}

/** GET /StopPoint/{id}. Returns null when TfL does not know the id. */
export async function fetchStopPoint(
  id: string,
  options: TflClientOptions = {},
): Promise<StopPoint | null> {
  try {
    const response = await requestJson(`/StopPoint/${encodeURIComponent(id)}`, {
      ...options,
      // Station metadata is a nice-to-have during a poll: fail fast rather than
      // holding the collector open.
      timeoutMs: options.timeoutMs ?? 10_000,
      maxRetries: options.maxRetries ?? 1,
    });
    const parsed = StopPointSchema.safeParse(response.payload);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof TflRequestError && error.httpStatus === 404) return null;
    throw error;
  }
}

/** GET /StopPoint/Search/{query} restricted to rail-type modes. */
export async function searchStopPoints(
  query: string,
  options: TflClientOptions = {},
): Promise<StopPointSearch | null> {
  try {
    const response = await requestJson(`/StopPoint/Search/${encodeURIComponent(query)}`, {
      ...options,
      timeoutMs: options.timeoutMs ?? 10_000,
      maxRetries: options.maxRetries ?? 1,
      params: { modes: "tube,dlr,overground,elizabeth-line,national-rail,tram" },
    });
    const parsed = StopPointSearchSchema.safeParse(response.payload);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof TflRequestError && error.httpStatus === 404) return null;
    throw error;
  }
}
