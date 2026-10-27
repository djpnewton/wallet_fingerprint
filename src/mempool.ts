/**
 * mempool.space client.
 *
 * The public instance is shared and aggressively rate limited, so every call
 * goes through a token bucket, honours Retry-After, retries transient failures
 * with jittered exponential backoff, and never retries a hard 4xx. Point
 * `--api` at your own instance if you plan to backfill tens of thousands of
 * transactions.
 */

import type { Logger } from './log.ts';
import { sleep, silentLogger } from './log.ts';
import type {
  BlockSummary,
  MempoolRecentTx,
  MempoolStats,
  MempoolTx,
  MempoolTxStatus,
} from './types.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, message?: string) {
    super(message ?? `HTTP ${status} for ${path}`);
    this.name = 'HttpError';
    this.status = status;
    this.path = path;
  }
}

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private notBefore = 0;
  readonly rps: number;
  readonly burst: number;

  constructor(rps: number, burst?: number) {
    this.rps = Math.max(0.1, rps);
    this.burst = Math.max(1, burst ?? Math.ceil(this.rps));
    this.tokens = this.burst;
    this.lastRefill = Date.now();
  }

  /** Globally pause every caller (used for 429 / Retry-After). */
  cooldown(ms: number): void {
    this.notBefore = Math.max(this.notBefore, Date.now() + Math.max(0, ms));
  }

  cooldownRemainingMs(): number {
    return Math.max(0, this.notBefore - Date.now());
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now < this.notBefore) {
        await sleep(this.notBefore - now);
        continue;
      }
      const elapsedSec = (now - this.lastRefill) / 1000;
      if (elapsedSec > 0) {
        this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.rps);
        this.lastRefill = now;
      }
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.rps) * 1000);
      await sleep(Math.max(5, waitMs + Math.random() * 10));
    }
  }
}

export interface ClientOptions {
  baseUrl?: string;
  rps?: number;
  timeoutMs?: number;
  retries?: number;
  /** Base for exponential backoff; lowered in tests. */
  backoffBaseMs?: number;
  logger?: Logger;
}

export interface ClientStats {
  requests: number;
  retries: number;
  rateLimitHits: number;
  errors: number;
  bytes: number;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

const TXID_RE = /^[0-9a-fA-F]{64}$/;
const HASH_RE = /^[0-9a-fA-F]{64}$/;

export class MempoolClient {
  readonly baseUrl: string;
  readonly limiter: RateLimiter;
  readonly stats: ClientStats = { requests: 0, retries: 0, rateLimitHits: 0, errors: 0, bytes: 0 };
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffBaseMs: number;
  private readonly logger: Logger;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://mempool.space').replace(/\/+$/, '');
    this.limiter = new RateLimiter(options.rps ?? 4);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retries = options.retries ?? 4;
    this.backoffBaseMs = options.backoffBaseMs ?? 300;
    this.logger = options.logger ?? silentLogger;
  }

