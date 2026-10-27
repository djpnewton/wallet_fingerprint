/**
 * Fingerprint rule engine.
 *
 * Rules are data (YAML), not code: each profile describes one observable
 * behavioural signature and the wallet software that plausibly produces it.
 * A transaction is matched against every enabled profile independently, so a
 * single transaction can carry several candidate wallets -- which is the point.
 * Attributions are combined with a noisy-OR, so agreement between independent
 * signatures raises confidence while a lone weak signature stays weak.
 *
 * This module is deliberately free of Node built-ins: the same engine runs in
 * the CLI, the dashboard and the static browser build, so an attribution can
 * never differ between them.
 */

import { parse as parseYaml } from 'yaml';
import { FEATURE_NAMES } from './features.ts';
import type {
  Category,
  CategoryMatch,
  Classification,
  CompareOp,
  Condition,
  FeatureValue,
  MatchSpec,
  NearMiss,
  Profile,
  ProfileMatch,
  TxFeatures,
  WalletTag,
} from './types.ts';

const OPS: ReadonlySet<string> = new Set<CompareOp>([
  'eq',
  'ne',
  'in',
  'notIn',
  'gte',
  'gt',
  'lte',
  'lt',
  'between',
  'contains',
  'notContains',
  'containsAny',
  'containsAll',
  'containsNone',
  'subsetOf',
  'exists',
  'absent',
]);

export class RuleError extends Error {}

function asRecord(features: TxFeatures): Record<string, FeatureValue> {
  return features as unknown as Record<string, FeatureValue>;
}

function isArray(v: unknown): v is Array<string | number> {
  return Array.isArray(v);
}

function asList(v: unknown): Array<string | number> {
  if (isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v as string | number];
}

function numeric(v: FeatureValue | undefined): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

