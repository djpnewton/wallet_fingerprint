/**
 * Backend-free build: the whole analyser, running in the browser.
 *
 * There is no database and no server here. Transactions arrive from the
 * mempool.space websocket, are fetched one at a time over REST (the socket is a
 * notification channel only), classified with the same engine the CLI uses, and
 * counted in memory. The dashboard then renders from that corpus through the
 * same `buildStats` the server uses.
 *
 * Consequences worth stating plainly, because they change what the numbers mean:
 *  - The corpus is a *sample*: everything seen since this page loaded, not the
 *    mempool.
 *  - Base rates — and therefore specificity — are measured against that sample,
 *    so they sharpen as it grows.
 *  - There is no history: nothing can be stale, and nothing survives a reload.
 */

import rulesYaml from '../../rules/default.yaml';
import { extractFeatures } from '../features.ts';
import { MemoryCorpus } from '../memory.ts';
import { buildStats } from '../report.ts';
import { nearMissFromFeatures } from '../near-miss.ts';
import { buildProfileSet, classify, parseRulesDocument, withBaseRates } from '../rules.ts';
import type { Category, Classification, MempoolTx, Profile, TxFeatures } from '../types.ts';

const API = 'https://mempool.space';
const WS_URL = 'wss://mempool.space/api/v1/ws';

/** No storage means no staleness: every row is by definition current. */
const RULES_DIGEST = 'web';

/** Upper bound on retained transactions, so a long session cannot exhaust memory. */
const MAX_CORPUS = 20_000;
const FETCH_CONCURRENCY = 8;
/** Backlog cap: beyond this we drop the oldest arrivals rather than fall behind. */
const MAX_QUEUE = 600;
const PUBLISH_MS = 1_000;
const RECLASSIFY_MIN_MS = 4_000;
const RECLASSIFY_EVERY = 250;
/**
 * Base rates need *some* corpus before they mean anything, but waiting for a
 * full refresh interval leaves the first seconds reporting every fingerprint at
 * full specificity — the over-attribution this project exists to avoid.
 */
const FIRST_BASE_RATE_SAMPLE = 20;
const WEAK_THRESHOLD = 0.35;

const parsed = buildProfileSet([parseRulesDocument(rulesYaml, 'default.yaml')]);
const baseProfiles: readonly Profile[] = parsed.profiles;
const categories: readonly Category[] = parsed.categories;

const corpus = new MemoryCorpus();
let activeProfiles: readonly Profile[] = baseProfiles;
let tipHeight: number | null = null;
let addedSinceReclassify = 0;
let lastReclassify = 0;

const runtime = { requests: 0, rateLimitHits: 0, skipped: 0, failed: 0 };

const queue: string[] = [];
const seen = new Set<string>();
let inFlight = 0;

interface Subscriber {
  excludeSpam: boolean;
  onStats: (payload: unknown) => void;
}
let subscriber: Subscriber | null = null;

// ------------------------------------------------------------------ classifying

function classifyFeatures(features: TxFeatures): Classification {
  return classify(features, activeProfiles, categories);
}

/**
 * Re-measures base rates and re-scores the corpus.
 *
 * Specificity is derived from how often a fingerprint fires, so it only means
 * anything relative to the corpus in hand. Early on that corpus is small and the
 * estimate is noisy; re-running as it grows is what stops the plausibility
 * numbers being frozen at whatever the first few hundred transactions looked
 * like — the exact failure this project was built to avoid.
 */
function refreshBaseRates(): void {
  const { counts, total } = corpus.profileBaseRates();
  if (total === 0) return;
  activeProfiles = withBaseRates(baseProfiles, counts, total);
  corpus.reclassify(classifyFeatures, { rulesFingerprint: RULES_DIGEST });
  addedSinceReclassify = 0;
  lastReclassify = Date.now();
}

function maybeReclassify(): void {
  if (lastReclassify === 0) {
    // First pass: as soon as there is a sample worth measuring, even though the
    // interval rule below has not elapsed.
    if (corpus.size >= FIRST_BASE_RATE_SAMPLE) refreshBaseRates();
    return;
  }
  if (addedSinceReclassify < RECLASSIFY_EVERY) return;
  if (Date.now() - lastReclassify < RECLASSIFY_MIN_MS) return;
  refreshBaseRates();
}

// --------------------------------------------------------------------- ingesting

async function fetchTx(txid: string): Promise<MempoolTx | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    runtime.requests++;
    let res: Response;
    try {
      res = await fetch(`${API}/api/tx/${txid}`);
    } catch {
      continue;
    }
    if (res.status === 429) {
      runtime.rateLimitHits++;
      const retryAfter = Number(res.headers.get('retry-after') ?? '1');
      await sleep(Number.isFinite(retryAfter) ? Math.max(1, retryAfter) * 1_000 : 1_000);
      continue;
    }
    if (!res.ok) {
      // A 404 here is usually a race: the socket announced the transaction a
      // moment before it was retrievable.
      continue;
    }
    return (await res.json()) as MempoolTx;
  }
  runtime.failed++;
  return null;
}

