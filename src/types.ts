/**
 * Shared types for the mempool.space ingest path and the fingerprint engine.
 *
 * The transaction shape mirrors `GET /api/tx/{txid}` from mempool.space (an
 * Esplora-compatible REST API). Only the fields we consume are declared.
 */

export interface MempoolPrevout {
  scriptpubkey: string;
  scriptpubkey_asm?: string;
  scriptpubkey_type: string;
  scriptpubkey_address?: string;
  value: number;
}

export interface MempoolVin {
  txid: string;
  vout: number;
  prevout: MempoolPrevout | null;
  scriptsig: string;
  scriptsig_asm?: string;
  witness?: string[];
  is_coinbase: boolean;
  sequence: number;
  inner_redeemscript_asm?: string;
  inner_witnessscript_asm?: string;
}

export interface MempoolVout {
  scriptpubkey: string;
  scriptpubkey_asm?: string;
  scriptpubkey_type: string;
  scriptpubkey_address?: string;
  value: number;
}

export interface MempoolTxStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}

export interface MempoolTx {
  txid: string;
  version: number;
  locktime: number;
  vin: MempoolVin[];
  vout: MempoolVout[];
  size: number;
  weight: number;
  fee: number;
  sigops?: number;
  status?: MempoolTxStatus;
}

/** Compact entry from the websocket `transactions` feed and `/api/mempool/recent`. */
export interface MempoolRecentTx {
  txid: string;
  fee: number;
  vsize: number;
  value: number;
  rate?: number;
  time?: number;
}

export interface MempoolStats {
  count: number;
  vsize: number;
  total_fee: number;
  fee_histogram?: [number, number][];
}

export interface BlockSummary {
  id: string;
  height: number;
  timestamp: number;
  tx_count: number;
}

export type FeatureScalar = string | number | boolean | null;
export type FeatureValue = FeatureScalar | string[] | number[];

/**
 * Every observable, wallet-controlled property we extract from a transaction.
 * Keys are flat so the rule engine can address them by name from YAML.
 */
export interface TxFeatures {
  txid: string;
  first_seen_at: number;
  tip_height_at_seen: number | null;

  // transaction header
  version: number;
  locktime: number;
  locktime_class: string;
  locktime_tip_delta: number | null;
  rbf_enabled_by_locktime: boolean;

  // size / fee
  size: number;
  weight: number;
  vsize: number;
  fee: number;
  fee_rate: number;
  fee_rate_bucket: string;
  fee_round_10: boolean;
  fee_round_100: boolean;

  // shape
  input_count: number;
  output_count: number;
  io_ratio_bucket: string;
  input_value_bucket: string;

  // script types
  input_script_types: string[];
  output_script_types: string[];
  input_types: string[];
  output_types: string[];
  input_type_profile: string;
  output_type_profile: string;
  all_inputs_same_type: boolean;
  all_outputs_same_type: boolean;
  segwit_inputs: number;
  taproot_inputs: number;
  legacy_inputs: number;
  nested_segwit_inputs: number;
  p2tr_keypath_inputs: number;
  p2tr_scriptpath_inputs: number;
  p2wsh_multisig_inputs: number;
  /** Inputs whose revealed witness script commits to a CSV or CLTV timelock. */
  timelock_inputs: number;
  /** Inputs whose timelocked script is also a bare multisig. */
  timelocked_multisig_inputs: number;
  /** Distinct OP_CSV operands (relative locktime, blocks or 512s units). */
  witness_csv_values: number[];
  /** Distinct OP_CLTV operands (height or unix time). */
  witness_cltv_values: number[];
  /** Threshold (m) and participant count (n) read from the first multisig script we find. */
  multisig_m: number | null;
  multisig_n: number | null;
  witness_shapes: string[];
  scriptsig_count: number;

  // sequence / RBF
  sequence_values: number[];
  sequence_profile: string;
  is_rbf: boolean;
  all_final_sequences: boolean;
  has_relative_locktime: boolean;
  distinct_sequence_values: number;

  // ordering
  bip69_inputs: boolean;
  bip69_outputs: boolean;
  output_order: string;
  change_index: number | null;
  change_position: string;
  change_script_type: string | null;
  change_matches_input_type: boolean;

  // addresses
  address_reuse: boolean;
  distinct_input_addresses: number;
  distinct_output_addresses: number;

