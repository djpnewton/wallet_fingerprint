import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzed, coreLikeTx, hex32, makeTx, profilesForTests, tempDb } from './helpers.ts';
import { clusters, explain, exportUnknown, nearMissReport } from '../src/research.ts';

function seed() {
  const db = tempDb('wf-research');
  const oddShape = {
    version: 2,
    locktime: 700_000,
    inputs: [{ value: 500_000, type: 'v0_p2wpkh', sequence: 0xffffffff }],
    outputs: [{ value: 490_001, type: 'v0_p2wsh' }],
  };
  const unknownTxids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const tx = makeTx({ ...oddShape, txid: hex32(0x40 + i) });
    const classified = analyzed(tx);
    assert.equal(classified.classification.isUnknown, true);
    db.saveAnalysis(classified, { raw: tx });
    unknownTxids.push(tx.txid);
  }
  const known = analyzed(coreLikeTx({ txid: hex32(0x50) }));
  db.saveAnalysis(known, { raw: null });
  return { db, unknownTxids, knownTxid: known.tx.txid };
}

test('unknown clusters group the research pool by signature', () => {
  const { db } = seed();
  const rows = clusters(db, 10, 2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.count, 3);
  assert.equal(rows[0]?.examples.length, 3);
  assert.ok(rows[0]?.signature.includes('out:v0_p2wsh'));
  db.close();
});

test('near misses report which conditions block a rule', () => {
  const { db } = seed();
  const rows = nearMissReport(db, profilesForTests(), { top: 5 });
  assert.ok(rows.length > 0);
  const blocker = rows.find((r) => r.profileId === 'v2-locktime0-final');
  assert.ok(blocker, 'expected v2-locktime0-final to be a near miss');
  assert.equal(blocker.txs, 3);
  assert.ok(blocker.avgRatio > 0.5 && blocker.avgRatio < 1);
  assert.ok(blocker.failed.some((f) => f.condition.startsWith('locktime_class')));
  assert.ok(blocker.failed.every((f) => f.count > 0));
  db.close();
});

test('the unknown pool exports as structured JSON rows', () => {
  const { db, unknownTxids } = seed();
  const rows = exportUnknown(db, { limit: 10 });
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.txid).sort(),
    [...unknownTxids].sort(),
  );
  const first = rows[0];
  assert.ok(first);
  assert.equal(first.features.version, 2);
  assert.equal(first.features.locktime_class, 'block_height');
  assert.ok(Array.isArray(first.labels));
  db.close();
});

test('explain returns features, tags and IO detail', () => {
  const { db, knownTxid, unknownTxids } = seed();
  const known = explain(db, knownTxid, profilesForTests());
  assert.ok(known);
  assert.equal(known.status, 'mempool');
  assert.equal(known.features.version, 2);
  assert.ok(known.wallets.length >= 5);
  assert.ok(known.wallets[0]?.name === 'Bitcoin Core');
  assert.equal(known.inputs.length, 1);
  assert.equal(known.outputs.length, 2);
  assert.ok(known.profiles.length > 0);
  assert.ok(known.profiles.every((p) => p.confidence > 0 && p.title.length > 0));

  const unknown = explain(db, unknownTxids[0] as string, profilesForTests());
  assert.ok(unknown);
  assert.equal(unknown.wallets.length, 0);
  assert.ok(unknown.nearMisses.length > 0);

  assert.equal(explain(db, hex32(0xff), profilesForTests()), null);
  db.close();
});

test('explain is case insensitive on the txid', () => {
  const { db, knownTxid } = seed();
  const upper = explain(db, knownTxid.toUpperCase(), profilesForTests());
  assert.ok(upper);
  assert.equal(upper.txid, knownTxid);
  db.close();
});
