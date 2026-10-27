#!/usr/bin/env node
/**
 * Command line entry point.
 *
 *   wallet-fingerprint init
 *   wallet-fingerprint live --dashboard
 *   wallet-fingerprint backfill --limit 2000
 *   wallet-fingerprint stats
 *   wallet-fingerprint show <txid>
 *   wallet-fingerprint research clusters
 *   wallet-fingerprint classify
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from './args.ts';
import { runBackfill } from './backfill.ts';
import { loadConfig, type Config } from './config.ts';
import { Db, WEAK_ATTRIBUTION_THRESHOLD } from './db.ts';
import { startDashboard } from './dashboard/server.ts';
import {
  DEFAULT_RULES_PATH,
  LOCAL_RULES_PATH,
  loadProfiles,
  rulesFingerprint,
  withBaseRates,
} from './fingerprints.ts';
import { createLogger, formatDuration } from './log.ts';
import { MempoolClient } from './mempool.ts';
import { Pipeline } from './pipeline.ts';
import { bar, pct, pctFine, sats, shortTxid, table } from './render.ts';
import { buildStats } from './report.ts';
import { clusters, exportUnknown, explain, nearMissReport } from './research.ts';
import { runLive } from './live.ts';

const HELP = `wallet-fingerprint — stream the Bitcoin mempool and tag transactions by wallet fingerprint

USAGE
  wallet-fingerprint <command> [options]

COMMANDS
  init                        create the database and validate the rule set
  live                        stream new mempool transactions and classify them
  backfill                    ingest the current mempool (or a sample of it)
  classify                    re-run the rule set over stored transactions
  stats                       summary, tag counts, unknown clusters
  show <txid>                 everything known about one transaction
  research clusters           group the unknown pool by coarse signature
  research near-miss          rules that almost match the unknown pool
  research export [--out f]   write the unknown pool as JSON Lines
  fingerprints [list|validate] inspect the fingerprint rule set
  dashboard                   serve the read-only web UI

OPTIONS
  --db <path>                 SQLite file (default data/mempool.sqlite)
  --api <url>                 mempool.space instance (default https://mempool.space)
  --rps <n>                   global request rate limit (default 8)
  --concurrency <n>           parallel tx fetches (default 6)
  --no-raw                    do not store raw transaction JSON (no re-classify)
  --rules <path>              replace the built-in rule file
  --overlay <path>            overlay rules by id (default rules/local.yaml)
  --config <path>             config file (default ./config.json)
  --limit <n|all>             backfill: max transactions this run
  --sample <n>                backfill: evenly spaced sample of the mempool
  --duration <seconds>        live: stop after N seconds
  --reconcile <seconds>       live: reconcile interval (default 300)
  --gap-fill <n>              live: max unseen txids queued per reconcile (default 1000)
  --dashboard                 also serve the web UI (live/backfill)
  --port <n>                  dashboard port (default 8787)
  --no-spam                   exclude Runes/Ordinals/data-carrier traffic from stats
  --weak                      research: include weakly attributed txs
  --max-confidence <n>        research: weak threshold (default 0.35)
  --json                      machine-readable output where supported
  --quiet | --verbose         log level
  -h, --help                  this text

EXAMPLES
  wallet-fingerprint live --dashboard
  wallet-fingerprint backfill --limit 500 --sample 5000
  wallet-fingerprint backfill --limit all --rps 12
  wallet-fingerprint research clusters --limit 30
`;

function numberFlag(value: string | boolean | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function configFromFlags(flags: Record<string, string | boolean>): Partial<Config> {
  const partial: Partial<Config> = {};
  if (typeof flags.db === 'string') partial.dbPath = resolve(flags.db);
  if (typeof flags.api === 'string') partial.apiBase = flags.api;
  if (flags.rps !== undefined) partial.rps = numberFlag(flags.rps, 8);
  if (flags.concurrency !== undefined) partial.concurrency = numberFlag(flags.concurrency, 6);
  if (flags.raw === false) partial.storeRaw = false;
  if (typeof flags.rules === 'string') partial.rulesPath = resolve(flags.rules);
  if (typeof flags.overlay === 'string') partial.overlayPath = resolve(flags.overlay);
  if (flags.port !== undefined) partial.dashboardPort = numberFlag(flags.port, 8787);
  if (flags.reconcile !== undefined) partial.reconcileSeconds = numberFlag(flags.reconcile, 300);
  if (flags['gap-fill'] !== undefined) partial.gapFillLimit = numberFlag(flags['gap-fill'], 1000);
  return partial;
}

function printHelpAndExit(code = 0): never {
  process.stdout.write(HELP);
  process.exit(code);
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.flags.help || parsed.command === 'help') printHelpAndExit(0);
  if (parsed.command === null) printHelpAndExit(1);

  const logger = createLogger({
    verbose: parsed.flags.verbose === true,
    quiet: parsed.flags.quiet === true,
  });
  const config = loadConfig(
    configFromFlags(parsed.flags),
    typeof parsed.flags.config === 'string' ? resolve(parsed.flags.config) : resolve('config.json'),
  );

  const command = parsed.command;

  if (command === 'fingerprints') {
    const set = loadProfiles(config.rulesPath ?? DEFAULT_RULES_PATH, config.overlayPath ?? LOCAL_RULES_PATH);
    const sub = parsed.positional[0] ?? 'list';
    if (sub === 'validate') {
      logger.info(`ok: ${set.profiles.length} profiles loaded (${set.profiles.filter((p) => !p.enabled).length} disabled)`);
      return 0;
    }
    if (parsed.flags.json === true) {
      process.stdout.write(`${JSON.stringify(set.profiles, null, 2)}\n`);
      return 0;
    }
    logger.info(
      table(
        ['id', 'family', 'conf', 'wallets', 'title'],
        set.profiles.map((p) => [
          p.id,
          p.family,
          p.confidence.toFixed(2),
          String(p.wallets.length),
          p.enabled ? p.title : `${p.title} (disabled)`,
        ]),
      ),
    );
    return 0;
  }

  const db = new Db(config.dbPath);
  const ruleSet = loadProfiles(config.rulesPath ?? DEFAULT_RULES_PATH, config.overlayPath ?? LOCAL_RULES_PATH);
  let profiles = ruleSet.profiles;
  const categories = ruleSet.categories;
  // Discount broad signatures using what we have already observed.
  const initialRates = db.profileBaseRates();
  profiles = withBaseRates(profiles, initialRates.counts, initialRates.total);

  if (command === 'init') {
    logger.info(`database ready at ${config.dbPath} (${db.countTxs()} transactions)`);
    logger.info(
      `rule set: ${profiles.length} profiles, ${profiles.reduce((n, p) => n + p.wallets.length, 0)} wallet attributions`,
    );
    db.close();
    return 0;
  }

  const client = new MempoolClient({
    baseUrl: config.apiBase,
    rps: config.rps,
    logger,
  });
  const pipeline = new Pipeline({
    client,
    db,
    profiles,
    categories,
    logger,
    storeRaw: config.storeRaw,
    concurrency: config.concurrency,
  });

  const maybeDashboard = async (): Promise<{ close: () => Promise<void> } | null> => {
    if (parsed.flags.dashboard !== true) return null;
    return startDashboard({
      db,
      profiles,
      categories,
      port: config.dashboardPort,
      logger,
      runtime: () => ({
        requests: client.stats.requests,
        retries: client.stats.retries,
        rateLimitHits: client.stats.rateLimitHits,
        errors: client.stats.errors,
        rps: config.rps,
      }),
    });
  };

  try {
    switch (command) {
      case 'live': {
        const dashboard = await maybeDashboard();
        const controller = new AbortController();
        const onSignal = (): void => {
          if (controller.signal.aborted) process.exit(130);
          logger.info('signal received, finishing in-flight work (ctrl-c again to force quit)');
          controller.abort();
        };
        process.on('SIGINT', onSignal);
        process.on('SIGTERM', onSignal);
        try {
          const stats = await runLive(pipeline, {
            durationSeconds: numberFlag(parsed.flags.duration, 0),
            reconcileSeconds: config.reconcileSeconds,
            gapFillLimit: config.gapFillLimit,
            signal: controller.signal,
            onTx: parsed.flags.verbose === true
              ? (info) => logger.debug(`${shortTxid(info.txid)} wallets=${info.wallets}${info.unknown ? ' UNKNOWN' : ''}`)
              : undefined,
          });
          logger.info(
            `done: ${stats.stored} stored, ${stats.unknown} unknown, ${stats.confirmed} confirmed, ${stats.failed} failed`,
          );
        } finally {
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
          await dashboard?.close();
        }
        return 0;
      }

      case 'backfill': {
        const dashboard = await maybeDashboard();
        const controller = new AbortController();
        const onSignal = (): void => {
          if (controller.signal.aborted) process.exit(130);
          logger.info('signal received, stopping after in-flight requests');
          controller.abort();
        };
        process.on('SIGINT', onSignal);
        process.on('SIGTERM', onSignal);
        try {
          const limitRaw = parsed.flags.limit;
          const limit = limitRaw === 'all' || limitRaw === true ? 0 : numberFlag(limitRaw, 1000);
          const sample = numberFlag(parsed.flags.sample, 0);
          logger.info(
            `backfill starting (limit ${limit === 0 ? 'all' : limit}, sample ${sample === 0 ? 'none' : sample})`,
          );
          let lastLog = Date.now();
          const result = await runBackfill(pipeline, {
            limit,
            sample,
            signal: controller.signal,
            onProgress: (p) => {
              if (Date.now() - lastLog < 5000) return;
              lastLog = Date.now();
              logger.info(
                `progress ${p.done.toLocaleString()}/${p.total.toLocaleString()} · ` +
                  `${p.stored.toLocaleString()} stored (${p.unknown} unknown) · ` +
                  `${p.ratePerSecond.toFixed(1)} tx/s · eta ${formatDuration(p.etaSeconds)}`,
              );
            },
          });
          logger.info(
            `backfill ${result.aborted ? 'aborted' : 'complete'} in ${formatDuration(result.elapsedSeconds)}: ` +
              `${result.stored.toLocaleString()} stored, ${result.unknown} unknown, ` +
              `${result.failed} failed, ${result.skipped.toLocaleString()} already present`,
          );
          if (client.stats.rateLimitHits > 0) {
            logger.warn(`hit the rate limit ${client.stats.rateLimitHits} times; consider --rps ${Math.max(1, Math.floor(config.rps / 2))}`);
          }
        } finally {
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
          await dashboard?.close();
        }
        return 0;
      }

      case 'classify': {
        // Classification determines which profiles fire, which determines the
        // base rates, which determine the plausibility discount. One extra pass
        // reaches a fixed point in practice, and every pass rewrites the whole
        // corpus, so the ceiling is deliberately low.
        let total = { processed: 0, newlyKnown: 0, newlyUnknown: 0, skipped: 0 };
        for (let pass = 0; pass < 2; pass++) {
          const calibration = pipeline.refreshProfiles();
          if (calibration.total === 0) break;
          const result = pipeline.reclassifyAll();
          total = { ...result, skipped: result.skipped };
          if (pass > 0 && result.newlyKnown === 0 && result.newlyUnknown === 0) break;
        }
        // A bulk rewrite leaves a large WAL; fold it back so reads stay fast.
        const checkpoint = db.checkpoint();
        if (checkpoint.checkpointed > 0) {
          logger.info(`checkpointed ${checkpoint.checkpointed.toLocaleString()} WAL frames`);
        }
        logger.info(
          `re-classified ${total.processed.toLocaleString()} stored transactions ` +
            `(${total.skipped.toLocaleString()} without raw payload skipped; ` +
            `${total.newlyKnown} moved unknown → tagged, ${total.newlyUnknown} moved tagged → unknown)`,
        );
        return 0;
      }

      case 'stats': {
        const excludeSpam = parsed.flags.spam === false;
        const report = buildStats(db, rulesFingerprint(profiles, categories), profiles, categories, {
          recentLimit: 15,
          clusterLimit: 15,
          excludeSpam,
        });
        if (parsed.flags.json === true) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
          return 0;
        }
        const s = report.summary;
        const share = (n: number): string => (s.total ? pct(n / s.total) : '0%');
        logger.info(
          `tracked ${s.total.toLocaleString()} txs · ${s.mempool.toLocaleString()} in mempool · ` +
            `${s.confirmed.toLocaleString()} confirmed` +
            (excludeSpam
              ? ` · ${s.spam.toLocaleString()} spam excluded`
              : ` · ${s.spam.toLocaleString()} spam included (--no-spam to hide)`),
        );
        if (report.spam.length > 0 && !excludeSpam) {
          logger.info(
            `spam breakdown: ${report.spam.map((b) => `${b.kind} ${b.txs.toLocaleString()}`).join(' · ')}`,
          );
        }
        // Deliberately lead with the honest split: a 6% "generic wallet" tag is not
        // an attribution, and counting it as one made an earlier version of this
        // report claim 90% coverage when only a few percent was meaningful.
        logger.info(
          `attribution: ${s.attributed.toLocaleString()} confident (>=${pct(WEAK_ATTRIBUTION_THRESHOLD)}, ` +
            `${share(s.attributed)}) · ${s.weak.toLocaleString()} weak (${share(s.weak)}) · ` +
            `${s.unknown.toLocaleString()} unknown (${share(s.unknown)})`,
        );
        if (s.stale > 0) {
          logger.warn(
            `${s.stale.toLocaleString()} of ${s.total.toLocaleString()} transactions were classified with a ` +
              'different rule set — run `wallet-fingerprint classify` to re-score them offline',
          );
        }
        const categoryRows = report.categories.filter((c) => c.txs > 0);
        if (categoryRows.length > 0) {
          logger.info(
            '\nwallet categories (exclusive — every transaction is in exactly one)',
          );
          const maxCat = Math.max(...categoryRows.map((c) => c.txs));
          process.stdout.write(
            `${table(
              ['category', 'txs', 'share', 'bar', 'candidate wallets'],
              categoryRows.map((c) => [
                c.title,
                String(c.txs),
                pctFine(c.prevalence),
                bar(c.txs, maxCat, 10),
                c.wallets.length > 0
                  ? c.wallets.map((w) => `${w.name} ${pct(w.confidence)}`).join(', ')
                  : '(no specific wallet tags)',
              ]),
              { align: ['left', 'right', 'right', 'left', 'left'], maxColumnWidth: 64 },
            )}\n`,
          );
        }

        const fingerprints = report.fingerprints.filter((f) => f.txs > 0);
        if (fingerprints.length > 0) {
          logger.info(
            '\nfingerprints (a transaction can match several; wallets listed here are equally consistent)',
          );
          const maxTx = Math.max(...fingerprints.map((f) => f.txs));
          process.stdout.write(
            `${table(
              ['fingerprint', 'txs', 'share', 'bar', 'candidate wallets'],
              fingerprints.slice(0, 20).map((f) => [
                f.id,
                String(f.txs),
                pctFine(f.prevalence),
                bar(f.txs, maxTx, 10),
                f.wallets.length > 0
                  ? f.wallets.map((w) => `${w.name} ${pct(w.confidence)}`).join(', ')
                  : '(labels only)',
              ]),
              { align: ['left', 'right', 'right', 'left', 'left'], maxColumnWidth: 64 },
            )}\n`,
          );
        }
        if (report.labels.length > 0) {
          logger.info('\nlabels');
          process.stdout.write(
            `${table(
              ['label', 'txs'],
              report.labels.map((l) => [l.label, String(l.txs)]),
              { align: ['left', 'right'], maxColumnWidth: 40 },
            )}\n`,
          );
        }
        if (report.clusters.length > 0) {
          logger.info('\nresearch clusters (unknown + weak attributions — candidates for a new profile)');
          process.stdout.write(
            `${table(
              ['txs', 'avg sat/vB', 'signature'],
              report.clusters.map((c) => [String(c.count), c.avg_fee_rate.toFixed(2), c.signature]),
              { align: ['right', 'right', 'left'], maxColumnWidth: 72 },
            )}\n`,
          );
        }
        if (report.recent.length > 0) {
          logger.info('\nrecent transactions');
          process.stdout.write(
            `${table(
              ['seen', 'txid', 'status', 'sat/vB', 'wallets', 'labels'],
              report.recent.map((r) => [
                new Date(r.first_seen_at * 1000).toISOString().slice(11, 19),
                shortTxid(r.txid),
                r.status,
                r.fee_rate.toFixed(1),
                r.wallets.length > 0
                  ? r.wallets
                      .slice(0, 3)
                      .map((w) => `${w.name} ${pct(w.confidence)}`)
                      .join(', ') + (r.wallets.length > 3 ? ` +${r.wallets.length - 3}` : '')
                  : '—',
                r.labels.slice(0, 3).join(', '),
              ]),
              { maxColumnWidth: 56 },
            )}\n`,
          );
        }
        return 0;
      }

      case 'show': {
        const txid = parsed.positional[0];
        if (!txid) {
          logger.error('show requires a txid');
          return 1;
        }
        const detail = explain(db, txid, profiles);
        if (!detail) {
          logger.error(`transaction ${txid} is not in the database`);
          return 1;
        }
        if (parsed.flags.json === true) {
          process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
          return 0;
        }
        const f = detail.features;
        logger.info(
          `txid ${detail.txid}\n` +
            `status ${detail.status}${detail.block_height ? ` at height ${detail.block_height}` : ''} · ` +
            `first seen ${new Date(detail.first_seen_at * 1000).toISOString()}\n` +
            `fee ${sats(detail.fee)} sat · ${sats(detail.vsize)} vB · ${detail.fee_rate.toFixed(2)} sat/vB\n` +
            `version ${f.version} · locktime ${f.locktime} (${f.locktime_class}) · sequences ${f.sequence_profile}\n` +
            `scripts ${f.input_type_profile || '—'} → ${f.output_type_profile || '—'} · ${f.input_count} in / ${f.output_count} out\n` +
            `change ${f.change_index === null ? 'not inferable' : `#${f.change_index} (${f.change_position}, ${f.change_script_type})`} · ` +
            `ordering ${f.output_order}${f.bip69_outputs ? ' · bip69' : ''}\n` +
            `signature ${f.signature}`,
        );
        if (detail.profiles.length > 0) {
          logger.info('\nmatched profiles (specificity = how rare the signature is)');
          process.stdout.write(
            `${table(
              ['profile', 'conf', 'prevalence', 'spec', 'title'],
              detail.profiles.map((p) => [
                p.profileId,
                p.confidence.toFixed(2),
                p.baseRate === null ? '—' : pctFine(p.baseRate),
                p.specificity.toFixed(2),
                p.title,
              ]),
              { align: ['left', 'right', 'right', 'right', 'left'], maxColumnWidth: 52 },
            )}\n`,
          );
        }
        if (detail.wallets.length > 0) {
          logger.info('\ncandidate wallets');
          process.stdout.write(
            `${table(
              ['wallet', 'plausibility', 'spec', 'signatures'],
              detail.wallets.map((w) => [
                w.name,
                pct(w.confidence),
                w.specificity.toFixed(2),
                w.profiles.join(', '),
              ]),
              { align: ['left', 'right', 'right', 'left'], maxColumnWidth: 60 },
            )}\n`,
          );
        } else {
          logger.info('\nno wallet matched — saved for research');
        }
        if (detail.labels.length > 0) logger.info(`labels: ${detail.labels.join(', ')}`);
        if (detail.nearMisses.length > 0) {
          logger.info('\nnear misses');
          process.stdout.write(
            `${detail.nearMisses
              .map((n) => `  ${n.title} — ${pct(n.ratio)} conditions met\n    ✗ ${n.failed.join('\n    ✗ ')}`)
              .join('\n')}\n`,
          );
        }
        logger.info('\ninputs');
        process.stdout.write(
          `${detail.inputs
            .map(
              (i) =>
                `  #${i.idx} ${i.address ?? '(no address)'} ${sats(i.value ?? 0)} sat ${i.script_type ?? ''}`,
            )
            .join('\n')}\n`,
        );
        logger.info('outputs');
        process.stdout.write(
          `${detail.outputs
            .map(
              (o) =>
                `  #${o.idx} ${o.address ?? '(no address)'} ${sats(o.value)} sat ${o.script_type}${o.is_dust ? ' DUST' : ''}`,
            )
            .join('\n')}\n`,
        );
        return 0;
      }

      case 'research': {
        const sub = parsed.positional[0] ?? 'clusters';
        const limit = numberFlag(parsed.flags.limit, 30);
        if (sub === 'clusters') {
          const includeWeak = parsed.flags.weak === true;
          const maxConfidence = numberFlag(parsed.flags['max-confidence'], WEAK_ATTRIBUTION_THRESHOLD);
          const rows = clusters(db, limit, numberFlag(parsed.flags['min-count'], 2), {
            includeWeak,
            maxConfidence,
            excludeSpam: parsed.flags.spam === false,
          });
          if (parsed.flags.json === true) {
            process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
            return 0;
          }
          if (rows.length === 0) {
            logger.info('no unknown clusters with at least the requested count');
            return 0;
          }
          logger.info(
            includeWeak
              ? `research pool: ${db.unknownCount().toLocaleString()} unknown + weak attributions ` +
                  `(<${maxConfidence}) in ${rows.length} clusters`
              : `unknown pool: ${db.unknownCount().toLocaleString()} transactions in ${rows.length} clusters`,
          );
          process.stdout.write(
            `${table(
              ['txs', 'avg sat/vB', 'in/out', 'signature', 'examples'],
              rows.map((c) => [
                String(c.count),
                c.avg_fee_rate.toFixed(2),
                `${c.avg_inputs.toFixed(1)}/${c.avg_outputs.toFixed(1)}`,
                c.signature,
                c.examples.slice(0, 2).map(shortTxid).join(' '),
              ]),
              { align: ['right', 'right', 'right', 'left', 'left'], maxColumnWidth: 62 },
            )}\n`,
          );
          return 0;
        }

        if (sub === 'near-miss') {
          const rows = nearMissReport(db, profiles, {
            top: limit,
            includeWeak: parsed.flags.weak === true,
            excludeSpam: parsed.flags.spam === false,
          });
          if (parsed.flags.json === true) {
            process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
            return 0;
          }
          if (rows.length === 0) {
            logger.info('no near misses — unknown transactions do not partially match any profile');
            return 0;
          }
          for (const row of rows) {
            process.stdout.write(
              `\n${row.title} (${row.profileId}) — ${row.txs} unknown tx(s), avg ${pct(row.avgRatio)} of conditions met\n`,
            );
            for (const failed of row.failed) {
              process.stdout.write(`  ✗ ${failed.condition} (blocks ${failed.count})\n`);
            }
          }
          return 0;
        }

        if (sub === 'export') {
          const rows = exportUnknown(db, {
            limit: limit === 0 ? 50_000 : limit,
            includeWeak: parsed.flags.weak === true,
            excludeSpam: parsed.flags.spam === false,
          });
          const out = typeof parsed.flags.out === 'string' ? resolve(parsed.flags.out) : null;
          const body = rows.map((r) => JSON.stringify(r)).join('\n');
          if (out) {
            writeFileSync(out, `${body}\n`);
            logger.info(`wrote ${rows.length} research-pool transactions to ${out}`);
          } else {
            process.stdout.write(`${body}\n`);
          }
          return 0;
        }

        logger.error(`unknown research subcommand: ${sub}`);
        return 1;
      }

      case 'dashboard': {
        const dashboard = await startDashboard({
          db,
          profiles,
          categories,
          port: config.dashboardPort,
          logger,
          runtime: () => ({ requests: client.stats.requests }),
        });
        await new Promise<void>((resolvePromise) => {
          const stop = (): void => {
            void dashboard.close().then(() => resolvePromise());
          };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
        return 0;
      }

      default:
        logger.error(`unknown command: ${command}`);
        printHelpAndExit(1);
    }
  } finally {
    db.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  });
