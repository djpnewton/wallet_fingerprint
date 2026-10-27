import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLive, type LiveSocket } from '../src/live.ts';
import { silentLogger } from '../src/log.ts';
import { Pipeline } from '../src/pipeline.ts';
import type { SocketHandlers } from '../src/mempool.ts';
import {
  TIP,
  analyzed,
  coreLikeTx,
  hex32,
  profilesForTests,
  stubClient,
  tempDb,
  waitFor,
} from './helpers.ts';
import type { MempoolTx } from '../src/types.ts';

function setupLive(txs: Record<string, MempoolTx>, extra: Parameters<typeof stubClient>[0] = {}) {
  const client = stubClient({ txs, ...extra });
  const db = tempDb('wf-live');
  const pipeline = new Pipeline({
    client,
    db,
    profiles: profilesForTests(),
    logger: silentLogger,
    concurrency: 3,
  });
  return { client, db, pipeline };
}

function bindableSocket(script: (handlers: SocketHandlers) => Promise<void> | void): LiveSocket & {
  bind: (handlers: SocketHandlers) => void;
} {
  const state: { handlers: SocketHandlers | null } = { handlers: null };
  const live = {
    async run(signal: AbortSignal): Promise<void> {
      const handlers = state.handlers;
      if (!handlers) throw new Error('handlers not installed');
      handlers.onStatus?.('open');
      await script(handlers);
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
    stop(): void {},
    bind(handlers: SocketHandlers) {
      state.handlers = handlers;
    },
  };
  return live;
}

test('live ingest fetches and classifies announced transactions', async () => {
  const a = coreLikeTx({ txid: hex32(0x21) });
  const b = coreLikeTx({ txid: hex32(0x22) });
  const { db, pipeline, client } = setupLive(
    { [a.txid]: a, [b.txid]: b },
    { mempoolTxids: () => [] },
  );

  const live = bindableSocket((handlers) => {
    handlers.onTransactions?.([a.txid, b.txid]);
  });

  const stats = await runLive(pipeline, {
    durationSeconds: 0.4,
    reconcileSeconds: 3600,
    gapFillLimit: 0,
    createSocket: (handlers) => {
      live.bind(handlers);
      return live;
    },
  });

  assert.equal(stats.stored, 2);
  assert.equal(stats.unknown, 0);
  assert.equal(db.countTxs(), 2);
  assert.equal(client.calls.tx, 2);
  assert.equal(db.hasTx(a.txid), true);
  assert.equal(db.hasTx(b.txid), true);
  db.close();
});

test('live ingest suppresses duplicate announcements', async () => {
  const a = coreLikeTx({ txid: hex32(0x23) });
  const { db, pipeline, client } = setupLive({ [a.txid]: a }, { mempoolTxids: () => [] });

  const live = bindableSocket((handlers) => {
    handlers.onTransactions?.([a.txid, a.txid, a.txid]);
  });

  await runLive(pipeline, {
    durationSeconds: 0.3,
    reconcileSeconds: 3600,
    gapFillLimit: 0,
    createSocket: (handlers) => {
      live.bind(handlers);
      return live;
    },
  });

  assert.equal(client.calls.tx, 1, 'duplicate announcements must not refetch');
  assert.equal(db.countTxs(), 1);
  db.close();
});

test('a new block marks tracked mempool transactions confirmed', async () => {
  const a = coreLikeTx({ txid: hex32(0x24) });
  const blockHash = 'cd'.repeat(32);
  const { db, pipeline } = setupLive(
    { [a.txid]: a },
    { mempoolTxids: () => [], blockTxids: { [blockHash]: [a.txid, 'ee'.repeat(32)] } },
  );

  const live = bindableSocket(async (handlers) => {
    handlers.onTransactions?.([a.txid]);
    await waitFor(() => db.hasTx(a.txid), 'transaction stored');
    handlers.onBlocks?.([{ id: blockHash, height: TIP + 1, timestamp: 1_700_000_500, tx_count: 2 }]);
  });

  const stats = await runLive(pipeline, {
    durationSeconds: 0.6,
    reconcileSeconds: 3600,
    gapFillLimit: 0,
    createSocket: (handlers) => {
      live.bind(handlers);
      return live;
    },
  });

  await waitFor(() => db.summary().confirmed === 1, 'transaction confirmed');
  assert.equal(stats.blocks, 1);
  assert.equal(stats.confirmed, 1);
  const row = db.db
    .prepare('SELECT status, block_height FROM transactions WHERE txid = ?')
    .get(a.txid) as { status: string; block_height: number };
  assert.equal(row.status, 'confirmed');
  assert.equal(row.block_height, TIP + 1);
  assert.equal(db.tipHeight(), TIP + 1);
  db.close();
});

test('reconcile queues transactions the socket never announced', async () => {
  const a = coreLikeTx({ txid: hex32(0x25) });
  const b = coreLikeTx({ txid: hex32(0x26) });
  const c = coreLikeTx({ txid: hex32(0x27) });
  const txs = { [a.txid]: a, [b.txid]: b, [c.txid]: c };
  const { db, pipeline } = setupLive(txs, { mempoolTxids: () => [a.txid, b.txid, c.txid] });

  const live = bindableSocket(() => {
    /* the socket announces nothing */
  });

  const stats = await runLive(pipeline, {
    durationSeconds: 0.8,
    reconcileSeconds: 3600,
    gapFillLimit: 10,
    initialReconcileDelayMs: 0,
    createSocket: (handlers) => {
      live.bind(handlers);
      return live;
    },
  });

  await waitFor(() => db.countTxs() === 3, 'gap fill stored all transactions');
  assert.equal(stats.stored, 3);
  db.close();
});

test('reconcile marks vanished transactions dropped', async () => {
  const a = coreLikeTx({ txid: hex32(0x28) });
  const { db, pipeline } = setupLive({ [a.txid]: a }, { mempoolTxids: () => [] });
  db.saveAnalysis(analyzed(a), { raw: null });

  const live = bindableSocket(() => {
    /* nothing to announce */
  });

  await runLive(pipeline, {
    durationSeconds: 0.6,
    reconcileSeconds: 3600,
    gapFillLimit: 0,
    initialReconcileDelayMs: 0,
    createSocket: (handlers) => {
      live.bind(handlers);
      return live;
    },
  });

  await waitFor(() => {
    const row = db.db.prepare('SELECT status FROM transactions WHERE txid = ?').get(a.txid) as
      | { status: string }
      | undefined;
    return row?.status === 'dropped';
  }, 'transaction dropped');
  db.close();
});

test('an external abort stops the live run', async () => {
  const { db, pipeline } = setupLive({}, { mempoolTxids: () => [] });
  const controller = new AbortController();
  const live = bindableSocket(() => {
    setTimeout(() => controller.abort(), 50);
  });

  const started = Date.now();
  const stats = await runLive(pipeline, {
    durationSeconds: 0,
    reconcileSeconds: 3600,
    gapFillLimit: 0,
    signal: controller.signal,
    createSocket: (handlers) => {
      live.bind(handlers);
      return live;
    },
  });

  assert.ok(Date.now() - started < 4000);
  assert.equal(stats.stored, 0);
  db.close();
});

test('shutdown abandons the queued backlog instead of draining it', async () => {
  // 200 announced transactions with a 100 ms fetch at concurrency 4: draining
  // the backlog would take ~5 s. A correct shutdown discards it instead.
  const txs: Record<string, MempoolTx> = {};
  for (let i = 0; i < 200; i++) {
    const txid = hex32(0x90 + i);
    txs[txid] = coreLikeTx({ txid });
  }
  const client = stubClient({ txs, delayMs: 100, mempoolTxids: () => [] });
  const db = tempDb('wf-live-shutdown');
  const pipeline = new Pipeline({
    client,
    db,
    profiles: profilesForTests(),
    logger: silentLogger,
    concurrency: 4,
  });

  const controller = new AbortController();
  const live = bindableSocket((handlers) => {
    handlers.onTransactions?.(Object.keys(txs));
    setTimeout(() => controller.abort(), 200);
  });

  const started = Date.now();
  const stats = await runLive(pipeline, {
    durationSeconds: 0,
    reconcileSeconds: 0,
    gapFillLimit: 0,
    signal: controller.signal,
    createSocket: (handlers) => {
      live.bind(handlers);
      return live;
    },
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2000, `shutdown must not drain the backlog, took ${elapsed}ms`);
  assert.ok(stats.queued > 50, 'the queue should have held a substantial backlog');
  assert.ok(stats.stored < stats.queued, 'queued work must be abandoned, not completed');
  db.close();
});
