/**
 * The two stores must count identically.
 *
 * `Db` answers in SQL and `MemoryCorpus` answers in JavaScript, so the same
 * corpus has to produce the same report. Without this test the static web build
 * could quietly disagree with the CLI about how many transactions a category
 * holds — exactly the kind of drift that makes a heuristic tool untrustworthy.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildStats } from '../src/report.ts';
import { MemoryCorpus } from '../src/memory.ts';
import { nearMissFromFeatures, nearMissReport } from '../src/research.ts';
import { rulesFingerprint } from '../src/fingerprints.ts';
import {
  analyzed,
  categoriesForTests,
  coinjoinTx,
  coreLikeTx,
  makeTx,
  profilesForTests,
  tempDb,
} from './helpers.ts';
import type { ClassifiedTx } from '../src/types.ts';

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Sorted by key so store-specific tie-breaking cannot fail the comparison. */
function sorted<T extends Record<string, unknown>>(rows: readonly T[], key: keyof T & string): T[] {
  return plain([...rows]).sort((a, b) => String(a[key]).localeCompare(String(b[key])));
}

/** A deliberately mixed corpus: attributed, weak, unknown, and spam. */
function corpus(): ClassifiedTx[] {
  const txs = [
    coreLikeTx({ txid: 'a'.repeat(64) }),
    coreLikeTx({ txid: 'b'.repeat(64), outputs: [{ value: 400_000, type: 'v0_p2wpkh', address: 'bc1qsame' }] }),
    coinjoinTx({ txid: 'c'.repeat(64) }),
    makeTx({ txid: 'd'.repeat(64), version: 1, locktime: 0, inputs: [{ value: 100_000, type: 'p2pkh' }] }),
    makeTx({
      txid: 'e'.repeat(64),
      locktime: 0,
      inputs: [{ value: 50_000, type: 'v0_p2wpkh', sequence: 0xffffffff }],
      outputs: [
        { value: 0, type: 'op_return', payload: '6a1052582004deadbeef' },
        { value: 40_000, type: 'v0_p2wpkh' },
      ],
    }),
  ];
  return txs.map((tx) => analyzed(tx));
}

