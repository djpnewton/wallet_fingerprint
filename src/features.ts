/**
 * Feature extraction.
 *
 * A "wallet fingerprint" is the set of observable choices that wallet software
 * makes when it builds a transaction: version, locktime policy, RBF/sequence
 * policy, the script types it can spend and pays to, how it orders outputs,
 * where it puts change, whether it adds OP_RETURN / anchor outputs, how it
 * batches, and so on. This module turns a raw mempool.space transaction into
 * that flat, addressable feature vector. No heuristics that need extra network
 * calls are used here, so every feature is reproducible from the transaction
 * alone (plus the chain tip height at first sight, for locktime classification).
 */

import type { IngestContext, MempoolTx, MempoolVin, MempoolVout, TxFeatures } from './types.ts';

const MAX_SEQUENCE = 0xffffffff;
const SEQUENCE_RBF = 0xfffffffd;
const SEQUENCE_LOCKTIME = 0xfffffffe;
const LOCKTIME_THRESHOLD = 500_000_000;
/** Max distance (blocks) between nLockTime and the tip to call it anti-fee-sniping. */
export const TIP_LOCKTIME_WINDOW = 6;
/** Max distance (seconds) between nLockTime and now to call it a current timestamp. */
export const TIMESTAMP_LOCKTIME_WINDOW = 7200;

const DUST_THRESHOLD: Record<string, number> = {
  p2pkh: 546,
  p2sh: 540,
  v0_p2wpkh: 294,
  v0_p2wsh: 330,
  v1_p2tr: 330,
  anchor: 240,
  p2a: 240,
};
const DEFAULT_DUST_THRESHOLD = 546;

/**
 * Data-carrier protocols that dominate mempool traffic without being payments.
 * Omni is deliberately absent: USDT transfers are real value transfers, even
 * though they also carry an OP_RETURN.
 */
const SPAM_PROTOCOLS = new Set(['runes', 'brc20', 'ord']);

/** Data carriers that still represent real value transfers rather than junk. */
const PAYMENT_CARRIERS = new Set(['omni']);

/** Output types that are provably unspendable and must not be treated as payments. */
const UNSPENDABLE_TYPES = new Set(['op_return', 'nulldata', 'nonstandard']);

export function isDustOutput(out: MempoolVout): boolean {
  if (out.value <= 0) return false;
  if (UNSPENDABLE_TYPES.has(out.scriptpubkey_type)) return false;
  const threshold = DUST_THRESHOLD[out.scriptpubkey_type] ?? DEFAULT_DUST_THRESHOLD;
  return out.value < threshold;
}

export function isUnspendableOutput(out: MempoolVout): boolean {
  return UNSPENDABLE_TYPES.has(out.scriptpubkey_type) || out.scriptpubkey_type === 'anchor';
}

function hexToAscii(hex: string): string {
  let out = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(code)) break;
    out += code >= 32 && code < 127 ? String.fromCharCode(code) : '.';
  }
  return out;
}

/**
 * Identifies the well-known data-carrier protocols carried in OP_RETURN.
 * Absence of a match yields 'unknown', which is itself a research signal.
 */
export function opReturnProtocol(scriptHex: string): string {
  const hex = scriptHex.toLowerCase();
  if (!hex.startsWith('6a')) return 'nonstandard';
  const body = hex.slice(2);
  if (body.length === 0) return 'empty';
  // OP_RETURN OP_13 = runes etching/mint/transfer marker.
  if (body.startsWith('5d')) return 'runes';
  // OP_RETURN PUSH20 "omni" ... = Omni Layer (USDT).
  if (body.startsWith('14') && body.slice(2, 10) === '6f6d6e69') return 'omni';
  const ascii = hexToAscii(body);
  if (ascii.includes('brc-20')) return 'brc20';
  if (ascii.includes('ord')) return 'ord';
  return 'unknown';
}

/**
 * Coarse "is this junk?" classification.
 *
 * Half the modern mempool is protocol traffic, so wallet statistics computed
 * over everything describe Runes minters rather than wallet behaviour. Tagging
 * it explicitly lets reports exclude it without silently dropping data.
 */
