/**
 * Research tooling for the unknown pool.
 *
 * The point of storing unmatched transactions is to find the next fingerprint:
 * `clusters` groups them by coarse signature (a big cluster with no profile is
 * a missing rule), and `nearMisses` reports which conditions are *almost* met,
 * which is the fastest way to spot a rule that is one condition too strict.
 */

import type { Db } from './db.ts';
import { WEAK_ATTRIBUTION_THRESHOLD, parseLabels, walletsOf } from './db.ts';
import { evaluateMatch } from './fingerprints.ts';
import type { ClusterRow } from './db.ts';
import type { Profile, TxFeatures, WalletTag } from './types.ts';

export interface NearMissRow {
  profileId: string;
  title: string;
  /** Unknown txs that satisfy at least one condition of this profile. */
  txs: number;
  /** Mean fraction of conditions satisfied. */
  avgRatio: number;
  failed: Array<{ condition: string; count: number }>;
}

export interface UnknownTx {
  txid: string;
  first_seen_at: number;
  fee_rate: number;
  signature: string;
  features: TxFeatures;
  labels: string[];
  nearMisses: unknown;
}

export function clusters(
  db: Db,
  limit = 25,
  minCount = 2,
  options: { includeWeak?: boolean; maxConfidence?: number; excludeSpam?: boolean } = {},
): ClusterRow[] {
  return db.researchClusters(limit, minCount, options);
}

function researchFeatures(
  db: Db,
  sampleSize: number,
  includeWeak: boolean,
  excludeSpam: boolean,
): TxFeatures[] {
  const rows = db.db
    .prepare(
      `SELECT features_json FROM transactions
        WHERE (is_unknown = 1 OR (? = 1 AND best_wallet_confidence < ?))
          AND (? = 0 OR spam_kind IS NULL)
        ORDER BY first_seen_at DESC LIMIT ?`,
    )
    .all(
      includeWeak ? 1 : 0,
      WEAK_ATTRIBUTION_THRESHOLD,
      excludeSpam ? 1 : 0,
      Math.max(1, Math.min(50_000, sampleSize)),
    ) as Array<{
    features_json: string;
  }>;
  return rows.map((r) => JSON.parse(r.features_json) as TxFeatures);
}

export function nearMissReport(
  db: Db,
  profiles: readonly Profile[],
  options: {
    sampleSize?: number;
    top?: number;
    includeWeak?: boolean;
    excludeSpam?: boolean;
  } = {},
): NearMissRow[] {
  const features = researchFeatures(
    db,
    options.sampleSize ?? 5000,
    options.includeWeak ?? false,
    options.excludeSpam ?? false,
  );
  const accumulator = new Map<string, { txs: number; ratioSum: number; failed: Map<string, number> }>();

  for (const f of features) {
    for (const profile of profiles) {
      if (!profile.enabled) continue;
      const result = evaluateMatch(f, profile.match);
      if (result.ok) continue;
      const ratio = result.total > 0 ? result.passed / result.total : 0;
      if (ratio === 0) continue;
      const acc = accumulator.get(profile.id) ?? { txs: 0, ratioSum: 0, failed: new Map() };
      acc.txs++;
      acc.ratioSum += ratio;
      for (const cond of result.failed) acc.failed.set(cond, (acc.failed.get(cond) ?? 0) + 1);
      accumulator.set(profile.id, acc);
    }
  }

  const rows: NearMissRow[] = [];
  for (const [profileId, acc] of accumulator) {
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) continue;
    rows.push({
      profileId,
      title: profile.title,
      txs: acc.txs,
      avgRatio: Number((acc.ratioSum / acc.txs).toFixed(2)),
      failed: [...acc.failed.entries()]
        .map(([condition, count]) => ({ condition, count }))
        .sort((a, b) => b.count - a.count || a.condition.localeCompare(b.condition))
        .slice(0, 4),
    });
  }

  return rows
    .sort((a, b) => b.txs - a.txs || b.avgRatio - a.avgRatio)
    .slice(0, options.top ?? 15);
}

