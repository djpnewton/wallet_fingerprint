/**
 * An in-memory corpus that answers the same questions as `Db`.
 *
 * This exists for the static web build, where there is no backend and no
 * storage: transactions are classified in the browser and counted as they
 * arrive. Both stores implement `StatsSource`, so the dashboard renders
 * identical numbers whether it is looking at 160k stored rows or 400 streamed
 * ones — only the corpus behind them differs.
 *
 * The counting rules are deliberately a transcription of the SQL in `db.ts`;
 * `test/memory.test.ts` asserts the two agree on the same corpus.
 */

import { isDustOutput } from './features.ts';
import { bestWalletConfidence, WEAK_ATTRIBUTION_THRESHOLD } from './rows.ts';
import type { ClusterRow, TransactionListRow, TxExplanation } from './rows.ts';
import type { Summary, StatsSource } from './report.ts';

import type { Classification, ClassifiedTx, MempoolTx, TxFeatures, WalletTag } from './types.ts';

interface MemoryRow {
  tx: MempoolTx;
  features: TxFeatures;
  /** Kept whole so the detail panel needs no second classification pass. */
  classification: Classification;
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
  is_unknown: 0 | 1;
  signature: string;
  profileIds: string[];
  wallets: WalletTag[];
  labels: string[];
  spam_kind: string | null;
  category_id: string | null;
  /** Digest of the rules that produced this row, for staleness reporting. */
  rules_fingerprint: string | null;
}

export interface AddOptions {
  /** Digest of the rule set that classified this transaction. */
  rulesFingerprint?: string | null;
}

export class MemoryCorpus implements StatsSource {
  private readonly rows = new Map<string, MemoryRow>();

  get size(): number {
    return this.rows.size;
  }

  /** Adds or replaces a transaction. Re-classifying must not double-count. */
  add(classified: ClassifiedTx, options: AddOptions = {}): void {
    const { tx, features, classification } = classified;
    const status = tx.status?.confirmed === true ? 'confirmed' : 'mempool';
    this.rows.set(features.txid, {
      tx,
      features,
      classification,
      txid: features.txid,
      first_seen_at: features.first_seen_at,
      status,
      block_height: tx.status?.block_height ?? null,
      version: tx.version,
      locktime: tx.locktime,
      fee: features.fee,
      fee_rate: features.fee_rate,
      vsize: features.vsize,
      input_count: features.input_count,
      output_count: features.output_count,
      wallet_count: classification.wallets.length,
      best_wallet_confidence: bestWalletConfidence(classification.wallets),
      is_unknown: classification.isUnknown ? 1 : 0,
      signature: features.signature,
      profileIds: classification.profiles.map((p) => p.profileId),
      wallets: classification.wallets,
      labels: classification.labels,
      spam_kind: features.spam_kind ?? null,
      category_id: classification.category?.id ?? null,
      rules_fingerprint: options.rulesFingerprint ?? null,
    });
  }

  clear(): void {
    this.rows.clear();
  }

  /**
   * Keeps only the `maxRows` most recent transactions.
   *
   * A streaming corpus has no natural bound, and a browser tab left open for a
   * day would otherwise grow until it is killed. Dropping the oldest rows keeps
   * the sample describing *current* behaviour, which is what it is for.
   */
  prune(maxRows: number): number {
    if (this.rows.size <= maxRows) return 0;
    const keep = [...this.rows.values()]
      .sort((a, b) => b.first_seen_at - a.first_seen_at)
      .slice(0, maxRows)
      .map((row) => row.txid);
    const kept = new Set(keep);
    let removed = 0;
    for (const txid of [...this.rows.keys()]) {
      if (kept.has(txid)) continue;
      this.rows.delete(txid);
      removed++;
    }
    return removed;
  }

  /**
   * Rewrites every row from an already-extracted feature vector, which is what
   * re-classification needs when base rates move underneath a growing corpus.
   */
  reclassify(
    classifyOne: (features: TxFeatures) => Classification,
    options: AddOptions = {},
  ): void {
    for (const row of [...this.rows.values()]) {
      const classification = classifyOne(row.features);
      this.rows.set(row.txid, {
        ...row,
        classification,
        wallet_count: classification.wallets.length,
        best_wallet_confidence: bestWalletConfidence(classification.wallets),
        is_unknown: classification.isUnknown ? 1 : 0,
        signature: row.features.signature,
        profileIds: classification.profiles.map((p) => p.profileId),
        wallets: classification.wallets,
        labels: classification.labels,
        spam_kind: row.features.spam_kind ?? null,
        category_id: classification.category?.id ?? null,
        rules_fingerprint: options.rulesFingerprint ?? row.rules_fingerprint,
      });
    }
  }

