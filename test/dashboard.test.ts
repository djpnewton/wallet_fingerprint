import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../src/dashboard/server.ts';
import { silentLogger } from '../src/log.ts';
import {
  analyzed,
  categoriesForTests,
  coreLikeTx,
  hex32,
  makeTx,
  profilesForTests,
  tempDb,
} from './helpers.ts';

function seed() {
  const db = tempDb('wf-dashboard');
  const known = analyzed(coreLikeTx({ txid: hex32(0x60) }));
  db.saveAnalysis(known, { raw: null });
  const unknown = analyzed(
    makeTx({
      txid: hex32(0x61),
      version: 2,
      locktime: 700_000,
      inputs: [{ value: 500_000, type: 'v0_p2wpkh', sequence: 0xffffffff }],
      outputs: [{ value: 490_001, type: 'v0_p2wsh' }],
    }),
  );
  db.saveAnalysis(unknown, { raw: null });
  return { db, knownTxid: known.tx.txid, unknownTxid: unknown.tx.txid };
}

async function withDashboard<T>(
  fn: (base: string, ctx: ReturnType<typeof seed>) => Promise<T>,
): Promise<T> {
  const ctx = seed();
  const dashboard = await startDashboard({
    db: ctx.db,
    profiles: profilesForTests(),
    categories: categoriesForTests(),
    port: 0,
    logger: silentLogger,
    runtime: () => ({ requests: 42, rateLimitHits: 1 }),
  });
  try {
    return await fn(`http://127.0.0.1:${dashboard.port}`, ctx);
  } finally {
    await dashboard.close();
    ctx.db.close();
  }
}

test('the dashboard serves the page and stats payload', async () => {
  await withDashboard(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Mempool <span>wallet fingerprints<\/span>/);
    // The page renders from a transport, which the static web build replaces.
    assert.match(html, /window\.__wfTransport \?\?/);
    assert.match(html, /new EventSource\(`\/api\/stream\$\{excludeSpam \? '\?exclude_spam=1' : ''\}`\)/);
    assert.match(html, /id="hideSpam"/);
    // The panel is fingerprint-centric: wallets are a candidate set, not a ranking.
    assert.match(html, /id="fingerprints"/);
    assert.match(html, /function renderFingerprints/);
    assert.match(html, /function renderProtocolTraffic/);
    // Two tabs: an exclusive wallet taxonomy and the multi-membership fingerprints.
    assert.match(html, /data-tab="wallets"/);
    assert.match(html, /data-tab="fingerprints"/);
    assert.match(html, /id="panel-wallets"/);
    assert.match(html, /function renderCategories/);
    // The tab icon is served next to the page, never fetched from a CDN.
    assert.match(html, /<link rel="icon" href="\.\/favicon\.svg" type="image\/svg\+xml"/);
    const favicon = await fetch(`${base}/favicon.svg`);
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get('content-type') ?? '', /^image\/svg\+xml/);
    assert.match(await favicon.text(), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);

    const stats = await fetch(`${base}/api/stats`);
    assert.equal(stats.status, 200);
    const payload = (await stats.json()) as {
      type: string;
      data: {
        summary: { total: number; unknown: number };
        recent: unknown[];
        fingerprints: Array<{ id: string; txs: number; prevalence: number; wallets: unknown[] }>;
        categories: Array<{ id: string; title: string; txs: number; wallets: unknown[] }>;
      };
      runtime: { requests: number };
    };
    assert.equal(payload.type, 'stats');
    assert.equal(payload.data.summary.total, 2);
    assert.equal(payload.data.summary.unknown, 1);

    assert.ok(payload.data.fingerprints.length > 0, 'the payload carries fingerprint rows');
    const fp = payload.data.fingerprints[0];
    assert.ok(fp, 'expected at least one fingerprint row');
    assert.equal(typeof fp.id, 'string');
    assert.equal(typeof fp.txs, 'number');
    assert.ok(fp.prevalence >= 0 && fp.prevalence <= 1);
    assert.ok(Array.isArray(fp.wallets));

    const cats = payload.data.categories;
    assert.ok(cats.length > 0, 'the payload carries wallet categories');
    const catSum = cats.reduce((n, c) => n + c.txs, 0);
    assert.equal(catSum, payload.data.summary.total, 'categories must partition the corpus');
    assert.equal(payload.data.recent.length, 2);
    assert.equal(payload.runtime.requests, 42);
  });
});

test('the transaction endpoint returns an explanation and validates input', async () => {
  await withDashboard(async (base, ctx) => {
    const ok = await fetch(`${base}/api/tx/${ctx.knownTxid}`);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { wallets: Array<{ name: string }>; features: { version: number } };
    assert.equal(body.features.version, 2);
    assert.equal(body.wallets[0]?.name, 'Bitcoin Core');

    const upper = await fetch(`${base}/api/tx/${ctx.knownTxid.toUpperCase()}`);
    assert.equal(upper.status, 200);

    assert.equal((await fetch(`${base}/api/tx/nothex`)).status, 400);
    assert.equal((await fetch(`${base}/api/tx/${'ab'.repeat(32)}`)).status, 404);
  });
});