  // extra outputs / protocols
  op_return_count: number;
  op_return_protocols: string[];
  has_op_return: boolean;
  has_inscription_envelope: boolean;
  has_anchor_output: boolean;
  /**
   * Coarse junk classification: `runes`, `inscription`, `data-carrier` or
   * `dust`. Null means ordinary payment activity. Reported separately so spam
   * can be hidden without mislabelling it as a wallet signature.
   */
  spam_kind: string | null;

  // value policy
  total_input_value: number | null;
  total_output_value: number;
  known_input_values: boolean;
  dust_output_count: number;
  has_dust_output: boolean;
  equal_output_max: number;
  equal_output_groups: number;
  round_outputs_1000: number;
  round_outputs_10000: number;
  all_outputs_round_1000: boolean;

  // structure heuristics
  is_coinjoin_like: boolean;
  is_consolidation: boolean;
  is_payment_batching: boolean;

  /** Coarse cluster key used to group unclassified transactions for research. */
  signature: string;
}

export type CompareOp =
  | 'eq'
  | 'ne'
  | 'in'
  | 'notIn'
  | 'gte'
  | 'gt'
  | 'lte'
  | 'lt'
  | 'between'
  | 'contains'
  | 'notContains'
  | 'containsAny'
  | 'containsAll'
  | 'containsNone'
  | 'subsetOf'
  | 'exists'
  | 'absent';

export interface Condition {
  feature: string;
  op?: CompareOp;
  value?: FeatureValue | FeatureValue[];
}

export interface MatchSpec {
  /** Every condition must hold. */
  all?: Condition[];
  /** At least one condition must hold (combined with `all` using AND). */
  any?: Condition[];
}

/**
 * What kind of actor an attribution names.
 *
 * `software` is a product someone installs (Bitcoin Core, Xverse, ord).
 * `archetype` is a description of the builder — "generic custodial send",
 * "Runes mint tooling (change-first)" — which is a real finding about the
 * transaction but is not a vendor. Keeping them apart stops a category's
 * candidate list from filling up with near-synonyms of its own title.
 */
export type AttributionKind = 'software' | 'archetype';

export interface WalletAttribution {
  name: string;
  confidence: number;
  kind: AttributionKind;
  note?: string;
}

export interface Profile {
  id: string;
  family: string;
  title: string;
  summary: string;
  confidence: number;
  evidence: string[];
  match: MatchSpec;
  wallets: WalletAttribution[];
  labels: string[];
  enabled: boolean;
  /**
   * Fraction of the observed corpus this profile matches, measured from the
   * database. `null` when there is not enough data to measure it.
   */
  baseRate: number | null;
  /**
   * Informativeness factor in [0, 1] derived from `baseRate`: a signature that
   * fires on half the mempool cannot distinguish anything, so it must not
   * produce confident wallet attributions.
   */
  specificity: number;
}

/**
 * A wallet category is an exclusive bucket: every transaction lands in exactly
 * one. Categories are declared as groups of fingerprints evaluated in priority
 * order (first match wins), which keeps the matching conditions in one place
 * while giving the corpus a partition that can be added up.
 */
export interface Category {
  id: string;
  title: string;
  description: string;
  /** Fingerprints whose match puts a transaction in this category. */
  anyOf: string[];
  /** Extra wallet tags for the category, merged with the member fingerprints'. */
  wallets: WalletAttribution[];
  labels: string[];
  enabled: boolean;
}

/** The exclusive assignment for one transaction. */
export interface CategoryMatch {
  id: string;
  title: string;
  /** Fingerprint that put the transaction here, or null for the fallback. */
  viaProfile: string | null;
}

export interface ProfileMatch {
  profileId: string;
  profileTitle: string;
  family: string;
  confidence: number;
  baseRate: number | null;
  specificity: number;
  labels: string[];
}

export interface WalletTag {
  name: string;
  /** Combined plausibility across every matching profile, in [0, 1]. */
  confidence: number;
  /** Specificity of the most informative profile backing this tag, in [0, 1]. */
  specificity: number;
  /** Profiles that produced this tag, strongest first. */
  profiles: string[];
}

export interface NearMiss {
  profileId: string;
  title: string;
  /** Fraction of conditions that held, in [0, 1]. */
  ratio: number;
  failed: string[];
}

export interface Classification {
  /** Exactly one category per transaction. */
  category: CategoryMatch;
  profiles: ProfileMatch[];
  wallets: WalletTag[];
  labels: string[];
  isUnknown: boolean;
  nearMisses: NearMiss[];
}

export interface ClassifiedTx {
  tx: MempoolTx;
  features: TxFeatures;
  classification: Classification;
}

export interface IngestContext {
  tipHeight: number | null;
  now: number;
}