  private select(options: { excludeSpam?: boolean } = {}): MemoryRow[] {
    const all = [...this.rows.values()];
    return options.excludeSpam === true ? all.filter((r) => r.spam_kind === null) : all;
  }

  summary(fingerprint?: string | null, options: { excludeSpam?: boolean } = {}): Summary {
    const rows = this.select(options);
    let mempool = 0;
    let confirmed = 0;
    let dropped = 0;
    let unknown = 0;
    let weak = 0;
    let attributed = 0;
    let tagged = 0;
    let totalFees = 0;
    let feeRateSum = 0;
    let firstSeen: number | null = null;
    let lastSeen: number | null = null;
    let stale = 0;

    for (const row of rows) {
      if (row.status === 'mempool') mempool++;
      else if (row.status === 'confirmed') confirmed++;
      else if (row.status === 'dropped') dropped++;
      if (row.is_unknown === 1) unknown++;
      else if (row.best_wallet_confidence < WEAK_ATTRIBUTION_THRESHOLD) weak++;
      else attributed++;
      tagged += row.wallet_count;
      totalFees += row.fee;
      feeRateSum += row.fee_rate;
      if (firstSeen === null || row.first_seen_at < firstSeen) firstSeen = row.first_seen_at;
      if (lastSeen === null || row.first_seen_at > lastSeen) lastSeen = row.first_seen_at;
      if (fingerprint && row.rules_fingerprint !== fingerprint) stale++;
    }

    // The spam count is deliberately unfiltered: the toggle needs to say how
    // much it is hiding.
    const spam = [...this.rows.values()].filter((r) => r.spam_kind !== null).length;

    return {
      total: rows.length,
      spam,
      mempool,
      confirmed,
      dropped,
      unknown,
      weak,
      tagged,
      attributed,
      stale,
      firstSeen,
      lastSeen,
      totalFees,
      avgFeeRate: rows.length > 0 ? feeRateSum / rows.length : 0,
    };
  }

