import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, MempoolClient, RateLimiter, mapPool } from '../src/mempool.ts';
import { coreLikeTx, hex32 } from './helpers.ts';

const realFetch = globalThis.fetch;

interface StubCall {
  url: string;
}

function stubFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): StubCall[] {
  const calls: StubCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('the rate limiter enforces a cooldown written by the caller', async () => {
  const limiter = new RateLimiter(1000, 5);
  assert.equal(limiter.cooldownRemainingMs(), 0);
  limiter.cooldown(80);
  assert.ok(limiter.cooldownRemainingMs() > 0);
  const started = Date.now();
  await limiter.acquire();
  assert.ok(Date.now() - started >= 60, 'acquire must wait out the cooldown');
});

test('the rate limiter spaces requests to roughly the configured rate', async () => {
  const limiter = new RateLimiter(50, 1);
  const started = Date.now();
  for (let i = 0; i < 4; i++) await limiter.acquire();
  const elapsed = Date.now() - started;
  // 4 tokens at 50/s with burst 1 => ~60ms of spacing.
  assert.ok(elapsed >= 40, `expected throttling, took ${elapsed}ms`);
  assert.ok(elapsed < 2000, `throttling should not be pathological, took ${elapsed}ms`);
});

test('tx() fetches and parses a transaction', async () => {
  const tx = coreLikeTx();
  const calls = stubFetch(() => jsonResponse(tx));
  const client = new MempoolClient({ baseUrl: 'https://example.test', rps: 1000, backoffBaseMs: 1 });

  const result = await client.tx(tx.txid);
  assert.equal(result.txid, tx.txid);
  assert.equal(calls[0]?.url, `https://example.test/api/tx/${tx.txid}`);
  assert.equal(client.stats.requests, 1);
  assert.equal(client.stats.bytes > 0, true);
});

test('invalid txids are rejected before any request is made', async () => {
  const calls = stubFetch(() => jsonResponse({}));
  const client = new MempoolClient({ baseUrl: 'https://example.test', rps: 1000 });
  await assert.rejects(() => client.tx('not-a-txid'), /invalid txid/);
  await assert.rejects(() => client.blockTxids('zz'), /invalid block hash/);
  assert.equal(calls.length, 0);
});

test('a 404 fails immediately without retrying', async () => {
  const calls = stubFetch(() => jsonResponse({ error: 'not found' }, 404));
  const client = new MempoolClient({ baseUrl: 'https://example.test', rps: 1000, backoffBaseMs: 1 });
  await assert.rejects(
    () => client.tx(hex32(7)),
    (err: unknown) => err instanceof HttpError && err.status === 404,
  );
  assert.equal(calls.length, 1);
  assert.equal(client.stats.retries, 0);
});

test('429 responses are retried after the Retry-After delay', async () => {
  let attempts = 0;
  const calls = stubFetch(() => {
    attempts++;
    if (attempts === 1) return jsonResponse({ error: 'rate limited' }, 429, { 'retry-after': '0.02' });
    return jsonResponse(coreLikeTx({ txid: hex32(8) }));
  });
  const client = new MempoolClient({
    baseUrl: 'https://example.test',
    rps: 1000,
    retries: 2,
    backoffBaseMs: 1,
  });

  const tx = await client.tx(hex32(8));
  assert.equal(tx.txid, hex32(8));
  assert.equal(calls.length, 2);
  assert.equal(client.stats.rateLimitHits, 1);
  assert.equal(client.stats.retries, 1);
});

test('exhausted 429 retries surface as HttpError 429', async () => {
  const calls = stubFetch(() => jsonResponse({ error: 'nope' }, 429, { 'retry-after': '0' }));
  const client = new MempoolClient({
    baseUrl: 'https://example.test',
    rps: 1000,
    retries: 1,
    backoffBaseMs: 1,
  });
  await assert.rejects(
    () => client.tx(hex32(9)),
    (err: unknown) => err instanceof HttpError && err.status === 429,
  );
  assert.equal(calls.length, 2);
});

test('5xx responses are retried and then surfaced', async () => {
  const calls = stubFetch(() => jsonResponse({ error: 'boom' }, 503));
  const client = new MempoolClient({
    baseUrl: 'https://example.test',
    rps: 1000,
    retries: 1,
    backoffBaseMs: 1,
  });
  await assert.rejects(
    () => client.tx(hex32(10)),
    (err: unknown) => err instanceof HttpError && err.status === 503,
  );
  assert.equal(calls.length, 2);
});

test('a transient network error is retried once and then succeeds', async () => {
  let attempts = 0;
  stubFetch(() => {
    attempts++;
    if (attempts === 1) throw new TypeError('fetch failed');
    return jsonResponse({ count: 1, vsize: 2, total_fee: 3 });
  });
  const client = new MempoolClient({
    baseUrl: 'https://example.test',
    rps: 1000,
    retries: 1,
    backoffBaseMs: 1,
  });
  const stats = await client.mempoolStats();
  assert.equal(stats.count, 1);
  assert.equal(attempts, 2);
});

test('the tip height endpoint is parsed from plain text', async () => {
  stubFetch(() => new Response('812345\n', { status: 200, headers: { 'content-type': 'text/plain' } }));
  const client = new MempoolClient({ baseUrl: 'https://example.test', rps: 1000 });
  assert.equal(await client.tipHeight(), 812345);
});

test('an invalid JSON body is a clear error', async () => {
  stubFetch(() => new Response('<html>nope</html>', { status: 200 }));
  const client = new MempoolClient({ baseUrl: 'https://example.test', rps: 1000, retries: 0 });
  await assert.rejects(() => client.mempoolStats(), /invalid JSON/);
});

test('mapPool preserves order while bounding concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const results = await mapPool(items, 4, async (item) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return item * 2;
  });
  assert.deepEqual(results, items.map((i) => i * 2));
  assert.ok(maxActive <= 4, `concurrency exceeded: ${maxActive}`);
  assert.ok(maxActive >= 2, 'expected some parallelism');
});

test('mapPool tolerates an empty input list', async () => {
  assert.deepEqual(await mapPool([], 4, async () => 1), []);
});
