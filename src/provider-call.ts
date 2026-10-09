export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
const MIN_PROVIDER_TIMEOUT_MS = 100;
const MAX_PROVIDER_TIMEOUT_MS = 120_000;

export function parseProviderTimeoutMs(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_PROVIDER_TIMEOUT_MS;
  if (!Number.isInteger(raw) || raw < MIN_PROVIDER_TIMEOUT_MS || raw > MAX_PROVIDER_TIMEOUT_MS) {
    throw new Error(
      `Provider timeout must be an integer between ${MIN_PROVIDER_TIMEOUT_MS} and ${MAX_PROVIDER_TIMEOUT_MS} ms`,
    );
  }
  return raw;
}

export class ProviderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider call timed out after ${timeoutMs} ms`);
    this.name = "ProviderTimeoutError";
  }
}

export async function callProviderWithTimeout<T>(
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const boundedTimeoutMs = parseProviderTimeoutMs(timeoutMs);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderTimeoutError(boundedTimeoutMs));
    }, boundedTimeoutMs);
  });

  try {
    return await Promise.race([call(controller.signal), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
