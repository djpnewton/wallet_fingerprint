/**
 * Live mempool ingest.
 *
 * The websocket is a notification channel: it announces new txids and new
 * blocks, but carries no vin/vout data. Each announced txid is fetched over
 * REST through the shared rate limiter and classified immediately, so the
 * database fills in arrival order.
 *
 * Two safety nets keep the log honest:
 *  - block events mark stored mempool transactions as confirmed;
 *  - a periodic reconcile compares the chain's mempool txid set against ours,
 *    marks vanished transactions confirmed/dropped, and slowly gap-fills
 *    anything the socket missed while we were disconnected.
 */

import { formatDuration } from './log.ts';
import { MempoolSocket, type SocketHandlers } from './mempool.ts';
import type { Pipeline } from './pipeline.ts';
import type { BlockSummary, MempoolTxStatus } from './types.ts';

/** Structural type so tests can drive the live loop without a real socket. */
export interface LiveSocket {
  run(signal: AbortSignal): Promise<void>;
  stop(): void;
}

export interface LiveOptions {
  /** Stop after N seconds; 0 runs until aborted. */
  durationSeconds?: number;
  reconcileSeconds?: number;
  gapFillLimit?: number;
  queueLimit?: number;
  /** Delay before the first reconcile pass (default 5s, capped at 30s). */
  initialReconcileDelayMs?: number;
  signal?: AbortSignal;
  onTx?: (info: { txid: string; wallets: number; unknown: boolean }) => void;
  onBlock?: (block: BlockSummary) => void;
  /** Injection point for tests; defaults to the real mempool.space websocket. */
  createSocket?: (handlers: SocketHandlers) => LiveSocket;
}

export interface LiveStats {
  announced: number;
  queued: number;
  processed: number;
  stored: number;
  unknown: number;
  failed: number;
  dropped: number;
  blocks: number;
  confirmed: number;
  reconnects: number;
}

class WorkQueue<T> {
  private items: T[] = [];
  private waiters: Array<(item: T | null) => void> = [];
  private closed = false;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = Math.max(16, limit);
  }

  get size(): number {
    return this.items.length;
  }

  push(item: T): boolean {
    if (this.closed) return false;
    if (this.items.length >= this.limit) return false;
    this.items.push(item);
    const waiter = this.waiters.shift();
    if (waiter) {
      const next = this.items.shift();
      waiter(next ?? null);
    }
    return true;
  }

  async shift(): Promise<T | null> {
    if (this.items.length > 0) return this.items.shift() as T;
    if (this.closed) return null;
    return new Promise<T | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Abandons any queued work. Draining instead would make shutdown take as long
   * as the backlog: with a full queue at the rate limit that is minutes, not
   * seconds. Anything dropped here is re-noticed by the next reconcile pass.
   */
  close(): void {
    this.closed = true;
    this.items.length = 0;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.(null);
    }
  }
}

/** Bounded set used only to suppress duplicate work inside one run. */
class LruSet {
  private readonly map = new Map<string, true>();
  private readonly max: number;

