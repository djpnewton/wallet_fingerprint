import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURE_NAMES,
  TIP_LOCKTIME_WINDOW,
  classifyLocktime,
  extractFeatures,
  inferChange,
  isDustOutput,
  opReturnProtocol,
  parseMultisigScript,
  analyzeScript,
} from '../src/features.ts';
import {
  CTX,
  NOW,
  SEQ_FINAL,
  SEQ_RBF,
  TIP,
  coinjoinTx,
  coreLikeTx,
  makeTx,
  makeVin,
  makeVout,
  analyzed,
} from './helpers.ts';

test('locktime classification distinguishes zero, tip, height and timestamp', () => {
  assert.deepEqual(classifyLocktime(0, CTX), { locktime_class: 'none', locktime_tip_delta: null });
  assert.deepEqual(classifyLocktime(TIP - 2, CTX), { locktime_class: 'tip_height', locktime_tip_delta: -2 });
  assert.equal(classifyLocktime(TIP - TIP_LOCKTIME_WINDOW - 1, CTX).locktime_class, 'block_height');
  assert.equal(classifyLocktime(700_000, CTX).locktime_class, 'block_height');
  assert.equal(classifyLocktime(NOW - 60, CTX).locktime_class, 'current_time');
  assert.equal(classifyLocktime(1_600_000_000, CTX).locktime_class, 'timestamp');
  assert.equal(classifyLocktime(TIP, { tipHeight: null, now: NOW }).locktime_class, 'block_height');
});

test('sequence profiles cover final, RBF, locktime-only and mixed', () => {
  const all = (sequence: number) =>
    extractFeatures(
      makeTx({
        inputs: [
          { sequence },
          { sequence, txid: '11'.repeat(32) },
        ],
      }),
      CTX,
    );

  assert.equal(all(SEQ_FINAL).sequence_profile, 'all_final');
  assert.equal(all(SEQ_FINAL).is_rbf, false);
  assert.equal(all(SEQ_RBF).sequence_profile, 'all_rbf');
  assert.equal(all(SEQ_RBF).is_rbf, true);
  assert.equal(all(0xfffffffe).sequence_profile, 'all_locktime_only');
  assert.equal(all(0xfffffffe).is_rbf, false);

  const mixed = extractFeatures(
    makeTx({
      inputs: [{ sequence: SEQ_RBF }, { sequence: SEQ_FINAL, txid: '22'.repeat(32) }],
    }),
    CTX,
  );
  assert.equal(mixed.sequence_profile, 'mixed');
  assert.equal(mixed.distinct_sequence_values, 2);
  assert.equal(mixed.is_rbf, true);
});

test('BIP68 relative locktime is detected only when the disable bit is clear', () => {
  const relative = extractFeatures(
    makeTx({ inputs: [{ sequence: 0x00000010 }] }),
    CTX,
  );
  assert.equal(relative.has_relative_locktime, true);

  const disabled = extractFeatures(makeTx({ inputs: [{ sequence: 0x80000001 }] }), CTX);
  assert.equal(disabled.has_relative_locktime, false);
});

test('dust detection uses per-script-type thresholds and ignores OP_RETURN', () => {
  assert.equal(isDustOutput(makeVout({ value: 200, type: 'v0_p2wpkh' })), true);
  assert.equal(isDustOutput(makeVout({ value: 300, type: 'v0_p2wpkh' })), false);
  assert.equal(isDustOutput(makeVout({ value: 500, type: 'p2pkh' })), true);
  assert.equal(isDustOutput(makeVout({ value: 600, type: 'p2pkh' })), false);
  assert.equal(isDustOutput(makeVout({ value: 0, type: 'op_return' })), false);
});

test('OP_RETURN protocol markers are decoded', () => {
  assert.equal(opReturnProtocol('6a5d0a010203'), 'runes');
  assert.equal(opReturnProtocol('6a146f6d6e69' + '00'.repeat(20)), 'omni');
  assert.equal(opReturnProtocol('6a0b68656c6c6f20776f726c64'), 'unknown');
  assert.equal(opReturnProtocol('6a'), 'empty');
  assert.equal(opReturnProtocol('0014' + '00'.repeat(20)), 'nonstandard');
  assert.equal(opReturnProtocol('6a0d' + Buffer.from('brc-20').toString('hex')), 'brc20');
});

