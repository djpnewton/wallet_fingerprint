# wallet-fingerprint

Logs the Bitcoin mempool through the [mempool.space](https://mempool.space) API and
tags every transaction with the wallet software whose fingerprint it plausibly
carries. Unmatched transactions — and transactions that only match weakly — are
kept in a research pool you can cluster and mine for new fingerprints.

```bash
npm install
node src/cli.ts live --dashboard      # stream the mempool, serve the UI on :8787
node src/cli.ts backfill --limit 500  # catch up on what is already in the mempool
node src/cli.ts stats                 # what have we got?
```

![dashboard](docs/dashboard.png)

## Why "fingerprint", not "identity"

Wallets make hundreds of small, observable choices when they build a
transaction: nVersion, whether to set nLockTime to the chain tip, which sequence
numbers to use, which script types they can spend and pay to, how they order
outputs, where change lands, whether they add OP_RETURN carriers or anchor
outputs, how they batch. Those choices form a **behavioural signature**.

Signatures are shared. A "v2, tip-height locktime, RBF, native segwit" spend is
what Bitcoin Core, Electrum, Sparrow, Nunchuk, Trezor Suite and half a dozen
others all produce. So this tool never picks a single winner: it tags the
transaction with **every** profile it matches and ranks the candidate wallets by
plausibility. When independent signatures agree on a wallet, confidence
increases (noisy-OR); a lone weak signature stays weak.

Treat the output as a lead, not proof.

### Specificity: why a common shape must not name a wallet

Attribution alone is not enough, because a fingerprint is only worth as much as
it is *rare*. Early on this tool reported Muun on 60% of tracked transactions —
not because anything pointed at Muun, but because Muun was listed in
`v2 + no locktime + RBF + segwit`, a bucket that now describes most of the
mempool (largely Runes spam at 0.1 sat/vB). The bucket was doing the talking.

So every profile's **prevalence** is measured against your own database, and its
plausibility is scaled by its **specificity**:

```
specificity = clamp( log2(1 / prevalence) / 4 , 0, 1 )
```

4 bits means "matches at most 6.25% of traffic" earns full weight. A signature
matching 60% scores 0.18; matching 90% scores ~0.08; matching everything scores 0.
The effect is self-correcting — as the mempool's mix shifts, the discount follows,
and no rule can hand out confidence just by being broad. Labels (`type:coinjoin`,
`protocol:runes`, …) are *behavioural facts* and are never discounted; only
wallet attribution is.

Live ingest and backfill re-measure prevalence on every reconcile, and `classify`
iterates until it converges. `show <txid>` prints each match with its prevalence
and specificity so any number can be traced back to its evidence.

Because of this, **`stats` reports three disjoint buckets** — `confident`
(≥35%), `weak` (<35%) and `unknown` — and they always add up to the corpus. An
earlier version showed "wallet-tagged: 90%", which was really just the share of
transactions that had *any* tag at all, ~86% of which were 2–10% generic
descriptors. Read the confident number.

### Spam: Runes, Ordinals and data carriers

Half the modern mempool is not payment traffic. In a typical snapshot ~55% of
transactions carry an OP_RETURN, almost all of them Runes mints at 0.1 sat/vB.
Averaged over everything, wallet statistics describe Runes bots rather than
wallets.

Every transaction is therefore tagged with a coarse `spam_kind`:
`runes`, `ordinals`, `inscription`, `data-carrier` or `dust` (null for ordinary
payments). Omni is deliberately **not** spam — USDT transfers are real value
transfers even though they also use an OP_RETURN.

They stay visible and queryable; the dashboard has a **hide spam** toggle
(persisted per browser) that re-renders every statistic without them, and the CLI
takes `--no-spam`.

**Spam is still wallet traffic.** A Runes mint is signed by software holding a
key, so it gets ordinary wallet attribution: the payload narrows the candidate
set to wallets that understand Runes, and the *shape* separates the
implementations. Two clearly distinct mint builders are visible in observed
traffic — `change-first` with descending outputs (≈6,400 txs) versus
`change-last` with ascending outputs (≈710) — and they are separate profiles.

One deliberate asymmetry: a protocol profile's prevalence is **not** discounted
the way a shape profile's is. A Runes payload is a categorical constraint, and
its high prevalence reflects the mempool being flooded with that protocol rather
than ambiguity about which wallet built the transaction; discounting it would
erase every protocol fingerprint. The measured prevalence is still reported, and
the shape-level profiles still do the narrowing. The dashboard summarises it in a
**Protocol traffic** block beneath the ranking:

```bash
node src/cli.ts stats --no-spam
```

```
tracked 2,816 txs · 1,730 in mempool · 1,086 confirmed · 3,857 spam excluded
attribution: 329 confident (>=35%, 12%) · 1,959 weak (70%) · 528 unknown (19%)
```

Hiding spam roughly doubles the confident-attribution rate (5% → 12%), because
what it removes is noise that can never be attributed to a wallet.

### Two views: Wallets and Fingerprints

The dashboard (and `stats`) splits the corpus two ways, because the two questions
are genuinely different.

**Wallets — an exclusive partition.** Every transaction lands in exactly one
wallet *category* (declared in `rules/default.yaml` under `categories:`, evaluated
in priority order, first match wins). A category is a claim about behaviour —
"Bitcoin Core Style", "CoinJoin", "Runes Minting", "Legacy" — and carries the
specific wallet tags that could have produced it:

```
Bitcoin Core Style                                2,486 txs · 7.9% of corpus
  Tip-height nLockTime with a consistent sequence policy: the default draft of
  Bitcoin Core and the coordinators that drive it.
  [Bitcoin Core 90%] [Electrum 70%] [Sparrow Wallet 65%] [Nunchuk 60%] [Specter Desktop 50%]
  via core-rbf-tip-locktime (2,656) · core-final-tip-locktime (97)

Unclassified                                      4,753 txs · 15% of corpus
  no specific wallet tags
```

A category need not have any wallet tags — "Unclassified" has none, and the broad
shapes carry a single generic descriptor.

Wallet entries carry a `kind`: `software` is a product someone installs
(Bitcoin Core, Xverse, ord); `archetype` describes the builder ("generic custodial
send", "Runes mint tooling (change-first, descending)") and is not a vendor.
Categories list **software only** — folding archetypes in just repeats the
category title in near-synonyms — while the Fingerprints tab shows both, with
archetypes rendered as dashed muted chips. Broad categories fall back to their
archetype when they can name no product at all. Order is priority, so a Runes mint
(which also reuses an address and has `nLockTime` 0) is filed under *Runes
Minting*, never under *Address Reuse*. The counts add up to the corpus exactly.

Timelocked Miniscript vaults get their own category, because a revealed
`OP_CSV`/`OP_CLTV` branch is the strongest structural signal on-chain: ordinary
payment wallets never produce one. Candidates are **Liana** (a Miniscript wallet
built around timelocked recovery), Nunchuk and Specter. The recovery delay itself
is a fingerprint — the 1,008-block (one week) default accounts for most observed
timelocked inputs.

**Fingerprints — overlapping.** A transaction can match many fingerprints, which
is what makes the research pool work: `core-rbf-tip-locktime` and
`taproot-keypath-only` and `address-reuse` can all fire on one transaction. This
view is uncollapsed, so prevalence overlaps and sums past 100%.

The split also separates two numbers that were previously conflated:

- **prevalence** (measured) — what share of the corpus the fingerprint or
  category covers
- **plausibility** (authored) — which wallet is most likely *given* that
  fingerprint; it is a prior within the category, not a measurement

Earlier versions collapsed both into a single per-wallet ranking, which could not
be right: ~620 of each top wallet's attributions came from the *same* profile, so
the ranking presented one finding as five and its percentages were an artefact of
profile membership.

### Spam: Runes, Ordinals and data carriers

Half the modern mempool is not payment traffic. In a typical snapshot ~55% of
transactions carry an OP_RETURN, almost all of them Runes mints at 0.1 sat/vB.
Averaged over everything, wallet statistics describe Runes bots rather than
wallets.

Every transaction is therefore tagged with a coarse `spam_kind`:
`runes`, `ordinals`, `inscription`, `data-carrier` or `dust` (null for ordinary
payments). Omni is deliberately **not** spam — USDT transfers are real value
transfers even though they also use an OP_RETURN.

They stay visible and queryable; the dashboard has a **hide spam** toggle
(persisted per browser) that re-renders every statistic without them, and the CLI
takes `--no-spam`.

**Spam is still wallet traffic.** A Runes mint is signed by software holding a
key, so it gets ordinary wallet attribution: the payload narrows the candidate
set to wallets that understand Runes, and the *shape* separates the
implementations. Two clearly distinct mint builders are visible in observed
traffic — `change-first` with descending outputs (≈6,400 txs) versus
`change-last` with ascending outputs (≈710) — and they are separate profiles.

One deliberate asymmetry: a protocol profile's prevalence is **not** discounted
the way a shape profile's is. A Runes payload is a categorical constraint, and
its high prevalence reflects the mempool being flooded with that protocol rather
than ambiguity about which wallet built the transaction; discounting it would
erase every protocol fingerprint. The measured prevalence is still reported, and
the shape-level profiles still do the narrowing. The dashboard summarises it in a
**Protocol traffic** block beneath the ranking:

```bash
node src/cli.ts stats --no-spam
```

```
tracked 2,816 txs · 1,730 in mempool · 1,086 confirmed · 3,857 spam excluded
attribution: 329 confident (>=35%, 12%) · 1,959 weak (70%) · 528 unknown (19%)
```

Hiding spam roughly doubles the confident-attribution rate (5% → 12%), because
what it removes is noise that can never be attributed to a wallet.

### The fingerprint panel (why there is no wallet ranking)

A transaction matches a **fingerprint**, and every wallet that fingerprint lists
is equally consistent with it. Presenting a ranked list of wallets therefore
invited a false reading: Nunchuk, Bitcoin Core, Electrum, Sparrow and Specter
appeared as five separate findings with slightly different numbers, when in fact
**~620 of each one's attributions came from the single profile
`core-rbf-tip-locktime`**. The differences between those rows were an artefact of
secondary memberships, not evidence.

So the panel is fingerprint-centric:

```
Segwit spend, tip-height locktime, RBF signalled   CORE-DERIVED       740 txs · 8.8% of corpus
  Bitcoin Core 90% · Electrum 70% · Sparrow Wallet 65% · Nunchuk 60% · Specter Desktop 50% · …
```

The row answers "what kind of activity is this, and how common is it?"; the pills
answer "which software builds it, most plausible first". The percentages on the
pills are **authored priors within that fingerprint** — a judgement about which
wallet is most likely, not a measurement of how many transactions it built. That
distinction is the whole point: prevalence (measured) and plausibility (authored)
are never mixed into one number.

Earlier iterations tried an average confidence per wallet (blended 76% and 18%
hits into "37%"), a raw tag count (put a 2% descriptor at the top), an evidence
mass, and a best-pick count. Each was a different way of adding up the same
conflation; none of them could be right.

### Is my data stale?

Every row records the `rules_fingerprint` of the rule set that classified it — a
digest of the profile ids, conditions, confidences, wallets and labels, plus an
engine version. Cosmetic edits (titles, prose, evidence) and measured fields
(prevalence, specificity) are excluded, so re-wording a rule never invalidates
the corpus.

When the loaded rule set differs from the stored one, `stats` and the dashboard
say so:

```
warn  5,345 of 5,345 transactions were classified with a different rule set
      — run `wallet-fingerprint classify` to re-score them offline
```

Then:

```bash
node src/cli.ts classify       # re-scores everything from stored raw payloads
```

**Reclassify rather than delete.** Every row keeps its raw transaction JSON, so
`classify` recomputes features and attribution offline with no network calls.
Deleting the database throws away mempool transactions that are already gone from
the network and can never be re-fetched. Only rows written with `--no-raw` are
unrecoverable, and `classify` reports their count explicitly.


## Static web build (no backend)

`npm run build:web` produces `dist/web/` — `index.html` and a single `app.js` —
and there is nothing else. No database, no server, no storage. Open the folder
from any static host and the page classifies the live mempool in the browser.

```bash
npm run build:web
python3 -m http.server 8790 --directory dist/web
# http://127.0.0.1:8790
```

How it works: the page subscribes to the mempool.space websocket, fetches each
announced transaction over REST (the socket carries only txids), runs the *same*
rule engine and the *same* reporting code as the CLI, and counts everything in
memory. mempool.space sends `access-control-allow-origin: *`, so no proxy is
needed. The rule set is inlined at build time, so there is exactly one request
type: transactions.

[![the static build](docs/web.png)](docs/web.png)

**What is different, and why it matters.** The corpus is a *sample*: everything
seen since the page loaded, not the mempool. Base rates — and therefore
specificity — are measured against that sample, so they sharpen as it grows and
a freshly loaded page will look noisier than a long-running one. There is no
history either, so nothing can go stale and nothing survives a reload. For
research on a real corpus, use the stored version.

The two builds share `rules.ts` (matching), `features.ts` (extraction),
`report.ts` (counting) and `dashboard/index.html` (rendering). Only the transport
differs, which is why the numbers mean the same thing on both — `test/memory.test.ts`
asserts that the SQLite and in-memory stores produce identical reports for the
same corpus.

## Install

Requires Node.js ≥ 22.18 (uses `node:sqlite` and native TypeScript execution).
No native builds, two small dependencies (`yaml` + TypeScript for type-checking).

```bash
npm install
cp config.example.json config.json   # optional; every key has a default
npm test                             # 89 tests, no network required
npm run typecheck
```

## Commands

| command | what it does |
| --- | --- |
| `live` | subscribe to the websocket, fetch + classify each new transaction |
| `backfill` | walk the current mempool's txid list (resumable, samplable) |
| `classify` | re-run the rule set over stored transactions, offline |
| `stats` | summary, wallet categories, fingerprints, research clusters, recent traffic |
| `show <txid>` | full feature vector, matched profiles, candidate wallets, near misses |
| `research clusters` | group the research pool by coarse signature |
| `research near-miss` | rules that *almost* match the research pool |
| `research export` | dump the research pool as JSON Lines |
| `fingerprints` | list or validate the rule set |
| `dashboard` | serve the read-only web UI |
| — | `npm run build:web` builds the backend-free static version |
| `init` | create the database and validate the rules |

Useful flags: `--db <path>`, `--api <url>`, `--rps <n>`, `--concurrency <n>`,
`--no-raw` (don't keep raw JSON), `--rules <path>`, `--overlay <path>`,
`--limit <n|all>`, `--sample <n>`, `--duration <s>`, `--reconcile <s>`,
`--gap-fill <n>`, `--dashboard`, `--port <n>`, `--no-spam`, `--json`, `--quiet`,
`--verbose`.

### Live ingest

```bash
node src/cli.ts live --dashboard --rps 10 --concurrency 8
```

- The websocket (`wss://<instance>/api/v1/ws`) is only a *notification* channel:
  it announces txids and blocks but carries no vin/vout, so each announcement is
  fetched over REST and classified immediately.
- New blocks mark tracked transactions `confirmed` (one block-txids request per
  block, not per transaction).
- A reconcile pass every `--reconcile` seconds diffs the chain's mempool txid set
  against ours, marks vanished transactions `confirmed`/`dropped`, and queues
  anything the socket missed while disconnected. That gap-fill is also how a
  long-running process grinds through the existing mempool backlog.
- Ctrl-C finishes in-flight work, aborts the rest, and exits.

### Backfill

```bash
node src/cli.ts backfill --sample 2000 --limit 500   # quick, evenly spaced look
node src/cli.ts backfill --limit all --rps 12       # everything, resumable
```

There is no bulk transaction endpoint, so a full snapshot is one request per
transaction: ~50k transactions at 8 req/s is roughly two hours. The run is
resumable — already-stored txids are skipped — and prints an ETA.

**Use your own instance for large backfills.** The public instance is shared and
rate limited; `--api https://your.mempool.instance` avoids abusing it. 429s are
honoured via `Retry-After` with a global cooldown, and transient 5xx/network
failures retry with jittered exponential backoff.

## Adding a fingerprint

Rules are data, not code: `rules/default.yaml`, with an optional
`rules/local.yaml` overlay (same `id` replaces the built-in profile, so you can
retune without forking the file).

```yaml
profiles:
  - id: my-wallet-signature
    family: local
    title: v2 spend, locktime 0, exactly two equal outputs
    summary: What I observed from wallet X in June.
    confidence: 0.5           # how strongly this identifies the behaviour
    match:
      all:
        - { feature: version, op: eq, value: 2 }
        - { feature: locktime_class, op: eq, value: none }
        - { feature: output_count, op: eq, value: 2 }
        - { feature: equal_output_max, op: eq, value: 2 }
      any:                     # optional OR-group, ANDed with `all`
        - { feature: sequence_profile, op: eq, value: all_rbf }
        - { feature: sequence_profile, op: eq, value: all_final }
    wallets:
      - { name: Wallet X, confidence: 0.8, note: 'observed 2026-06' }
    labels: [behavior:no-antifid]
```

Operators: `eq ne in notIn gte gt lte lt between contains notContains
containsAny containsAll containsNone subsetOf exists absent`. Every feature name
is documented in [docs/FEATURES.md](docs/FEATURES.md) and validated at load time,
so a typo fails loudly instead of silently disabling a rule.

Two rules of thumb when authoring one:

- **Prefer a template over a shape.** `p2wsh_multisig_inputs >= 1 && multisig_m == 2
  && multisig_n == 2` identifies something concrete (Muun's 2-of-2 accounts);
  `input_types contains v0_p2wpkh` identifies a third of the network.
- **Only name a wallet you could defend.** If the signature also fits six other
  wallets, use a generic descriptor. Specificity will shrink the numbers anyway,
  but a short honest candidate list is more useful than a long noisy one.

Then re-score what you already have — no network needed:

```bash
node src/cli.ts classify
```

`--no-raw` disables the raw-JSON capture that makes offline re-classification
possible; keep it on unless disk is a concern.

## The research pool

A transaction is **unknown** when no profile matched at all. It is **weak** when
the best wallet attribution is below `0.35` plausibility — usually a broad
profile firing at 15–33%, which is not real attribution. Both stay in the
research pool:

```bash
node src/cli.ts research clusters --weak        # group by coarse signature
node src/cli.ts research near-miss --weak       # which condition blocks which rule?
node src/cli.ts research export --weak --out pool.jsonl
```

Two workflows pay off:

1. **Clusters.** A signature with hundreds of members and no profile is a missing
   fingerprint. `research clusters` shows count, average fee rate, average
   in/out, and example txids.
2. **Near misses.** For each unknown transaction, every failing profile is scored
   by the fraction of conditions it satisfied; the report aggregates the
   conditions that most often block a match. A rule that is one condition too
   strict shows up immediately (e.g. `output count lte 3 (157)`).

`show <txid>` prints the same near-miss detail for a single transaction, and
`/api/research/unknown.jsonl?weak=1` serves it from the dashboard.

## Data model

SQLite (`node:sqlite`), WAL mode, single file (`data/mempool.sqlite`).

| table | contents |
| --- | --- |
| `transactions` | one row per tx: header/fee/shape columns, full `features_json`, matched profiles, `category_id` (exclusive), wallet tags, labels, near misses, `is_unknown`, `best_wallet_confidence`, `spam_kind`, `rules_fingerprint` (staleness), optional `raw_json` |
| `tx_wallets` | `(txid, wallet, confidence, profiles)` — fast "everything tagged X" |
| `tx_labels` | `(txid, label)` |
| `tx_inputs` / `tx_outputs` | per-input/output detail for value and address analysis |
| `blocks` | ingested block headers, used for tip tracking |
| `meta` | ingest state |

Wallet tags are denormalised so dashboard and CLI queries stay index scans.

Storage is roughly **6 KB per transaction** with the raw payload kept (~3 GB for
the whole mempool); `--no-raw` roughly halves that at the cost of offline
re-classification.

`classify` rewrites every row, which generates an enormous write-ahead log: a
full re-run over 77k transactions pushed the WAL to **28 GB** and made every
query take seconds. Three things now prevent that — writes are batched into one
transaction per 500 rows instead of one per row, `PRAGMA journal_size_limit` caps
the WAL at 64 MB, and `classify` truncates the WAL when it finishes. If a
database is left with a bloated WAL, reclaim it with:

```bash
sqlite3 data/mempool.sqlite 'PRAGMA wal_checkpoint(TRUNCATE);'
```

The dashboard is read-only and binds to `127.0.0.1`: two tabs (Wallets /
Fingerprints), KPIs, behaviour labels, live transaction table, research clusters,
near misses, and a transaction inspector (paste a txid in the search box).

Reports are cached for 8 s per spam filter. Building one costs ~1.5 s over a
large corpus, and rebuilding it inline on every tick blocked the event loop —
which made the whole UI look frozen and the spam toggle appear to do nothing.

## Layout

```
src/
  cli.ts            command wiring and human output
  args.ts           argument parsing
  config.ts         defaults < config.json < env < flags
  mempool.ts        REST client (rate limit, retry, abort) + websocket
  features.ts       transaction -> feature vector
  rules.ts          the rule engine (matches, confidence) — browser-safe
  fingerprints.ts   rule *loading* from disk + rules digest (Node only)
  rows.ts           storage-agnostic row types the reporter builds from
  memory.ts         in-memory corpus for the static build, mirroring db.ts
  near-miss.ts      near-miss ranking over feature vectors — browser-safe
  pipeline.ts       fetch -> extract -> classify -> store (shared by all modes)
  backfill.ts       resumable mempool snapshot
  live.ts           websocket ingest, block confirmation, reconcile
  db.ts             schema, migrations, queries
  research.ts       clustering, near-miss aggregation, export, explain
  report.ts         shared stats payload
  render.ts         table/bar helpers
  dashboard/        HTTP server + single-page UI
  web/              static build entry (websocket ingest, no storage)
scripts/build-web.ts  bundles src/web into dist/web/
rules/default.yaml  the shipped fingerprint profiles
docs/FEATURES.md    every feature name and meaning
```

## Caveats

- Attribution is **heuristic**. A tag means "this transaction is consistent with
  how wallet X builds transactions", nothing more. Multiple wallets per
  transaction is normal and expected.
- Wallet behaviour changes with releases; profiles carry an `evidence` field and
  a confidence you should revisit. Named-exchange attributions are deliberately
  weaker than the generic "custodial batcher" entry.
- Change detection is intentionally conservative and refuses to guess when
  ambiguous, because a wrong change guess corrupts every downstream conclusion.
- Only public mempool data is used; nothing here deanonymises anyone on its own,
  and the database is a local file.
