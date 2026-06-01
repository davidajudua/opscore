import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHttp } from '../src/http.js';

// Spin a throwaway localhost server per test. createHttp uses its own undici
// dispatcher, so a real server is the reliable way to exercise it (MockAgent
// intercepts the global dispatcher, which createHttp does not use).
async function serve(handler) {
  const server = http.createServer(handler);
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('requestJson surfaces HTTP status for a non-ok, non-JSON body (not a JSON parse error)', async () => {
  const s = await serve((req, res) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('upstream gateway error');
  });
  try {
    const { requestJson } = createHttp();
    await assert.rejects(
      () => requestJson(s.url),
      (e) => {
        assert.equal(e.status, 502);
        assert.match(e.message, /HTTP 502/);
        assert.doesNotMatch(e.message, /invalid JSON/);
        return true;
      },
    );
  } finally {
    await s.close();
  }
});

test('requestJson parses a successful JSON response', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, n: 7 }));
  });
  try {
    const { requestJson } = createHttp();
    const data = await requestJson(s.url);
    assert.deepEqual(data, { ok: true, n: 7 });
  } finally {
    await s.close();
  }
});

test('a caller-supplied AbortSignal still aborts (composed with the timeout)', async () => {
  const s = await serve(() => {
    /* never responds — would hang without an abort */
  });
  try {
    const { requestJson } = createHttp({ defaultTimeoutMs: 60_000 });
    const ac = new AbortController();
    const p = requestJson(s.url, { signal: ac.signal });
    ac.abort();
    await assert.rejects(() => p);
  } finally {
    await s.close();
  }
});

test('the internal timeout aborts a stalled response even with no caller signal', async () => {
  const s = await serve(() => {
    /* never responds — internal timeout must fire */
  });
  try {
    const { requestJson } = createHttp({ defaultTimeoutMs: 150 });
    await assert.rejects(() => requestJson(s.url), /timed out|aborted|abort/i);
  } finally {
    await s.close();
  }
});