test('witness shapes identify key-path, script-path and nested segwit', () => {
  const keyPath = extractFeatures(
    makeTx({ inputs: [{ type: 'v1_p2tr', witness: ['aa'.repeat(64)] }], outputs: [{ value: 190_000 }] }),
    CTX,
  );
  assert.deepEqual(keyPath.witness_shapes, ['p2tr_keypath']);
  assert.equal(keyPath.p2tr_keypath_inputs, 1);
  assert.equal(keyPath.p2tr_scriptpath_inputs, 0);

  const scriptPath = extractFeatures(
    makeTx({
      inputs: [{ type: 'v1_p2tr', witness: ['aa'.repeat(64), 'bb'.repeat(40), 'c0'.repeat(40)] }],
      outputs: [{ value: 190_000 }],
    }),
    CTX,
  );
  assert.deepEqual(scriptPath.witness_shapes, ['p2tr_scriptpath']);

  const nested = extractFeatures(
    makeTx({
      inputs: [{ type: 'p2sh', witness: ['3044' + '00'.repeat(70), '02' + '11'.repeat(32)] }],
      outputs: [{ value: 190_000, type: 'p2sh' }],
    }),
    CTX,
  );
  assert.deepEqual(nested.witness_shapes, ['p2sh_p2wpkh']);
  assert.equal(nested.nested_segwit_inputs, 1);
});

test('inscription envelopes and anchor outputs are recognised', () => {
  const tx = makeTx({
    inputs: [
      {
        type: 'v1_p2tr',
        witness: ['0063036f7264010155', 'aa'.repeat(64)],
      },
    ],
    outputs: [{ value: 10_000, type: 'v1_p2tr' }, { value: 240, type: 'anchor' }],
  });
  const f = extractFeatures(tx, CTX);
  assert.equal(f.has_inscription_envelope, true);
  assert.equal(f.has_anchor_output, true);
});

test('change inference is unique-match only and refuses to guess', () => {
  const unambiguous = makeupChangeTx();
  const change = inferChange(unambiguous, ['v0_p2wpkh']);
  assert.deepEqual(change, { index: 1, method: 'type-unique' });

  const ambiguous = coreLikeTx();
  assert.equal(inferChange(ambiguous, ['v0_p2wpkh']), null);

  const features = extractFeatures(unambiguous, CTX);
  assert.equal(features.change_index, 1);
  assert.equal(features.change_position, 'last');
  assert.equal(features.change_matches_input_type, true);

  const noChange = extractFeatures(coreLikeTx(), CTX);
  assert.equal(noChange.change_index, null);
  assert.equal(noChange.change_position, 'none');
});

function makeupChangeTx() {
  return makeTx({
    inputs: [{ value: 500_000, type: 'v0_p2wpkh' }],
    outputs: [
      { value: 100_000, type: 'p2pkh', address: '1Recipient' },
      { value: 399_000, type: 'v0_p2wpkh', address: 'bc1qchange' },
    ],
  });
}

test('CoinJoin structure is detected by equal-value output groups', () => {
  const f = extractFeatures(coinjoinTx(), CTX);
  assert.equal(f.equal_output_max, 5);
  assert.equal(f.equal_output_groups, 1);
  assert.equal(f.is_coinjoin_like, true);
  assert.equal(f.is_consolidation, false);
  assert.equal(f.is_payment_batching, false);

  const consolidation = extractFeatures(
    makeTx({
      inputs: Array.from({ length: 6 }, (_, i) => ({ txid: '33'.repeat(32), vout: i, value: 50_000 })),
      outputs: [{ value: 299_000, type: 'v0_p2wpkh' }],
    }),
    CTX,
  );
  assert.equal(consolidation.is_consolidation, true);
  assert.equal(consolidation.is_coinjoin_like, false);
});

test('payment batching requires many distinct recipients', () => {
  const f = extractFeatures(
    makeTx({
      inputs: [{ value: 2_000_000 }],
      outputs: Array.from({ length: 12 }, (_, i) => ({
        value: 100_000 + i * 1111,
        address: `bc1qrecipient${i}`,
      })),
    }),
    CTX,
  );
  assert.equal(f.is_payment_batching, true);
  assert.equal(f.equal_output_max, 1);
});

