import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBackfill } from '../src/backfill.ts';
import { silentLogger } from '../src/log.ts';
import { Pipeline } from '../src/pipeline.ts';
import { profilesForTests, coreLikeTx, hex32, stubClient, tempDb } from './helpers.ts';
import type { MempoolTx } from '../src/types.ts';

function setup(txs: Record<string, MempoolTx>) {
  const client = stubClient({ txs });
  const db = tempDb('wf-backfill');
  const pipeline = new Pipeline({
    client,
    db,
    profiles: profilesForTests(),
    logger: silentLogger,
    concurrency: 3,
  });
  return { client, db, pipeline };
}

function txSet(count: number, start = 0x10): Record<string, MempoolTx> {
  const txs: Record<string, MempoolTx> = {};
  for (let i = 0; i < count; i++) {
    const txid = hex32(start + i);
    txs[txid] = coreLikeTx({ txid });
  }
  return txs;
}

test('backfill stores every pending transaction', async () => {
  const txs = txSet(5);
  const { db, pipeline } = setup(txs);
  const result = await runBackfill(pipeline, { limit: 0, sample: 0 });

  assert.equal(result.candidates, 5);
  assert.equal(result.stored, 5);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 0);
  assert.equal(db.countTxs(), 5);
  assert.equal(result.aborted, false);
  db.close();
});

test('backfill skips transactions that are already stored', async () => {
  const txs = txSet(4);
  const { db, pipeline } = setup(txs);
  await runBackfill(pipeline, { limit: 0, sample: 0 });
  const second = await runBackfill(pipeline, { limit: 0, sample: 0 });

  assert.equal(second.skipped, 4);
  assert.equal(second.candidates, 0);
  assert.equal(second.stored, 0);
  assert.equal(db.countTxs(), 4);
  db.close();
});

test('backfill honours the limit', async () => {
  const txs = txSet(10);
  const { db, pipeline } = setup(txs);
  const result = await runBackfill(pipeline, { limit: 3, sample: 0 });
  assert.equal(result.candidates, 3);
  assert.equal(result.stored, 3);
  assert.equal(db.countTxs(), 3);
  db.close();
});

test('backfill samples the mempool evenly instead of taking a prefix', async () => {
  const txs = txSet(20);
  const { db, pipeline } = setup(txs);
  const result = await runBackfill(pipeline, { limit: 0, sample: 4 });
  assert.equal(result.stored, 4);

  const stored = db
    .db
    .prepare('SELECT txid FROM transactions ORDER BY first_seen_at')
    .all() as Array<{ txid: string }>;
  const indexes = stored
    .map((row) => Object.keys(txs).indexOf(row.txid))
    .sort((a, b) => a - b);
  assert.equal(indexes.length, 4);
  assert.ok(indexes[0] === 0, 'first sampled txid should be the first entry');
  assert.ok((indexes.at(-1) ?? 0) >= 10, 'sampling should reach past the first quarter of the list');
  db.close();
});

test('backfill stops promptly when aborted', async () => {
  const txs = txSet(20);
  const { db, pipeline } = setup(txs);
  const controller = new AbortController();
  controller.abort();

  const result = await runBackfill(pipeline, { limit: 0, sample: 0, signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.equal(result.stored, 0);
  assert.equal(db.countTxs(), 0);
  db.close();
});

test('backfill counts transient per-transaction failures without aborting', async () => {
  const txs = txSet(4);
  const failingTxid = hex32(0x11);
  const client = stubClient({ txs, failFor: [failingTxid] });
  const db = tempDb('wf-backfill-fail');
  const pipeline = new Pipeline({
    client,
    db,
    profiles: profilesForTests(),
    logger: silentLogger,
    concurrency: 2,
  });

  const result = await runBackfill(pipeline, { limit: 0, sample: 0 });
  assert.equal(result.stored, 3);
  assert.equal(result.failed, 1);
  assert.equal(db.hasTx(failingTxid), false);
  db.close();
});

test('backfill writes unknowns to the research pool', async () => {
  const odd = coreLikeTx({
    txid: hex32(0x31),
    locktime: 700_000,
    inputs: [{ value: 500_000, type: 'v0_p2wpkh', sequence: 0xffffffff }],
    outputs: [{ value: 490_001, type: 'v0_p2wsh' }],
  });
  const { db, pipeline } = setup({ [odd.txid]: odd });
  const result = await runBackfill(pipeline, { limit: 0, sample: 0 });

  assert.equal(result.stored, 1);
  assert.equal(result.unknown, 1);
  assert.equal(db.unknownCount(), 1);
  db.close();
});

test('raw payloads are skipped when raw storage is disabled', async () => {
  const txs = txSet(1);
  const client = stubClient({ txs });
  const db = tempDb('wf-backfill-raw');
  const pipeline = new Pipeline({
    client,
    db,
    profiles: profilesForTests(),
    logger: silentLogger,
    storeRaw: false,
  });
  await runBackfill(pipeline, { limit: 0, sample: 0 });
  const txid = Object.keys(txs)[0] as string;
  assert.equal(db.getRaw(txid), null);
  assert.notEqual(db.getFeatures(txid), null);
  db.close();
});
