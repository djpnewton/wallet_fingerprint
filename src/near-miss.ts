/**
 * Near-miss analysis, over feature vectors rather than a store.
 *
 * A 'near miss' is a profile that satisfied only some of its conditions on an
 * unattributed transaction — the strongest evidence that a rule is *almost*
 * describing a group we cannot name yet, and therefore one condition too strict.
 *
 * Deliberately storage-free: the CLI computes it from SQLite and the static web
 * build computes it from its in-memory sample, using the same code.
 */

import { evaluateMatch } from './rules.ts';
import type { Profile, TxFeatures } from './types.ts';

export interface NearMissRow {
  profileId: string;
  title: string;
  /** Unknown txs that satisfy at least one condition of this profile. */
  txs: number;
  /** Mean fraction of conditions satisfied. */
  avgRatio: number;
  failed: Array<{ condition: string; count: number }>;
}

/**
 * Ranks profiles by how close they came to matching unattributed traffic.
 */
export function nearMissFromFeatures(

  features: Iterable<TxFeatures>,
  profiles: readonly Profile[],
  options: { top?: number } = {},
): NearMissRow[] {
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