test('BIP69 output ordering needs at least three spendable outputs', () => {
  const sorted = makeTx({
    inputs: [{ value: 500_000 }],
    outputs: [
      { value: 50_000, script: '0014' + 'aa'.repeat(20) },
      { value: 60_000, script: '0014' + 'bb'.repeat(20) },
      { value: 70_000, script: '0014' + 'cc'.repeat(20) },
    ],
  });
  assert.equal(extractFeatures(sorted, CTX).bip69_outputs, true);

  const unsorted = makeTx({
    inputs: [{ value: 500_000 }],
    outputs: [
      { value: 70_000, script: '0014' + 'cc'.repeat(20) },
      { value: 50_000, script: '0014' + 'aa'.repeat(20) },
      { value: 60_000, script: '0014' + 'bb'.repeat(20) },
    ],
  });
  assert.equal(extractFeatures(unsorted, CTX).bip69_outputs, false);

  const twoOutputs = makeTx({
    inputs: [{ value: 500_000 }],
    outputs: [
      { value: 50_000, script: '0014' + 'aa'.repeat(20) },
      { value: 60_000, script: '0014' + 'bb'.repeat(20) },
    ],
  });
  assert.equal(extractFeatures(twoOutputs, CTX).bip69_outputs, false);
});

test('input ordering is recognised in both txid byte orders', () => {
  // Non-palindromic txids, so display order and internal (reversed) order differ.
  const a = '11'.repeat(31) + '22';
  const b = '22'.repeat(31) + '11';

  const display = makeTx({
    inputs: [
      { txid: a, vout: 0, value: 100_000 },
      { txid: b, vout: 0, value: 100_000 },
    ],
    outputs: [{ value: 190_000 }],
  });
  assert.equal(extractFeatures(display, CTX).bip69_inputs, true);

  const reversed = makeTx({
    inputs: [
      { txid: b, vout: 0, value: 100_000 },
      { txid: a, vout: 0, value: 100_000 },
    ],
    outputs: [{ value: 190_000 }],
  });
  // Sorted by the internal (reversed) byte order, which many signers use.
  assert.equal(extractFeatures(reversed, CTX).bip69_inputs, true);

  const unsorted = makeTx({
    inputs: [
      { txid: a, vout: 2, value: 100_000 },
      { txid: a, vout: 1, value: 100_000 },
    ],
    outputs: [{ value: 190_000 }],
  });
  assert.equal(extractFeatures(unsorted, CTX).bip69_inputs, false);
});

test('address reuse is flagged when an input address reappears in the outputs', () => {
  const tx = makeTx({
    inputs: [{ value: 200_000, address: 'bc1qsame' }],
    outputs: [{ value: 190_000, address: 'bc1qsame' }],
  });
  assert.equal(extractFeatures(tx, CTX).address_reuse, true);

  const clean = makeTx({
    inputs: [{ value: 200_000, address: 'bc1qin' }],
    outputs: [{ value: 190_000, address: 'bc1qout' }],
  });
  assert.equal(extractFeatures(clean, CTX).address_reuse, false);
});

test('unknown prevouts leave total input value null without breaking extraction', () => {
  const tx = makeTx({
    inputs: [
      {
        raw: {
          txid: '44'.repeat(32),
          vout: 0,
          prevout: null,
          scriptsig: '',
          is_coinbase: false,
          sequence: SEQ_FINAL,
        },
      },
    ],
    outputs: [{ value: 190_000 }],
  });
  const f = extractFeatures(tx, CTX);
  assert.equal(f.total_input_value, null);
  assert.equal(f.known_input_values, false);
  assert.equal(f.input_types[0], 'unknown');
});

test('signature is stable and changes with wallet-controlled choices', () => {
  const a = extractFeatures(coreLikeTx(), CTX);
  const b = extractFeatures(coreLikeTx(), CTX);
  assert.equal(a.signature, b.signature);

  const c = extractFeatures(coreLikeTx({ locktime: 0 }), CTX);
  assert.notEqual(a.signature, c.signature);
});

test('extracted features contain every addressable feature name', () => {
  const f = extractFeatures(coreLikeTx(), CTX);
  for (const key of Object.keys(f)) {
    assert.ok(FEATURE_NAMES.has(key), `missing feature name ${key}`);
  }
  assert.equal(FEATURE_NAMES.size, Object.keys(f).length);
  assert.equal(makeVin().prevout?.value, 100_000);
});

// ------------------------------------------------------------ multisig parsing

const PK = (seed: string) => `21${'02' + seed.repeat(32)}`;
const PK65 = (seed: string) => `41${'04' + seed.repeat(64)}`;

