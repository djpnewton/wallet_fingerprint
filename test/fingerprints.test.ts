import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFeatures } from '../src/features.ts';
import {
  DEFAULT_RULES_PATH,
  RuleError,
  attributionWeight,
  classify,
  evaluateCondition,
  specificityFromBaseRate,
  withBaseRates,
  evaluateMatch,
  loadProfiles,
  rulesFingerprint,
} from '../src/fingerprints.ts';
import { buildStats } from '../src/report.ts';
import type { Profile, TxFeatures } from '../src/types.ts';
import {
  CTX,
  TIP,
  analyzed,
  coinjoinTx,
  coreLikeTx,
  hex32,
  makeTx,
  tempDb,
  SEQ_FINAL,
  SEQ_RBF,
} from './helpers.ts';

const features = (tx: ReturnType<typeof makeTx>): TxFeatures => extractFeatures(tx, CTX);

test('the shipped rule set loads and validates', () => {
  const set = loadProfiles(DEFAULT_RULES_PATH, null);
  assert.ok(set.profiles.length >= 20, `expected a substantial rule set, got ${set.profiles.length}`);
  assert.equal(new Set(set.profiles.map((p) => p.id)).size, set.profiles.length);
  for (const profile of set.profiles) {
    assert.ok(profile.confidence > 0 && profile.confidence <= 1);
    for (const wallet of profile.wallets) {
      assert.ok(wallet.confidence > 0 && wallet.confidence <= 1, `${profile.id}/${wallet.name}`);
    }
    // A profile with neither wallets nor labels would be dead weight.
    assert.ok(profile.wallets.length > 0 || profile.labels.length > 0, `${profile.id} has no output`);
  }
});

test('condition operators behave as documented', () => {
  const f = features(coreLikeTx());
  const check = (cond: Parameters<typeof evaluateCondition>[1]) => evaluateCondition(f, cond);

  assert.equal(check({ feature: 'version', op: 'eq', value: 2 }), true);
  assert.equal(check({ feature: 'version', op: 'ne', value: 1 }), true);
  assert.equal(check({ feature: 'version', op: 'in', value: [1, 2] }), true);
  assert.equal(check({ feature: 'version', op: 'notIn', value: [1] }), true);
  assert.equal(check({ feature: 'input_count', op: 'gte', value: 1 }), true);
  assert.equal(check({ feature: 'input_count', op: 'lt', value: 1 }), false);
  assert.equal(check({ feature: 'input_count', op: 'between', value: [0, 5] }), true);
  assert.equal(check({ feature: 'input_types', op: 'contains', value: 'v0_p2wpkh' }), true);
  assert.equal(check({ feature: 'input_types', op: 'containsNone', value: ['p2pkh'] }), true);
  assert.equal(check({ feature: 'input_types', op: 'containsAll', value: ['v0_p2wpkh'] }), true);
  assert.equal(check({ feature: 'output_types', op: 'subsetOf', value: ['v0_p2wpkh', 'op_return'] }), true);
  assert.equal(check({ feature: 'output_types', op: 'subsetOf', value: ['p2pkh'] }), false);
  assert.equal(check({ feature: 'sequence_profile', op: 'eq', value: 'all_rbf' }), true);
  assert.equal(check({ feature: 'change_index', op: 'exists' }), false);
  assert.equal(check({ feature: 'change_index', op: 'absent' }), true);
  assert.equal(check({ feature: 'nope', op: 'eq', value: 1 }), false);
  assert.throws(() => check({ feature: 'version', op: 'sorta' as never, value: 1 }), RuleError);
});