  private async requestText(
    path: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    let attempt = 0;
    for (;;) {
      await this.limiter.acquire();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
      const signal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal;
      this.stats.requests++;
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          headers: { accept: 'application/json', 'user-agent': 'wallet-fingerprint/0.1' },
          signal,
        });
        if (res.status === 429) {
          this.stats.rateLimitHits++;
          const waitMs = parseRetryAfter(res.headers.get('retry-after')) ?? this.backoffBaseMs * 2 ** attempt;
          this.limiter.cooldown(waitMs);
          this.logger.debug(`429 on ${path}; cooling down ${Math.round(waitMs)}ms`);
          if (attempt++ < this.retries) {
            this.stats.retries++;
            continue;
          }
          throw new HttpError(429, path, `rate limited after ${this.retries} retries`);
        }
        if (res.status >= 500) {
          if (attempt++ < this.retries) {
            this.stats.retries++;
            await sleep(this.backoffBaseMs * 2 ** attempt + Math.random() * this.backoffBaseMs);
            continue;
          }
          throw new HttpError(res.status, path);
        }
        if (!res.ok) throw new HttpError(res.status, path);
        const text = await res.text();
        this.stats.bytes += text.length;
        return text;
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (options.signal?.aborted) throw new Error(`request aborted for ${path}`);
        this.stats.errors++;
        if (attempt++ < this.retries) {
          this.stats.retries++;
          const backoff =
            Math.min(30_000, this.backoffBaseMs * 2 ** attempt) + Math.random() * this.backoffBaseMs;
          this.logger.debug(`retry ${attempt}/${this.retries} for ${path} in ${Math.round(backoff)}ms`);
          await sleep(backoff);
          continue;
        }
        throw new Error(`request failed for ${path}: ${(err as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private async requestJson<T>(
    path: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const text = await this.requestText(path, options);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`invalid JSON from ${path}: ${text.slice(0, 120)}`);
    }
  }

  async tipHeight(signal?: AbortSignal): Promise<number> {
    const text = await this.requestText('/api/blocks/tip/height', { signal });
    const height = Number(text.trim());
    if (!Number.isFinite(height)) throw new Error(`unexpected tip height payload: ${text.slice(0, 40)}`);
    return height;
  }

  async mempoolStats(signal?: AbortSignal): Promise<MempoolStats> {
    return this.requestJson<MempoolStats>('/api/mempool', { signal });
  }

  /** Every txid currently in the mempool (one ~4 MB response, slow on purpose). */
  async mempoolTxids(signal?: AbortSignal): Promise<string[]> {
    return this.requestJson<string[]>('/api/mempool/txids', { signal, timeoutMs: 90_000 });
  }

  /** Ten most recent mempool entries with fee/vsize only. */
  async mempoolRecent(signal?: AbortSignal): Promise<MempoolRecentTx[]> {
    return this.requestJson<MempoolRecentTx[]>('/api/mempool/recent', { signal });
  }

  async tx(txid: string, signal?: AbortSignal): Promise<MempoolTx> {
    if (!TXID_RE.test(txid)) throw new Error(`invalid txid: ${txid}`);
    return this.requestJson<MempoolTx>(`/api/tx/${txid.toLowerCase()}`, { signal });
  }

  async txStatus(txid: string, signal?: AbortSignal): Promise<MempoolTxStatus> {
    if (!TXID_RE.test(txid)) throw new Error(`invalid txid: ${txid}`);
    return this.requestJson<MempoolTxStatus>(`/api/tx/${txid.toLowerCase()}/status`, { signal });
  }

  async block(hash: string, signal?: AbortSignal): Promise<BlockSummary> {
    if (!HASH_RE.test(hash)) throw new Error(`invalid block hash: ${hash}`);
    return this.requestJson<BlockSummary>(`/api/block/${hash.toLowerCase()}`, { signal });
  }

  async blockTxids(hash: string, signal?: AbortSignal): Promise<string[]> {
    if (!HASH_RE.test(hash)) throw new Error(`invalid block hash: ${hash}`);
    return this.requestJson<string[]>(`/api/block/${hash.toLowerCase()}/txids`, {
      signal,
      timeoutMs: 60_000,
    });
  }
}

export interface SocketHandlers {
  onTransactions?: (txids: string[]) => void;
  onBlocks?: (blocks: BlockSummary[]) => void;
  onStatus?: (status: 'connecting' | 'open' | 'closed', detail?: string) => void;
}

export interface SocketOptions {
  baseUrl?: string;
  handlers: SocketHandlers;
  logger?: Logger;
  /** Close and reconnect if no frame arrives for this long. */
  idleTimeoutMs?: number;
}

/**
 * WebSocket subscription to the live mempool.
 *
 * The `transactions` feed is compact (txid, fee, vsize, value) so callers must
 * still fetch the full transaction over REST; the socket is a notification
 * channel, not a data source. Reconnects are handled here with jittered
 * exponential backoff, and the initial snapshot after (re)connect replays the
 * last two hours of changed transactions, which is why callers must dedupe.
 */
export class MempoolSocket {
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly wsUrl: string;
  private readonly handlers: SocketHandlers;
  private readonly logger: Logger;
  private readonly idleTimeoutMs: number;

  constructor(options: SocketOptions) {
    const base = (options.baseUrl ?? 'https://mempool.space').replace(/\/+$/, '');
    this.wsUrl = `${base.replace(/^http/, 'ws')}/api/v1/ws`;
    this.handlers = options.handlers;
    this.logger = options.logger ?? silentLogger;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  }

  async run(signal: AbortSignal): Promise<void> {
    this.stopped = false;
    while (!this.stopped && !signal.aborted) {
      try {
        await this.connectOnce(signal);
      } catch (err) {
        this.logger.warn(`websocket error: ${(err as Error).message}`);
      }
      if (this.stopped || signal.aborted) break;
      this.attempt++;
      const backoff = Math.min(60_000, 1000 * 2 ** Math.min(this.attempt, 6)) + Math.random() * 1000;
      this.logger.info(`reconnecting in ${(backoff / 1000).toFixed(1)}s`);
      await sleep(backoff);
    }
    this.handlers.onStatus?.('closed');
  }

  stop(): void {
    this.stopped = true;
    this.clearIdle();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.logger.warn(`no websocket frame for ${this.idleTimeoutMs}ms, reconnecting`);
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private connectOnce(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.handlers.onStatus?.('connecting');
      let settled = false;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        this.clearIdle();
        if (err) reject(err);
        else resolve();
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(this.wsUrl);
      } catch (err) {
        finish(err as Error);
        return;
      }
      this.ws = ws;

      const onAbort = (): void => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        finish();
      };
      signal.addEventListener('abort', onAbort, { once: true });

      ws.addEventListener('open', () => {
        this.attempt = 0;
        this.handlers.onStatus?.('open');
        this.armIdle();
        ws.send(JSON.stringify({ action: 'want', data: ['blocks', 'live-2h-changed', 'stats'] }));
      });

      ws.addEventListener('message', (event: MessageEvent) => {
        this.armIdle();
        const raw = typeof event.data === 'string' ? event.data : '';
        if (!raw) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return;
        }
        const txs = msg.transactions;
        if (Array.isArray(txs)) {
          const txids = txs
            .map((t) => (typeof t === 'object' && t !== null ? (t as { txid?: string }).txid : undefined))
            .filter((t): t is string => typeof t === 'string');
          if (txids.length > 0) this.handlers.onTransactions?.(txids);
        }
        const blocks = msg.blocks;
        if (Array.isArray(blocks)) {
          const summaries = blocks.filter(
            (b): b is BlockSummary =>
              typeof b === 'object' &&
              b !== null &&
              typeof (b as BlockSummary).height === 'number' &&
              typeof (b as BlockSummary).id === 'string',
          );
          if (summaries.length > 0) this.handlers.onBlocks?.(summaries);
        }
      });

      ws.addEventListener('close', () => {
        signal.removeEventListener('abort', onAbort);
        this.handlers.onStatus?.('closed');
        finish();
      });

      ws.addEventListener('error', () => {
        signal.removeEventListener('abort', onAbort);
        finish(new Error('websocket failure'));
      });
    });
  }
}

/** Bounded-concurrency map preserving input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index] as T;
      results[index] = await fn(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}