describe('MemoryCorpus parity with Db', () => {
  it('produces the same summary, categories, profiles and labels', () => {
    const rows = corpus();
    const fingerprint = rulesFingerprint(profilesForTests(), categoriesForTests());

    const db = tempDb('parity');
    const memory = new MemoryCorpus();
    try {
      for (const classified of rows) {
        db.saveAnalysis(classified, { rulesFingerprint: fingerprint, raw: null });
        memory.add(classified, { rulesFingerprint: fingerprint });
      }

      const fromDb = buildStats(db, fingerprint, profilesForTests(), categoriesForTests(), {
        recentLimit: 10,
        clusterLimit: 10,
      });
      const fromMemory = buildStats(memory, fingerprint, profilesForTests(), categoriesForTests(), {
        recentLimit: 10,
        clusterLimit: 10,
      });

      assert.deepEqual(fromMemory.summary, fromDb.summary);
      assert.deepEqual(
        fromMemory.categories.map((c) => [c.id, c.txs]),
        fromDb.categories.map((c) => [c.id, c.txs]),
      );
      assert.deepEqual(
        fromMemory.fingerprints.map((f) => [f.id, f.txs]),
        fromDb.fingerprints.map((f) => [f.id, f.txs]),
      );
      // node:sqlite returns null-prototype rows and leaves ties in arbitrary
      // order, so compare values, normalised and canonically sorted by key.
      assert.deepEqual(sorted(fromMemory.labels, 'label'), sorted(fromDb.labels, 'label'));
      assert.deepEqual(sorted(fromMemory.profiles, 'profileId'), sorted(fromDb.profiles, 'profileId'));
      assert.deepEqual(sorted(fromMemory.spam, 'kind'), sorted(fromDb.spam, 'kind'));
      // Every fixture shares one first_seen_at, so recent order is ambiguous.
      const recent = (rows: typeof fromDb.recent) =>
        [...rows].sort((a, b) => a.txid.localeCompare(b.txid)).map((r) => [r.txid, r.is_unknown, r.spam_kind]);
      assert.deepEqual(recent(fromMemory.recent), recent(fromDb.recent));
    } finally {
      db.close();
    }
  });

  it('partitions the corpus exactly when spam is hidden', () => {
    const rows = corpus();
    const fingerprint = rulesFingerprint(profilesForTests(), categoriesForTests());
    const db = tempDb('parity-spam');
    const memory = new MemoryCorpus();
    try {
      for (const classified of rows) {
        db.saveAnalysis(classified, { rulesFingerprint: fingerprint, raw: null });
        memory.add(classified, { rulesFingerprint: fingerprint });
      }

      for (const excludeSpam of [false, true]) {
        const stats = buildStats(memory, fingerprint, profilesForTests(), categoriesForTests(), {
          excludeSpam,
        });
        const categorised = stats.categories.reduce((sum, c) => sum + c.txs, 0);
        assert.equal(categorised, stats.summary.total, `categories must sum to total (spam=${excludeSpam})`);
        assert.equal(
          stats.summary.unknown + stats.summary.weak + stats.summary.attributed,
          stats.summary.total,
          `attribution partition must sum to total (spam=${excludeSpam})`,
        );
      }
    } finally {
      db.close();
    }
  });

  it('reports the same research clusters as the SQL query', () => {
    const rows = corpus();
    const fingerprint = rulesFingerprint(profilesForTests(), categoriesForTests());
    const db = tempDb('parity-clusters');
    const memory = new MemoryCorpus();
    try {
      for (const classified of rows) {
        db.saveAnalysis(classified, { rulesFingerprint: fingerprint, raw: null });
        memory.add(classified, { rulesFingerprint: fingerprint });
      }
      const fromDb = db.researchClusters(25, 1, { includeWeak: true });
      const fromMemory = memory.researchClusters(25, 1, { includeWeak: true });
      assert.deepEqual(
        fromMemory.map((c) => [c.signature, c.count]),
        fromDb.map((c) => [c.signature, c.count]),
      );
    } finally {
      db.close();
    }
  });

  it('computes near misses from features without a database', () => {
    const rows = corpus();
    const db = tempDb('parity-nearmiss');
    const memory = new MemoryCorpus();
    try {
      for (const classified of rows) {
        db.saveAnalysis(classified, { rulesFingerprint: 'x', raw: null });
        memory.add(classified, { rulesFingerprint: 'x' });
      }
      const fromDb = nearMissReport(db, profilesForTests(), { includeWeak: true, sampleSize: 100 });
      const fromMemory = nearMissFromFeatures(
        memory.featuresForResearch(100, true, false),
        profilesForTests(),
      );
      assert.deepEqual(fromMemory, fromDb);
    } finally {
      db.close();
    }
  });

  it('replaces rather than duplicates a re-classified transaction', () => {
    const first = corpus()[0] as ClassifiedTx;
    const memory = new MemoryCorpus();
    memory.add(first, { rulesFingerprint: 'v1' });
    assert.equal(memory.size, 1);
    memory.add(first, { rulesFingerprint: 'v2' });
    assert.equal(memory.size, 1, 'the same txid must not be counted twice');
    assert.equal(memory.summary('v2').stale, 0);
    assert.equal(memory.summary('v1').stale, 1, 'a different digest marks the row stale');
  });

  it('reclassifies the stored feature vectors when rules move', () => {
    const rows = corpus();
    const memory = new MemoryCorpus();
    for (const classified of rows) memory.add(classified, { rulesFingerprint: 'old' });
    const before = memory.summary('old');
    assert.equal(before.stale, 0);

    memory.reclassify((features) => analyzed({ ...(rows[0] as ClassifiedTx).tx, txid: features.txid }).classification, {
      rulesFingerprint: 'new',
    });
    assert.equal(memory.size, rows.length);
    assert.equal(memory.summary('new').stale, 0);
    assert.equal(memory.summary('old').stale, rows.length);
  });
});