export function classifySpam(input: {
  hasInscriptionEnvelope: boolean;
  opReturnProtocols: readonly string[];
  dustOutputCount: number;
}): string | null {
  if (input.hasInscriptionEnvelope) return 'inscription';
  if (input.opReturnProtocols.some((p) => SPAM_PROTOCOLS.has(p))) {
    return input.opReturnProtocols.includes('runes') ? 'runes' : 'ordinals';
  }
  const junkCarriers = input.opReturnProtocols.filter((p) => !PAYMENT_CARRIERS.has(p));
  if (junkCarriers.length > 0) return 'data-carrier';
  if (input.dustOutputCount > 0) return 'dust';
  return null;
}

function countBucket(n: number): string {
  if (n <= 1) return '1';
  if (n === 2) return '2';
  if (n <= 4) return '3-4';
  if (n <= 9) return '5-9';
  if (n <= 19) return '10-19';
  if (n <= 49) return '20-49';
  return '50+';
}

function valueBucket(sats: number): string {
  const btc = sats / 1e8;
  if (btc < 0.001) return '<0.001';
  if (btc < 0.01) return '0.001-0.01';
  if (btc < 0.1) return '0.01-0.1';
  if (btc < 1) return '0.1-1';
  if (btc < 10) return '1-10';
  return '>=10';
}

function feeRateBucket(satPerVb: number): string {
  if (satPerVb < 1) return '<1';
  if (satPerVb < 2) return '1-2';
  if (satPerVb < 5) return '2-5';
  if (satPerVb < 10) return '5-10';
  if (satPerVb < 50) return '10-50';
  return '50+';
}

export function classifyLocktime(
  locktime: number,
  ctx: Pick<IngestContext, 'tipHeight' | 'now'>,
): { locktime_class: string; locktime_tip_delta: number | null } {
  if (locktime === 0) return { locktime_class: 'none', locktime_tip_delta: null };
  if (locktime < LOCKTIME_THRESHOLD) {
    const delta = ctx.tipHeight === null ? null : locktime - ctx.tipHeight;
    if (delta !== null && Math.abs(delta) <= TIP_LOCKTIME_WINDOW) {
      return { locktime_class: 'tip_height', locktime_tip_delta: delta };
    }
    return { locktime_class: 'block_height', locktime_tip_delta: delta };
  }
  if (Math.abs(locktime - ctx.now) <= TIMESTAMP_LOCKTIME_WINDOW) {
    return { locktime_class: 'current_time', locktime_tip_delta: null };
  }
  return { locktime_class: 'timestamp', locktime_tip_delta: null };
}

function sequenceProfile(sequences: number[]): {
  profile: string;
  isRbf: boolean;
  allFinal: boolean;
  distinct: number;
} {
  const distinct = new Set(sequences).size;
  const isRbf = sequences.some((s) => s <= SEQUENCE_RBF);
  const allFinal = sequences.length > 0 && sequences.every((s) => s === MAX_SEQUENCE);
  let profile: string;
  if (sequences.length === 0) profile = 'none';
  else if (sequences.every((s) => s === MAX_SEQUENCE)) profile = 'all_final';
  else if (sequences.every((s) => s === SEQUENCE_RBF)) profile = 'all_rbf';
  else if (sequences.every((s) => s === SEQUENCE_LOCKTIME)) profile = 'all_locktime_only';
  else if (sequences.every((s) => s === sequences[0])) profile = 'all_same_custom';
  else profile = 'mixed';
  return { profile, isRbf, allFinal, distinct };
}

const OP_CHECKMULTISIG = 'ae';
const OP_CHECKLOCKTIMEVERIFY = 0xb1;
const OP_CHECKSEQUENCEVERIFY = 0xb2;
const OP_1 = 0x51;
const OP_16 = 0x60;

export interface ScriptAnalysis {
  opcodes: number[];
  /** True when the script commits to a relative (CSV) timelock. */
  hasCsv: boolean;
  /** True when the script commits to an absolute (CLTV) timelock. */
  hasCltv: boolean;
  /** Threshold and participant count when the script is a bare multisig. */
  multisig: { m: number; n: number } | null;
  /** Block/unit values guarded by OP_CSV, in script order. */
  csvValues: number[];
  /** Unix-time or height values guarded by OP_CLTV. */
  cltvValues: number[];
}

