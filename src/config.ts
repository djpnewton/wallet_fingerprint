/**
 * Configuration resolution: defaults < config.json < environment < CLI flags.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  apiBase: string;
  dbPath: string;
  rps: number;
  concurrency: number;
  storeRaw: boolean;
  dashboardPort: number;
  reconcileSeconds: number;
  idleTimeoutSeconds: number;
  gapFillLimit: number;
  rulesPath: string | null;
  overlayPath: string | null;
}

export const DEFAULTS: Config = {
  apiBase: 'https://mempool.space',
  dbPath: resolve('data', 'mempool.sqlite'),
  rps: 8,
  concurrency: 6,
  storeRaw: true,
  dashboardPort: 8787,
  reconcileSeconds: 300,
  idleTimeoutSeconds: 120,
  gapFillLimit: 1000,
  rulesPath: null,
  overlayPath: null,
};

type PartialConfig = Partial<Config>;

const ENV_MAP: Record<string, keyof Config> = {
  WF_API_BASE: 'apiBase',
  WF_DB_PATH: 'dbPath',
  WF_RPS: 'rps',
  WF_CONCURRENCY: 'concurrency',
  WF_STORE_RAW: 'storeRaw',
  WF_DASHBOARD_PORT: 'dashboardPort',
  WF_RECONCILE_SECONDS: 'reconcileSeconds',
  WF_IDLE_TIMEOUT_SECONDS: 'idleTimeoutSeconds',
  WF_GAP_FILL_LIMIT: 'gapFillLimit',
  WF_RULES_PATH: 'rulesPath',
  WF_OVERLAY_PATH: 'overlayPath',
};

const NUMERIC_KEYS = new Set<keyof Config>([
  'rps',
  'concurrency',
  'dashboardPort',
  'reconcileSeconds',
  'idleTimeoutSeconds',
  'gapFillLimit',
]);

function coerce(key: keyof Config, value: unknown): unknown {
  if (NUMERIC_KEYS.has(key)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (key === 'storeRaw') {
    if (typeof value === 'boolean') return value;
    const s = String(value).toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
    return undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

export function loadConfig(
  flags: PartialConfig = {},
  configPath: string | null = resolve('config.json'),
): Config {
  const config: Config = { ...DEFAULTS };

  if (configPath && existsSync(configPath)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`invalid config file ${configPath}: ${(err as Error).message}`);
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in DEFAULTS)) continue;
      const coerced = coerce(key as keyof Config, value);
      if (coerced !== undefined) (config as unknown as Record<string, unknown>)[key] = coerced;
    }
  }

  for (const [envKey, key] of Object.entries(ENV_MAP)) {
    const raw = process.env[envKey];
    if (raw === undefined) continue;
    const coerced = coerce(key, raw);
    if (coerced !== undefined) (config as unknown as Record<string, unknown>)[key] = coerced;
  }

  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined || value === null) continue;
    const coerced = coerce(key as keyof Config, value);
    if (coerced !== undefined) (config as unknown as Record<string, unknown>)[key] = coerced;
  }

  if (config.rps <= 0) throw new Error('rps must be > 0');
  if (config.concurrency <= 0) throw new Error('concurrency must be > 0');
  return config;
}
