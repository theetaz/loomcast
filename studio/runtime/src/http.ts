// Fetch with retries for the TTS provider: 429 and 5xx responses and network failures are retried
// with exponential backoff (honouring Retry-After); other responses are returned as they are.

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class ProviderError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.retryable = retryable;
  }
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** A short, key-free description of a failed response for error messages. */
export async function describeFailure(response: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await response.text()).slice(0, 500);
    try {
      const json = JSON.parse(body) as { detail?: unknown };
      detail = typeof json.detail === "string" ? json.detail : JSON.stringify(json.detail ?? json);
    } catch {
      detail = body;
    }
  } catch {
    // The body is not readable; the status says enough.
  }
  return `HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
}

/** Fetches `url`, retrying 429, 5xx and network errors. Returns the final response. */
export async function fetchWithRetry(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const base = options.baseDelayMs ?? 1_000;
  const max = options.maxDelayMs ?? 20_000;
  const sleep = options.sleep ?? defaultSleep;
  const signal = init.signal ?? undefined;

  for (let attempt = 1; ; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (signal?.aborted || attempt >= attempts) throw error;
    }
    if (response && (!isRetryableStatus(response.status) || attempt >= attempts)) return response;
    const backoff = Math.min(max, base * 2 ** (attempt - 1));
    const wait = response ? Math.min(max, retryAfterMs(response) ?? backoff) : backoff;
    await response?.body?.cancel().catch(() => undefined);
    await sleep(wait, signal);
  }
}
