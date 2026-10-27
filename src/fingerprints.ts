/**
 * Node-side rule loading.
 *
 * The engine itself lives in `rules.ts`, which imports nothing from Node so it
 * can also be bundled for the browser. This module adds the things only a
 * filesystem host can do: resolving rule paths, reading files, and hashing the
 * rule set to detect stale stored classifications.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProfileSet, ENGINE_VERSION, parseRulesDocument, RuleError } from './rules.ts';
import type { ProfileSet, RuleDocument } from './rules.ts';
import type { Category, Profile } from './types.ts';

export * from './rules.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RULES_PATH = resolve(HERE, '..', 'rules', 'default.yaml');
export const LOCAL_RULES_PATH = resolve(HERE, '..', 'rules', 'local.yaml');

/**
 * Stable digest of everything that affects a classification result.
 *
 * Cosmetic fields (title, summary, evidence) are excluded on purpose: rewording
 * a rule must not force a full reclassification. Measured fields (baseRate,
 * specificity) are excluded too, since they are derived from the corpus rather
 * than authored. Anything that changes *which* wallets a transaction gets, or at
 * what confidence, is included.
 */
export function rulesFingerprint(
  profiles: readonly Profile[],
  categories: readonly Category[] = [],
): string {
  const categoryPart = [...categories]
    .map((c) => ({ id: c.id, enabled: c.enabled, anyOf: c.anyOf, wallets: c.wallets, labels: c.labels }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const canonical = [...profiles]
    .map((p) => ({
      id: p.id,
      enabled: p.enabled,
      confidence: p.confidence,
      match: p.match,
      wallets: p.wallets,
      labels: [...p.labels].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256')
    .update(`engine:${ENGINE_VERSION}\n`)
    .update(JSON.stringify(canonical))
    .update(JSON.stringify(categoryPart))
    .digest('hex')
    .slice(0, 16);
}

function readRulesFile(path: string): RuleDocument {
  return parseRulesDocument(readFileSync(path, 'utf8'), path);
}

/**
 * Loads the built-in rule set, then applies an optional overlay file where a
 * profile with the same id replaces the built-in one (so you can retune a rule
 * without forking the whole file).
 */
export function loadProfiles(
  builtinPath: string = DEFAULT_RULES_PATH,
  overlayPath: string | null = LOCAL_RULES_PATH,
): ProfileSet {
  if (!existsSync(builtinPath)) throw new RuleError(`rules file not found: ${builtinPath}`);
  const files = [readRulesFile(builtinPath)];
  if (overlayPath && existsSync(overlayPath)) files.push(readRulesFile(overlayPath));
  return buildProfileSet(files);
}