/**
 * Walks a witness script, respecting push data, and reports the timelock and
 * multisig structure it commits to.
 *
 * A naive byte scan for 0xb1/0xb2 is worthless — those bytes appear constantly
 * inside pushed public keys — so the walk must skip every push. This is what
 * makes Miniscript vaults identifiable at all: a script of the form
 * `IF <pk> ELSE <n> CSV DROP <pk> ENDIF` is a relative-timelock recovery branch,
 * which ordinary payment wallets never produce.
 */
export function analyzeScript(scriptHex: string): ScriptAnalysis {
  const hex = scriptHex.toLowerCase();
  const opcodes: number[] = [];
  const csvValues: number[] = [];
  const cltvValues: number[] = [];
  let i = 0;
  let lastNum: number | null = null;
  let firstOp: number | null = null;
  let pushCount = 0;
  let secondOp: number | null = null;

  while (i + 1 < hex.length) {
    const op = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(op)) break;
    i += 2;
    opcodes.push(op);

    let len = 0;
    if (op >= 0x01 && op <= 0x4b) {
      len = op;
    } else if (op === 0x4c) {
      len = Number.parseInt(hex.slice(i, i + 2), 16);
      i += 2;
    } else if (op === 0x4d) {
      len = Number.parseInt(hex.slice(i + 2, i + 4) + hex.slice(i, i + 2), 16);
      i += 4;
    } else if (op === 0x4e) {
      i += 8;
      len = 0;
    }

    if (op === OP_CHECKSEQUENCEVERIFY && lastNum !== null) csvValues.push(lastNum);
    if (op === OP_CHECKLOCKTIMEVERIFY && lastNum !== null) cltvValues.push(lastNum);

    // Track the most recent small integer, which is the operand of a following
    // OP_CSV / OP_CLTV.
    if (op === 0x00) lastNum = 0;
    else if (op >= OP_1 && op <= OP_16) lastNum = op - 0x50;
    else if (len > 0 && len <= 4) {
      const bytes = hex.slice(i, i + len * 2);
      if (/^[0-9a-f]+$/.test(bytes) && bytes.length === len * 2) {
        const pairs: string[] = [];
        for (let b = 0; b < bytes.length; b += 2) pairs.push(bytes.slice(b, b + 2));
        const value = Number.parseInt(pairs.reverse().join(''), 16);
        lastNum = Number.isFinite(value) ? value : null;
      } else {
        lastNum = null;
      }
    } else {
      lastNum = null;
    }

    if (firstOp === null) firstOp = op;
    else if (secondOp === null) secondOp = op;
    if (len > 0) pushCount++;
    i += len * 2;
  }

  // Bare `m <pk>… n CHECKMULTISIG` only: first and second opcodes are thresholds
  // and the script ends with CHECKMULTISIG.
  let multisig: { m: number; n: number } | null = null;
  if (
    firstOp !== null &&
    secondOp !== null &&
    firstOp >= OP_1 &&
    firstOp <= OP_16 &&
    hex.endsWith(OP_CHECKMULTISIG)
  ) {
    multisig = parseMultisigScript(hex);
  }

  return {
    opcodes,
    hasCsv: csvValues.length > 0,
    hasCltv: cltvValues.length > 0,
    multisig,
    csvValues,
    cltvValues,
  };
}

/** The witness script revealed by a spend: P2WSH last item, P2TR script-path second-to-last. */
export function witnessScriptOf(vin: MempoolVin): string | null {
  const witness = vin.witness ?? [];
  if (witness.length === 0) return null;
  const type = vin.prevout?.scriptpubkey_type ?? '';
  if (type === 'v0_p2wsh') return witness[witness.length - 1] ?? null;
  if (type === 'v1_p2tr' && witness.length > 1) return witness[witness.length - 2] ?? null;
  return null;
}

export function isTimelockedScript(scriptHex: string): boolean {
  const analysis = analyzeScript(scriptHex);
  return analysis.hasCsv || analysis.hasCltv;
}

/**
 * Reads a bare `m <pubkey>... n CHECKMULTISIG` witness script.
 *
 * Multisig is the one shape that genuinely separates wallet families on-chain:
 * Muun, Casa and most collaborative-custody providers spend P2WSH built from
 * this exact template, and ordinary single-signature wallets never produce it.
 */
