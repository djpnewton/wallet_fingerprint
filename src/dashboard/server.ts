/**
 * Read-only dashboard: a single page plus a handful of JSON endpoints and an
 * SSE stream that re-pushes the stats report every few seconds.
 *
 * It binds to 127.0.0.1 by default; this is an observability surface for a
 * local ingest process, not a public service.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import type { Db } from '../db.ts';
import type { Logger } from '../log.ts';
import { buildStats, toRecentRow } from '../report.ts';
import { exportUnknown, nearMissReport, explain } from '../research.ts';
import type { Category, Profile } from '../types.ts';
import { rulesFingerprint } from '../fingerprints.ts';

export interface DashboardOptions {
  db: Db;
  profiles: readonly Profile[];
  categories: readonly Category[];
  port?: number;
  host?: string;
  logger: Logger;
  /** Extra runtime facts shown in the header (e.g. client request counters). */
  runtime?: () => Record<string, unknown>;
}

const INDEX_HTML = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function parseQuery(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams) out[key] = value;
  return out;
}

export interface DashboardHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export async function startDashboard(options: DashboardOptions): Promise<DashboardHandle> {
  const { db, profiles, logger } = options;
  const port = options.port ?? 8787;
  const host = options.host ?? '127.0.0.1';
  // Each stream remembers its own filter so the toggle can be per-client.
  const streamClients = new Set<{ res: ServerResponse; excludeSpam: boolean }>();
  const fingerprint = rulesFingerprint(profiles, options.categories);

  // Building the report costs ~1.5s over a large corpus, so it is cached per
  // filter. Serving a stale-by-a-few-seconds payload keeps HTTP responsive; the
  // alternative (rebuilding inline) blocked the event loop and made the whole UI
  // feel broken, because every request queued behind the rebuild.
  const STATS_TTL_MS = 8000;
  const statsCache = new Map<boolean, { at: number; json: string }>();

  const statsPayload = (excludeSpam = false, force = false): string => {
    const cached = statsCache.get(excludeSpam);
    if (!force && cached && Date.now() - cached.at < STATS_TTL_MS) return cached.json;
    const report = buildStats(db, fingerprint, profiles, options.categories, {
      recentLimit: 40,
      clusterLimit: 20,
      excludeSpam,
    });
    const json = JSON.stringify({
      type: 'stats',
      data: report,
      runtime: options.runtime?.() ?? {},
    });
    statsCache.set(excludeSpam, { at: Date.now(), json });
    return json;
  };

  const wantsNoSpam = (search: URLSearchParams): boolean => {
    const raw = search.get('exclude_spam');
    return raw === '1' || raw === 'true';
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const query = parseQuery(url);

    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }

    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(INDEX_HTML);
      return;
    }

    if (path === '/api/stats') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(statsPayload(wantsNoSpam(url.searchParams)));
      return;
    }

    if (path === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const excludeSpam = wantsNoSpam(url.searchParams);
      res.write(`event: stats\ndata: ${statsPayload(excludeSpam)}\n\n`);
      streamClients.add({ res, excludeSpam });
      req.on('close', () => {
        for (const client of streamClients) {
          if (client.res === res) streamClients.delete(client);
        }
      });
      return;
    }

    if (path === '/api/transactions') {
      const limit = Number(query.limit ?? 50);
      const rows = db.listTransactions({
        limit: Number.isFinite(limit) ? limit : 50,
        onlyUnknown: query.unknown === '1' || query.unknown === 'true',
        excludeSpam: query.exclude_spam === '1' || query.exclude_spam === 'true',
        onlySpam: query.spam_only === '1' || query.spam_only === 'true',
        ...(query.category ? { category: query.category } : {}),
        ...(query.wallet ? { wallet: query.wallet } : {}),
        ...(query.label ? { label: query.label } : {}),
        ...(query.status ? { status: query.status } : {}),
      });
      json(res, 200, { transactions: rows.map(toRecentRow) });
      return;
    }

    if (path === '/api/categories') {
      const rows = buildStats(db, fingerprint, profiles, options.categories, {
        recentLimit: 1,
        clusterLimit: 0,
        excludeSpam: wantsNoSpam(url.searchParams),
      });
      json(res, 200, { categories: rows.categories });
      return;
    }

    if (path === '/api/fingerprints') {
      const counts = new Map(db.profileCounts(500).map((c) => [c.profileId, c.txs]));
      json(res, 200, {
        profiles: profiles.map((p) => ({
          id: p.id,
          family: p.family,
          title: p.title,
          summary: p.summary,
          confidence: p.confidence,
          baseRate: p.baseRate,
          specificity: p.specificity,
          enabled: p.enabled,
          labels: p.labels,
          evidence: p.evidence,
          wallets: p.wallets,
          txs: counts.get(p.id) ?? 0,
        })),
      });
      return;
    }

    if (path === '/api/research/clusters') {
      json(res, 200, {
        clusters: db.researchClusters(Number(query.limit ?? 30) || 30, Number(query.min ?? 2) || 2, {
          includeWeak: query.weak === '1' || query.weak === 'true',
          excludeSpam: wantsNoSpam(url.searchParams),
        }),
      });
      return;
    }

    if (path === '/api/research/near-misses') {
      json(res, 200, {
        nearMisses: nearMissReport(db, profiles, {
          sampleSize: 5000,
          top: 20,
          excludeSpam: wantsNoSpam(url.searchParams),
        }),
      });
      return;
    }

    if (path === '/api/research/unknown.jsonl') {
      const rows = exportUnknown(db, {
        limit: Number(query.limit ?? 5000) || 5000,
        includeWeak: query.weak === '1' || query.weak === 'true',
        excludeSpam: query.exclude_spam === '1' || query.exclude_spam === 'true',
      });
      const body = rows.map((r) => JSON.stringify(r)).join('\n');
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': 'attachment; filename="unknown-transactions.jsonl"',
      });
      res.end(body);
      return;
    }

    if (path.startsWith('/api/tx/')) {
      const txid = path.slice('/api/tx/'.length).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txid)) {
        json(res, 400, { error: 'invalid txid' });
        return;
      }
      const explanation = explain(db, txid, profiles);
      if (!explanation) {
        json(res, 404, { error: 'transaction not found' });
        return;
      }
      json(res, 200, explanation);
      return;
    }

    json(res, 404, { error: 'not found' });
  });

  const streamTimer = setInterval(() => {
    if (streamClients.size === 0) return;
    // One build per distinct filter per tick, shared by every connected client.
    const payloads = new Map<boolean, string>();
    for (const client of streamClients) {
      try {
        let payload = payloads.get(client.excludeSpam);
        if (payload === undefined) {
          payload = statsPayload(client.excludeSpam);
          payloads.set(client.excludeSpam, payload);
        }
        client.res.write(`event: stats\ndata: ${payload}\n\n`);
      } catch {
        streamClients.delete(client);
      }
    }
  }, STATS_TTL_MS);
  streamTimer.unref?.();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  logger.info(`dashboard listening on http://${host}:${boundPort}`);

  return {
    server,
    port: boundPort,
    close: async () => {
      clearInterval(streamTimer);
      for (const client of streamClients) {
        try {
          client.res.end();
        } catch {
          /* ignore */
        }
      }
      streamClients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
