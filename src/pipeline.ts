/**
 * The analysis pipeline: raw mempool.space tx -> features -> classification ->
 * SQLite. Shared by backfill, live ingest, and offline re-classification so all
 * three paths produce byte-identical rows.
 */

import type { Db } from './db.ts';
import { extractFeatures } from './features.ts';
import { classify, rulesFingerprint, withBaseRates } from './fingerprints.ts';
import type { Logger } from './log.ts';
import type { MempoolClient } from './mempool.ts';
import type { Category, ClassifiedTx, IngestContext, MempoolTx, Profile } from './types.ts';

export interface PipelineOptions {
  client: MempoolClient;
  db: Db;
  profiles: readonly Profile[];
  /** Exclusive wallet categories, evaluated in priority order. */
  categories?: readonly Category[];
  logger: Logger;
  storeRaw?: boolean;
  tipRefreshMs?: number;
  concurrency?: number;
}

export interface StoreResult {
  txid: string;
  wallets: number;
  unknown: boolean;
  profiles: string[];
}

export class Pipeline {
  readonly client: MempoolClient;
  readonly db: Db;
  profiles: readonly Profile[];
  /** Exclusive wallet categories, evaluated in priority order. */
  categories: readonly Category[];
  readonly logger: Logger;
  readonly storeRaw: boolean;
  readonly concurrency: number;
  /** Digest of the current rule set, stamped onto every row we write. */
  rulesFingerprint: string;
  private readonly tipRefreshMs: number;
  private tipHeight: number | null = null;
  private tipFetchedAt = 0;

  constructor(options: PipelineOptions) {
    this.client = options.client;
    this.db = options.db;
    this.profiles = options.profiles;
    this.categories = options.categories ?? [];
    this.rulesFingerprint = rulesFingerprint(options.profiles, this.categories);
    this.logger = options.logger;
    this.storeRaw = options.storeRaw ?? true;
    this.concurrency = Math.max(1, options.concurrency ?? 6);
    this.tipRefreshMs = options.tipRefreshMs ?? 30_000;
  }

  /** Chain tip, cached briefly. Falls back to the last known value on error. */
  async currentTip(): Promise<number | null> {
    if (this.tipHeight !== null && Date.now() - this.tipFetchedAt < this.tipRefreshMs) {
      return this.tipHeight;
    }
    try {
      this.tipHeight = await this.client.tipHeight();
      this.tipFetchedAt = Date.now();
    } catch (err) {
      this.logger.warn(`could not refresh chain tip: ${(err as Error).message}`);
    }
    return this.tipHeight;
  }

  setTip(height: number): void {
    if (this.tipHeight === null || height > this.tipHeight) {
      this.tipHeight = height;
      this.tipFetchedAt = Date.now();
    }
  }

  get cachedTip(): number | null {
    return this.tipHeight;
  }

  /**
   * Re-measures every profile's base rate from stored data and applies it.
   *
   * Called before a backfill and on each reconcile, so specificity tracks the
   * corpus as the mempool's composition shifts (a Runes flood makes the broad
   * locktime-zero bucket even less informative, and the discount follows).
   */
  refreshProfiles(): { measured: number; total: number } {
    const { counts, total } = this.db.profileBaseRates();
    this.profiles = withBaseRates(this.profiles, counts, total);
    this.rulesFingerprint = rulesFingerprint(this.profiles, this.categories);
    this.db.setMeta('rules_fingerprint', this.rulesFingerprint);
    return { measured: counts.size, total };
  }

  analyze(tx: MempoolTx, ctx: IngestContext): ClassifiedTx {
    const features = extractFeatures(tx, ctx);
    const classification = classify(features, this.profiles, this.categories);
    return { tx, features, classification };
  }

  store(classified: ClassifiedTx, raw: unknown | null): void {
    this.db.saveAnalysis(classified, { raw, rulesFingerprint: this.rulesFingerprint });
  }

  /** Fetch a txid, classify it, persist it. Returns null when the fetch failed. */
  async fetchAndStore(txid: string, ctx?: IngestContext): Promise<StoreResult | null> {
    let tx: MempoolTx;
    try {
      tx = await this.client.tx(txid);
    } catch (err) {
      // The websocket can announce a transaction a moment before the REST
      // backend can serve it (and barely-live transactions get replaced). One
      // short retry resolves the common indexing race; a genuine 404 means the
      // transaction is gone, so we drop it rather than retrying forever.
      if ((err as { status?: number }).status === 404) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        try {
          tx = await this.client.tx(txid);
        } catch (retryErr) {
          this.logger.debug(`tx ${txid.slice(0, 12)} unavailable: ${(retryErr as Error).message}`);
          return null;
        }
      } else {
        this.logger.warn(`failed to fetch ${txid.slice(0, 12)}: ${(err as Error).message}`);
        return null;
      }
    }
    const resolvedCtx: IngestContext = ctx ?? {
      tipHeight: await this.currentTip(),
      now: Math.floor(Date.now() / 1000),
    };
    const classified = this.analyze(tx, resolvedCtx);
    this.store(classified, this.storeRaw ? tx : null);
    return {
      txid: tx.txid,
      wallets: classified.classification.wallets.length,
      unknown: classified.classification.isUnknown,
      profiles: classified.classification.profiles.map((p) => p.profileId),
    };
  }

  /**
   * Re-evaluates stored transactions against the current rule set without any
   * network access, using the raw payload captured at ingest time.
   */
  reclassifyAll(): { processed: number; skipped: number; newlyKnown: number; newlyUnknown: number } {
    let processed = 0;
    let newlyKnown = 0;
    let newlyUnknown = 0;
    const now = Math.floor(Date.now() / 1000);

    for (const batch of this.db.iterReclassifiable(500)) {
      // One transaction per batch instead of per row: a full re-classify of tens
      // of thousands of rows otherwise generates a write transaction (and WAL
      // growth) for every single one.
      this.db.transaction(() => {
      for (const row of batch) {
        const tx = JSON.parse(row.raw_json) as MempoolTx;
        if (row.status === 'confirmed' && row.block_height !== null) {
          tx.status = {
            confirmed: true,
            block_height: row.block_height,
            block_hash: row.block_hash ?? undefined,
            block_time: row.block_time ?? undefined,
          };
        }
        const previous = JSON.parse(row.features_json) as {
          first_seen_at?: number;
          tip_height_at_seen?: number | null;
        };
        const ctx: IngestContext = {
          tipHeight: previous.tip_height_at_seen ?? null,
          now: previous.first_seen_at ?? now,
        };
        const classified = this.analyze(tx, ctx);
        if (row.is_unknown === 1 && !classified.classification.isUnknown) newlyKnown++;
        if (row.is_unknown === 0 && classified.classification.isUnknown) newlyUnknown++;
        this.db.saveAnalysis(classified, {
          raw: tx,
          now,
          rulesFingerprint: this.rulesFingerprint,
        });
        processed++;
      }
      });
    }

    return { processed, skipped: this.db.countTxs() - processed, newlyKnown, newlyUnknown };
  }
}