export function parseMultisigScript(scriptHex: string): { m: number; n: number } | null {
  const hex = scriptHex.toLowerCase();
  if (!hex.endsWith(OP_CHECKMULTISIG)) return null;
  let i = 0;
  const readOp = (): number | null => {
    if (i >= hex.length) return null;
    const byte = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) return null;
    i += 2;
    return byte;
  };

  const first = readOp();
  // OP_1..OP_16 are 0x51..0x60.
  if (first === null || first < 0x51 || first > 0x60) return null;
  const m = first - 0x50;

  let pushCount = 0;
  for (;;) {
    if (i >= hex.length) return null;
    const op = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(op)) return null;
    if (op >= 0x51 && op <= 0x60) {
      const n = op - 0x50;
      i += 2;
      if (hex.slice(i) !== OP_CHECKMULTISIG) return null;
      if (pushCount !== n || m > n) return null;
      return { m, n };
    }
    // Direct push of a 33- or 65-byte public key.
    if (op !== 0x21 && op !== 0x41) return null;
    i += 2;
    if (i + op * 2 > hex.length) return null;
    i += op * 2;
    pushCount++;
    if (pushCount > 20) return null;
  }
}

function witnessShape(vin: MempoolVin): string | null {
  const witness = vin.witness ?? [];
  if (witness.length === 0) return null;
  const type = vin.prevout?.scriptpubkey_type ?? 'unknown';
  switch (type) {
    case 'v0_p2wpkh':
      return 'p2wpkh';
    case 'v0_p2wsh': {
      const script = witness[witness.length - 1] ?? '';
      return parseMultisigScript(script) ? 'p2wsh_multisig' : 'p2wsh';
    }
    case 'v1_p2tr':
      return witness.length === 1 ? 'p2tr_keypath' : 'p2tr_scriptpath';
    case 'p2sh': {
      const second = witness[1] ?? '';
      const first = witness[0] ?? '';
      if (witness.length === 2 && /^(02|03)[0-9a-fA-F]{64}$/.test(second)) return 'p2sh_p2wpkh';
      if (witness.length === 2 && /^(02|03)[0-9a-fA-F]{64}$/.test(first)) return 'p2sh_p2wpkh';
      return 'p2sh_wrapped_script';
    }
    default:
      return `witness_${type}`;
  }
}

function isBip69InputOrder(vin: MempoolVin[]): boolean {
  if (vin.length < 2) return false;
  const byDisplay = [...vin].sort((a, b) => {
    if (a.txid === b.txid) return a.vout - b.vout;
    return a.txid < b.txid ? -1 : 1;
  });
  const byInternal = [...vin].sort((a, b) => {
    const ra = reverseHex(a.txid);
    const rb = reverseHex(b.txid);
    if (ra === rb) return a.vout - b.vout;
    return ra < rb ? -1 : 1;
  });
  const matches = (order: MempoolVin[]) => order.every((v, i) => v.txid === vin[i]?.txid && v.vout === vin[i]?.vout);
  return matches(byDisplay) || matches(byInternal);
}

function reverseHex(hex: string): string {
  const pairs: string[] = [];
  for (let i = 0; i < hex.length; i += 2) pairs.push(hex.slice(i, i + 2));
  return pairs.reverse().join('');
}

function isBip69OutputOrder(vout: MempoolVout[]): boolean {
  // With fewer than 3 outputs, "sorted by script" is satisfied by chance far too
  // often to be evidence of a BIP69 policy, and OP_RETURN payloads (6a...) sort
  // trivially above every real script, so exclude those transactions too.
  if (vout.length < 3) return false;
  if (vout.some((o) => isUnspendableOutput(o))) return false;
  const sorted = [...vout].sort((a, b) => {
    const sa = a.scriptpubkey.toLowerCase();
    const sb = b.scriptpubkey.toLowerCase();
    if (sa === sb) return a.value - b.value;
    return sa < sb ? -1 : 1;
  });
  return sorted.every((o, i) => o.scriptpubkey === vout[i]?.scriptpubkey && o.value === vout[i]?.value);
}

function outputValueOrder(vout: MempoolVout[]): string {
  if (vout.length < 2) return 'single';
  let ascending = true;
  let descending = true;
  for (let i = 1; i < vout.length; i++) {
    const prev = vout[i - 1]?.value ?? 0;
    const cur = vout[i]?.value ?? 0;
    if (cur < prev) ascending = false;
    if (cur > prev) descending = false;
  }
  if (ascending && descending) return 'equal';
  if (ascending) return 'asc';
  if (descending) return 'desc';
  return 'mixed';
}