  constructor(max = 200_000) {
    this.max = max;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  add(key: string): void {
    this.map.set(key, true);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

export async function runLive(pipeline: Pipeline, options: LiveOptions = {}): Promise<LiveStats> {
  const { logger, db, client } = pipeline;
  const durationSeconds = options.durationSeconds ?? 0;
  const reconcileSeconds = options.reconcileSeconds ?? 300;
  const gapFillLimit = options.gapFillLimit ?? 1000;

  const stats: LiveStats = {
    announced: 0,
    queued: 0,
    processed: 0,
    stored: 0,
    unknown: 0,
    failed: 0,
    dropped: 0,
    blocks: 0,
    confirmed: 0,
    reconnects: 0,
  };

  const queue = new WorkQueue<string>(options.queueLimit ?? 5000);
  const seen = new LruSet();
  const controller = new AbortController();
  const startedAt = Date.now();

  const abort = (): void => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let durationTimer: ReturnType<typeof setTimeout> | null = null;
  if (durationSeconds > 0) durationTimer = setTimeout(abort, durationSeconds * 1000);

  const tip = await pipeline.currentTip();
  logger.info(
    `live ingest starting (tip ${tip ?? '?'}, ${client.limiter.rps} req/s, concurrency ${pipeline.concurrency})`,
  );

  let lastBlockHeight = tip ?? 0;

  const enqueue = (txid: string): void => {
    if (controller.signal.aborted) return;
    if (seen.has(txid)) return;
    seen.add(txid);
    if (db.hasTx(txid)) return;
    if (!queue.push(txid)) {
      stats.dropped++;
      if (stats.dropped % 100 === 1) {
        logger.warn(`queue full (${queue.size}); dropping new txids (${stats.dropped} so far)`);
      }
      return;
    }
    stats.queued++;
  };

  const workers = Array.from({ length: pipeline.concurrency }, async () => {
    for (;;) {
      const txid = await queue.shift();
      if (txid === null) return;
      if (controller.signal.aborted) return;
      const ctx = {
        tipHeight: await pipeline.currentTip(),
        now: Math.floor(Date.now() / 1000),
      };
      const result = await pipeline.fetchAndStore(txid, ctx);
      stats.processed++;
      if (result === null) stats.failed++;
      else {
        stats.stored++;
        if (result.unknown) stats.unknown++;
        options.onTx?.({ txid: result.txid, wallets: result.wallets, unknown: result.unknown });
      }
    }
  });

  let blockChain: Promise<void> = Promise.resolve();
  const handleBlocks = (blocks: BlockSummary[]): void => {
    blockChain = blockChain
      .then(async () => {
        const ordered = [...blocks].sort((a, b) => a.height - b.height);
        for (const block of ordered) {
          if (block.height <= lastBlockHeight) continue;
          lastBlockHeight = block.height;
          pipeline.setTip(block.height);
          db.saveBlock(block.height, block.id, block.timestamp, block.tx_count);
          stats.blocks++;
          options.onBlock?.(block);
          try {
            const txids = await client.blockTxids(block.id);
            const confirmed = db.markConfirmed(block.height, block.id, block.timestamp, txids);
            stats.confirmed += confirmed;
            logger.info(
              `block ${block.height} ${block.id.slice(0, 12)}… confirmed ${confirmed} tracked tx(s)`,
            );
          } catch (err) {
            logger.warn(`could not process block ${block.height}: ${(err as Error).message}`);
          }
        }
      })
      .catch((err: Error) => logger.warn(`block handling failed: ${err.message}`));
  };

  const handlers: SocketHandlers = {
    onTransactions(txids) {
      stats.announced += txids.length;
      for (const txid of txids) enqueue(txid);
    },
    onBlocks: handleBlocks,
    onStatus(status) {
      if (status === 'open') logger.info('websocket connected');
      else if (status === 'closed') stats.reconnects++;
    },
  };
  const socket: LiveSocket = options.createSocket
    ? options.createSocket(handlers)
    : new MempoolSocket({ baseUrl: client.baseUrl, logger, handlers });

  let reconciling = false;
  const reconcile = async (): Promise<void> => {
    if (reconciling || controller.signal.aborted) return;
    reconciling = true;
    const started = Date.now();
    try {
      const mempoolTxids = await client.mempoolTxids(controller.signal);
      const inMempool = new Set(mempoolTxids);

      const stored = db.db
        .prepare("SELECT txid FROM transactions WHERE status = 'mempool'")
        .all() as Array<{ txid: string }>;
      const missing = stored.map((r) => r.txid).filter((t) => !inMempool.has(t));

      const batch = missing.slice(0, 200);
      const confirmed: Array<{ txid: string; status: MempoolTxStatus }> = [];
      const dropped: string[] = [];
      for (const txid of batch) {
        if (controller.signal.aborted) break;
        try {
          const status = await client.txStatus(txid, controller.signal);
          if (status.confirmed) confirmed.push({ txid, status });
          else dropped.push(txid);
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === 404) dropped.push(txid);
        }
      }
      for (const { txid, status } of confirmed) {
        if (status.block_height !== undefined && status.block_hash !== undefined) {
          db.markConfirmed(status.block_height, status.block_hash, status.block_time ?? null, [txid]);
          stats.confirmed++;
        }
      }
      const droppedCount = db.markDropped(dropped);
      if (missing.length > 0) {
        logger.info(
          `reconcile: ${missing.length} tracked tx(s) left the mempool (${droppedCount} marked dropped, ${confirmed.length} confirmed)`,
        );
      }

      const known = db.allTxids();
      let gapFilled = 0;
      for (const txid of mempoolTxids) {
        if (gapFilled >= gapFillLimit) break;
        if (known.has(txid) || seen.has(txid)) continue;
        enqueue(txid);
        gapFilled++;
      }
      if (gapFilled > 0) logger.info(`reconcile: queued ${gapFilled} tx(s) we had not seen`);

      // Recalibrate specificity as the corpus grows.
      pipeline.refreshProfiles();

      logger.debug(`reconcile finished in ${Date.now() - started}ms`);
    } catch (err) {
      if (!controller.signal.aborted) logger.warn(`reconcile failed: ${(err as Error).message}`);
    } finally {
      reconciling = false;
    }
  };

  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  if (reconcileSeconds > 0) {
    reconcileTimer = setInterval(() => {
      void reconcile();
    }, Math.max(30, reconcileSeconds) * 1000);
    reconcileTimer.unref?.();
  }

  const reportTimer = setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    logger.info(
      `live: ${stats.stored.toLocaleString()} stored (${stats.unknown} unknown) of ` +
        `${stats.announced.toLocaleString()} announced, ${stats.failed} failed, ` +
        `${stats.dropped} dropped, queue ${queue.size}, ` +
        `${(stats.stored / Math.max(1, elapsed)).toFixed(1)} tx/s`,
    );
  }, 30_000);
  reportTimer.unref?.();

