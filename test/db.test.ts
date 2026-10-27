import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.ts';
import { buildStats } from '../src/report.ts';
import { rulesFingerprint, withBaseRates } from '../src/fingerprints.ts';
import {
  SEQ_RBF,
  analyzed,
  categoriesForTests,
  coinjoinTx,
  coreLikeTx,
  hex32,
  makeTx,
  profilesForTests,
} from './helpers.ts';

const HOLD_LOCK = join(dirname(dirname(fileURLToPath(import.meta.url))), 'test', 'scripts', 'hold-lock.ts');

function tempDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'wf-db-'));
  return new Db(join(dir, 'test.sqlite'));
}

test('a fresh database has the schema and empty stats', () => {
  const db = tempDb();
  assert.equal(db.countTxs(), 0);
  assert.equal(db.tipHeight(), null);
  const summary = db.summary();
  assert.equal(summary.total, 0);
  assert.equal(summary.unknown, 0);
  assert.equal(db.getMeta('anything'), null);
  db.setMeta('k', 'v');
  assert.equal(db.getMeta('k'), 'v');
  db.close();
});

test('saving an analysis persists the row, tags, and IO detail', () => {
  const db = tempDb();
  const classified = analyzed(coreLikeTx());
  db.saveAnalysis(classified, { raw: coreLikeTx() });

  assert.equal(db.countTxs(), 1);
  assert.equal(db.hasTx(classified.tx.txid), true);

  const summary = db.summary();
  assert.equal(summary.total, 1);
  assert.equal(summary.unknown, 0);
  assert.equal(summary.tagged, classified.classification.wallets.length);

  const wallets = db.walletCounts();
  assert.ok(wallets.length >= 5);
  assert.equal(wallets[0]?.wallet, 'Bitcoin Core');

  const labels = db.labelCounts();
  assert.ok(labels.some((l) => l.label === 'behavior:rbf'));

  const profiles = db.profileCounts();
  assert.ok(profiles.some((p) => p.profileId === 'core-rbf-tip-locktime'));

  const inputs = db.db.prepare('SELECT * FROM tx_inputs WHERE txid = ?').all(classified.tx.txid);
  const outputs = db.db.prepare('SELECT * FROM tx_outputs WHERE txid = ?').all(classified.tx.txid);
  assert.equal(inputs.length, 1);
  assert.equal(outputs.length, 2);

  const features = db.getFeatures(classified.tx.txid);
  assert.equal(features?.version, 2);
  assert.notEqual(db.getRaw(classified.tx.txid), null);
  db.close();
});

test('re-saving is idempotent and preserves first_seen_at', () => {
  const db = tempDb();
  const classified = analyzed(coreLikeTx());
  db.saveAnalysis(classified, { raw: null });
  const firstSeen = classified.features.first_seen_at;

  const again = analyzed(coreLikeTx());
  db.saveAnalysis(again, { raw: null, now: firstSeen + 500 });

  const row = db.db
    .prepare('SELECT first_seen_at, last_seen_at, wallet_count FROM transactions WHERE txid = ?')
    .get(classified.tx.txid) as { first_seen_at: number; last_seen_at: number; wallet_count: number };
  assert.equal(row.first_seen_at, firstSeen);
  assert.equal(row.last_seen_at, firstSeen + 500);
  assert.equal(row.wallet_count, classified.classification.wallets.length);
  assert.equal(db.countTxs(), 1);

  // Re-saving must not duplicate tag rows.
  const tagCount = db.db
    .prepare('SELECT COUNT(*) AS n FROM tx_wallets WHERE txid = ?')
    .get(classified.tx.txid) as { n: number };
  assert.equal(tagCount.n, classified.classification.wallets.length);
  db.close();
});

test('unknown transactions are stored and clustered by signature', () => {
  const db = tempDb();
  const odd = makeTx({
    txid: hex32(0x71),
    version: 2,
    locktime: 700_000,
    inputs: [{ value: 500_000, type: 'v0_p2wpkh', sequence: 0xffffffff }],
    outputs: [{ value: 490_001, type: 'v0_p2wsh' }],
  });
  const odd2 = { ...odd, txid: hex32(0x72) };

  for (const tx of [odd, odd2]) {
    const classified = analyzed(tx);
    assert.equal(classified.classification.isUnknown, true);
    db.saveAnalysis(classified, { raw: tx });
  }

  assert.equal(db.unknownCount(), 2);
  const clusters = db.unknownClusters(10, 2);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]?.count, 2);
  assert.equal(clusters[0]?.examples.length, 2);
  assert.ok((clusters[0]?.signature ?? '').includes('lt:block_height'));

  // minCount filters singleton clusters out.
  assert.equal(db.unknownClusters(10, 3).length, 0);

  const recent = db.listTransactions({ onlyUnknown: true });
  assert.equal(recent.length, 2);
  assert.equal(recent[0]?.is_unknown, 1);
  db.close();
});