/**
 * Change detection, deliberately conservative.
 *
 * The textbook heuristic is "the change output reuses an input script type and
 * is the only such output". When that is ambiguous we return null instead of
 * guessing, because a wrong change guess silently corrupts downstream analysis.
 */
export function inferChange(
  tx: MempoolTx,
  inputTypes: string[],
): { index: number; method: string } | null {
  const outputs = tx.vout;
  if (outputs.length < 2) return null;
  const inputTypeSet = new Set(inputTypes);
  const matching = outputs
    .map((o, index) => ({ index, type: o.scriptpubkey_type }))
    .filter((o) => inputTypeSet.has(o.type) && !isUnspendableOutput(outputs[o.index] as MempoolVout));

  // Only trust it when there is exactly one candidate *and* at least one output
  // that does not match, otherwise "the one match" may simply be the payment.
  const only = matching[0];
  if (matching.length === 1 && only !== undefined && matching.length < outputs.length) {
    return { index: only.index, method: 'type-unique' };
  }
  return null;
}

export function extractFeatures(tx: MempoolTx, ctx: IngestContext): TxFeatures {
  const vin = tx.vin ?? [];
  const vout = tx.vout ?? [];
  const weight = tx.weight ?? 0;
  const vsize = Math.max(1, Math.ceil(weight / 4));
  const fee = tx.fee ?? 0;
  const feeRate = fee / vsize;

  const inputScriptTypes = vin.map((v) => v.prevout?.scriptpubkey_type ?? 'unknown');
  const outputScriptTypes = vout.map((o) => o.scriptpubkey_type);
  const inputTypes = [...new Set(inputScriptTypes)].sort();
  const outputTypes = [...new Set(outputScriptTypes)].sort();

  const sequences = vin.map((v) => (v.sequence ?? MAX_SEQUENCE) >>> 0);
  const seq = sequenceProfile(sequences);

  const locktime = tx.locktime ?? 0;
  const { locktime_class, locktime_tip_delta } = classifyLocktime(locktime, ctx);

  const witnessShapes = vin.map(witnessShape).filter((s): s is string => s !== null);
  const p2trScriptPath = witnessShapes.filter((s) => s === 'p2tr_scriptpath').length;
  const p2trKeyPath = witnessShapes.filter((s) => s === 'p2tr_keypath').length;

  const multisigInputs = vin
    .filter((v) => (v.prevout?.scriptpubkey_type ?? '') === 'v0_p2wsh')
    .map((v) => parseMultisigScript((v.witness ?? []).at(-1) ?? ''))
    .filter((parsed): parsed is { m: number; n: number } => parsed !== null);

  const scriptAnalyses = vin
    .map((v) => witnessScriptOf(v))
    .filter((script): script is string => script !== null)
    .map((script) => analyzeScript(script))
    .filter((analysis) => analysis.hasCsv || analysis.hasCltv);
  const csvValues = [...new Set(scriptAnalyses.flatMap((a) => a.csvValues))].sort((a, b) => a - b);
  const cltvValues = [...new Set(scriptAnalyses.flatMap((a) => a.cltvValues))].sort((a, b) => a - b);

  const hasInscriptionEnvelope = (tx.vin ?? []).some((v) =>
    (v.witness ?? []).some((item) => item.toLowerCase().startsWith('0063036f7264')),
  );

  const opReturnProtocols = vout
    .filter((o) => o.scriptpubkey_type === 'op_return' || o.scriptpubkey_type === 'nulldata')
    .map((o) => opReturnProtocol(o.scriptpubkey));

  const spendableOutputs = vout.filter((o) => !isUnspendableOutput(o));
  const dustCount = vout.filter(isDustOutput).length;

  const valueCounts = new Map<number, number>();
  for (const o of spendableOutputs) {
    if (o.value <= 0) continue;
    valueCounts.set(o.value, (valueCounts.get(o.value) ?? 0) + 1);
  }
  let equalOutputMax = 0;
  let equalOutputGroups = 0;
  for (const count of valueCounts.values()) {
    equalOutputMax = Math.max(equalOutputMax, count);
    if (count >= 2) equalOutputGroups++;
  }

  const knownInputValues = vin.length > 0 && vin.every((v) => !v.is_coinbase && v.prevout != null);
  const totalInputValue = knownInputValues
    ? vin.reduce((sum, v) => sum + (v.prevout?.value ?? 0), 0)
    : null;
  const totalOutputValue = vout.reduce((sum, o) => sum + o.value, 0);

  const inputAddresses = new Set(
    vin.map((v) => v.prevout?.scriptpubkey_address).filter((a): a is string => Boolean(a)),
  );
  const outputAddresses = new Set(
    vout.map((o) => o.scriptpubkey_address).filter((a): a is string => Boolean(a)),
  );
  const addressReuse = [...outputAddresses].some((a) => inputAddresses.has(a));

  const change = inferChange(tx, inputScriptTypes);
  const changeIndex = change?.index ?? null;
  const changeOutput = changeIndex === null ? null : (vout[changeIndex] ?? null);
  const changePosition =
    changeIndex === null
      ? 'none'
      : changeIndex === 0
        ? 'first'
        : changeIndex === vout.length - 1
          ? 'last'
          : 'middle';

  const round1000 = spendableOutputs.filter((o) => o.value > 0 && o.value % 1000 === 0).length;
  const round10000 = spendableOutputs.filter((o) => o.value > 0 && o.value % 10000 === 0).length;

  const coinjoinLike =
    equalOutputMax >= 3 &&
    vin.length >= 2 &&
    spendableOutputs.length >= 3 &&
    equalOutputMax >= Math.min(vin.length, spendableOutputs.length);
  const consolidation = !coinjoinLike && vin.length >= 5 && spendableOutputs.length <= 2;

  const bip69Inputs = isBip69InputOrder(vin);
  const bip69Outputs = isBip69OutputOrder(vout);

  const features: TxFeatures = {
    txid: tx.txid,
    first_seen_at: ctx.now,
    tip_height_at_seen: ctx.tipHeight,

    version: tx.version,
    locktime,
    locktime_class,
    locktime_tip_delta,
    rbf_enabled_by_locktime: sequences.some((s) => s <= SEQUENCE_LOCKTIME),

    size: tx.size ?? 0,
    weight,
    vsize,
    fee,
    fee_rate: Number(feeRate.toFixed(3)),
    fee_rate_bucket: feeRateBucket(feeRate),
    fee_round_10: fee % 10 === 0,
    fee_round_100: fee % 100 === 0,

    input_count: vin.length,
    output_count: vout.length,
    io_ratio_bucket: `${countBucket(vin.length)}x${countBucket(vout.length)}`,
    input_value_bucket: totalInputValue === null ? 'unknown' : valueBucket(totalInputValue),

    input_script_types: inputScriptTypes,
    output_script_types: outputScriptTypes,
    input_types: inputTypes,
    output_types: outputTypes,
    input_type_profile: inputTypes.join('+'),
    output_type_profile: outputTypes.join('+'),
    all_inputs_same_type: inputTypes.length === 1,
    all_outputs_same_type: outputTypes.length === 1,
    segwit_inputs: inputScriptTypes.filter((t) => t.startsWith('v0_') || t === 'v1_p2tr').length,
    taproot_inputs: inputScriptTypes.filter((t) => t === 'v1_p2tr').length,
    legacy_inputs: inputScriptTypes.filter((t) => t === 'p2pkh' || t === 'p2sh').length,
    nested_segwit_inputs: witnessShapes.filter((s) => s === 'p2sh_p2wpkh').length,
    p2tr_keypath_inputs: p2trKeyPath,
    p2tr_scriptpath_inputs: p2trScriptPath,
    p2wsh_multisig_inputs: multisigInputs.length,
    timelock_inputs: scriptAnalyses.length,
    timelocked_multisig_inputs: scriptAnalyses.filter((a) => a.multisig !== null).length,
    witness_csv_values: csvValues,
    witness_cltv_values: cltvValues,
    multisig_m: multisigInputs[0]?.m ?? null,
    multisig_n: multisigInputs[0]?.n ?? null,
    witness_shapes: [...new Set(witnessShapes)].sort(),
    scriptsig_count: vin.filter((v) => (v.scriptsig ?? '').length > 0).length,

    sequence_values: [...new Set(sequences)].sort((a, b) => a - b),
    sequence_profile: seq.profile,
    is_rbf: seq.isRbf,
    all_final_sequences: seq.allFinal,
    has_relative_locktime: sequences.some(
      (s) => (s & 0x80000000) === 0 && (s & 0x0000ffff) > 0,
    ),
    distinct_sequence_values: seq.distinct,

    bip69_inputs: bip69Inputs,
    bip69_outputs: bip69Outputs,
    output_order: bip69Outputs ? 'bip69' : outputValueOrder(vout),
    change_index: changeIndex,
    change_position: changePosition,
    change_script_type: changeOutput?.scriptpubkey_type ?? null,
    change_matches_input_type: changeOutput
      ? inputTypes.includes(changeOutput.scriptpubkey_type)
      : false,

    address_reuse: addressReuse,
    distinct_input_addresses: inputAddresses.size,
    distinct_output_addresses: outputAddresses.size,

    op_return_count: opReturnProtocols.length,
    op_return_protocols: [...new Set(opReturnProtocols)].sort(),
    has_op_return: opReturnProtocols.length > 0,
    has_inscription_envelope: hasInscriptionEnvelope,
    spam_kind: classifySpam({
      hasInscriptionEnvelope,
      opReturnProtocols,
      dustOutputCount: dustCount,
    }),
    has_anchor_output: vout.some(
      (o) =>
        o.scriptpubkey_type === 'anchor' ||
        o.scriptpubkey_type === 'p2a' ||
        o.scriptpubkey.toLowerCase() === '51024e73',
    ),

    total_input_value: totalInputValue,
    total_output_value: totalOutputValue,
    known_input_values: knownInputValues,
    dust_output_count: dustCount,
    has_dust_output: dustCount > 0,
    equal_output_max: equalOutputMax,
    equal_output_groups: equalOutputGroups,
    round_outputs_1000: round1000,
    round_outputs_10000: round10000,
    all_outputs_round_1000:
      spendableOutputs.length > 0 && round1000 === spendableOutputs.length,

    is_coinjoin_like: coinjoinLike,
    is_consolidation: consolidation,
    is_payment_batching:
      spendableOutputs.length >= 5 && equalOutputMax <= 2 && distinctOutputCount(vout) >= 4,

    signature: '',
  };

  features.signature = buildSignature(features);
  return features;
}

