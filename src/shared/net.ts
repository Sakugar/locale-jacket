// Bounded HTTP requests for subscriptions, data sets and update checks. Each of those
// runs one at a time, so a server that answers and then stops sending would otherwise
// block every later run (including "Update now") for as long as the worker lives.
// Every request therefore has an overall deadline, a stall timeout (for the headers
// and between body chunks) and a hard byte cap counted while the body streams in.
// Running out of any of them throws a readable Error, like an HTTP error would.

export interface NetLimits {
  /** The whole request, headers and body, must finish within this time. */
  totalMs: number;
  /** Longest wait for the response headers, and between two chunks of the body. */
  stallMs: number;
  /** Most bytes of body accepted (after content decoding). */
  maxBytes: number;
}

export function formatBytes(n: number): string {
  if (n >= 1048576) return `${Math.round((n / 1048576) * 10) / 10} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

const seconds = (ms: number) => (ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000) || ms / 1000} s`);

export function tooLargeError(maxBytes: number): Error {
  return new Error(`The file is larger than ${formatBytes(maxBytes)}.`);
}

/**
 * Fetch `url` within `limits`. The body is read only for a 2xx answer and returned as
 * exactly-sized bytes (no second copy when the server sends a correct content-length);
 * for any other status `body` is null and the caller decides what the status means.
 */
export async function fetchLimited(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  limits: NetLimits,
  onProgress?: (got: number, total: number) => void,
): Promise<{ res: Response; body: Uint8Array | null }> {
  const controller = new AbortController();
  let failure: Error | null = null;
  let rejectFailed: (e: Error) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => (rejectFailed = reject));
  failed.catch(() => undefined);
  const fail = (e: Error) => {
    if (failure) return;
    failure = e;
    rejectFailed(e);
    controller.abort(e);
  };
  const total = setTimeout(() => fail(new Error(`The download did not finish within ${seconds(limits.totalMs)}.`)), limits.totalMs);
  let stall: ReturnType<typeof setTimeout> | undefined;
  const arm = (msg: string) => {
    clearTimeout(stall);
    stall = setTimeout(() => fail(new Error(msg)), limits.stallMs);
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    arm(`The server did not answer within ${seconds(limits.stallMs)}.`);
    const res = await Promise.race([fetchFn(url, { ...init, signal: controller.signal }), failed]);
    if (!res.ok) {
      res.body?.cancel().catch(() => undefined);
      return { res, body: null };
    }
    const declared = Number(res.headers.get('content-length')) || 0;
    if (declared > limits.maxBytes) {
      res.body?.cancel().catch(() => undefined);
      throw tooLargeError(limits.maxBytes);
    }
    if (!res.body) {
      arm(`The server stopped sending data for ${seconds(limits.stallMs)}.`);
      const all = new Uint8Array(await Promise.race([res.arrayBuffer(), failed]));
      if (all.byteLength > limits.maxBytes) throw tooLargeError(limits.maxBytes);
      return { res, body: all };
    }
    reader = res.body.getReader();
    // Sized from content-length when known; grows (by doubling, up to the cap) otherwise,
    // or when the length was that of a compressed body.
    let buf = new Uint8Array(Math.min(limits.maxBytes, declared || 64 * 1024));
    let got = 0;
    for (;;) {
      arm(`The server stopped sending data for ${seconds(limits.stallMs)}.`);
      const { done, value } = await Promise.race([reader.read(), failed]);
      if (done) break;
      if (got + value.length > limits.maxBytes) throw tooLargeError(limits.maxBytes);
      if (got + value.length > buf.length) {
        const next = new Uint8Array(Math.min(limits.maxBytes, Math.max(buf.length * 2, got + value.length)));
        next.set(buf.subarray(0, got));
        buf = next;
      }
      buf.set(value, got);
      got += value.length;
      onProgress?.(got, declared);
    }
    reader = null;
    return { res, body: got === buf.length ? buf : buf.slice(0, got) };
  } catch (e) {
    throw failure ?? e;
  } finally {
    clearTimeout(total);
    clearTimeout(stall);
    reader?.cancel().catch(() => undefined);
    // Stop the request if it is still running (a failure, or a body not read).
    if (!failure) controller.abort();
  }
}
