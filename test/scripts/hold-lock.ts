/**
 * Holds a write transaction open for a fixed time, so a parent process can
 * verify that a second writer waits (busy timeout) instead of failing with
 * "database is locked".
 *
 * Usage: hold-lock.ts <db-path> <hold-ms>
 */

import { DatabaseSync } from 'node:sqlite';

const [, , dbPath, holdMsRaw] = process.argv;
if (!dbPath) {
  process.stderr.write('usage: hold-lock.ts <db-path> <hold-ms>\n');
  process.exit(1);
}
const holdMs = Number(holdMsRaw ?? 800);

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('BEGIN IMMEDIATE');
db.exec('CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER)');
db.exec('INSERT INTO lock_probe VALUES (1)');

// Signal the parent only once the write lock is definitely held.
process.stdout.write('locked\n');

setTimeout(() => {
  db.exec('COMMIT');
  db.close();
  process.exit(0);
}, holdMs);
