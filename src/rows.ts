/**
 * Storage-agnostic row shapes and accessors.
 *
 * `report.ts` builds every surface (CLI, dashboard, static web build) from these
 * types, so they cannot live in `db.ts` — that module imports `node:sqlite`,
 * which a browser bundle must never pull in.
 */

import type { TxFeatures, WalletTag } from './types.ts';

/** Matches below this best-wallet confidence are treated as research material. */
export const WEAK_ATTRIBUTION_THRESHOLD = 0.35;

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

/** Detail-panel payload: everything one transaction can be explained with. */
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
