import { fetch, Agent, ProxyAgent } from 'undici';

/**
 * HTTP client wrapper around undici's fetch.
 *
 * Adds per-request timeouts, JSON request/response helpers, a keep-alive dispatcher,
 * and optional proxy support. Used by any bot that needs to call an external API
 * (e.g. Payment Bot's blockchain explorers).
 */
export function createHttp({ logger, defaultHeaders = {}, defaultTimeoutMs = 20_000, proxy } = {}) {
  const dispatcher = proxy
    ? new ProxyAgent(proxy)
    : new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 30_000 });

  // Build the undici fetch init from caller options, pulling out our own knobs.
  // `signal` is destructured out of `...rest` so a caller-supplied signal can be
  // *composed* with the timeout signal rather than silently overwriting it.
  function prepare(options) {
    const {
      method = 'GET',
      headers = {},
      body,
      json,
      timeoutMs = defaultTimeoutMs,
      signal: callerSignal,
      ...rest
    } = options;

    const finalHeaders = { ...defaultHeaders, ...headers };
    let finalBody = body;
    if (json !== undefined) {
      finalHeaders['content-type'] = finalHeaders['content-type'] ?? 'application/json';
      finalBody = JSON.stringify(json);
    }
    return { method, finalHeaders, finalBody, timeoutMs, callerSignal, rest };
  }

  function armTimeout(timeoutMs, callerSignal) {
    const ac = new AbortController();
    const timer = setTimeout(
      () => ac.abort(new Error(`request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    // Compose: abort when EITHER the timeout fires or the caller aborts. This keeps
    // the timeout effective even when the caller passes their own AbortSignal.
    const signal = callerSignal ? AbortSignal.any([ac.signal, callerSignal]) : ac.signal;
    return { signal, clear: () => clearTimeout(timer) };
  }

  /**
   * Low-level request. The timeout covers up to response headers; the caller owns the
   * response body and is responsible for reading it (use `requestJson` for a helper
   * whose timeout also spans body consumption).
   */
  async function request(url, options = {}) {
    const { method, finalHeaders, finalBody, timeoutMs, callerSignal, rest } = prepare(options);
    const { signal, clear } = armTimeout(timeoutMs, callerSignal);
    try {
      return await fetch(url, {
        method,
        headers: finalHeaders,
        body: finalBody,
        dispatcher,
        ...rest,
        signal,
      });
    } finally {
      clear();
    }
  }

  /**
   * Request + parse JSON. Unlike `request`, the timeout here spans body consumption
   * too, so a slow or stalled response body cannot hang the caller indefinitely.
   * Non-2xx responses throw an HTTP error carrying the raw body (checked before any
   * JSON parse, so a non-JSON error page surfaces a meaningful status, not a parse error).
   */
  async function requestJson(url, options = {}) {
    const { method, finalHeaders, finalBody, timeoutMs, callerSignal, rest } = prepare(options);
    const { signal, clear } = armTimeout(timeoutMs, callerSignal);
    try {
      const res = await fetch(url, {
        method,
        headers: finalHeaders,
        body: finalBody,
        dispatcher,
        ...rest,
        signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
        e.status = res.status;
        e.body = text.slice(0, 500);
        throw e;
      }
      try {
        return text ? JSON.parse(text) : null;
      } catch (err) {
        const e = new Error(`invalid JSON response from ${url}: ${err.message}`);
        e.status = res.status;
        e.body = text.slice(0, 500);
        throw e;
      }
    } finally {
      clear();
    }
  }

  return {
    request,
    requestJson,
    dispatcher,
    log: logger,
  };
}