test('bare multisig templates expose their threshold and participant count', () => {
  assert.deepEqual(parseMultisigScript(`52${PK('11')}${PK('22')}52ae`), { m: 2, n: 2 });
  assert.deepEqual(parseMultisigScript(`52${PK('11')}${PK('22')}${PK('33')}53ae`), { m: 2, n: 3 });
  assert.deepEqual(parseMultisigScript(`53${PK('11')}${PK('22')}${PK('33')}53ae`), { m: 3, n: 3 });
  assert.deepEqual(parseMultisigScript(`51${PK('11')}51ae`), { m: 1, n: 1 });
  // Uncompressed public keys (65 bytes) are legal in bare multisig.
  assert.deepEqual(parseMultisigScript(`52${PK65('11')}${PK65('22')}52ae`), { m: 2, n: 2 });
});

test('non-multisig scripts are rejected', () => {
  assert.equal(parseMultisigScript(''), null);
  assert.equal(parseMultisigScript('51ae'), null, 'no pubkeys');
  assert.equal(parseMultisigScript(`52${PK('11')}53ae`), null, 'n does not match key count');
  assert.equal(parseMultisigScript(`53${PK('11')}${PK('22')}52ae`), null, 'm > n');
  assert.equal(parseMultisigScript(`52${PK('11')}${PK('22')}52ac`), null, 'wrong final opcode');
  assert.equal(parseMultisigScript(`52${PK('11')}${PK('22')}52`), null, 'truncated');
  // A timelock/CSV-guarded script that merely ends in CHECKMULTISIG is not bare.
  assert.equal(parseMultisigScript(`b2${PK('11')}${PK('22')}52ae`), null);
});

test('P2WSH inputs are split into multisig and non-multisig witness shapes', () => {
  const script = `52${PK('11')}${PK('22')}52ae`;
  const multisig = makeTx({
    inputs: [
      {
        type: 'v0_p2wsh',
        witness: ['', '30' + '44'.repeat(1), '30' + '44'.repeat(1), script],
      },
    ],
    outputs: [{ value: 190_000, type: 'v0_p2wsh' }],
  });
  const f = extractFeatures(multisig, CTX);
  assert.deepEqual(f.witness_shapes, ['p2wsh_multisig']);
  assert.equal(f.p2wsh_multisig_inputs, 1);
  assert.equal(f.multisig_m, 2);
  assert.equal(f.multisig_n, 2);

  const otherScript = '63' + 'aa'.repeat(40) + '67' + '51' + 'b2' + '68';
  const nonMultisig = makeTx({
    inputs: [{ type: 'v0_p2wsh', witness: ['30' + '44', otherScript] }],
    outputs: [{ value: 190_000 }],
  });
  const g = extractFeatures(nonMultisig, CTX);
  assert.deepEqual(g.witness_shapes, ['p2wsh']);
  assert.equal(g.p2wsh_multisig_inputs, 0);
  assert.equal(g.multisig_m, null);
  assert.equal(g.multisig_n, null);
});

test('a Muun-shaped 2-of-2 spend matches the 2-of-2 profile', () => {
  const script = `52${PK('11')}${PK('22')}52ae`;
  const tx = makeTx({
    version: 1,
    locktime: 0,
    inputs: [{ type: 'v0_p2wsh', value: 500_000, witness: ['', '30' + '44', '30' + '44', script] }],
    outputs: [{ value: 490_000, type: 'v0_p2wsh' }],
  });
  const { classification } = analyzed(tx);
  const ids = classification.profiles.map((p) => p.profileId);
  assert.ok(ids.includes('multisig-2of2-p2wsh'), `expected 2-of-2 profile, got ${ids.join(',')}`);
  assert.ok(classification.labels.includes('policy:multisig-2of2'));
  const muun = classification.wallets.find((w) => w.name === 'Muun');
  assert.ok(muun, 'a 2-of-2 spend should surface Muun as a candidate');
  assert.ok(muun.confidence > 0.3);
});

// ------------------------------------------------------------ spam classification