function looseEqual(a: FeatureValue | undefined, b: unknown): boolean {
  if (a === undefined || a === null) return b === null || b === undefined;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

export function evaluateCondition(features: TxFeatures, cond: Condition): boolean {
  const record = asRecord(features);
  const actual = record[cond.feature];
  const op: CompareOp = cond.op ?? 'eq';
  const expected = cond.value;

  switch (op) {
    case 'exists':
      if (actual === null || actual === undefined) return false;
      if (isArray(actual)) return actual.length > 0;
      if (typeof actual === 'string') return actual.length > 0;
      return true;
    case 'absent':
      if (actual === null || actual === undefined) return true;
      if (isArray(actual)) return actual.length === 0;
      if (typeof actual === 'string') return actual.length === 0;
      return false;
    case 'eq':
      return looseEqual(actual, expected);
    case 'ne':
      return !looseEqual(actual, expected);
    case 'in':
      return asList(expected).some((v) => looseEqual(actual, v));
    case 'notIn':
      return !asList(expected).some((v) => looseEqual(actual, v));
    case 'gte':
    case 'gt':
    case 'lte':
    case 'lt':
    case 'between': {
      const a = numeric(actual);
      if (a === null) return false;
      if (op === 'between') {
        const bounds = asList(expected).map((v) => Number(v));
        const [lo, hi] = [bounds[0], bounds[1]];
        if (lo === undefined || hi === undefined) return false;
        return a >= lo && a <= hi;
      }
      const b = Number(expected);
      if (Number.isNaN(b)) return false;
      if (op === 'gte') return a >= b;
      if (op === 'gt') return a > b;
      if (op === 'lte') return a <= b;
      return a < b;
    }
    case 'contains':
      if (isArray(actual)) return actual.some((v) => looseEqual(v as FeatureValue, expected));
      if (typeof actual === 'string') return actual.includes(String(expected));
      return false;
    case 'notContains':
      return !evaluateCondition(features, { ...cond, op: 'contains' });
    case 'containsAny':
      return asList(expected).some((v) => evaluateCondition(features, { feature: cond.feature, op: 'contains', value: v as FeatureValue }));
    case 'containsAll':
      return asList(expected).every((v) => evaluateCondition(features, { feature: cond.feature, op: 'contains', value: v as FeatureValue }));
    case 'containsNone':
      return !asList(expected).some((v) => evaluateCondition(features, { feature: cond.feature, op: 'contains', value: v as FeatureValue }));
    case 'subsetOf': {
      const allowed = new Set(asList(expected).map(String));
      if (!isArray(actual)) return false;
      return actual.every((v) => allowed.has(String(v)));
    }
    default:
      throw new RuleError(`unknown operator: ${String(op)}`);
  }
}

export function describeCondition(cond: Condition): string {
  return `${cond.feature} ${cond.op ?? 'eq'} ${JSON.stringify(cond.value ?? true)}`;
}

export interface MatchResult {
  ok: boolean;
  passed: number;
  total: number;
  failed: string[];
}

export function evaluateMatch(features: TxFeatures, spec: MatchSpec): MatchResult {
  const failed: string[] = [];
  let passed = 0;
  let total = 0;

  for (const cond of spec.all ?? []) {
    total++;
    if (evaluateCondition(features, cond)) passed++;
    else failed.push(describeCondition(cond));
  }

  if (spec.any && spec.any.length > 0) {
    const anyPassed = spec.any.some((cond) => evaluateCondition(features, cond));
    total++;
    if (anyPassed) passed++;
    else failed.push(`any(${spec.any.map(describeCondition).join(' | ')})`);
  }

  return { ok: failed.length === 0 && total > 0, passed, total, failed };
}

/**
 * Bumped whenever the meaning of a stored classification changes (new features,
 * changed confidence maths). Part of the rules fingerprint, so stored rows are
 * flagged stale when the engine moves underneath them.
 */
export const ENGINE_VERSION = 2;

/**
 * Bits of surprise a signature must carry to earn full plausibility weight.
 * 4 bits ≈ a signature that fires on at most 6.25% of traffic. Anything broader
 * is, by construction, close to the network's modal behaviour and cannot
 * distinguish wallet software.
 */
export const REFERENCE_BITS = 4;

/**
 * Informativeness of a signature, from how often it fires.
 *
 * This is the correction that keeps broad buckets honest: `v2 + no locktime +
 * RBF + segwit` describes roughly 60% of today's mempool (mostly Runes spam), so
 * it should not be able to hand out 25% plausibility to six different wallets.
 * Its self-information is only 0.7 bits, so it contributes ~18% of full weight.
 */
export function specificityFromBaseRate(baseRate: number | null): number {
  if (baseRate === null || !Number.isFinite(baseRate)) return 1;
  if (baseRate <= 0) return 1;
  if (baseRate >= 1) return 0;
  const bits = Math.log2(1 / baseRate);
  return Math.min(1, Math.max(0, bits / REFERENCE_BITS));
}

/**
 * Returns copies of the profiles with measured base rates applied. Counts come
 * from the stored `profile_ids_json`, so this is a cheap GROUP BY rather than a
 * re-match of the whole corpus.
 */
export function withBaseRates(
  profiles: readonly Profile[],
  matches: ReadonlyMap<string, number>,
  total: number,
): Profile[] {
  return profiles.map((profile) => {
    if (total <= 0) return { ...profile, baseRate: null, specificity: 1 };
    // Laplace smoothing: an unobserved profile gets a small but non-zero rate
    // instead of infinite information.
    const baseRate = ((matches.get(profile.id) ?? 0) + 0.5) / (total + 1);
    return { ...profile, baseRate, specificity: specificityFromBaseRate(baseRate) };
  });
}

/**
 * Attribution weight for one profile.
 *
 * Prevalence normally discounts a signature, because a shape half the mempool
 * emits cannot distinguish wallet software. Protocol markers are the exception:
 * a Runes payload is a *categorical* constraint — only software that understands
 * Runes can emit it — and its high prevalence reflects the mempool being flooded
 * with that protocol, not ambiguity about which wallet built the transaction.
 * Discounting it would make every protocol fingerprint invisible.
 *
 * The shape-level profiles still carry the refinement (change position, output
 * ordering), so the two levels compose: protocol narrows the wallet family, the
 * shape picks out the implementation.
 */
export function attributionWeight(profile: Profile): number {
  return profile.family === 'protocol' ? 1 : profile.specificity;
}

/** Noisy-OR: independent signatures pointing at the same wallet reinforce. */
function combineConfidence(values: number[]): number {
  let miss = 1;
  for (const v of values) miss *= 1 - Math.min(0.99, Math.max(0, v));
  return Math.min(0.99, 1 - miss);
}

const MAX_NEAR_MISSES = 3;
const NEAR_MISS_THRESHOLD = 0.5;

/** Fallback category for transactions no category claims. */
export const UNCLASSIFIED_CATEGORY: Category = {
  id: 'unclassified',
  title: 'Unclassified',
  description: 'Matched no wallet category: kept for research.',
  anyOf: [],
  wallets: [],
  labels: [],
  enabled: true,
};

/**
 * Assigns the exclusive category: the first category (in declaration order)
 * with at least one matching fingerprint wins.
 *
 * Order is therefore priority, and the rule file puts the most specific shapes
 * first so a CoinJoin is never filed under "address reuse".
 */
export function assignCategory(
  matchedProfileIds: ReadonlySet<string>,
  categories: readonly Category[],
): CategoryMatch {
  for (const category of categories) {
    if (!category.enabled) continue;
    const via = category.anyOf.find((id) => matchedProfileIds.has(id));
    if (via !== undefined) {
      return { id: category.id, title: category.title, viaProfile: via };
    }
  }
  return {
    id: UNCLASSIFIED_CATEGORY.id,
    title: UNCLASSIFIED_CATEGORY.title,
    viaProfile: null,
  };
}

export function classify(
  features: TxFeatures,
  profiles: readonly Profile[],
  categories: readonly Category[] = [],
): Classification {
  const matched: ProfileMatch[] = [];
  const walletAccumulator = new Map<
    string,
    { values: number[]; profiles: string[]; specificity: number }
  >();
  const labels = new Set<string>();
  const nearMisses: NearMiss[] = [];

  for (const profile of profiles) {
    if (!profile.enabled) continue;
    const result = evaluateMatch(features, profile.match);
    if (result.ok) {
      matched.push({
        profileId: profile.id,
        profileTitle: profile.title,
        family: profile.family,
        confidence: profile.confidence,
        baseRate: profile.baseRate,
        specificity: profile.specificity,
        labels: profile.labels,
      });
      for (const label of profile.labels) labels.add(label);
      for (const wallet of profile.wallets) {
        const existing = walletAccumulator.get(wallet.name) ?? {
          values: [],
          profiles: [],
          specificity: 0,
        };
        // Specificity discounts attribution only; labels stay factual.
        existing.values.push(profile.confidence * wallet.confidence * attributionWeight(profile));
        existing.profiles.push(profile.id);
        existing.specificity = Math.max(existing.specificity, profile.specificity);
        walletAccumulator.set(wallet.name, existing);
      }
    } else if (result.total > 0) {
      const ratio = result.passed / result.total;
      if (ratio >= NEAR_MISS_THRESHOLD) {
        nearMisses.push({
          profileId: profile.id,
          title: profile.title,
          ratio: Number(ratio.toFixed(2)),
          failed: result.failed,
        });
      }
    }
  }

  const wallets: WalletTag[] = [...walletAccumulator.entries()]
    .map(([name, acc]) => ({
      name,
      confidence: Number(combineConfidence(acc.values).toFixed(3)),
      specificity: Number(acc.specificity.toFixed(3)),
      profiles: acc.profiles,
    }))
    .filter((wallet) => wallet.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));

  nearMisses.sort((a, b) => b.ratio - a.ratio || a.profileId.localeCompare(b.profileId));

  const category = assignCategory(
    new Set(matched.map((m) => m.profileId)),
    categories,
  );

  return {
    category,
    profiles: matched.sort(
      (a, b) => b.confidence - a.confidence || a.profileId.localeCompare(b.profileId),
    ),
    wallets,
    labels: [...labels].sort(),
    isUnknown: wallets.length === 0,
    nearMisses: nearMisses.slice(0, MAX_NEAR_MISSES),
  };
}