test('lists can be filtered by wallet, label and status', () => {
  const db = tempDb();
  const core = analyzed(coreLikeTx());
  const cj = analyzed(coinjoinTx({ txid: hex32(0x55) }));
  db.saveAnalysis(core, { raw: null });
  db.saveAnalysis(cj, { raw: null });

  const byWallet = db.listTransactions({ wallet: 'Samourai Whirlpool' });
  assert.equal(byWallet.length, 1);
  assert.equal(byWallet[0]?.txid, cj.tx.txid);

  const byLabel = db.listTransactions({ label: 'type:coinjoin' });
  assert.equal(byLabel.length, 1);

  const byStatus = db.listTransactions({ status: 'confirmed' });
  assert.equal(byStatus.length, 0);

  const limited = db.listTransactions({ limit: 1 });
  assert.equal(limited.length, 1);
  db.close();
});

test('confirmations and drops are recorded', () => {
  const db = tempDb();
  const tx = analyzed(coreLikeTx());
  db.saveAnalysis(tx, { raw: null });
  const txid = tx.tx.txid;

  const changed = db.markConfirmed(1234, 'ab'.repeat(32), 1_700_000_100, [txid, 'ff'.repeat(32)]);
  assert.equal(changed, 1);
  const confirmedRow = db.db
    .prepare('SELECT status, block_height, block_hash FROM transactions WHERE txid = ?')
    .get(txid) as { status: string; block_height: number; block_hash: string };
  assert.equal(confirmedRow.status, 'confirmed');
  assert.equal(confirmedRow.block_height, 1234);
  assert.equal(confirmedRow.block_hash, 'ab'.repeat(32));

  // Confirming twice is a no-op.
  assert.equal(db.markConfirmed(1234, 'ab'.repeat(32), 1_700_000_100, [txid]), 0);

  // Dropped only applies to mempool rows.
  assert.equal(db.markDropped([txid]), 0);

  const second = analyzed(coreLikeTx({ txid: hex32(0x99) }));
  db.saveAnalysis(second, { raw: null });
  assert.equal(db.markDropped([second.tx.txid]), 1);
  const droppedRow = db.db
    .prepare('SELECT status FROM transactions WHERE txid = ?')
    .get(second.tx.txid) as { status: string };
  assert.equal(droppedRow.status, 'dropped');

  db.saveBlock(1234, 'ab'.repeat(32), 1_700_000_100, 3000);
  assert.equal(db.tipHeight(), 1234);
  db.close();
});

test('reclassifiable rows are yielded in batches', () => {
  const db = tempDb();
  for (let i = 0; i < 5; i++) {
    const tx = coreLikeTx({ txid: hex32(0xa0 + i) });
    db.saveAnalysis(analyzed(tx), { raw: tx });
  }
  const noRaw = coreLikeTx({ txid: hex32(0xbb) });
  db.saveAnalysis(analyzed(noRaw), { raw: null });

  let count = 0;
  for (const batch of db.iterReclassifiable(2)) {
    count += batch.length;
    assert.ok(batch.length <= 2);
  }
  assert.equal(count, 5, 'only rows with a raw payload are re-classifiable');
  db.close();
});

test('the stats report aggregates every surface', () => {
  const db = tempDb();
  db.saveAnalysis(analyzed(coreLikeTx()), { raw: null });
  db.saveAnalysis(analyzed(coinjoinTx({ txid: hex32(0x66) })), { raw: null });

  const report = buildStats(
    db,
    rulesFingerprint(profilesForTests()),
    profilesForTests(),
    categoriesForTests(),
    { recentLimit: 5 },
  );
  assert.equal(report.summary.total, 2);
  assert.ok(report.fingerprints.length > 0);
  assert.ok(report.labels.length > 0);
  assert.ok(report.profiles.length > 0);
  assert.equal(report.recent.length, 2);
  assert.ok((report.recent[0]?.wallets.length ?? 0) > 0);
  db.close();
});