function distinctOutputCount(vout: MempoolVout[]): number {
  const seen = new Set<string>();
  for (const o of vout) {
    if (isUnspendableOutput(o)) continue;
    seen.add(`${o.scriptpubkey_address ?? o.scriptpubkey}:${o.value}`);
  }
  return seen.size;
}

/**
 * The set of addressable feature names, derived from a synthetic transaction so
 * it can never drift from `TxFeatures`. Used to validate rule files.
 */
export const FEATURE_NAMES: ReadonlySet<string> = new Set(
  Object.keys(
    extractFeatures(
      {
        txid: '00'.repeat(32),
        version: 2,
        locktime: 0,
        vin: [
          {
            txid: '00'.repeat(32),
            vout: 0,
            prevout: null,
            scriptsig: '',
            is_coinbase: false,
            sequence: MAX_SEQUENCE,
          },
        ],
        vout: [{ scriptpubkey: '00', scriptpubkey_type: 'p2pkh', value: 1 }],
        size: 1,
        weight: 4,
        fee: 0,
      },
      { tipHeight: 800_000, now: 1_700_000_000 },
    ),
  ),
);

/**
 * Coarse cluster key for the unknown-pool research workflow: transactions with
 * an identical signature share every wallet-controlled choice we currently
 * measure, so they are candidates for a new profile.
 */
export function buildSignature(f: TxFeatures): string {
  return [
    `v${f.version}`,
    `lt:${f.locktime_class}`,
    `seq:${f.sequence_profile}`,
    `in:${f.input_type_profile || 'none'}`,
    `out:${f.output_type_profile || 'none'}`,
    `io:${f.io_ratio_bucket}`,
    `chg:${f.change_position}`,
    `ord:${f.output_order}`,
    `op:${f.op_return_protocols.join('+') || 'none'}`,
    `eq:${f.equal_output_max >= 3 ? 'y' : 'n'}`,
    `dust:${f.has_dust_output ? 'y' : 'n'}`,
    `round:${f.all_outputs_round_1000 ? 'y' : 'n'}`,
  ].join('|');
}