test('match.all is an AND and match.any is an OR', () => {
  const f = features(coreLikeTx());
  const all = evaluateMatch(f, {
    all: [
      { feature: 'version', op: 'eq', value: 2 },
      { feature: 'locktime_class', op: 'eq', value: 'tip_height' },
    ],
  });
  assert.equal(all.ok, true);
  assert.equal(all.total, 2);

  const failing = evaluateMatch(f, {
    all: [{ feature: 'version', op: 'eq', value: 1 }],
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.failed.length, 1);

  const any = evaluateMatch(f, {
    all: [{ feature: 'version', op: 'eq', value: 2 }],
    any: [
      { feature: 'locktime_class', op: 'eq', value: 'timestamp' },
      { feature: 'locktime_class', op: 'eq', value: 'tip_height' },
    ],
  });
  assert.equal(any.ok, true);
});

test('a core-style spend is attributed to several wallets at once', () => {
  const set = loadProfiles(DEFAULT_RULES_PATH, null);
  const result = classify(features(coreLikeTx()), set.profiles);

  assert.equal(result.isUnknown, false);
  assert.ok(result.wallets.length >= 5, 'fingerprint space is shared: expect a plurality of candidates');
  assert.equal(result.wallets[0]?.name, 'Bitcoin Core');
  assert.ok((result.wallets[0]?.confidence ?? 0) > 0.7);
  assert.deepEqual(
    result.wallets.map((w) => w.confidence),
    [...result.wallets.map((w) => w.confidence)].sort((a, b) => b - a),
    'wallets must be ranked by plausibility',
  );
  assert.ok(result.labels.includes('behavior:antifid'));
  assert.ok(result.labels.includes('behavior:rbf'));
  assert.ok(result.profiles.some((p) => p.profileId === 'core-rbf-tip-locktime'));
});

test('a no-RBF tip-locktime spend loses the RBF profile but keeps a Core-style one', () => {
  const set = loadProfiles(DEFAULT_RULES_PATH, null);
  const tx = coreLikeTx({
    inputs: [{ value: 500_000, type: 'v0_p2wpkh', sequence: SEQ_FINAL }],
  });
  const result = classify(features(tx), set.profiles);
  const ids = result.profiles.map((p) => p.profileId);
  assert.ok(ids.includes('core-final-tip-locktime'));
  assert.ok(!ids.includes('core-rbf-tip-locktime'));
  assert.ok(result.labels.includes('policy:no-rbf'));
});

test('shared signatures reinforce confidence through noisy-OR', () => {
  const set = loadProfiles(DEFAULT_RULES_PATH, null);
  const single = classify(features(coreLikeTx()), set.profiles);
  const singleSparrow = single.wallets.find((w) => w.name === 'Sparrow Wallet');
  assert.ok(singleSparrow);

  // A taproot spend with a tip-height locktime matches both the core-derived and
  // taproot profiles, which both list Sparrow.
  const taproot = makeTx({
    locktime: TIP,
    inputs: [{ value: 500_000, type: 'v1_p2tr', sequence: SEQ_RBF }],
    outputs: [{ value: 490_000, type: 'v1_p2tr' }],
  });
  const combined = classify(features(taproot), set.profiles);
  const sparrow = combined.wallets.find((w) => w.name === 'Sparrow Wallet');
  assert.ok(sparrow);
  assert.ok(
    sparrow.confidence > singleSparrow.confidence,
    `expected reinforcement (${sparrow.confidence} > ${singleSparrow.confidence})`,
  );
  assert.ok(sparrow.profiles.length >= 2);
});

test('a coinjoin-shaped spend matches the Whirlpool profile', () => {
  const set = loadProfiles(DEFAULT_RULES_PATH, null);
  const result = classify(features(coinjoinTx()), set.profiles);
  const ids = result.profiles.map((p) => p.profileId);
  assert.ok(ids.includes('whirlpool-coinjoin'));
  assert.ok(result.labels.includes('type:coinjoin'));
  assert.equal(result.wallets[0]?.name, 'Samourai Whirlpool');
});

test('a shape no profile covers is unknown and keeps near misses for research', () => {
  const set = loadProfiles(DEFAULT_RULES_PATH, null);
  const odd = makeTx({
    version: 2,
    locktime: 700_000,
    inputs: [{ value: 500_000, type: 'v0_p2wpkh', sequence: SEQ_FINAL }],
    outputs: [{ value: 490_001, type: 'v0_p2wsh' }],
  });
  const result = classify(features(odd), set.profiles);
  assert.equal(result.isUnknown, true);
  assert.equal(result.wallets.length, 0);
  assert.ok(result.nearMisses.length > 0);
  assert.ok(result.nearMisses.every((n) => n.ratio >= 0.5));
  assert.ok(result.nearMisses[0]!.ratio >= result.nearMisses.at(-1)!.ratio);
});

test('rule files are validated with actionable errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-rules-'));
  const bad = join(dir, 'bad.yaml');
  writeFileSync(
    bad,
    `version: 1
profiles:
  - id: broken
    confidence: 0.5
    match:
      all:
        - feature: not_a_feature
          op: eq
          value: 1
`,
  );
  assert.throws(() => loadProfiles(bad, null), /unknown feature "not_a_feature"/);

  const badConfidence = join(dir, 'confidence.yaml');
  writeFileSync(
    badConfidence,
    `version: 1
profiles:
  - id: broken
    confidence: 3
    match:
      all:
        - { feature: version, op: eq, value: 2 }
`,
  );
  assert.throws(() => loadProfiles(badConfidence, null), /confidence in \(0, 1\]/);

  const badOp = join(dir, 'op.yaml');
  writeFileSync(
    badOp,
    `version: 1
profiles:
  - id: broken
    confidence: 0.5
    match:
      all:
        - { feature: version, op: equals, value: 2 }
`,
  );
  assert.throws(() => loadProfiles(badOp, null), /unknown operator/);
});