  categoryCounts(options: { excludeSpam?: boolean } = {}): Map<string, number> {
    const counts = new Map<string, number>();
    for (const row of this.select(options)) {
      const id = row.category_id ?? 'unclassified';
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }

  spamBreakdown(): Array<{ kind: string; txs: number }> {
    const counts = new Map<string, number>();
    for (const row of this.rows.values()) {
      if (row.spam_kind === null) continue;
      counts.set(row.spam_kind, (counts.get(row.spam_kind) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([kind, txs]) => ({ kind, txs }))
      .sort((a, b) => b.txs - a.txs || a.kind.localeCompare(b.kind));
  }

  labelCounts(limit = 40, options: { excludeSpam?: boolean } = {}): Array<{ label: string; txs: number }> {
    const counts = new Map<string, number>();
    for (const row of this.select(options)) {
      for (const label of new Set(row.labels)) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, txs]) => ({ label, txs }))
      .sort((a, b) => b.txs - a.txs || a.label.localeCompare(b.label))
      .slice(0, capped(limit));
  }

  profileCounts(limit = 40, options: { excludeSpam?: boolean } = {}): Array<{ profileId: string; txs: number }> {
    const counts = new Map<string, number>();
    for (const row of this.select(options)) {
      for (const id of new Set(row.profileIds)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([profileId, txs]) => ({ profileId, txs }))
      .sort((a, b) => b.txs - a.txs || a.profileId.localeCompare(b.profileId))
      .slice(0, capped(limit));
  }

  /** Firing rates used to derive specificity; mirrors `Db.profileBaseRates`. */
  profileBaseRates(): { counts: Map<string, number>; total: number } {
    const counts = new Map<string, number>();
    for (const row of this.rows.values()) {
      for (const id of new Set(row.profileIds)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return { counts, total: this.rows.size };
  }

  researchClusters(
    limit = 25,
    minCount = 2,
    options: { includeWeak?: boolean; maxConfidence?: number; excludeSpam?: boolean } = {},
  ): ClusterRow[] {
    const includeWeak = options.includeWeak ?? false;
    const maxConfidence = options.maxConfidence ?? WEAK_ATTRIBUTION_THRESHOLD;
    const groups = new Map<string, MemoryRow[]>();
    for (const row of this.select(options)) {
      const weak = includeWeak && row.best_wallet_confidence < maxConfidence;
      if (row.is_unknown !== 1 && !weak) continue;
      const group = groups.get(row.signature);
      if (group) group.push(row);
      else groups.set(row.signature, [row]);
    }

    return [...groups.entries()]
      .filter(([, rows]) => rows.length >= minCount)
      .map(([signature, rows]) => ({
        signature,
        count: rows.length,
        examples: rows.slice(0, 5).map((r) => r.txid),
        labels: [...new Set(rows.flatMap((r) => r.labels))].join(','),
        avg_fee_rate: Number(mean(rows.map((r) => r.fee_rate)).toFixed(2)),
        avg_inputs: Number(mean(rows.map((r) => r.input_count)).toFixed(2)),
        avg_outputs: Number(mean(rows.map((r) => r.output_count)).toFixed(2)),
      }))
      .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature))
      .slice(0, capped(limit));
  }

  listTransactions(
    options: { limit?: number; excludeSpam?: boolean; unknownOnly?: boolean } = {},
  ): TransactionListRow[] {
    let rows = this.select(options);
    if (options.unknownOnly === true) rows = rows.filter((r) => r.is_unknown === 1);
    return rows
      .sort((a, b) => b.first_seen_at - a.first_seen_at)
      .slice(0, Math.max(1, options.limit ?? 25))
      .map((row) => toListRow(row));
  }

  /** Feature vectors of the rows the near-miss report samples. */
  featuresForResearch(
    limit = 5000,
    includeWeak = false,
    excludeSpam = false,
  ): TxFeatures[] {
    return this.select({ excludeSpam })
      .filter((row) => (includeWeak ? row.best_wallet_confidence < WEAK_ATTRIBUTION_THRESHOLD : row.is_unknown === 1))
      .slice(0, Math.max(1, Math.min(50_000, limit)))
      .map((row) => row.features);
  }

  /** Every row, newest first — the export path. */
  all(): Array<TransactionListRow & { features: TxFeatures }> {
    return [...this.rows.values()]
      .sort((a, b) => b.first_seen_at - a.first_seen_at)
      .map((row) => ({ ...toListRow(row), features: row.features }));
  }

  /** One transaction with its feature vector, for the detail panel. */
  byTxid(txid: string): (TransactionListRow & { features: TxFeatures }) | null {
    const row = this.rows.get(txid);
    return row ? { ...toListRow(row), features: row.features } : null;
  }

  /**
   * The detail panel payload, mirroring `research.explain` for a stored row.
   * Deriving it from the retained classification keeps the browser detail view
   * identical to the server one without a second match pass.
   */
  explain(txid: string): TxExplanation | null {
    const row = this.rows.get(txid.toLowerCase());
    if (!row) return null;
    const { tx, features, classification } = row;
    return {
      txid: row.txid,
      status: row.status,
      block_height: row.block_height,
      first_seen_at: row.first_seen_at,
      fee: row.fee,
      vsize: row.vsize,
      fee_rate: row.fee_rate,
      features,
      wallets: row.wallets,
      labels: row.labels,
      profiles: classification.profiles.map((p) => ({
        profileId: p.profileId,
        confidence: p.confidence,
        title: p.profileTitle,
        baseRate: p.baseRate,
        specificity: p.specificity,
      })),
      nearMisses: classification.nearMisses,
      inputs: (tx.vin ?? []).map((vin, idx) => ({
        idx,
        prev_txid: vin.txid ?? null,
        prev_vout: vin.vout ?? null,
        value: vin.prevout?.value ?? null,
        address: vin.prevout?.scriptpubkey_address ?? null,
        script_type: vin.prevout?.scriptpubkey_type ?? null,
      })),
      outputs: (tx.vout ?? []).map((vout, idx) => ({
        idx,
        value: vout.value,
        address: vout.scriptpubkey_address ?? null,
        script_type: vout.scriptpubkey_type ?? '',
        is_dust: isDustOutput(vout),
      })),
    };
  }
}

function toListRow(row: MemoryRow): TransactionListRow {
  return {
    txid: row.txid,
    first_seen_at: row.first_seen_at,
    status: row.status,
    block_height: row.block_height,
    version: row.version,
    locktime: row.locktime,
    fee: row.fee,
    fee_rate: row.fee_rate,
    vsize: row.vsize,
    input_count: row.input_count,
    output_count: row.output_count,
    wallet_count: row.wallet_count,
    best_wallet_confidence: row.best_wallet_confidence,
    is_unknown: row.is_unknown,
    signature: row.signature,
    labels_json: JSON.stringify(row.labels),
    wallets_json: JSON.stringify(row.wallets),
    spam_kind: row.spam_kind,
    category_id: row.category_id,
  };
}

/** `db.ts` caps the tag/cluster queries at 500 rows; mirror that exactly. */
function capped(value: number): number {
  return Math.max(1, Math.min(500, Math.floor(value)));
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}
