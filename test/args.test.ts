import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.ts';

test('parses the command and positional arguments', () => {
  const parsed = parseArgs(['show', 'ab'.repeat(32), '--db', '/tmp/x.sqlite']);
  assert.equal(parsed.command, 'show');
  assert.deepEqual(parsed.positional, ['ab'.repeat(32)]);
  assert.equal(parsed.flags.db, '/tmp/x.sqlite');
});

test('supports --key=value, bare flags and --no-<flag>', () => {
  const parsed = parseArgs(['backfill', '--limit=500', '--verbose', '--no-raw', '--dashboard']);
  assert.equal(parsed.flags.limit, '500');
  assert.equal(parsed.flags.verbose, true);
  assert.equal(parsed.flags.raw, false);
  assert.equal(parsed.flags.dashboard, true);
});

test('a trailing flag without a value is boolean', () => {
  const parsed = parseArgs(['research', 'clusters', '--json']);
  assert.equal(parsed.command, 'research');
  assert.deepEqual(parsed.positional, ['clusters']);
  assert.equal(parsed.flags.json, true);
});

test('--help is recognised anywhere', () => {
  assert.equal(parseArgs(['--help']).flags.help, true);
  assert.equal(parseArgs(['live', '-h']).flags.help, true);
});

test('negative and numeric values are treated as values only when attached', () => {
  const parsed = parseArgs(['backfill', '--limit', '0', '--rps', '2.5']);
  assert.equal(parsed.flags.limit, '0');
  assert.equal(parsed.flags.rps, '2.5');
});

test('an empty argv yields no command', () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.command, null);
  assert.deepEqual(parsed.positional, []);
});