test('an overlay replaces a profile by id without duplicating it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-overlay-'));
  const overlay = join(dir, 'local.yaml');
  writeFileSync(
    overlay,
    `version: 1
profiles:
  - id: core-rbf-tip-locktime
    family: core-derived
    title: Retuned Core profile
    summary: local override
    confidence: 0.4
    match:
      all:
        - { feature: version, op: eq, value: 2 }
    wallets:
      - { name: Bitcoin Core, confidence: 0.5 }
    labels: [behavior:antifid]
  - id: local-only
    family: local
    title: Local-only profile
    summary: test
    confidence: 0.3
    match:
      all:
        - { feature: version, op: eq, value: 1 }
    wallets: []
    labels: [local:test]
`,
  );
  const set = loadProfiles(DEFAULT_RULES_PATH, overlay);
  const core = set.byId.get('core-rbf-tip-locktime');
  assert.equal(core?.confidence, 0.4);
  assert.equal(core?.title, 'Retuned Core profile');
  assert.ok(set.byId.has('local-only'));
  assert.equal(
    set.profiles.filter((p) => p.id === 'core-rbf-tip-locktime').length,
    1,
    'overlay must replace, not duplicate',
  );
});

test('disabled profiles are skipped', () => {
  const profile: Profile = {
    id: 'disabled-one',
    family: 'test',
    title: 'Disabled',
    summary: '',
    confidence: 0.9,
    evidence: [],
    match: { all: [{ feature: 'version', op: 'eq', value: 2 }] },
    wallets: [{ name: 'Never Matches', confidence: 0.9, kind: 'software' }],
    labels: ['x'],
    enabled: false,
    baseRate: null,
    specificity: 1,
  };
  const f = features(makeTx({ txid: hex32(1) }));
  const result = classify(f, [profile]);
  assert.equal(result.wallets.length, 0);
  assert.equal(result.isUnknown, true);
});

// ------------------------------------------------------- specificity weighting

