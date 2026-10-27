/** Shared test fixtures: deterministic synthetic transactions. */

import { extractFeatures } from '../src/features.ts';
import * as fingerprintModule from '../src/fingerprints.ts';
import type {
  Category,
  ClassifiedTx,
  IngestContext,
  MempoolTx,
  MempoolVin,
  MempoolVout,
  Profile,
} from '../src/types.ts';

export const TIP = 800_000;
export const NOW = 1_700_000_000;
export const CTX: IngestContext = { tipHeight: TIP, now: NOW };

export const SEQ_FINAL = 0xffffffff;
export const SEQ_RBF = 0xfffffffd;

export function hex20(seed: number): string {
  return seed.toString(16).padStart(2, '0').repeat(20);
}

export function hex32(seed: number): string {
  return seed.toString(16).padStart(2, '0').repeat(32);
}

const SCRIPT_PREFIX: Record<string, string> = {
  p2pkh: '76a914',
  p2sh: 'a914',
  v0_p2wpkh: '0014',
  v0_p2wsh: '0020',
  v1_p2tr: '5120',
  op_return: '6a',
  anchor: '51024e73',
};

export function scriptFor(type: string, seed: number, payload?: string): string {
  const prefix = SCRIPT_PREFIX[type] ?? '0014';
  if (type === 'op_return') return payload ?? '6a04deadbeef';
  if (type === 'anchor') return '51024e73';
  if (type === 'v0_p2wpkh' || type === 'p2pkh') return `${prefix}${hex20(seed)}${type === 'p2pkh' ? '88ac' : ''}`;
  if (type === 'p2sh' || type === 'v0_p2wsh') return `${prefix}${hex32(seed)}`;
  if (type === 'v1_p2tr') return `${prefix}${hex32(seed)}`;
  return `${prefix}${hex20(seed)}`;
}

export interface InputSpec {
  value?: number;
  type?: string;
  address?: string;
  sequence?: number;
  txid?: string;
  vout?: number;
  witness?: string[];
  raw?: MempoolVin;
}

export function makeVin(spec: InputSpec = {}, index = 0): MempoolVin {
  if (spec.raw) return spec.raw;
  const type = spec.type ?? 'v0_p2wpkh';
  const address = spec.address ?? `bc1qinput${index}`;
  const sequence = spec.sequence ?? SEQ_RBF;
  const witness =
    spec.witness ??
    (type === 'v0_p2wpkh'
      ? ['30440220' + '00'.repeat(32) + '01', '02' + '11'.repeat(32)]
      : type === 'v1_p2tr'
        ? ['aa'.repeat(64)]
        : []);
  return {
    txid: spec.txid ?? hex32(0x10 + index),
    vout: spec.vout ?? 0,
    prevout: {
      scriptpubkey: scriptFor(type, 0x40 + index),
      scriptpubkey_type: type,
      scriptpubkey_address: address,
      value: spec.value ?? 100_000,
    },
    scriptsig: type === 'p2pkh' ? '47' + '00'.repeat(0x47) : '',
    witness,
    is_coinbase: false,
    sequence,
  };
}

export interface OutputSpec {
  value: number;
  type?: string;
  address?: string;
  script?: string;
  payload?: string;
}

export function makeVout(spec: OutputSpec, index = 0): MempoolVout {
  const type = spec.type ?? 'v0_p2wpkh';
  return {
    scriptpubkey: spec.script ?? scriptFor(type, 0x80 + index, spec.payload),
    scriptpubkey_type: type,
    ...(type === 'op_return' ? {} : { scriptpubkey_address: spec.address ?? `bc1qoutput${index}` }),
    value: spec.value,
  };
}

export interface TxSpec {
  txid?: string;
  version?: number;
  locktime?: number;
  inputs?: InputSpec[];
  outputs?: OutputSpec[];
  fee?: number;
  status?: MempoolTx['status'];
}

export function makeTx(spec: TxSpec = {}): MempoolTx {
  const inputs = (spec.inputs ?? [{ value: 200_000 }]).map((i, idx) => makeVin(i, idx));
  const outputs = (spec.outputs ?? [{ value: 190_000 }]).map((o, idx) => makeVout(o, idx));
  const totalOut = outputs.reduce((sum, o) => sum + o.value, 0);
  const totalIn = inputs.reduce((sum, i) => sum + (i.prevout?.value ?? 0), 0);
  const fee = spec.fee ?? Math.max(0, totalIn - totalOut);
  return {
    txid: spec.txid ?? hex32(0xaa),
    version: spec.version ?? 2,
    locktime: spec.locktime ?? 0,
    vin: inputs,
    vout: outputs,
    size: 150,
    weight: 600,
    fee,
    ...(spec.status ? { status: spec.status } : {}),
  };
}

