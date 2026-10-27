/**
 * Shared reporting: everything the CLI prints and the dashboard serves is built
 * here, so both surfaces always agree.
 */

import type { ClusterRow, Db } from './db.ts';
import { parseLabels, walletsOf } from './db.ts';
import { UNCLASSIFIED_CATEGORY } from './fingerprints.ts';
import type { Category, Profile, WalletAttribution, WalletTag } from './types.ts';

/**
 * One row of the fingerprint panel.
 *
 * The fingerprint, not the wallet, is the unit of evidence: every wallet listed
 * by a matching profile is equally consistent with the transaction, so a
 * per-wallet ranking invents distinctions the data does not contain.
 */
export interface FingerprintRow {
  id: string;
  family: string;
  title: string;
  summary: string;
  confidence: number;
  /** Fraction of the (filtered) corpus this fingerprint matched. */
  prevalence: number;
  txs: number;
  specificity: number;
  labels: string[];
  wallets: WalletAttribution[];
}

/** One row of the exclusive Wallets tab. */
export interface WalletCategoryRow {
  id: string;
  title: string;
  description: string;
  txs: number;
  prevalence: number;
  labels: string[];
  /** Fingerprints that feed this category, with their own transaction counts. */
  fingerprints: Array<{ id: string; title: string; txs: number }>;
  /** Candidate wallet tags, merged from the member fingerprints. */
  wallets: WalletAttribution[];
}

export interface StatsReport {
  generatedAt: number;
  summary: ReturnType<Db['summary']>;
  /** Digest of the rule set currently loaded. */
  rulesFingerprint: string;
  labels: ReturnType<Db['labelCounts']>;
  profiles: ReturnType<Db['profileCounts']>;
  clusters: ClusterRow[];
  recent: RecentRow[];
  spam: Array<{ kind: string; txs: number }>;
  fingerprints: FingerprintRow[];
  categories: WalletCategoryRow[];
}

export interface RecentRow {
  txid: string;
  first_seen_at: number;
  status: string;
  fee_rate: number;
  input_count: number;
  output_count: number;
  is_unknown: boolean;
  spam_kind: string | null;
  labels: string[];
  wallets: WalletTag[];
}

function fingerprintRows(
  db: Db,
  profiles: readonly Profile[],
  walletLimit: number,
  excludeSpam: boolean,
): FingerprintRow[] {
  const counts = new Map(db.profileCounts(500, { excludeSpam }).map((c) => [c.profileId, c.txs]));
  const total = db.summary(null, { excludeSpam }).total;
  return profiles
    .filter((profile) => profile.enabled)
    .map((profile) => {
      const txs = counts.get(profile.id) ?? 0;
      return {
        id: profile.id,
        family: profile.family,
        title: profile.title,
        summary: profile.summary,
        confidence: profile.confidence,
        prevalence: total > 0 ? txs / total : 0,
        txs,
        specificity: profile.specificity,
        labels: profile.labels,
        wallets: [...profile.wallets]
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, walletLimit),
      };
    })
    .sort((a, b) => b.txs - a.txs || a.id.localeCompare(b.id));
}

export function toRecentRow(row: ReturnType<Db['listTransactions']>[number]): RecentRow {
  return {
    txid: row.txid,
    first_seen_at: row.first_seen_at,
    status: row.status,
    fee_rate: row.fee_rate,
    input_count: row.input_count,
    output_count: row.output_count,
    is_unknown: row.is_unknown === 1,
    spam_kind: row.spam_kind ?? null,
    labels: parseLabels(row),
    wallets: walletsOf(row),
  };
}

/**
 * Merges the candidate wallets of a category's fingerprints.
 *
 * Only real software is listed. A category already *is* a behaviour
 * description, so folding in archetypes from its fingerprints ("Runes mint
 * tooling (change-first)", "generic custodial send") just repeats the title in
 * near-synonyms — that is the redundancy this filter removes. Archetypes are
 * still shown on the fingerprint itself, where they are the actual finding.
 *
 * Falls back to archetypes only when the category can name no software at all,
 * so broad buckets still say something.
 */