interface RawRulesFile {
  version?: number;
  profiles?: unknown;
  categories?: unknown;
}

function validateProfile(raw: unknown, source: string, index: number): Profile {
  const where = `${source}: profiles[${index}]`;
  if (typeof raw !== 'object' || raw === null) throw new RuleError(`${where} must be a mapping`);
  const obj = raw as Record<string, unknown>;

  const id = obj.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new RuleError(`${where} has invalid id ${JSON.stringify(id)} (use kebab-case)`);
  }
  const confidence = obj.confidence;
  if (typeof confidence !== 'number' || confidence <= 0 || confidence > 1) {
    throw new RuleError(`${where} (${id}) needs confidence in (0, 1]`);
  }
  const match = obj.match as MatchSpec | undefined;
  if (!match || (!match.all && !match.any)) {
    throw new RuleError(`${where} (${id}) needs match.all and/or match.any`);
  }
  const conds = [...(match.all ?? []), ...(match.any ?? [])];
  if (conds.length === 0) throw new RuleError(`${where} (${id}) has an empty match`);
  for (const cond of conds) {
    if (typeof cond?.feature !== 'string') {
      throw new RuleError(`${where} (${id}) has a condition without a feature`);
    }
    if (!FEATURE_NAMES.has(cond.feature)) {
      throw new RuleError(
        `${where} (${id}) references unknown feature "${cond.feature}". See docs/FEATURES.md.`,
      );
    }
    if (cond.op && !OPS.has(cond.op)) {
      throw new RuleError(`${where} (${id}) uses unknown operator "${cond.op}"`);
    }
  }

  const walletsRaw = obj.wallets ?? [];
  if (!Array.isArray(walletsRaw)) throw new RuleError(`${where} (${id}) wallets must be a list`);
  const wallets = walletsRaw.map((w, i) => {
    if (typeof w !== 'object' || w === null) {
      throw new RuleError(`${where} (${id}) wallets[${i}] must be a mapping`);
    }
    const wallet = w as Record<string, unknown>;
    if (typeof wallet.name !== 'string' || wallet.name.length === 0) {
      throw new RuleError(`${where} (${id}) wallets[${i}].name is required`);
    }
    const c = wallet.confidence;
    if (typeof c !== 'number' || c <= 0 || c > 1) {
      throw new RuleError(`${where} (${id}) wallets[${i}] (${wallet.name}) needs confidence in (0, 1]`);
    }
    const kind = wallet.kind === 'archetype' ? 'archetype' : 'software';
    return {
      name: wallet.name,
      confidence: c,
      kind: kind as 'software' | 'archetype',
      ...(typeof wallet.note === 'string' ? { note: wallet.note } : {}),
    };
  });

  const labels = asList(obj.labels as FeatureValue | undefined).map(String);

  return {
    id,
    family: typeof obj.family === 'string' ? obj.family : 'other',
    title: typeof obj.title === 'string' ? obj.title : id,
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    confidence,
    evidence: asList(obj.evidence as FeatureValue | undefined).map(String),
    match,
    wallets,
    labels,
    enabled: obj.enabled !== false,
    baseRate: null,
    specificity: 1,
  };
}

