/**
 * Seeds a database for CLI end-to-end tests: two ordinary spends and one shape
 * no profile covers.
 */

import { Db } from '../../src/db.ts';
import { extractFeatures } from '../../src/features.ts';
import { classify, loadProfiles, DEFAULT_RULES_PATH } from '../../src/fingerprints.ts';
import { TIP, coreLikeTx, hex32, makeTx } from '../helpers.ts';
import type { IngestContext, MempoolTx } from '../../src/types.ts';

const dbPath = process.argv[2];
if (!dbPath) {
  process.stderr.write('usage: seed.ts <db-path>\n');
  process.exit(1);
}

const ctx: IngestContext = { tipHeight: TIP, now: 1_700_000_000 };
const profiles = loadProfiles(DEFAULT_RULES_PATH, null).profiles;
const db = new Db(dbPath);

const txs: MempoolTx[] = [
  coreLikeTx({ txid: hex32(0x11) }),
  coreLikeTx({ txid: hex32(0x12), locktime: TIP - 3 }),
  makeTx({
    txid: hex32(0x13),
    version: 2,
    locktime: 700_000,
    inputs: [{ value: 500_000, type: 'v0_p2wpkh', sequence: 0xffffffff }],
    outputs: [{ value: 490_001, type: 'v0_p2wsh' }],
  }),
  makeTx({
    txid: hex32(0x14),
    version: 2,
    locktime: 700_000,
    inputs: [{ value: 500_000, type: 'v0_p2wpkh', sequence: 0xffffffff }],
    outputs: [{ value: 490_001, type: 'v0_p2wsh' }],
  }),
];

for (const tx of txs) {
  const features = extractFeatures(tx, ctx);
  db.saveAnalysis({ tx, features, classification: classify(features, profiles) }, { raw: tx });
}

process.stdout.write(
  `${JSON.stringify({
    known: [hex32(0x11), hex32(0x12)],
    unknown: hex32(0x13),
    unknownAll: [hex32(0x13), hex32(0x14)],
    total: db.countTxs(),
  })}\n`,
);
db.close();