function mergeWallets(profiles: readonly Profile[]): WalletAttribution[] {
  const byName = new Map<string, WalletAttribution>();
  for (const profile of profiles) {
    for (const wallet of profile.wallets) {
      const existing = byName.get(wallet.name);
      if (!existing || wallet.confidence > existing.confidence) {
        byName.set(wallet.name, wallet);
      }
    }
  }
  const merged = [...byName.values()];
  const software = merged.filter((w) => w.kind === 'software');
  const chosen = software.length > 0 ? software : merged;
  return chosen.sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
}

function categoryRows(
  db: Db,
  profiles: readonly Profile[],
  categories: readonly Category[],
  options: { excludeSpam?: boolean } = {},
): WalletCategoryRow[] {
  const excluded = options.excludeSpam === true;
  const counts = db.categoryCounts({ excludeSpam: excluded });
  const profileCounts = new Map(db.profileCounts(500, { excludeSpam: excluded }).map((c) => [c.profileId, c.txs]));
  const total = db.summary(null, { excludeSpam: excluded }).total;
  const byId = new Map(profiles.map((p) => [p.id, p]));

  const rows: WalletCategoryRow[] = categories
    .filter((category) => category.enabled)
    .map((category) => {
      const members = category.anyOf
        .map((id) => byId.get(id))
        .filter((p): p is Profile => p !== undefined);
      return {
        id: category.id,
        title: category.title,
        description: category.description,
        txs: counts.get(category.id) ?? 0,
        prevalence: total > 0 ? (counts.get(category.id) ?? 0) / total : 0,
        labels: category.labels,
        fingerprints: members.map((p) => ({
          id: p.id,
          title: p.title,
          txs: profileCounts.get(p.id) ?? 0,
        })),
        wallets: mergeWallets(members),
      };
    });

  rows.push({
    id: UNCLASSIFIED_CATEGORY.id,
    title: UNCLASSIFIED_CATEGORY.title,
    description: UNCLASSIFIED_CATEGORY.description,
    txs: counts.get(UNCLASSIFIED_CATEGORY.id) ?? 0,
    prevalence: total > 0 ? (counts.get(UNCLASSIFIED_CATEGORY.id) ?? 0) / total : 0,
    labels: [],
    fingerprints: [],
    wallets: [],
  });

  return rows.sort((a, b) => b.txs - a.txs || a.id.localeCompare(b.id));
}

export function buildStats(
  db: Db,
  rulesFingerprint: string,
  profiles: readonly Profile[],
  categories: readonly Category[],
  options: {
    recentLimit?: number;
    clusterLimit?: number;
    /** Include weakly attributed transactions in the research clusters. */
    includeWeak?: boolean;
    /** Exclude Runes/Ordinals/data-carrier traffic from every statistic. */
    excludeSpam?: boolean;
  } = {},
): StatsReport {
  return {
    generatedAt: Math.floor(Date.now() / 1000),
    summary: db.summary(rulesFingerprint, { excludeSpam: options.excludeSpam }),
    rulesFingerprint,
    labels: db.labelCounts(40, { excludeSpam: options.excludeSpam }),
    profiles: db.profileCounts(40, { excludeSpam: options.excludeSpam }),
    clusters: db.researchClusters(options.clusterLimit ?? 15, 2, {
      includeWeak: options.includeWeak ?? true,
      excludeSpam: options.excludeSpam,
    }),
    recent: db
      .listTransactions({ limit: options.recentLimit ?? 25, excludeSpam: options.excludeSpam })
      .map(toRecentRow),
    spam: db.spamBreakdown(),
    fingerprints: fingerprintRows(db, profiles, 25, options.excludeSpam === true),
    categories: categoryRows(db, profiles, categories, { excludeSpam: options.excludeSpam }),
  };
}
