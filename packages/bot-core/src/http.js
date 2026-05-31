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

  async function request(url, options = {}) {
    const {
      method = 'GET',
      headers = {},
      body,
      json,
      timeoutMs = defaultTimeoutMs,
      ...rest
    } = options;

    const ac = new AbortController();
    const timer = setTimeout(
      () => ac.abort(new Error(`request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    const finalHeaders = { ...defaultHeaders, ...headers };
    let finalBody = body;
    if (json !== undefined) {
      finalHeaders['content-type'] = finalHeaders['content-type'] ?? 'application/json';
      finalBody = JSON.stringify(json);
    }

    try {
      const res = await fetch(url, {
        method,
        headers: finalHeaders,
        body: finalBody,
        dispatcher,
        signal: ac.signal,
        ...rest,
      });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestJson(url, options = {}) {
    const res = await request(url, options);
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (err) {
      const e = new Error(`invalid JSON response from ${url}: ${err.message}`);
      e.status = res.status;
      e.body = text.slice(0, 500);
      throw e;
    }
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
      e.status = res.status;
      e.body = parsed;
      throw e;
    }
    return parsed;
  }

  return {
    request,
    requestJson,
    dispatcher,
    log: logger,
  };
}