test('list, fingerprints and research endpoints are wired', async () => {
  await withDashboard(async (base) => {
    const unknownOnly = await fetch(`${base}/api/transactions?unknown=1`);
    const unknownBody = (await unknownOnly.json()) as { transactions: Array<{ txid: string; is_unknown: boolean }> };
    assert.equal(unknownBody.transactions.length, 1);
    assert.equal(unknownBody.transactions[0]?.is_unknown, true);

    const byWallet = await fetch(`${base}/api/transactions?wallet=Bitcoin%20Core`);
    const walletBody = (await byWallet.json()) as { transactions: unknown[] };
    assert.equal(walletBody.transactions.length, 1);

    const fingerprints = await fetch(`${base}/api/fingerprints`);
    const fp = (await fingerprints.json()) as { profiles: Array<{ id: string; txs: number }> };
    assert.ok(fp.profiles.length >= 20);
    assert.ok(fp.profiles.some((p) => p.id === 'core-rbf-tip-locktime' && p.txs === 1));

    const clusterRes = await fetch(`${base}/api/research/clusters?min=1`);
    const clusterBody = (await clusterRes.json()) as { clusters: Array<{ count: number }> };
    assert.equal(clusterBody.clusters.length, 1);

    const near = await fetch(`${base}/api/research/near-misses`);
    const nearBody = (await near.json()) as { nearMisses: Array<{ profileId: string }> };
    assert.ok(nearBody.nearMisses.length > 0);

    const exportRes = await fetch(`${base}/api/research/unknown.jsonl`);
    assert.equal(exportRes.status, 200);
    assert.match(exportRes.headers.get('content-disposition') ?? '', /unknown-transactions\.jsonl/);
    const lines = (await exportRes.text()).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.ok(JSON.parse(lines[0] as string));
  });
});

test('the SSE stream pushes a stats frame immediately', async () => {
  await withDashboard(async (base) => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/stream`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = res.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('event: stats')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    assert.match(received, /event: stats\ndata: \{"type":"stats"/);
  });
});

test('unknown routes and methods are rejected', async () => {
  await withDashboard(async (base) => {
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/stats`, { method: 'POST' })).status, 405);
  });
});

test('the spam filter applies to stats, transactions and the stream', async () => {
  await withDashboard(async (base, ctx) => {
    // Add a Runes-shaped transaction to the fixture database.
    ctx.db.saveAnalysis(
      analyzed(
        makeTx({
          txid: hex32(0x77),
          outputs: [
            { value: 546, type: 'v0_p2wpkh' },
            { value: 0, type: 'op_return', payload: '6a5d0a010203' },
          ],
        }),
      ),
      { raw: null },
    );

    const all = (await (await fetch(`${base}/api/stats`)).json()) as {
      data: { summary: { total: number; spam: number }; spam: Array<{ kind: string }> };
    };
    assert.equal(all.data.summary.total, 3);
    assert.equal(all.data.summary.spam, 1);
    assert.equal(all.data.spam[0]?.kind, 'runes');

    const clean = (await (await fetch(`${base}/api/stats?exclude_spam=1`)).json()) as {
      data: { summary: { total: number; spam: number } };
    };
    assert.equal(clean.data.summary.total, 2);
    assert.equal(clean.data.summary.spam, 1, 'the hidden count stays visible');

    const allTx = (await (await fetch(`${base}/api/transactions`)).json()) as {
      transactions: Array<{ txid: string; spam_kind: string | null }>;
    };
    assert.equal(allTx.transactions.length, 3);
    const spamRow = allTx.transactions.find((t) => t.txid === hex32(0x77));
    assert.equal(spamRow?.spam_kind, 'runes');

    const cleanTx = (await (await fetch(`${base}/api/transactions?exclude_spam=1`)).json()) as {
      transactions: Array<{ txid: string }>;
    };
    assert.equal(cleanTx.transactions.length, 2);
    assert.equal(cleanTx.transactions.some((t) => t.txid === hex32(0x77)), false);

    // The stream honours the flag on its own URL.
    const controller = new AbortController();
    const res = await fetch(`${base}/api/stream?exclude_spam=1`, { signal: controller.signal });
    const reader = res.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('event: stats')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    const payload = JSON.parse(
      received.slice(received.indexOf('data: ') + 6, received.indexOf('\n\n')),
    ) as { data: { summary: { total: number } } };
    assert.equal(payload.data.summary.total, 2);
  });
});