function ingest(tx: MempoolTx): void {
  const features = extractFeatures(tx, { tipHeight, now: Math.floor(Date.now() / 1_000) });
  corpus.add(
    { tx, features, classification: classifyFeatures(features) },
    { rulesFingerprint: RULES_DIGEST },
  );
  addedSinceReclassify++;
  maybeReclassify();
}

function pump(): void {
  while (inFlight < FETCH_CONCURRENCY && queue.length > 0) {
    const txid = queue.shift() as string;
    inFlight++;
    void fetchTx(txid)
      .then((tx) => {
        if (tx) {
          ingest(tx);
          if (corpus.size > MAX_CORPUS) corpus.prune(MAX_CORPUS);
          seen.delete(txid);
        } else {
          seen.delete(txid);
        }
      })
      .finally(() => {
        inFlight--;
        pump();
      });
  }
}

function enqueue(txids: readonly string[]): void {
  for (const txid of txids) {
    if (seen.has(txid)) continue;
    seen.add(txid);
    queue.push(txid);
  }
  // Falling behind is worse than losing old arrivals: the newest transactions
  // are the ones describing current behaviour.
  while (queue.length > MAX_QUEUE) {
    const dropped = queue.shift();
    if (dropped) {
      seen.delete(dropped);
      runtime.skipped++;
    }
  }
  pump();
}

// ------------------------------------------------------------------------ socket

function connectSocket(): void {
  let socket: WebSocket;
  try {
    socket = new WebSocket(WS_URL);
  } catch {
    setTimeout(connectSocket, 3_000);
    return;
  }
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ action: 'want', data: ['blocks', 'live-2h-changed', 'stats'] }));
  });
  socket.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data !== 'string') return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (Array.isArray(msg.blocks)) {
      for (const block of msg.blocks) {
        const height = (block as { height?: number }).height;
        if (typeof height === 'number' && (tipHeight === null || height > tipHeight)) tipHeight = height;
      }
    }
    const txs = msg.transactions;
    if (Array.isArray(txs)) {
      const txids = txs
        .map((t) => (typeof t === 'object' && t !== null ? (t as { txid?: string }).txid : undefined))
        .filter((t): t is string => typeof t === 'string');
      if (txids.length > 0) enqueue(txids);
    }
  });
  socket.addEventListener('close', () => setTimeout(connectSocket, 3_000));
  socket.addEventListener('error', () => socket.close());
}

// --------------------------------------------------------------------- transport

function statsPayload(excludeSpam: boolean): unknown {
  return {
    data: buildStats(corpus, RULES_DIGEST, activeProfiles, categories, {
      recentLimit: 25,
      clusterLimit: 15,
      includeWeak: true,
      excludeSpam,
    }),
    runtime: {
      requests: runtime.requests,
      rateLimitHits: runtime.rateLimitHits,
      skipped: runtime.skipped,
      failed: runtime.failed,
    },
  };
}

function unknownJsonl(excludeSpam: boolean): string {
  const lines: string[] = [];
  for (const row of corpus.all()) {
    const weak = row.best_wallet_confidence < WEAK_THRESHOLD;
    if (row.is_unknown !== 1 && !weak) continue;
    if (excludeSpam && row.spam_kind !== null) continue;
    lines.push(
      JSON.stringify({
        txid: row.txid,
        first_seen_at: row.first_seen_at,
        fee_rate: row.fee_rate,
        signature: row.signature,
        spam_kind: row.spam_kind,
        category_id: row.category_id,
        best_wallet_confidence: row.best_wallet_confidence,
        wallets: JSON.parse(row.wallets_json),
        labels: JSON.parse(row.labels_json),
        features: row.features,
      }),
    );
  }
  return lines.join('\n');
}

const transport = {
  downloads: true as const,
  /** No backfill exists here, so telling the user to run one would be a lie. */
  emptyHint: 'no transactions yet — waiting for mempool traffic',
  stream: ({ excludeSpam, onStats }: { excludeSpam: boolean; onStats: (payload: unknown) => void }) => {
    subscriber = { excludeSpam, onStats };
    onStats(statsPayload(excludeSpam));
    return {
      close: () => {
        subscriber = null;
      },
    };
  },
  nearMisses: async (excludeSpam: boolean) => {
    const features = corpus.featuresForResearch(5_000, false, excludeSpam);
    return { nearMisses: nearMissFromFeatures(features, activeProfiles, { top: 15 }) };
  },
  tx: async (txid: string) => {
    const explanation = corpus.explain(txid);
    if (!explanation) throw new Error('not found');
    return explanation;
  },
  exportHref: (excludeSpam: boolean) =>
    URL.createObjectURL(new Blob([unknownJsonl(excludeSpam)], { type: 'application/x-ndjson' })),
};

declare global {
  interface Window {
    __wfTransport?: typeof transport;
  }
}
window.__wfTransport = transport;

// -------------------------------------------------------------------------- boot

setInterval(() => {
  if (subscriber) subscriber.onStats(statsPayload(subscriber.excludeSpam));
}, PUBLISH_MS);

void fetch(`${API}/api/blocks/tip/height`)
  .then((res) => (res.ok ? res.text() : null))
  .then((text) => {
    const height = Number(text);
    if (Number.isFinite(height) && height > 0) tipHeight = height;
  })
  .catch(() => {
    /* the websocket blocks feed will supply it shortly */
  })
  .finally(connectSocket);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