export interface ProfileSet {
  profiles: Profile[];
  byId: Map<string, Profile>;
  categories: Category[];
}

function validateCategory(raw: unknown, source: string, index: number, profileIds: Set<string>): Category {
  const where = `${source}: categories[${index}]`;
  if (typeof raw !== 'object' || raw === null) throw new RuleError(`${where} must be a mapping`);
  const obj = raw as Record<string, unknown>;

  const id = obj.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new RuleError(`${where} has invalid id ${JSON.stringify(id)} (use kebab-case)`);
  }
  const anyOf = asList(obj.anyOf as FeatureValue | undefined).map(String);
  if (anyOf.length === 0) {
    throw new RuleError(`${where} (${id}) needs a non-empty anyOf list of fingerprint ids`);
  }
  for (const ref of anyOf) {
    if (!profileIds.has(ref)) {
      throw new RuleError(`${where} (${id}) references unknown fingerprint "${ref}"`);
    }
  }

  const walletsRaw = obj.wallets ?? [];
  if (!Array.isArray(walletsRaw)) throw new RuleError(`${where} (${id}) wallets must be a list`);
  const wallets = walletsRaw.map((w, i) => {
    if (typeof w !== 'object' || w === null) {
      throw new RuleError(`${where} (${id}) wallets[${i}] must be a mapping`);
    }
    const wallet = w as Record<string, unknown>;
    if (typeof wallet.name !== 'string' || wallet.name.length === 0) {
      throw new RuleError(`${where} (${id}) wallets[${i}].name is required`);
    }
    const c = wallet.confidence;
    if (typeof c !== 'number' || c <= 0 || c > 1) {
      throw new RuleError(`${where} (${id}) wallets[${i}] needs confidence in (0, 1]`);
    }
    const kind = wallet.kind === 'archetype' ? 'archetype' : 'software';
    return {
      name: wallet.name,
      confidence: c,
      kind: kind as 'software' | 'archetype',
      ...(typeof wallet.note === 'string' ? { note: wallet.note } : {}),
    };
  });

  return {
    id,
    title: typeof obj.title === 'string' ? obj.title : id,
    description: typeof obj.description === 'string' ? obj.description : '',
    anyOf,
    wallets,
    labels: asList(obj.labels as FeatureValue | undefined).map(String),
    enabled: obj.enabled !== false,
  };
}