test('profile base rates are measured from stored matches', () => {
  const db = tempDb();
  for (let i = 0; i < 4; i++) {
    db.saveAnalysis(analyzed(coreLikeTx({ txid: hex32(0xc0 + i) })), { raw: null });
  }
  db.saveAnalysis(
    analyzed(
      makeTx({
        txid: hex32(0xd0),
        version: 2,
        locktime: 700_000,
        inputs: [{ value: 500_000, type: 'v0_p2wpkh', sequence: 0xffffffff }],
        outputs: [{ value: 490_001, type: 'v0_p2wsh' }],
      }),
    ),
    { raw: null },
  );

  const { counts, total } = db.profileBaseRates();
  assert.equal(total, 5);
  assert.equal(counts.get('core-rbf-tip-locktime'), 4);
  assert.equal(counts.get('multisig-2of2-p2wsh'), undefined);

  // Applying them makes the common core profile less informative than a rare one.
  const measured = withBaseRates(profilesForTests(), counts, total);
  const core = measured.find((p) => p.id === 'core-rbf-tip-locktime');
  const rare = measured.find((p) => p.id === 'omni-usdt');
  assert.ok(core && rare);
  assert.ok((core.baseRate ?? 0) > 0.5);
  assert.ok(core.specificity < rare.specificity);
  db.close();
});

test('rows classified by a different rule set are reported as stale', () => {
  const db = tempDb();
  const fp = rulesFingerprint(profilesForTests());
  const tx = analyzed(coreLikeTx());
  db.saveAnalysis(tx, { raw: null, rulesFingerprint: fp });

  assert.equal(db.staleCount(fp), 0);
  assert.equal(db.summary(fp).stale, 0);

  // A different rule set makes the stored row stale.
  assert.equal(db.staleCount('deadbeefdeadbeef'), 1);
  assert.equal(db.summary('deadbeefdeadbeef').stale, 1);

  // Rows written without a stamp (pre-v3) are stale by definition.
  const legacy = analyzed(coreLikeTx({ txid: hex32(0xee) }));
  db.saveAnalysis(legacy, { raw: null });
  assert.equal(db.summary(fp).stale, 1);
  assert.equal(db.summary(fp).total, 2);

  // No fingerprint (fresh install) reports nothing rather than everything.
  assert.equal(db.summary(null).stale, 0);
  db.close();
});

test('the summary separates confident attribution from any-tag', () => {
  const db = tempDb();
  db.saveAnalysis(analyzed(coreLikeTx()), { raw: null });
  // A shape that only matches broad buckets: tagged, but not attributable.
  db.saveAnalysis(
    analyzed(
      makeTx({
        txid: hex32(0xf0),
        version: 2,
        locktime: 0,
        inputs: [{ value: 500_000, type: 'v0_p2wpkh', sequence: 0x7d }],
        outputs: [
          { value: 400_000, type: 'v0_p2wpkh' },
          { value: 99_000, type: 'v0_p2wpkh', address: 'bc1qin-reuse' },
        ],
      }),
    ),
    { raw: null },
  );

  const s = db.summary(null);
  assert.equal(s.total, 2);
  assert.equal(s.attributed + s.weak + s.unknown, s.total ?? 0, 'categories must partition the corpus');
  assert.ok((s.attributed ?? 0) >= 1, 'the core-like spend is a confident attribution');
  assert.ok((s.tagged ?? 0) >= (s.attributed ?? 0));
  db.close();
});

// --------------------------------------------------------- spam & wallet ranking

function seedSpam(db: Db): void {
  // Ordinary spend.
  db.saveAnalysis(analyzed(coreLikeTx({ txid: hex32(0xa1) })), { raw: null });
  // Runes mint: data carrier, no wallet signal.
  db.saveAnalysis(
    analyzed(
      makeTx({
        txid: hex32(0xa2),
        outputs: [
          { value: 546, type: 'v0_p2wpkh' },
          { value: 0, type: 'op_return', payload: '6a5d0a010203' },
        ],
      }),
    ),
    { raw: null },
  );
}

test('spam is tagged and can be excluded from every statistic', () => {
  const db = tempDb();
  seedSpam(db);

  const all = db.summary(null);
  assert.equal(all.total, 2);
  assert.equal(all.spam, 1);

  const clean = db.summary(null, { excludeSpam: true });
  assert.equal(clean.total, 1);
  assert.equal(clean.spam, 1, 'the spam count itself is reported regardless of the filter');

  const breakdown = db.spamBreakdown();
  assert.deepEqual(breakdown, [{ kind: 'runes', txs: 1 }]);

  assert.equal(db.listTransactions({}).length, 2);
  assert.equal(db.listTransactions({ excludeSpam: true }).length, 1);
  assert.equal(db.listTransactions({ onlySpam: true }).length, 1);

  const walletTxAll = db.walletCounts(10);
  const walletTxClean = db.walletCounts(10, { excludeSpam: true });
  const totalAll = walletTxAll.reduce((n, w) => n + w.txs, 0);
  const totalClean = walletTxClean.reduce((n, w) => n + w.txs, 0);
  assert.ok(totalClean < totalAll, 'spam must not contribute wallet tags when excluded');
  db.close();
});