test('protocol traffic is classified as spam without mislabelling payments', () => {
  const runes = extractFeatures(
    makeTx({
      outputs: [
        { value: 546, type: 'v0_p2wpkh' },
        { value: 0, type: 'op_return', payload: '6a5d0a010203' },
      ],
    }),
    CTX,
  );
  assert.equal(runes.spam_kind, 'runes');

  const inscription = extractFeatures(
    makeTx({
      inputs: [{ type: 'v1_p2tr', witness: ['0063036f7264010155', 'aa'.repeat(64)] }],
      outputs: [{ value: 10_000, type: 'v1_p2tr' }],
    }),
    CTX,
  );
  assert.equal(inscription.spam_kind, 'inscription');

  const opaqueCarrier = extractFeatures(
    makeTx({
      outputs: [
        { value: 10_000, type: 'v0_p2wpkh' },
        { value: 0, type: 'op_return', payload: '6a0b68656c6c6f20776f726c64' },
      ],
    }),
    CTX,
  );
  assert.equal(opaqueCarrier.spam_kind, 'data-carrier');

  const dust = extractFeatures(
    makeTx({ outputs: [{ value: 200, type: 'v0_p2wpkh' }, { value: 190_000, type: 'v0_p2wpkh' }] }),
    CTX,
  );
  assert.equal(dust.spam_kind, 'dust');

  // Omni carries USDT: a data carrier, but a real value transfer, so not spam.
  const omni = extractFeatures(
    makeTx({
      outputs: [
        { value: 10_000, type: 'v0_p2wpkh' },
        { value: 0, type: 'op_return', payload: `6a146f6d6e69${'00'.repeat(20)}` },
      ],
    }),
    CTX,
  );
  assert.deepEqual(omni.op_return_protocols, ['omni']);
  assert.equal(omni.spam_kind, null);
});

test('an ordinary payment is never spam', () => {
  assert.equal(extractFeatures(coreLikeTx(), CTX).spam_kind, null);
  assert.equal(extractFeatures(coinjoinTx(), CTX).spam_kind, null);
});

// --------------------------------------------------- script timelock analysis

test('timelock detection survives pushed data that contains the opcode bytes', () => {
  // A pubkey full of 0xb1/0xb2 bytes must not be mistaken for a timelock.
  const sneaky = `21${'b2'.repeat(33)}ac`;
  const analysis = analyzeScript(sneaky);
  assert.equal(analysis.hasCsv, false);
  assert.equal(analysis.hasCltv, false);

  // The real Miniscript shape: IF <pk> ELSE <1008> CSV DROP <pk> ENDIF … ENDIF
  const csvScript = `6321${'02' + '11'.repeat(32)}6702f003b27521${'03' + '22'.repeat(32)}68ac`;
  const csv = analyzeScript(csvScript);
  assert.equal(csv.hasCsv, true);
  assert.deepEqual(csv.csvValues, [1008]);

  // <pk> CHECKSIG IF <height> CLTV DROP <pk> ENDIF CHECKSIG
  const cltvScript = `2103${'33'.repeat(32)}ac6704${'f0030000'}b1752103${'44'.repeat(32)}68ac`;
  const cltv = analyzeScript(cltvScript);
  assert.equal(cltv.hasCltv, true);
  assert.equal(cltv.cltvValues.length, 1);
});

test('multisig is detected only for a bare m-of-n template', () => {
  const bare = `52${PK('11')}${PK('22')}52ae`;
  assert.deepEqual(analyzeScript(bare).multisig, { m: 2, n: 2 });

  // A script that merely ends in CHECKMULTISIG after other logic is not bare.
  const wrapped = `63${PK('11')}${PK('22')}52ae68`;
  assert.equal(analyzeScript(wrapped).multisig, null);
});

test('a Miniscript vault spend exposes its timelock to the extractor', () => {
  const script = `6321${'02' + '11'.repeat(32)}6702f003b27521${'03' + '22'.repeat(32)}68ac`;
  const tx = makeTx({
    version: 2,
    locktime: 0,
    inputs: [{ value: 500_000, type: 'v0_p2wsh', witness: ['', '30' + '44', script] }],
    outputs: [{ value: 490_000, type: 'v0_p2wsh' }],
  });
  const f = extractFeatures(tx, CTX);
  assert.equal(f.timelock_inputs, 1);
  assert.deepEqual(f.witness_csv_values, [1008]);
  assert.equal(f.timelocked_multisig_inputs, 0);

  const { classification } = analyzed(tx);
  const ids = classification.profiles.map((p) => p.profileId);
  assert.ok(ids.includes('miniscript-relative-timelock'), `got ${ids.join(',')}`);
  assert.ok(ids.includes('miniscript-csv-1008'));
  assert.equal(classification.category.id, 'timelocked-miniscript');
  const liana = classification.wallets.find((w) => w.name === 'Liana');
  assert.ok(liana, 'Liana should be a candidate for a timelocked Miniscript vault');
});

test('an ordinary payment never reports a timelock', () => {
  const f = extractFeatures(coreLikeTx(), CTX);
  assert.equal(f.timelock_inputs, 0);
  assert.deepEqual(f.witness_csv_values, []);
  assert.deepEqual(f.witness_cltv_values, []);
});