export function exportUnknown(
  db: Db,
  options: { limit?: number; includeWeak?: boolean; excludeSpam?: boolean } = {},
): UnknownTx[] {
  const limit = Math.max(1, Math.min(50_000, options.limit ?? 5000));
  const rows = db.db
    .prepare(
      `SELECT txid, first_seen_at, fee_rate, signature, features_json, labels_json, near_miss_json
         FROM transactions
        WHERE (is_unknown = 1 OR (? = 1 AND best_wallet_confidence < ?))
          AND (? = 0 OR spam_kind IS NULL)
        ORDER BY first_seen_at DESC LIMIT ?`,
    )
    .all(
      options.includeWeak ? 1 : 0,
      WEAK_ATTRIBUTION_THRESHOLD,
      options.excludeSpam ? 1 : 0,
      limit,
    ) as Array<{
    txid: string;
    first_seen_at: number;
    fee_rate: number;
    signature: string;
    features_json: string;
    labels_json: string;
    near_miss_json: string;
  }>;

  return rows.map((r) => ({
    txid: r.txid,
    first_seen_at: r.first_seen_at,
    fee_rate: r.fee_rate,
    signature: r.signature,
    features: JSON.parse(r.features_json) as TxFeatures,
    labels: JSON.parse(r.labels_json) as string[],
    nearMisses: JSON.parse(r.near_miss_json) as unknown,
  }));
}

export interface TxExplanation {
  txid: string;
  status: string;
  block_height: number | null;
  first_seen_at: number;
  fee: number;
  vsize: number;
  fee_rate: number;
  features: TxFeatures;
  wallets: WalletTag[];
  labels: string[];
  profiles: Array<{
    profileId: string;
    confidence: number;
    title: string;
    baseRate: number | null;
    specificity: number;
  }>;
  nearMisses: Array<{ profileId: string; title: string; ratio: number; failed: string[] }>;
  inputs: Array<{
    idx: number;
    prev_txid: string | null;
    prev_vout: number | null;
    value: number | null;
    address: string | null;
    script_type: string | null;
  }>;
  outputs: Array<{
    idx: number;
    value: number;
    address: string | null;
    script_type: string;
    is_dust: boolean;
  }>;
}

export function explain(db: Db, txid: string, profiles: readonly Profile[] = []): TxExplanation | null {
  const row = db.db
    .prepare(
      `SELECT txid, status, block_height, first_seen_at, fee, vsize, fee_rate, features_json,
              wallets_json, labels_json, profile_ids_json, near_miss_json
         FROM transactions WHERE txid = ?`,
    )
    .get(txid.toLowerCase()) as
    | {
        txid: string;
        status: string;
        block_height: number | null;
        first_seen_at: number;
        fee: number;
        vsize: number;
        fee_rate: number;
        features_json: string;
        wallets_json: string;
        labels_json: string;
        profile_ids_json: string;
        near_miss_json: string;
      }
    | undefined;
  if (!row) return null;

  const profileIds = JSON.parse(row.profile_ids_json) as string[];
  const byId = new Map(profiles.map((p) => [p.id, p]));

  const inputs = db.db
    .prepare(
      'SELECT idx, prev_txid, prev_vout, value, address, script_type FROM tx_inputs WHERE txid = ? ORDER BY idx',
    )
    .all(txid) as TxExplanation['inputs'];
  const outputs = db.db
    .prepare('SELECT idx, value, address, script_type, is_dust FROM tx_outputs WHERE txid = ? ORDER BY idx')
    .all(txid) as Array<{
    idx: number;
    value: number;
    address: string | null;
    script_type: string;
    is_dust: number;
  }>;

  return {
    txid: row.txid,
    status: row.status,
    block_height: row.block_height,
    first_seen_at: row.first_seen_at,
    fee: row.fee,
    vsize: row.vsize,
    fee_rate: row.fee_rate,
    features: JSON.parse(row.features_json) as TxFeatures,
    wallets: walletsOf({ wallets_json: row.wallets_json }),
    labels: parseLabels({ labels_json: row.labels_json }),
    profiles: profileIds.map((profileId) => {
      const profile = byId.get(profileId);
      return {
        profileId,
        confidence: profile?.confidence ?? 0,
        title: profile?.title ?? profileId,
        baseRate: profile?.baseRate ?? null,
        specificity: profile?.specificity ?? 1,
      };
    }),
    nearMisses: JSON.parse(row.near_miss_json) as TxExplanation['nearMisses'],
    inputs: inputs.map((i) => ({ ...i })),
    outputs: outputs.map((o) => ({ ...o, is_dust: Boolean(o.is_dust) })),
  };
}