test('wallet counts separate confidence, best-pick and evidence, and order by confident count', () => {
  const db = tempDb();
  // Twelve transactions that only match a broad locktime-zero bucket.
  for (let i = 0; i < 12; i++) {
    db.saveAnalysis(
      analyzed(
        makeTx({
          txid: hex32(0x60 + i),
          version: 2,
          locktime: 0,
          inputs: [{ value: 500_000, type: 'v0_p2wpkh', sequence: SEQ_RBF }],
          outputs: [{ value: 490_000, type: 'v0_p2wpkh' }],
        }),
      ),
      { raw: null },
    );
  }
  // One transaction with a specific, high-confidence signature.
  db.saveAnalysis(analyzed(coreLikeTx({ txid: hex32(0xb1) })), { raw: null });

  const wallets = db.walletCounts(20);
  const core = wallets.find((w) => w.wallet === 'Bitcoin Core');
  const generic = wallets.find((w) => w.wallet.startsWith('generic modern segwit'));
  assert.ok(core, 'expected Bitcoin Core among the candidates');
  assert.ok(generic, 'expected the broad descriptor to be present');

  // `confident` counts only attributions at or above the threshold.
  assert.ok(core.confident >= 1);
  assert.equal(generic.confident, 0);
  assert.ok(core.maxConfidence > 0.7);
  assert.ok(generic.maxConfidence < 0.35);

  // Best-pick counts transactions where the wallet was the strongest candidate,
  // and the list is ordered by it (the number the dashboard draws the bar from).
  assert.ok(core.topPick >= 1);
  assert.equal(generic.topPick, 0, 'a descriptor with no confident hit is never a best pick');
  assert.ok(core.evidence > 0 && generic.evidence > 0);
  for (let i = 1; i < wallets.length; i++) {
    assert.ok(
      (wallets[i - 1]?.confident ?? 0) >= (wallets[i]?.confident ?? 0),
      'walletCounts must be ordered by confident attributions',
    );
  }
  db.close();
});

test('a second writer waits for the lock instead of crashing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-lock-'));
  const dbPath = join(dir, 'shared.sqlite');
  // Create the schema first so the holder does not race the parent's init.
  const warm = new Db(dbPath);
  warm.close();

  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HOLD_LOCK, dbPath, '900'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childErrors: string[] = [];
  child.stderr?.on('data', (chunk) => childErrors.push(String(chunk)));

  // Wait until the child actually holds the write lock.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child never acquired the lock')), 5000);
    child.stdout?.on('data', (chunk) => {
      if (String(chunk).includes('locked')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const started = Date.now();
  const db = new Db(dbPath);
  // Before the busy timeout this threw ERR_SQLITE_ERROR "database is locked".
  db.setMeta('probe', 'value');
  const elapsed = Date.now() - started;

  assert.equal(db.getMeta('probe'), 'value');
  assert.ok(elapsed > 200, `expected to wait for the writer, returned in ${elapsed}ms`);
  assert.deepEqual(childErrors, []);

  db.close();
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
});

test('categories partition the corpus exactly', () => {
  const db = tempDb();
  db.saveAnalysis(analyzed(coreLikeTx({ txid: hex32(0xa1) })), { raw: null });
  db.saveAnalysis(analyzed(coinjoinTx({ txid: hex32(0xa2) })), { raw: null });
  db.saveAnalysis(
    analyzed(
      makeTx({
        txid: hex32(0xa3),
        version: 2,
        locktime: 700_000,
        inputs: [{ value: 500_000, type: 'v0_p2wpkh', sequence: 0xffffffff }],
        outputs: [{ value: 490_001, type: 'v0_p2wsh' }],
      }),
    ),
    { raw: null },
  );

  const counts = db.categoryCounts();
  const sum = [...counts.values()].reduce((a, b) => a + b, 0);
  assert.equal(sum, db.countTxs(), 'every transaction must be in exactly one category');
  assert.equal(counts.get('core-style'), 1);
  assert.equal(counts.get('coinjoin'), 1);
  assert.equal(counts.get('unclassified'), 1);

  // The category is stored, filterable, and surfaces on the row.
  const core = db.listTransactions({ category: 'core-style' });
  assert.equal(core.length, 1);
  assert.equal(core[0]?.category_id, 'core-style');

  const all = db.listTransactions({});
  assert.equal(all.length, 3);
  assert.ok(all.every((row) => row.category_id !== null));
  db.close();
});
