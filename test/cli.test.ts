import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runNode(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [...NODE_FLAGS, ...args],
      { cwd: PROJECT_ROOT, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number }).code === 'number'
          ? ((err as { code?: number }).code as number)
          : err
            ? 1
            : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

const cli = (args: string[]): Promise<RunResult> => runNode(['src/cli.ts', ...args]);

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('--help prints usage and succeeds', async () => {
  const result = await cli(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /wallet-fingerprint — stream the Bitcoin mempool/);
  assert.match(result.stdout, /research clusters/);
});

test('an unknown command fails with a clear error', async () => {
  const result = await cli(['frobnicate']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown command: frobnicate/);
});

test('init creates the database and validates the rules', async () => {
  const dbPath = join(tempDir('wf-cli-'), 'nested', 'db.sqlite');
  const result = await cli(['init', '--db', dbPath]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(existsSync(dbPath));
  assert.match(result.stdout, /database ready/);
  assert.match(result.stdout, /rule set: \d+ profiles/);
});

test('fingerprints validates and lists the shipped rules', async () => {
  const validate = await cli(['fingerprints', 'validate']);
  assert.equal(validate.code, 0, validate.stderr);
  assert.match(validate.stdout, /ok: \d+ profiles loaded/);

  const list = await cli(['fingerprints', 'list', '--json']);
  assert.equal(list.code, 0, list.stderr);
  const profiles = JSON.parse(list.stdout) as Array<{ id: string; wallets: unknown[] }>;
  assert.ok(profiles.length >= 20);
  assert.ok(profiles.some((p) => p.id === 'whirlpool-coinjoin'));
});

test('stats, show, research and classify work against a seeded database', async () => {
  const dbPath = join(tempDir('wf-cli-'), 'db.sqlite');
  const seeded = await runNode(['test/scripts/seed.ts', dbPath]);
  assert.equal(seeded.code, 0, seeded.stderr);
  const seedInfo = JSON.parse(seeded.stdout) as {
    known: string[];
    unknown: string;
    unknownAll: string[];
    total: number;
  };
  assert.equal(seedInfo.total, 4);

  const stats = await cli(['stats', '--json', '--db', dbPath]);
  assert.equal(stats.code, 0, stats.stderr);
  const report = JSON.parse(stats.stdout) as {
    summary: { total: number; unknown: number };
    categories: Array<{ id: string; txs: number; wallets: Array<{ name: string }> }>;
    fingerprints: Array<{ id: string }>;
    clusters: Array<{ count: number }>;
  };
  assert.equal(report.summary.total, 4);
  assert.equal(report.summary.unknown, 2);
  // Categories are exclusive and must add up to the corpus.
  assert.equal(
    report.categories.reduce((n, c) => n + c.txs, 0),
    report.summary.total,
    'category counts must partition the corpus',
  );
  const coreStyle = report.categories.find((c) => c.id === 'core-style');
  assert.ok(coreStyle, 'expected a core-style category');
  assert.ok(coreStyle.wallets.some((w) => w.name === 'Bitcoin Core'));

  const human = await cli(['stats', '--db', dbPath]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /wallet categories/);
  assert.match(human.stdout, /fingerprints/);
  assert.match(human.stdout, /research clusters/);
  assert.match(human.stdout, /spam included/);

  // --no-spam must be accepted and report what it excluded.
  const noSpam = await cli(['stats', '--no-spam', '--db', dbPath]);
  assert.equal(noSpam.code, 0, noSpam.stderr);
  assert.match(noSpam.stdout, /spam excluded/);
  assert.match(noSpam.stdout, /confident/);

  const show = await cli(['show', seedInfo.known[0] as string, '--db', dbPath]);
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, /candidate wallets/);
  assert.match(show.stdout, /Bitcoin Core/);
  assert.match(show.stdout, /inputs/);

  const showJson = await cli(['show', seedInfo.unknown, '--json', '--db', dbPath]);
  assert.equal(showJson.code, 0, showJson.stderr);
  const detail = JSON.parse(showJson.stdout) as { wallets: unknown[]; nearMisses: unknown[] };
  assert.equal(detail.wallets.length, 0);
  assert.ok(detail.nearMisses.length > 0);

  const missing = await cli(['show', 'ab'.repeat(32), '--db', dbPath]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /not in the database/);

  const clusterJson = await cli(['research', 'clusters', '--json', '--db', dbPath]);
  assert.equal(clusterJson.code, 0, clusterJson.stderr);
  const clustersJson = JSON.parse(clusterJson.stdout) as Array<{ count: number }>;
  assert.equal(clustersJson[0]?.count, 2);

  const nearMiss = await cli(['research', 'near-miss', '--db', dbPath]);
  assert.equal(nearMiss.code, 0, nearMiss.stderr);
  assert.match(nearMiss.stdout, /conditions met/);

  const outFile = join(tempDir('wf-export-'), 'unknown.jsonl');
  const exported = await cli(['research', 'export', '--out', outFile, '--db', dbPath]);
  assert.equal(exported.code, 0, exported.stderr);
  const lines = readFileSync(outFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const exportedIds = lines.map((l) => (JSON.parse(l) as { txid: string }).txid).sort();
  assert.deepEqual(exportedIds, [...seedInfo.unknownAll].sort());

  const reclassified = await cli(['classify', '--db', dbPath]);
  assert.equal(reclassified.code, 0, reclassified.stderr);
  assert.match(reclassified.stdout, /re-classified 4 stored transactions/);
});