test('specificity falls as a signature becomes more common', () => {
  assert.equal(specificityFromBaseRate(null), 1, 'unmeasured profiles are not discounted');
  assert.equal(specificityFromBaseRate(0), 1);
  assert.equal(specificityFromBaseRate(1), 0, 'a signature that fires on everything says nothing');

  const rare = specificityFromBaseRate(0.02);
  const uncommon = specificityFromBaseRate(0.14);
  const modal = specificityFromBaseRate(0.605);
  const everywhere = specificityFromBaseRate(0.7);

  assert.equal(rare, 1, '2% of traffic earns full weight');
  assert.ok(uncommon > modal && modal > everywhere, 'discount must be monotonic');
  assert.ok(modal < 0.25, `a 60% signature must be heavily discounted, got ${modal}`);

  // 4 bits ≈ 6.25% earns exactly full weight.
  assert.equal(specificityFromBaseRate(0.0625), 1);
});

test('a broad profile cannot outvote a specific one', () => {
  const base = {
    family: 'test',
    summary: '',
    evidence: [],
    labels: [] as string[],
    enabled: true,
    baseRate: null as number | null,
    specificity: 1,
  };
  const broad: Profile = {
    ...base,
    id: 'broad',
    title: 'Broad',
    confidence: 0.9,
    specificity: specificityFromBaseRate(0.605),
    match: { all: [{ feature: 'version', op: 'eq', value: 2 }] },
    wallets: [{ name: 'Named Wallet', confidence: 0.9, kind: 'software' }],
  };
  const specific: Profile = {
    ...base,
    id: 'specific',
    title: 'Specific',
    confidence: 0.6,
    specificity: specificityFromBaseRate(0.005),
    match: {
      all: [
        { feature: 'version', op: 'eq', value: 2 },
        { feature: 'locktime_class', op: 'eq', value: 'tip_height' },
        { feature: 'sequence_profile', op: 'eq', value: 'all_rbf' },
      ],
    },
    wallets: [{ name: 'Other Wallet', confidence: 0.7, kind: 'software' }],
  };

  const result = classify(features(coreLikeTx()), [broad, specific]);
  assert.equal(result.wallets[0]?.name, 'Other Wallet');
  const named = result.wallets.find((w) => w.name === 'Named Wallet');
  assert.ok(named);
  assert.ok(named.confidence < 0.15, `broad attribution must be small, got ${named.confidence}`);
  assert.equal(named.specificity, Number(specificityFromBaseRate(0.605).toFixed(3)));

  // Labels are behavioural facts, so they are never discounted.
  assert.ok(result.profiles.find((p) => p.profileId === 'broad'));
});

test('withBaseRates measures from stored match counts and smooths unobserved profiles', () => {
  const set = loadProfiles(DEFAULT_RULES_PATH, null);
  const core = set.byId.get('core-rbf-tip-locktime');
  const runes = set.byId.get('runes-data-carrier');
  assert.ok(core && runes);

  const counts = new Map<string, number>([
    [core.id, 93],
    [runes.id, 1604],
  ]);
  const measured = withBaseRates(set.profiles, counts, 2917);

  const measuredCore = measured.find((p) => p.id === core.id);
  const measuredRunes = measured.find((p) => p.id === runes.id);
  const unseen = measured.find((p) => p.id === 'lightning-anchor');
  assert.ok(measuredCore && measuredRunes && unseen);

  assert.ok((measuredCore.baseRate ?? 0) > 0.03 && (measuredCore.baseRate ?? 0) < 0.04);
  assert.ok((measuredRunes.baseRate ?? 0) > 0.5);
  assert.ok(measuredRunes.specificity < measuredCore.specificity);
  assert.ok((unseen.baseRate ?? 0) > 0, 'unobserved profiles get a smoothed, tiny rate');
  assert.equal(unseen.specificity, 1);

  // Without data nothing is discounted.
  const unmeasured = withBaseRates(set.profiles, new Map(), 0);
  assert.ok(unmeasured.every((p) => p.baseRate === null && p.specificity === 1));
});

