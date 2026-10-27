import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, loadConfig } from '../src/config.ts';

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('defaults apply when nothing else is provided', () => {
  const config = loadConfig({}, null);
  assert.equal(config.apiBase, DEFAULTS.apiBase);
  assert.equal(config.storeRaw, true);
  assert.equal(config.rps, DEFAULTS.rps);
  assert.equal(config.dbPath, DEFAULTS.dbPath);
});

test('a config file layers over the defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({ apiBase: 'https://mempool.example', rps: 2, storeRaw: false, unknownKey: 1 }),
  );
  const config = loadConfig({}, path);
  assert.equal(config.apiBase, 'https://mempool.example');
  assert.equal(config.rps, 2);
  assert.equal(config.storeRaw, false);
  assert.equal(config.concurrency, DEFAULTS.concurrency, 'unspecified keys keep their default');
});

test('environment variables override the config file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ rps: 2 }));

  const config = withEnv({ WF_RPS: '9', WF_API_BASE: 'https://env.example', WF_STORE_RAW: '0' }, () =>
    loadConfig({}, path),
  );
  assert.equal(config.rps, 9);
  assert.equal(config.apiBase, 'https://env.example');
  assert.equal(config.storeRaw, false);
});

test('cli flags win over everything', () => {
  const config = withEnv({ WF_RPS: '9' }, () =>
    loadConfig({ rps: 3, concurrency: 2, dbPath: '/tmp/custom.sqlite' }, null),
  );
  assert.equal(config.rps, 3);
  assert.equal(config.concurrency, 2);
  assert.equal(config.dbPath, '/tmp/custom.sqlite');
});

test('an invalid config file is reported clearly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, '{ not json');
  assert.throws(() => loadConfig({}, path), /invalid config file/);
});

test('nonsensical rates are rejected', () => {
  assert.throws(() => loadConfig({ rps: 0 }, null), /rps must be > 0/);
  assert.throws(() => loadConfig({ concurrency: 0 }, null), /concurrency must be > 0/);
});