/** A rule file that has been parsed but not yet validated or merged. */
export interface RuleDocument {
  source: string;
  data: RawRulesFile;
}

/**
 * Parses one YAML rule document. Validation is deferred to `buildProfileSet`
 * because an overlay may add profiles that an earlier document refers to.
 */
export function parseRulesDocument(text: string, source: string): RuleDocument {
  const data = parseYaml(text) as RawRulesFile | null;
  if (data === null || typeof data !== 'object') {
    throw new RuleError(`${source}: expected a YAML mapping`);
  }
  return { source, data };
}

/**
 * Merges rule documents into one profile set.
 *
 * Later documents win by id, so an overlay can retune a built-in profile without
 * forking the whole file. Categories are validated against the *merged* profile
 * list, which is why this runs after every document has been read.
 */
export function buildProfileSet(files: readonly RuleDocument[]): ProfileSet {
  const byId = new Map<string, Profile>();
  const order: string[] = [];
  for (const { source, data } of files) {
    const rawProfiles = data.profiles;
    if (!Array.isArray(rawProfiles)) throw new RuleError(`${source}: "profiles" must be a list`);
    rawProfiles.forEach((raw, index) => {
      const profile = validateProfile(raw, source, index);
      if (!byId.has(profile.id)) order.push(profile.id);
      byId.set(profile.id, profile);
    });
  }

  const profileIds = new Set(byId.keys());
  const categoriesById = new Map<string, Category>();
  const categoryOrder: string[] = [];
  for (const { source, data } of files) {
    if (data.categories === undefined) continue;
    if (!Array.isArray(data.categories)) throw new RuleError(`${source}: "categories" must be a list`);
    data.categories.forEach((raw, index) => {
      const category = validateCategory(raw, source, index, profileIds);
      if (!categoriesById.has(category.id)) categoryOrder.push(category.id);
      categoriesById.set(category.id, category);
    });
  }

  return {
    profiles: order.map((id) => byId.get(id) as Profile),
    byId,
    categories: categoryOrder.map((id) => categoriesById.get(id) as Category),
  };
}