test('the shipped locktime-zero buckets no longer name wallets they cannot support', () => {
  const set = loadProfiles(DEFAULT_RULES_PATH, null);
  for (const id of ['v2-locktime0-rbf', 'v2-locktime0-final', 'address-reuse']) {
    const profile = set.byId.get(id);
    assert.ok(profile, id);
    for (const wallet of profile.wallets) {
      assert.match(
        wallet.name,
        /generic|bot|custodial|processor/,
        `${id} should not attribute a specific vendor (found ${wallet.name})`,
      );
    }
  }
});

test('Muun is attributed only through its 2-of-2 multisig signature', () => {
  const set = loadProfiles(DEFAULT_RULES_PATH, null);
  const profilesNamingMuun = set.profiles.filter((p) => p.wallets.some((w) => w.name === 'Muun'));
  assert.deepEqual(
    profilesNamingMuun.map((p) => p.id),
    ['multisig-2of2-p2wsh'],
    'Muun must not appear in shape-only buckets',
  );

  // A plain segwit spend must not produce a Muun tag at all.
  const plain = classify(features(coreLikeTx()), set.profiles);
  assert.equal(plain.wallets.some((w) => w.name === 'Muun'), false);
});

test('the rules fingerprint tracks what affects a classification, not cosmetics', () => {
  const set = loadProfiles(DEFAULT_RULES_PATH, null);
  const baseline = rulesFingerprint(set.profiles);
  assert.match(baseline, /^[0-9a-f]{16}$/);
  assert.equal(baseline, rulesFingerprint(set.profiles), 'must be stable');

  // Measured fields are derived from data, so they must not invalidate stored rows.
  const measured = withBaseRates(set.profiles, new Map([['core-rbf-tip-locktime', 50]]), 1000);
  assert.equal(rulesFingerprint(measured), baseline);

  // Cosmetic edits must not force a reclassification either.
  const retitled = set.profiles.map((p) =>
    p.id === 'core-rbf-tip-locktime' ? { ...p, title: 'Renamed', summary: 'Different prose.' } : p,
  );
  assert.equal(rulesFingerprint(retitled), baseline);

  // Anything that changes attribution does.
  const reweighted = set.profiles.map((p) =>
    p.id === 'core-rbf-tip-locktime' ? { ...p, confidence: 0.5 } : p,
  );
  assert.notEqual(rulesFingerprint(reweighted), baseline);

  const disabled = set.profiles.map((p) =>
    p.id === 'core-rbf-tip-locktime' ? { ...p, enabled: false } : p,
  );
  assert.notEqual(rulesFingerprint(disabled), baseline);

  const conditionChanged = set.profiles.map((p) =>
    p.id === 'core-rbf-tip-locktime'
      ? { ...p, match: { all: [{ feature: 'version' as const, op: 'eq' as const, value: 1 }] } }
      : p,
  );
  assert.notEqual(rulesFingerprint(conditionChanged), baseline);
});

test('protocol traffic is attributed to Runes-capable wallets, not left blank', () => {
  const set = loadProfiles(DEFAULT_RULES_PATH, null);
  // A Runes mint: one input, OP_RETURN carrier first, change first, descending.
  const script = '6a5d0a010203';
  const mint = makeTx({
    version: 2,
    locktime: 0,
    inputs: [{ value: 50_000, type: 'v0_p2wpkh', sequence: SEQ_RBF }],
    outputs: [
      { value: 20_000, script: '0014' + 'aa'.repeat(20), type: 'v0_p2wpkh' },
      { value: 0, type: 'op_return', payload: script },
    ],
  });
  // Measure prevalence the way the CLI does: Runes is ~55% of a spam-heavy corpus.
  const measured = withBaseRates(set.profiles, new Map([['runes-data-carrier', 550]]), 1000);
  const result = classify(features(mint), measured);

  // The payload narrows the field, so candidates must exist.
  assert.equal(result.isUnknown, false);
  assert.ok(result.wallets.length >= 3, 'a Runes mint is still signed by wallet software');
  const generic = result.wallets.find((w) => /Runes-capable/.test(w.name));
  assert.ok(generic, 'expected the generic Runes-capable candidate');
  assert.ok(generic.confidence >= 0.35);

  // Prevalence is measured and reported, but not allowed to erase the signal:
  // a protocol marker is a categorical constraint, not a modal shape.
  const marker = result.profiles.find((p) => p.profileId === 'runes-data-carrier');
  assert.ok(marker);
  assert.ok(marker.specificity < 0.5, `expected a heavy measured discount, got ${marker.specificity}`);
  assert.equal(attributionWeight({ ...set.byId.get('runes-data-carrier')! }), 1);
});