/** Core-style spend: v2, tip locktime, RBF, segwit in -> segwit change + payment. */
export function coreLikeTx(overrides: TxSpec = {}): MempoolTx {
  return makeTx({
    locktime: TIP - 1,
    inputs: [{ value: 500_000, type: 'v0_p2wpkh', sequence: SEQ_RBF }],
    outputs: [
      { value: 100_000, type: 'v0_p2wpkh', address: 'bc1qrecipient' },
      { value: 399_000, type: 'v0_p2wpkh', address: 'bc1qchange' },
    ],
    ...overrides,
  });
}

/** Five equal outputs + change: a Whirlpool-shaped CoinJoin. */
export function coinjoinTx(overrides: TxSpec = {}): MempoolTx {
  const denom = 1_000_000;
  return makeTx({
    version: 2,
    locktime: 0,
    inputs: Array.from({ length: 5 }, (_, i) => ({
      value: denom + 2_000,
      type: 'v0_p2wpkh',
      sequence: SEQ_RBF,
      txid: hex32(0x30 + i),
    })),
    outputs: [
      ...Array.from({ length: 5 }, (_, i) => ({ value: denom, type: 'v0_p2wpkh' as const, address: `bc1qcj${i}` })),
      { value: 8_000, type: 'v0_p2wpkh', address: 'bc1qchange' },
    ],
    ...overrides,
  });
}

/** Classify a synthetic tx with the shipped rule set (cached across tests). */
let cachedProfiles: Profile[] | null = null;

export function profilesForTests(): Profile[] {
  if (cachedProfiles === null) {
    const { loadProfiles, DEFAULT_RULES_PATH } = fingerprintModule;
    cachedProfiles = loadProfiles(DEFAULT_RULES_PATH, null).profiles;
  }
  return cachedProfiles;
}

export function analyzed(tx: MempoolTx, ctx: IngestContext = CTX): ClassifiedTx {
  const features = extractFeatures(tx, ctx);
  const classification = fingerprintModule.classify(features, profilesForTests(), categoriesForTests());
  return { tx, features, classification };
}

let cachedCategories: Category[] | null = null;

export function categoriesForTests(): Category[] {
  if (cachedCategories === null) {
    const { loadProfiles, DEFAULT_RULES_PATH } = fingerprintModule;
    cachedCategories = loadProfiles(DEFAULT_RULES_PATH, null).categories;
  }
  return cachedCategories;
}


// ---------------------------------------------------------------- test doubles

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.ts';
import { MempoolClient } from '../src/mempool.ts';
import type { MempoolStats, MempoolTxStatus } from '../src/types.ts';

export function tempDb(name = 'wf'): Db {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  return new Db(join(dir, 'test.sqlite'));
}

export interface StubClientOptions {
  txs?: Record<string, MempoolTx>;
  tip?: number;
  mempoolTxids?: () => string[];
  blockTxids?: Record<string, string[]>;
  statuses?: Record<string, MempoolTxStatus>;
  failFor?: string[];
  rps?: number;
  /** Artificial latency per tx fetch, to exercise backlog/shutdown behaviour. */
  delayMs?: number;
}

export interface StubClient extends MempoolClient {
  readonly calls: { tx: number; txids: number; blockTxids: number; txStatus: number; tipHeight: number };
}

/**
 * Duck-typed MempoolClient for ingest tests. Cast at the call site; every method
 * used by the pipeline is implemented.
 */
export function stubClient(options: StubClientOptions = {}): StubClient {
  const calls = { tx: 0, txids: 0, blockTxids: 0, txStatus: 0, tipHeight: 0 };
  const failing = new Set(options.failFor ?? []);
  const txs = options.txs ?? {};
  const mempoolTxids = options.mempoolTxids ?? (() => Object.keys(txs));

  const stub = {
    baseUrl: 'https://stub.test',
    limiter: { rps: options.rps ?? 1000, acquire: async () => {}, cooldown: () => {}, cooldownRemainingMs: () => 0 },
    stats: { requests: 0, retries: 0, rateLimitHits: 0, errors: 0, bytes: 0 },
    calls,
    async tipHeight(): Promise<number> {
      calls.tipHeight++;
      return options.tip ?? TIP;
    },
    async tx(txid: string): Promise<MempoolTx> {
      calls.tx++;
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (failing.has(txid)) throw new Error(`stub failure for ${txid}`);
      const tx = txs[txid];
      if (!tx) throw new Error(`no stub tx ${txid}`);
      return tx;
    },
    async mempoolTxids(): Promise<string[]> {
      calls.txids++;
      return mempoolTxids();
    },
    async blockTxids(hash: string): Promise<string[]> {
      calls.blockTxids++;
      return options.blockTxids?.[hash] ?? [];
    },
    async txStatus(txid: string): Promise<MempoolTxStatus> {
      calls.txStatus++;
      const status = options.statuses?.[txid];
      if (status) return status;
      const err = new Error('not found') as Error & { status?: number };
      err.status = 404;
      throw err;
    },
    async mempoolStats(): Promise<MempoolStats> {
      return { count: Object.keys(txs).length, vsize: 0, total_fee: 0 };
    },
  };
  return stub as unknown as StubClient;
}

/** Poll until `fn` is truthy, or fail the test with `label`. */
export async function waitFor(
  fn: () => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms`);
}
