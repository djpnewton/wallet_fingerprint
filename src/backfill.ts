/**
 * Resumable mempool backfill.
 *
 * There is no bulk transaction endpoint on mempool.space, so a full snapshot is
 * one request per transaction. That is why this is resumable (already-stored
 * txids are skipped) and why `--sample` exists for quick looks.
 */

import { formatDuration } from './log.ts';
import { mapPool } from './mempool.ts';
import type { Pipeline } from './pipeline.ts';

export interface BackfillOptions {
  /** Max transactions to process; 0 means "everything not already stored". */
  limit: number;
  /** Evenly spaced sample of the mempool txid list; 0 disables sampling. */
  sample: number;
  signal?: AbortSignal;
  onProgress?: (progress: BackfillProgress) => void;
}

export interface BackfillProgress {
  done: number;
  total: number;
  stored: number;
  unknown: number;
  failed: number;
  elapsedSeconds: number;
  etaSeconds: number;
  ratePerSecond: number;
}

export interface BackfillResult extends BackfillProgress {
  candidates: number;
  skipped: number;
  aborted: boolean;
}

function evenlySpaced<T>(items: readonly T[], count: number): T[] {
  if (count <= 0 || count >= items.length) return [...items];
  const step = items.length / count;
  const out: T[] = [];
  for (let i = 0; i < count; i++) {
    const item = items[Math.floor(i * step)];
    if (item !== undefined) out.push(item);
  }
  return out;
}

export async function runBackfill(
  pipeline: Pipeline,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const { logger, client, db } = pipeline;
  const startedAt = Date.now();

  // A backfill can add thousands of rows, so calibrate against what we already
  // know before classifying anything new.
  const calibration = pipeline.refreshProfiles();
  if (calibration.total > 0) {
    logger.info(
      `calibrated ${calibration.measured} profile base rates against ${calibration.total.toLocaleString()} stored txs`,
    );
  }

  logger.info(`fetching mempool txid list from ${client.baseUrl} ...`);
  const allTxids = await client.mempoolTxids();
  logger.info(`mempool holds ${allTxids.length.toLocaleString()} transactions`);

  const sampled = options.sample > 0 ? evenlySpaced(allTxids, options.sample) : allTxids;
  if (options.sample > 0) logger.info(`sampled ${sampled.length} txids (evenly spaced)`);

  const known = db.allTxids();
  const pending: string[] = [];
  for (const txid of sampled) {
    if (!known.has(txid)) pending.push(txid);
  }
  const skipped = sampled.length - pending.length;
  logger.info(`${skipped.toLocaleString()} already stored, ${pending.length.toLocaleString()} to fetch`);

  const selected = options.limit > 0 ? pending.slice(0, options.limit) : pending;
  if (options.limit > 0 && pending.length > options.limit) {
    logger.info(`limiting this run to ${options.limit.toLocaleString()} transactions`);
  }

  const estimatedSeconds = selected.length / Math.max(0.1, client.limiter.rps);
  if (selected.length > 0) {
    logger.info(
      `estimated time at ${client.limiter.rps} req/s with concurrency ${pipeline.concurrency}: ${formatDuration(estimatedSeconds)}`,
    );
  }

  let done = 0;
  let stored = 0;
  let unknown = 0;
  let failed = 0;
  let aborted = false;
  const ctx = {
    tipHeight: await pipeline.currentTip(),
    now: Math.floor(Date.now() / 1000),
  };

  const report = (): BackfillProgress => {
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const ratePerSecond = done / Math.max(0.001, elapsedSeconds);
    const remaining = selected.length - done;
    return {
      done,
      total: selected.length,
      stored,
      unknown,
      failed,
      elapsedSeconds,
      ratePerSecond,
      etaSeconds: ratePerSecond > 0 ? remaining / ratePerSecond : Number.POSITIVE_INFINITY,
    };
  };

  const progressCallback = options.onProgress;
  let lastProgress = Date.now();

  await mapPool(selected, pipeline.concurrency, async (txid) => {
    if (options.signal?.aborted) {
      aborted = true;
      return;
    }
    const result = await pipeline.fetchAndStore(txid, ctx);
    done++;
    // A long run can add tens of thousands of rows; recalibrate as we go so the
    // specificity discount reflects the corpus we are actually accumulating.
    if (done % 500 === 0) pipeline.refreshProfiles();
    if (result === null) failed++;
    else {
      stored++;
      if (result.unknown) unknown++;
    }
    const now = Date.now();
    if (progressCallback && now - lastProgress >= 1000) {
      lastProgress = now;
      progressCallback(report());
    }
  });

  if (options.signal?.aborted) aborted = true;
  const finalProgress = report();
  return {
    ...finalProgress,
    candidates: selected.length,
    skipped,
    aborted,
  };
}