test('the two minting implementations are separated by change position and ordering', () => {
  const set = loadProfiles(DEFAULT_RULES_PATH, null);
  const build = (order: 'desc-first' | 'asc-last') =>
    makeTx({
      version: 2,
      locktime: 0,
      inputs: [{ value: 50_000, type: 'v0_p2wpkh', sequence: SEQ_RBF }],
      outputs:
        order === 'desc-first'
          ? [
              { value: 20_000, script: '0014' + 'aa'.repeat(20), type: 'v0_p2wpkh' },
              { value: 0, type: 'op_return', payload: '6a5d0a010203' },
            ]
          : [
              { value: 0, type: 'op_return', payload: '6a5d0a010203' },
              { value: 20_000, script: '0014' + 'bb'.repeat(20), type: 'v0_p2wpkh' },
            ],
    });

  const first = classify(features(build('desc-first')), set.profiles);
  const second = classify(features(build('asc-last')), set.profiles);
  assert.ok(first.profiles.some((p) => p.profileId === 'runes-mint-desc-order'));
  assert.ok(!first.profiles.some((p) => p.profileId === 'runes-mint-mixed-order'));
  assert.ok(second.profiles.some((p) => p.profileId === 'runes-mint-mixed-order'));
});

// ------------------------------------------------------------ wallet categories

test('a transaction lands in exactly one category', () => {
  const set = loadProfiles(DEFAULT_RULES_PATH, null);
  assert.ok(set.categories.length >= 15, 'expected a full taxonomy');
  assert.equal(new Set(set.categories.map((c) => c.id)).size, set.categories.length);

  const core = classify(features(coreLikeTx()), set.profiles, set.categories);
  assert.equal(core.category.id, 'core-style');
  assert.equal(core.category.viaProfile, 'core-rbf-tip-locktime');
  // It also matches other fingerprints — that is the point of the second tab.
  assert.ok(core.profiles.length > 1);

  const cj = classify(features(coinjoinTx()), set.profiles, set.categories);
  assert.equal(cj.category.id, 'coinjoin');

  const none = classify(
    features(
      makeTx({
        version: 2,
        locktime: 700_000,
        inputs: [{ value: 500_000, type: 'v0_p2wpkh', sequence: SEQ_FINAL }],
        outputs: [{ value: 490_001, type: 'v0_p2wsh' }],
      }),
    ),
    set.profiles,
    set.categories,
  );
  assert.equal(none.category.id, 'unclassified');
  assert.equal(none.category.viaProfile, null);
});

test('category priority keeps specific shapes out of the catch-alls', () => {
  const set = loadProfiles(DEFAULT_RULES_PATH, null);
  // A Runes mint also reuses an address and has locktime 0; it must still be Runes.
  const runes = makeTx({
    version: 2,
    locktime: 0,
    inputs: [{ value: 50_000, type: 'v0_p2wpkh', sequence: SEQ_RBF, address: 'bc1qsame' }],
    outputs: [
      { value: 20_000, type: 'v0_p2wpkh', address: 'bc1qsame' },
      { value: 0, type: 'op_return', payload: '6a5d0a010203' },
    ],
  });
  const result = classify(features(runes), set.profiles, set.categories);
  const ids = result.profiles.map((p) => p.profileId);
  assert.ok(ids.includes('address-reuse'), 'the fixture must also match address-reuse');
  assert.ok(ids.includes('v2-locktime0-rbf'), 'and the locktime-zero fingerprint');
  assert.equal(result.category.id, 'runes', 'priority must win over the broad buckets');
});

