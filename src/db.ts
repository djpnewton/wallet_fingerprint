/**
 * SQLite persistence (node:sqlite, no native build step).
 *
 * Layout rationale:
 *  - `transactions` is the analysis row: one row per tx with its full feature
 *    vector, tags, and (optionally) the raw mempool.space payload so rules can
 *    be re-evaluated offline without refetching.
 *  - `tx_wallets` / `tx_labels` are denormalised tag tables so "show me every
 *    tx tagged Sparrow" stays an index scan instead of a JSON scan.
 *  - `tx_inputs` / `tx_outputs` keep per-input/output detail for research
 *    (address reuse, value clustering) without re-parsing JSON.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDustOutput } from './features.ts';
import type { ClassifiedTx, TxFeatures, WalletTag } from './types.ts';

const SCHEMA_VERSION = 5;

/** Matches below this best-wallet confidence are treated as research material. */
export const WEAK_ATTRIBUTION_THRESHOLD = 0.35;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blocks (
  height INTEGER PRIMARY KEY,
  hash TEXT NOT NULL,
  block_time INTEGER,
  tx_count INTEGER,
  ingested_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  txid TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  block_height INTEGER,
  block_hash TEXT,
  block_time INTEGER,
  version INTEGER NOT NULL,
  locktime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  weight INTEGER NOT NULL,
  vsize INTEGER NOT NULL,
  fee INTEGER NOT NULL,
  fee_rate REAL NOT NULL,
  input_count INTEGER NOT NULL,
  output_count INTEGER NOT NULL,
  total_input_value INTEGER,
  total_output_value INTEGER NOT NULL,
  features_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  profile_ids_json TEXT NOT NULL,
  wallets_json TEXT NOT NULL,
  labels_json TEXT NOT NULL,
  near_miss_json TEXT NOT NULL,
  wallet_count INTEGER NOT NULL,
  best_wallet_confidence REAL NOT NULL DEFAULT 0,
  is_unknown INTEGER NOT NULL,
  classified_at INTEGER NOT NULL,
  rules_fingerprint TEXT,
  spam_kind TEXT,
  category_id TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_txs_first_seen ON transactions(first_seen_at);
CREATE INDEX IF NOT EXISTS idx_txs_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_txs_unknown ON transactions(is_unknown, first_seen_at);
CREATE INDEX IF NOT EXISTS idx_txs_signature ON transactions(signature);
CREATE INDEX IF NOT EXISTS idx_txs_wallet_count ON transactions(wallet_count);
CREATE INDEX IF NOT EXISTS idx_txs_best_conf ON transactions(best_wallet_confidence);
CREATE INDEX IF NOT EXISTS idx_txs_fingerprint ON transactions(rules_fingerprint);
CREATE INDEX IF NOT EXISTS idx_txs_spam ON transactions(spam_kind);
CREATE INDEX IF NOT EXISTS idx_txs_category ON transactions(category_id);

CREATE TABLE IF NOT EXISTS tx_wallets (
  txid TEXT NOT NULL,
  wallet TEXT NOT NULL,
  confidence REAL NOT NULL,
  profiles_json TEXT NOT NULL,
  PRIMARY KEY (txid, wallet)
);
CREATE INDEX IF NOT EXISTS idx_tx_wallets_wallet ON tx_wallets(wallet, confidence);

CREATE TABLE IF NOT EXISTS tx_labels (
  txid TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (txid, label)
);
CREATE INDEX IF NOT EXISTS idx_tx_labels_label ON tx_labels(label);

CREATE TABLE IF NOT EXISTS tx_inputs (
  txid TEXT NOT NULL,
  idx INTEGER NOT NULL,
  prev_txid TEXT,
  prev_vout INTEGER,
  value INTEGER,
  address TEXT,
  script_type TEXT,
  sequence INTEGER,
  witness_items INTEGER,
  PRIMARY KEY (txid, idx)
);

CREATE TABLE IF NOT EXISTS tx_outputs (
  txid TEXT NOT NULL,
  idx INTEGER NOT NULL,
  value INTEGER NOT NULL,
  address TEXT,
  script_type TEXT NOT NULL,
  script_hex TEXT NOT NULL,
  is_dust INTEGER NOT NULL,
  PRIMARY KEY (txid, idx)
);
CREATE INDEX IF NOT EXISTS idx_tx_outputs_address ON tx_outputs(address);
`;

export type SqlValue = string | number | null;

export interface ReclassifiableRow {
  txid: string;
  raw_json: string;
  features_json: string;
  status: string;
  is_unknown: number;
  block_height: number | null;
  block_hash: string | null;
  block_time: number | null;
}

export function sqlValue(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return Number(v);
  return JSON.stringify(v);
}

export interface StoredTransaction {
  txid: string;
  first_seen_at: number;
  last_seen_at: number;
  status: string;
  block_height: number | null;
  block_hash: string | null;
  block_time: number | null;
  version: number;
  locktime: number;
  size: number;
  weight: number;
  vsize: number;
  fee: number;
  fee_rate: number;
  input_count: number;
  output_count: number;
  total_input_value: number | null;
  total_output_value: number;
  features_json: string;
  signature: string;
  profile_ids_json: string;
  wallets_json: string;
  labels_json: string;
  near_miss_json: string;
  wallet_count: number;
  best_wallet_confidence: number;
  is_unknown: number;
  classified_at: number;
  rules_fingerprint: string | null;
  spam_kind: string | null;
  category_id: string | null;
  raw_json: string | null;
}

export interface InsertOptions {
  raw: unknown | null;
  now?: number;
  /** Digest of the rule set that produced this classification. */
  rulesFingerprint?: string | null;
}

export interface TransactionListRow {
  txid: string;
  first_seen_at: number;
  status: string;
  block_height: number | null;
  version: number;
  locktime: number;
  fee: number;
  fee_rate: number;
  vsize: number;
  input_count: number;
  output_count: number;
  wallet_count: number;
  best_wallet_confidence: number;
  is_unknown: number;
  signature: string;
  labels_json: string;
  wallets_json: string;
  spam_kind: string | null;
  category_id: string | null;
}

export interface ClusterRow {
  signature: string;
  count: number;
  examples: string[];
  labels: string;
  avg_fee_rate: number;
  avg_inputs: number;
  avg_outputs: number;
}

export class Db {
  readonly path: string;
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    // WAL still allows only one writer at a time. Without a busy timeout the
    // second process fails immediately with "database is locked", which is fatal
    // in practice: running `stats` or `classify` in one terminal while `live`
    // ingests in another would crash the ingester. Wait instead of failing.
    this.db.exec('PRAGMA busy_timeout = 15000');
    // Without a size limit the WAL grew unbounded under repeated bulk rewrites
    // (a full re-classify touches millions of pages), reaching 28 GB and making
    // every query take seconds. Cap it and let SQLite reset it on checkpoint.
    this.db.exec('PRAGMA journal_size_limit = 67108864');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.init();
  }

  private init(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    const current = row?.user_version ?? 0;
    if (current === 0) {
      this.db.exec(SCHEMA);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      return;
    }
    if (current > SCHEMA_VERSION) {
      throw new Error(`database schema v${current} is newer than this build (v${SCHEMA_VERSION})`);
    }
    if (current < SCHEMA_VERSION) {
      // Column migrations must run before the DDL: the DDL creates indexes over
      // columns that older databases do not have yet.
      if (current < 2) this.migrateToV2();
      if (current < 3) this.migrateToV3();
      if (current < 4) this.migrateToV4();
      if (current < 5) this.migrateToV5();
      // Re-running the DDL adds tables/indexes introduced since the last
      // version; every statement is CREATE ... IF NOT EXISTS.
      this.db.exec(SCHEMA);
    }
  }

  /** v2: track the best wallet confidence so weak attributions stay researchable. */
  private migrateToV2(): void {
    const columns = this.db.prepare('PRAGMA table_info(transactions)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'best_wallet_confidence')) {
      this.db.exec(
        'ALTER TABLE transactions ADD COLUMN best_wallet_confidence REAL NOT NULL DEFAULT 0',
      );
    }
    const rows = this.db.prepare('SELECT txid, wallets_json FROM transactions').all() as Array<{
      txid: string;
      wallets_json: string;
    }>;
    const update = this.db.prepare('UPDATE transactions SET best_wallet_confidence = ? WHERE txid = ?');
    this.transaction(() => {
      for (const row of rows) {
        let best = 0;
        try {
          const wallets = JSON.parse(row.wallets_json) as WalletTag[];
          best = wallets.reduce((max, w) => Math.max(max, w.confidence ?? 0), 0);
        } catch {
          best = 0;
        }
        update.run(sqlValue(best), row.txid);
      }
      this.db.exec(`PRAGMA user_version = 2`);
    });
  }

  /**
   * v3: record which rule set classified each row. Rows from before this
   * migration keep NULL, which is treated as stale so a reclassify is prompted.
   */
  private migrateToV3(): void {
    const columns = this.db.prepare('PRAGMA table_info(transactions)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'rules_fingerprint')) {
      this.db.exec('ALTER TABLE transactions ADD COLUMN rules_fingerprint TEXT');
    }
    this.db.exec('PRAGMA user_version = 3');
  }

  /** v4: record junk/protocol traffic so it can be excluded from statistics. */
  private migrateToV4(): void {
    const columns = this.db.prepare('PRAGMA table_info(transactions)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'spam_kind')) {
      this.db.exec('ALTER TABLE transactions ADD COLUMN spam_kind TEXT');
    }
    this.db.exec('PRAGMA user_version = 4');
  }

  /** v5: exclusive wallet category per transaction. */
  private migrateToV5(): void {
    const columns = this.db.prepare('PRAGMA table_info(transactions)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'category_id')) {
      this.db.exec('ALTER TABLE transactions ADD COLUMN category_id TEXT');
    }
    this.db.exec('PRAGMA user_version = 5');
  }

  close(): void {
    this.db.close();
  }

  private txDepth = 0;

  /**
   * Runs `fn` inside a write transaction. Reentrant: a nested call joins the
   * outer transaction, so callers can group thousands of writes without every
   * `saveAnalysis` starting (and committing) its own.
   */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth++;
      try {
        return fn();
      } finally {
        this.txDepth--;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  /** Folds the write-ahead log back into the database and truncates it. */
  checkpoint(): { busy: number; log: number; checkpointed: number } {
    return this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
      busy: number;
      log: number;
      checkpointed: number;
    };
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  allTxids(): Set<string> {
    const rows = this.db.prepare('SELECT txid FROM transactions').all() as Array<{ txid: string }>;
    return new Set(rows.map((r) => r.txid));
  }

  hasTx(txid: string): boolean {
    return this.db.prepare('SELECT 1 AS x FROM transactions WHERE txid = ?').get(txid) !== undefined;
  }

  countTxs(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number };
    return row.n;
  }

  /** Insert or replace an analysed transaction plus its denormalised tag rows. */
  saveAnalysis(classified: ClassifiedTx, options: InsertOptions): void {
    const { tx, features, classification } = classified;
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const status = tx.status?.confirmed ? 'confirmed' : 'mempool';

    const walletsJson = JSON.stringify(classification.wallets);
    const labelsJson = JSON.stringify(classification.labels);
    const profileIdsJson = JSON.stringify(classification.profiles.map((p) => p.profileId));

    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO transactions (
             txid, first_seen_at, last_seen_at, status, block_height, block_hash, block_time,
             version, locktime, size, weight, vsize, fee, fee_rate, input_count, output_count,
             total_input_value, total_output_value, features_json, signature, profile_ids_json,
             wallets_json, labels_json, near_miss_json, wallet_count, best_wallet_confidence,
             is_unknown, classified_at, rules_fingerprint, spam_kind, category_id, raw_json
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           )
           ON CONFLICT(txid) DO UPDATE SET
             last_seen_at = excluded.last_seen_at,
             status = excluded.status,
             block_height = COALESCE(excluded.block_height, transactions.block_height),
             block_hash = COALESCE(excluded.block_hash, transactions.block_hash),
             block_time = COALESCE(excluded.block_time, transactions.block_time),
             version = excluded.version,
             locktime = excluded.locktime,
             size = excluded.size,
             weight = excluded.weight,
             vsize = excluded.vsize,
             fee = excluded.fee,
             fee_rate = excluded.fee_rate,
             input_count = excluded.input_count,
             output_count = excluded.output_count,
             total_input_value = excluded.total_input_value,
             total_output_value = excluded.total_output_value,
             features_json = excluded.features_json,
             signature = excluded.signature,
             profile_ids_json = excluded.profile_ids_json,
             wallets_json = excluded.wallets_json,
             labels_json = excluded.labels_json,
             near_miss_json = excluded.near_miss_json,
             wallet_count = excluded.wallet_count,
             best_wallet_confidence = excluded.best_wallet_confidence,
             is_unknown = excluded.is_unknown,
             classified_at = excluded.classified_at,
             rules_fingerprint = excluded.rules_fingerprint,
             spam_kind = excluded.spam_kind,
             category_id = excluded.category_id,
             raw_json = COALESCE(excluded.raw_json, transactions.raw_json)`,
        )
        .run(
          tx.txid,
          sqlValue(features.first_seen_at),
          sqlValue(now),
          status,
          sqlValue(tx.status?.block_height),
          sqlValue(tx.status?.block_hash),
          sqlValue(tx.status?.block_time),
          sqlValue(tx.version),
          sqlValue(tx.locktime),
          sqlValue(tx.size),
          sqlValue(tx.weight),
          sqlValue(features.vsize),
          sqlValue(features.fee),
          sqlValue(features.fee_rate),
          sqlValue(features.input_count),
          sqlValue(features.output_count),
          sqlValue(features.total_input_value),
          sqlValue(features.total_output_value),
          JSON.stringify(features),
          features.signature,
          profileIdsJson,
          walletsJson,
          labelsJson,
          JSON.stringify(classification.nearMisses),
          sqlValue(classification.wallets.length),
          sqlValue(bestWalletConfidence(classification.wallets)),
          sqlValue(classification.isUnknown ? 1 : 0),
          sqlValue(now),
          sqlValue(options.rulesFingerprint ?? null),
          sqlValue(features.spam_kind),
          sqlValue(classification.category?.id ?? null),
          options.raw === null ? null : JSON.stringify(options.raw),
        );

      this.db.prepare('DELETE FROM tx_wallets WHERE txid = ?').run(tx.txid);
      const walletStmt = this.db.prepare(
        'INSERT INTO tx_wallets (txid, wallet, confidence, profiles_json) VALUES (?, ?, ?, ?)',
      );
      for (const w of classification.wallets) {
        walletStmt.run(tx.txid, w.name, sqlValue(w.confidence), JSON.stringify(w.profiles));
      }

      this.db.prepare('DELETE FROM tx_labels WHERE txid = ?').run(tx.txid);
      const labelStmt = this.db.prepare('INSERT INTO tx_labels (txid, label) VALUES (?, ?)');
      for (const label of classification.labels) labelStmt.run(tx.txid, label);

      this.db.prepare('DELETE FROM tx_inputs WHERE txid = ?').run(tx.txid);
      const inStmt = this.db.prepare(
        `INSERT INTO tx_inputs (txid, idx, prev_txid, prev_vout, value, address, script_type, sequence, witness_items)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      tx.vin.forEach((vin, idx) => {
        inStmt.run(
          tx.txid,
          idx,
          sqlValue(vin.txid),
          sqlValue(vin.vout),
          sqlValue(vin.prevout?.value),
          sqlValue(vin.prevout?.scriptpubkey_address),
          sqlValue(vin.prevout?.scriptpubkey_type ?? 'unknown'),
          sqlValue(vin.sequence >>> 0),
          sqlValue(vin.witness?.length ?? 0),
        );
      });

      this.db.prepare('DELETE FROM tx_outputs WHERE txid = ?').run(tx.txid);
      const outStmt = this.db.prepare(
        `INSERT INTO tx_outputs (txid, idx, value, address, script_type, script_hex, is_dust)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      tx.vout.forEach((vout, idx) => {
        outStmt.run(
          tx.txid,
          idx,
          sqlValue(vout.value),
          sqlValue(vout.scriptpubkey_address),
          vout.scriptpubkey_type,
          vout.scriptpubkey,
          sqlValue(isDustOutput(vout) ? 1 : 0),
        );
      });
    });
  }

  /** Marks txs as mined; unknown txids are ignored. Returns rows touched. */
  markConfirmed(height: number, hash: string, blockTime: number | null, txids: string[]): number {
    if (txids.length === 0) return 0;
    const stmt = this.db.prepare(
      `UPDATE transactions
         SET status = 'confirmed', block_height = ?, block_hash = ?, block_time = ?
       WHERE txid = ? AND status != 'confirmed'`,
    );
    return this.transaction(() => {
      let changes = 0;
      for (const txid of txids) {
        const result = stmt.run(sqlValue(height), hash, sqlValue(blockTime), txid);
        changes += Number(result.changes);
      }
      return changes;
    });
  }

  markDropped(txids: string[]): number {
    if (txids.length === 0) return 0;
    const stmt = this.db.prepare(
      `UPDATE transactions SET status = 'dropped' WHERE txid = ? AND status = 'mempool'`,
    );
    return this.transaction(() => {
      let changes = 0;
      for (const txid of txids) changes += Number(stmt.run(txid).changes);
      return changes;
    });
  }

  saveBlock(height: number, hash: string, blockTime: number | null, txCount: number): void {
    this.db
      .prepare(
        `INSERT INTO blocks (height, hash, block_time, tx_count, ingested_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(height) DO UPDATE SET hash = excluded.hash, tx_count = excluded.tx_count`,
      )
      .run(sqlValue(height), hash, sqlValue(blockTime), sqlValue(txCount), sqlValue(Math.floor(Date.now() / 1000)));
  }

  tipHeight(): number | null {
    const row = this.db.prepare('SELECT MAX(height) AS h FROM blocks').get() as { h: number | null };
    return row.h ?? null;
  }

  getFeatures(txid: string): TxFeatures | null {
    const row = this.db
      .prepare('SELECT features_json FROM transactions WHERE txid = ?')
      .get(txid) as { features_json: string } | undefined;
    return row ? (JSON.parse(row.features_json) as TxFeatures) : null;
  }

  getRaw(txid: string): string | null {
    const row = this.db
      .prepare('SELECT raw_json FROM transactions WHERE txid = ?')
      .get(txid) as { raw_json: string | null } | undefined;
    return row?.raw_json ?? null;
  }

  /**
   * Streams rows that can be re-classified offline (raw payload present), one
   * batch at a time so a large database never has to fit in memory.
   */
  iterReclassifiable(batchSize = 500): Iterable<ReclassifiableRow[]> {
    const db = this.db;
    function* gen(): Generator<ReclassifiableRow[]> {
      let lastRowid = 0;
      while (true) {
        const rows = db
          .prepare(
            `SELECT rowid AS rowid, txid, raw_json, features_json, status, is_unknown,
                    block_height, block_hash, block_time
               FROM transactions
              WHERE raw_json IS NOT NULL AND rowid > ?
              ORDER BY rowid LIMIT ?`,
          )
          .all(lastRowid, batchSize) as unknown as Array<ReclassifiableRow & { rowid: number }>;
        if (rows.length === 0) return;
        lastRowid = rows[rows.length - 1]?.rowid ?? lastRowid;
        yield rows;
      }
    }
    return gen();
  }

  listTransactions(options: {
    limit?: number;
    onlyUnknown?: boolean;
    wallet?: string;
    label?: string;
    status?: string;
    excludeSpam?: boolean;
    onlySpam?: boolean;
    category?: string;
  }): TransactionListRow[] {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (options.onlyUnknown) clauses.push('t.is_unknown = 1');
    if (options.wallet) {
      clauses.push('EXISTS (SELECT 1 FROM tx_wallets w WHERE w.txid = t.txid AND w.wallet = ?)');
      params.push(options.wallet);
    }
    if (options.label) {
      clauses.push('EXISTS (SELECT 1 FROM tx_labels l WHERE l.txid = t.txid AND l.label = ?)');
      params.push(options.label);
    }
    if (options.status) {
      clauses.push('t.status = ?');
      params.push(options.status);
    }
    if (options.category) {
      clauses.push("COALESCE(t.category_id, 'unclassified') = ?");
      params.push(options.category);
    }
    if (options.excludeSpam) clauses.push('t.spam_kind IS NULL');
    if (options.onlySpam) clauses.push('t.spam_kind IS NOT NULL');
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(2000, options.limit ?? 50));
    return this.db
      .prepare(
        `SELECT t.txid, t.first_seen_at, t.status, t.block_height, t.version, t.locktime,
                t.fee, t.fee_rate, t.vsize, t.input_count, t.output_count, t.wallet_count,
                t.best_wallet_confidence, t.is_unknown, t.signature, t.labels_json, t.wallets_json,
                t.spam_kind, t.category_id
           FROM transactions t
           ${where}
          ORDER BY t.first_seen_at DESC
          LIMIT ${limit}`,
      )
      .all(...params) as unknown as TransactionListRow[];
  }

  summary(
    fingerprint?: string | null,
    options: { excludeSpam?: boolean } = {},
  ): {
    total: number;
    spam: number;
    mempool: number;
    confirmed: number;
    dropped: number;
    unknown: number;
    weak: number;
    /** Rows with at least one wallet tag, however weak. */
    tagged: number;
    /** Rows with an attribution at or above the weak threshold. */
    attributed: number;
    /** Rows classified by a rule set other than the current one. */
    stale: number;
    firstSeen: number | null;
    lastSeen: number | null;
    totalFees: number;
    avgFeeRate: number;
  } {
    const spamTotal = this.db
      .prepare('SELECT COUNT(*) AS n FROM transactions WHERE spam_kind IS NOT NULL')
      .get() as { n: number };
    // `spam_kind IS NOT NULL` is the definition of junk; excludeSpam hides it.
    const spamFilter = options.excludeSpam === true ? 'WHERE spam_kind IS NULL' : '';
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'mempool' THEN 1 ELSE 0 END) AS mempool,
                SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
                SUM(CASE WHEN status = 'dropped' THEN 1 ELSE 0 END) AS dropped,
                SUM(is_unknown) AS unknown,
                SUM(CASE WHEN is_unknown = 0 AND best_wallet_confidence < ? THEN 1 ELSE 0 END) AS weak,
                SUM(CASE WHEN is_unknown = 0 AND best_wallet_confidence >= ? THEN 1 ELSE 0 END) AS attributed,
                SUM(wallet_count) AS tagged,
                MIN(first_seen_at) AS firstSeen,
                MAX(first_seen_at) AS lastSeen,
                SUM(fee) AS totalFees,
                AVG(fee_rate) AS avgFeeRate
           FROM transactions ${spamFilter}`,
      )
      .get(WEAK_ATTRIBUTION_THRESHOLD, WEAK_ATTRIBUTION_THRESHOLD) as Record<string, number | null>;
    return {
      total: row.total ?? 0,
      spam: spamTotal.n,
      mempool: row.mempool ?? 0,
      confirmed: row.confirmed ?? 0,
      dropped: row.dropped ?? 0,
      unknown: row.unknown ?? 0,
      weak: row.weak ?? 0,
      tagged: row.tagged ?? 0,
      attributed: row.attributed ?? 0,
      stale: this.staleCount(fingerprint, options.excludeSpam === true),
      firstSeen: row.firstSeen ?? null,
      lastSeen: row.lastSeen ?? null,
      totalFees: row.totalFees ?? 0,
      avgFeeRate: row.avgFeeRate ?? 0,
    };
  }

  /** Transactions per exclusive wallet category. */
  categoryCounts(options: { excludeSpam?: boolean } = {}): Map<string, number> {
    const spamFilter = options.excludeSpam === true ? 'AND spam_kind IS NULL' : '';
    const rows = this.db
      .prepare(
        `SELECT COALESCE(category_id, 'unclassified') AS id, COUNT(*) AS txs
           FROM transactions
          WHERE 1 = 1 ${spamFilter}
          GROUP BY COALESCE(category_id, 'unclassified')`,
      )
      .all() as Array<{ id: string; txs: number }>;
    return new Map(rows.map((row) => [String(row.id), Number(row.txs)]));
  }

  /** Rows carrying a spam classification, grouped by kind. */
  spamBreakdown(): Array<{ kind: string; txs: number }> {
    const rows = this.db
      .prepare(
        `SELECT spam_kind AS kind, COUNT(*) AS txs
           FROM transactions WHERE spam_kind IS NOT NULL
          GROUP BY spam_kind ORDER BY txs DESC`,
      )
      .all() as Array<{ kind: string; txs: number }>;
    return rows.map((row) => ({ kind: String(row.kind), txs: Number(row.txs) }));
  }

  /**
   * Wallet ranking by *evidence*, not tag volume.
   *
   * Ranking by total tags put "generic wallet without address rotation" on top
   * with 3,869 tags and a 2% average, while Bitcoin Core's confident
   * attributions were averaged away with shape-only hits. So the ranking metric
   * is the plain count of confident attributions: a number the panel displays,
   * draws its bar from, and sorts by, with no hidden weighting. `topPick` and
   * `evidence` are reported alongside for inspection.
   */
  walletCounts(
    limit = 25,
    options: { excludeSpam?: boolean; threshold?: number } = {},
  ): Array<{
    wallet: string;
    txs: number;
    confident: number;
    /**
     * Transactions where this wallet was the single most plausible candidate
     * *and* cleared the confidence threshold.
     */
    topPick: number;
    /** Total evidence: sum of plausibility across every attribution. */
    evidence: number;
    avgConfidence: number;
    maxConfidence: number;
  }> {
    const threshold = options.threshold ?? WEAK_ATTRIBUTION_THRESHOLD;
    const joinFilter = options.excludeSpam === true ? 'AND t.spam_kind IS NULL' : '';
    const rows = this.db
      .prepare(
        `WITH best AS (SELECT txid, MAX(confidence) AS m FROM tx_wallets GROUP BY txid)
         SELECT w.wallet,
                COUNT(*) AS txs,
                SUM(CASE WHEN w.confidence >= ? THEN 1 ELSE 0 END) AS confident,
                SUM(CASE WHEN w.confidence = b.m AND w.confidence >= ? THEN 1 ELSE 0 END) AS topPick,
                SUM(w.confidence) AS evidence,
                AVG(w.confidence) AS avgConfidence,
                MAX(w.confidence) AS maxConfidence
           FROM tx_wallets w
           JOIN transactions t ON t.txid = w.txid
           JOIN best b ON b.txid = w.txid
          WHERE 1 = 1 ${joinFilter}
          GROUP BY w.wallet
          ORDER BY confident DESC, evidence DESC, txs DESC, w.wallet ASC
          LIMIT ?`,
      )
      .all(threshold, threshold, Math.max(1, Math.min(500, limit))) as Array<{
      wallet: string;
      txs: number;
      confident: number;
      topPick: number;
      evidence: number;
      avgConfidence: number;
      maxConfidence: number;
    }>;
    return rows.map((row) => ({
      wallet: String(row.wallet),
      txs: Number(row.txs),
      confident: Number(row.confident),
      topPick: Number(row.topPick),
      evidence: Number(Number(row.evidence).toFixed(1)),
      avgConfidence: Number(row.avgConfidence),
      maxConfidence: Number(row.maxConfidence),
    }));
  }

  labelCounts(limit = 40, options: { excludeSpam?: boolean } = {}): Array<{ label: string; txs: number }> {
    const joinFilter = options.excludeSpam === true ? 'WHERE t.spam_kind IS NULL' : '';
    return this.db
      .prepare(
        `SELECT l.label, COUNT(*) AS txs
           FROM tx_labels l JOIN transactions t ON t.txid = l.txid
           ${joinFilter}
          GROUP BY l.label ORDER BY txs DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(500, limit))) as Array<{ label: string; txs: number }>;
  }

  /**
   * How often each profile fires across the whole corpus, which is what makes a
   * signature's specificity measurable rather than guessed.
   */
  profileBaseRates(): { counts: Map<string, number>; total: number } {
    const rows = this.db
      .prepare(
        `SELECT value AS profileId, COUNT(*) AS txs
           FROM transactions, json_each(transactions.profile_ids_json)
          GROUP BY value`,
      )
      .all() as Array<{ profileId: string; txs: number }>;
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(String(row.profileId), row.txs);
    return { counts, total: this.countTxs() };
  }

  profileCounts(limit = 40, options: { excludeSpam?: boolean } = {}): Array<{ profileId: string; txs: number }> {
    const spamFilter = options.excludeSpam === true ? 'WHERE transactions.spam_kind IS NULL' : '';
    return this.db
      .prepare(
        `SELECT value AS profileId, COUNT(*) AS txs
           FROM transactions, json_each(transactions.profile_ids_json)
           ${spamFilter}
          GROUP BY value ORDER BY txs DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(500, limit))) as Array<{ profileId: string; txs: number }>;
  }

  /**
   * Groups the unknown pool by coarse signature. This is the research entry
   * point: a large cluster with no profile is a missing fingerprint.
   */
  unknownClusters(limit = 25, minCount = 2): ClusterRow[] {
    const rows = this.db
      .prepare(
        `SELECT signature,
                COUNT(*) AS count,
                AVG(fee_rate) AS avg_fee_rate,
                AVG(input_count) AS avg_inputs,
                AVG(output_count) AS avg_outputs,
                GROUP_CONCAT(txid) AS txids,
                GROUP_CONCAT(DISTINCT labels_json) AS labels
           FROM transactions
          WHERE is_unknown = 1
          GROUP BY signature
         HAVING COUNT(*) >= ?
          ORDER BY count DESC, signature ASC
          LIMIT ?`,
      )
      .all(minCount, Math.max(1, Math.min(500, limit))) as Array<{
      signature: string;
      count: number;
      avg_fee_rate: number;
      avg_inputs: number;
      avg_outputs: number;
      txids: string;
      labels: string | null;
    }>;
    return rows.map((r) => ({
      signature: r.signature,
      count: r.count,
      examples: r.txids.split(',').slice(0, 5),
      labels: r.labels ?? '',
      avg_fee_rate: Number(r.avg_fee_rate.toFixed(2)),
      avg_inputs: Number(r.avg_inputs.toFixed(2)),
      avg_outputs: Number(r.avg_outputs.toFixed(2)),
    }));
  }

  /**
   * Like `unknownClusters`, but can also include transactions that were matched
   * only weakly: a broad profile can tag a transaction at 15% plausibility,
   * which is not real attribution and should stay available for research.
   */
  researchClusters(
    limit = 25,
    minCount = 2,
    options: { includeWeak?: boolean; maxConfidence?: number; excludeSpam?: boolean } = {},
  ): ClusterRow[] {
    const includeWeak = options.includeWeak ?? false;
    const maxConfidence = options.maxConfidence ?? WEAK_ATTRIBUTION_THRESHOLD;
    const rows = this.db
      .prepare(
        `SELECT signature,
                COUNT(*) AS count,
                AVG(fee_rate) AS avg_fee_rate,
                AVG(input_count) AS avg_inputs,
                AVG(output_count) AS avg_outputs,
                GROUP_CONCAT(txid) AS txids,
                GROUP_CONCAT(DISTINCT labels_json) AS labels
           FROM transactions
          WHERE (is_unknown = 1 OR (? = 1 AND best_wallet_confidence < ?))
            AND (? = 0 OR spam_kind IS NULL)
          GROUP BY signature
         HAVING COUNT(*) >= ?
          ORDER BY count DESC, signature ASC
          LIMIT ?`,
      )
      .all(
        includeWeak ? 1 : 0,
        sqlValue(maxConfidence),
        options.excludeSpam ? 1 : 0,
        minCount,
        Math.max(1, Math.min(500, limit)),
      ) as Array<{
      signature: string;
      count: number;
      avg_fee_rate: number;
      avg_inputs: number;
      avg_outputs: number;
      txids: string;
      labels: string | null;
    }>;
    return rows.map((r) => ({
      signature: r.signature,
      count: r.count,
      examples: r.txids.split(',').slice(0, 5),
      labels: r.labels ?? '',
      avg_fee_rate: Number(r.avg_fee_rate.toFixed(2)),
      avg_inputs: Number(r.avg_inputs.toFixed(2)),
      avg_outputs: Number(r.avg_outputs.toFixed(2)),
    }));
  }

  unknownCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE is_unknown = 1').get() as {
      n: number;
    };
    return row.n;
  }

  /** Rows not classified by `fingerprint`, including pre-v3 rows with no stamp. */
  staleCount(fingerprint: string | null | undefined, excludeSpam = false): number {
    if (!fingerprint) return 0;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions
          WHERE (rules_fingerprint IS NULL OR rules_fingerprint != ?)
            AND (? = 0 OR spam_kind IS NULL)`,
      )
      .get(fingerprint, excludeSpam ? 1 : 0) as { n: number };
    return row.n;
  }

  inputValueReuse(txid: string): { inputs: number; reused: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS inputs,
                SUM(CASE WHEN o.address IS NOT NULL THEN 1 ELSE 0 END) AS reused
           FROM tx_inputs i
           JOIN tx_outputs o ON o.txid = i.txid AND o.idx = i.idx
          WHERE i.txid = ?`,
      )
      .get(txid) as { inputs: number; reused: number | null };
    return { inputs: row.inputs, reused: row.reused ?? 0 };
  }
}

/** Highest plausibility among a transaction's wallet tags (0 when untagged). */
export function bestWalletConfidence(wallets: readonly WalletTag[]): number {
  let best = 0;
  for (const wallet of wallets) {
    if (wallet.confidence > best) best = wallet.confidence;
  }
  return Number(best.toFixed(3));
}

export function walletsOf(row: { wallets_json: string }): WalletTag[] {
  try {
    return JSON.parse(row.wallets_json) as WalletTag[];
  } catch {
    return [];
  }
}

export function parseLabels(row: { labels_json: string }): string[] {
  try {
    return JSON.parse(row.labels_json) as string[];
  } catch {
    return [];
  }
}