  // Delay the first reconcile: it downloads the whole mempool txid list, which
  // should not compete with the initial live burst.
  let reconcileTask: Promise<void> = Promise.resolve();
  if (reconcileSeconds > 0) {
    const delay =
      options.initialReconcileDelayMs ?? Math.min(30, Math.max(5, reconcileSeconds)) * 1000;
    const kickoff = setTimeout(() => {
      reconcileTask = reconcile();
    }, delay);
    kickoff.unref?.();
  }

  const socketRun = socket.run(controller.signal);

  await new Promise<void>((resolve) => {
    if (controller.signal.aborted) {
      resolve();
      return;
    }
    controller.signal.addEventListener('abort', () => resolve(), { once: true });
    // Defensive: if the socket gives up permanently we must not hang forever.
    void socketRun.then(() => {
      if (!controller.signal.aborted) {
        logger.warn('websocket loop exited unexpectedly; stopping');
        controller.abort();
      }
      resolve();
    });
  });

  logger.info('shutting down live ingest ...');
  socket.stop();
  queue.close();
  await Promise.all(workers);
  await blockChain;
  await socketRun;
  // Aborted requests settle immediately; the race is belt-and-braces so a stuck
  // reconcile can never keep the process alive after shutdown.
  await Promise.race([reconcileTask, new Promise<void>((r) => setTimeout(r, 5000).unref?.())]);
  if (reconcileTimer) clearInterval(reconcileTimer);
  clearInterval(reportTimer);
  if (durationTimer) clearTimeout(durationTimer);
  options.signal?.removeEventListener('abort', abort);

  const elapsed = (Date.now() - startedAt) / 1000;
  logger.info(
    `live stopped after ${formatDuration(elapsed)}: ${stats.stored.toLocaleString()} stored, ` +
      `${stats.unknown} unknown, ${stats.confirmed} confirmed by block, ${stats.failed} failed`,
  );
  return stats;
}