test('category definitions are validated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-cat-'));
  const bad = join(dir, 'bad.yaml');
  writeFileSync(
    bad,
    `version: 1
profiles:
  - id: known
    confidence: 0.5
    match:
      all:
        - { feature: version, op: eq, value: 2 }
categories:
  - id: broken
    anyOf: [does-not-exist]
`,
  );
  assert.throws(() => loadProfiles(bad, null), /references unknown fingerprint "does-not-exist"/);

  const empty = join(dir, 'empty.yaml');
  writeFileSync(
    empty,
    `version: 1
profiles:
  - id: known
    confidence: 0.5
    match:
      all:
        - { feature: version, op: eq, value: 2 }
categories:
  - id: broken
    anyOf: []
`,
  );
  assert.throws(() => loadProfiles(empty, null), /non-empty anyOf/);
});

test('wallet names survive YAML parsing intact', () => {
  const set = loadProfiles(DEFAULT_RULES_PATH, null);
  const profile = set.byId.get('runes-mint-desc-order');
  assert.ok(profile);
  // An unquoted comma inside a flow mapping once truncated this to
  // "Runes mint tooling (change-first" — assert the whole name round-trips.
  const archetype = profile.wallets.find((w) => w.kind === 'archetype');
  assert.equal(archetype?.name, 'Runes mint tooling (change-first, descending)');

  for (const p of set.profiles) {
    for (const w of p.wallets) {
      assert.ok(w.name.trim() === w.name && w.name.length > 2, `bad wallet name in ${p.id}: ${w.name}`);
      assert.equal(typeof w.kind, 'string', `${p.id}/${w.name} needs a kind`);
    }
  }
});

test('a product is named once across the rule set', () => {
  const set = loadProfiles(DEFAULT_RULES_PATH, null);
  const names = new Set<string>();
  for (const p of set.profiles) for (const w of p.wallets) names.add(w.name);
  // The same vendor must not appear under two spellings.
  const okx = [...names].filter((n) => n.startsWith('OKX'));
  assert.deepEqual(okx, ['OKX Wallet'], `expected one OKX name, got ${okx.join(', ')}`);
});

test('categories name products, not builder archetypes, when they can', () => {
  const set = loadProfiles(DEFAULT_RULES_PATH, null);
  const report = buildStats(
    (() => {
      const db = tempDb();
      for (const [i, tx] of [
        coreLikeTx({ txid: hex32(0x11) }),
        coinjoinTx({ txid: hex32(0x12) }),
      ].entries()) {
        db.saveAnalysis(analyzed(tx), { raw: null });
        void i;
      }
      const runes = makeTx({
        txid: hex32(0x13),
        version: 2,
        locktime: 0,
        inputs: [{ value: 50_000, type: 'v0_p2wpkh', sequence: SEQ_RBF }],
        outputs: [
          { value: 20_000, type: 'v0_p2wpkh' },
          { value: 0, type: 'op_return', payload: '6a5d0a010203' },
        ],
      });
      db.saveAnalysis(analyzed(runes), { raw: null });
      return db;
    })(),
    'fp',
    set.profiles,
    set.categories,
    { recentLimit: 1, clusterLimit: 0 },
  );

  for (const category of report.categories) {
    if (category.wallets.length === 0) continue;
    const hasSoftware = category.wallets.some((w) => w.kind === 'software');
    if (!hasSoftware) continue;
    assert.deepEqual(
      category.wallets.filter((w) => w.kind === 'archetype'),
      [],
      `${category.id} mixes archetypes into a list that names software`,
    );
  }

  const runes = report.categories.find((c) => c.id === 'runes');
  assert.ok(runes);
  assert.ok(runes.wallets.every((w) => w.kind === 'software'));
  assert.ok(!runes.wallets.some((w) => /^generic|Runes mint tooling|value-sorted/.test(w.name)));
});
