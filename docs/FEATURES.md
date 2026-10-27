# Feature reference

Every field produced by `extractFeatures()` (`src/features.ts`) for a transaction.
Rule files address these names directly, and `loadProfiles()` rejects unknown
names so a typo can never silently disable a rule.

Values are derived **only** from the transaction plus the chain-tip height at
first sight. No extra network calls are made, so a stored transaction can be
re-scored offline (`wallet-fingerprint classify`).

## Identity and context

| feature | type | meaning |
| --- | --- | --- |
| `txid` | string | transaction id |
| `first_seen_at` | number | unix seconds when we first ingested it |
| `tip_height_at_seen` | number \| null | chain tip height when we first saw it (used for locktime classification) |

## Header

| feature | type | meaning |
| --- | --- | --- |
| `version` | number | nVersion (1 legacy, 2 modern) |
| `locktime` | number | raw nLockTime |
| `locktime_class` | string | `none`, `tip_height`, `block_height`, `current_time`, `timestamp` |
| `locktime_tip_delta` | number \| null | `locktime - tip` when locktime is a height |
| `rbf_enabled_by_locktime` | boolean | any sequence ≤ `0xfffffffe` (locktime is active) |

`tip_height` is the anti-fee-sniping signature: within ±6 blocks of the tip.
`current_time` means within two hours of ingestion time.

## Size and fee

| feature | type | meaning |
| --- | --- | --- |
| `size` | number | bytes |
| `weight` | number | weight units |
| `vsize` | number | `ceil(weight / 4)` (mempool.space omits this field, so we derive it) |
| `fee` | number | sats |
| `fee_rate` | number | sat/vB, 3 decimals |
| `fee_rate_bucket` | string | `<1`, `1-2`, `2-5`, `5-10`, `10-50`, `50+` |
| `fee_round_10` | boolean | fee divisible by 10 |
| `fee_round_100` | boolean | fee divisible by 100 |

## Shape

| feature | type | meaning |
| --- | --- | --- |
| `input_count` | number | number of inputs |
| `output_count` | number | number of outputs |
| `io_ratio_bucket` | string | e.g. `1x2`, `3-4x10-19`, `50+x1` |
| `input_value_bucket` | string | BTC bucket of the input total, or `unknown` |

## Script types

| feature | type | meaning |
| --- | --- | --- |
| `input_script_types` | string[] | per input, in order (`p2pkh`, `p2sh`, `v0_p2wpkh`, `v0_p2wsh`, `v1_p2tr`, `unknown`) |
| `output_script_types` | string[] | per output, in order (also `op_return`, `anchor`, …) |
| `input_types` | string[] | sorted unique input types |
| `output_types` | string[] | sorted unique output types |
| `input_type_profile` | string | `+`-joined unique input types, e.g. `v0_p2wpkh+v1_p2tr` |
| `output_type_profile` | string | same for outputs |
| `all_inputs_same_type` | boolean | single input script type |
| `all_outputs_same_type` | boolean | single output script type |
| `segwit_inputs` | number | inputs spending `v0_*` or `v1_p2tr` |
| `taproot_inputs` | number | inputs spending `v1_p2tr` |
| `legacy_inputs` | number | inputs spending `p2pkh` or `p2sh` |
| `nested_segwit_inputs` | number | P2SH inputs whose witness is a single key (wrapped segwit) |
| `p2tr_keypath_inputs` | number | P2TR inputs with a single witness item |
| `p2tr_scriptpath_inputs` | number | P2TR inputs with more than one witness item |
| `p2wsh_multisig_inputs` | number | P2WSH inputs whose witness script is a bare `m <pk>… n CHECKMULTISIG` |
| `timelock_inputs` | number | inputs whose revealed witness script commits to a CSV or CLTV timelock |
| `timelocked_multisig_inputs` | number | of those, how many are also bare multisig |
| `witness_csv_values` | number[] | distinct `OP_CSV` operands (relative locktime, blocks/512s units) |
| `witness_cltv_values` | number[] | distinct `OP_CLTV` operands (height or unix time) |
| `multisig_m` | number \| null | threshold read from the first multisig script |
| `multisig_n` | number \| null | participant count read from the first multisig script |
| `witness_shapes` | string[] | sorted unique shapes: `p2wpkh`, `p2wsh`, `p2wsh_multisig`, `p2tr_keypath`, `p2tr_scriptpath`, `p2sh_p2wpkh`, `p2sh_wrapped_script` |
| `scriptsig_count` | number | inputs with a non-empty scriptSig |

## Sequence / RBF

| feature | type | meaning |
| --- | --- | --- |
| `sequence_values` | number[] | sorted unique sequence numbers |
| `sequence_profile` | string | `all_final`, `all_rbf`, `all_locktime_only`, `all_same_custom`, `mixed`, `none` |
| `is_rbf` | boolean | any sequence ≤ `0xfffffffd` (BIP125) |
| `all_final_sequences` | boolean | every sequence is `0xffffffff` |
| `has_relative_locktime` | boolean | a sequence has BIP68 enabled with a non-zero value |
| `distinct_sequence_values` | number | count of distinct sequences |

## Ordering and change

| feature | type | meaning |
| --- | --- | --- |
| `bip69_inputs` | boolean | inputs sorted by outpoint (either txid byte order), ≥2 inputs |
| `bip69_outputs` | boolean | ≥3 spendable outputs sorted by script then value |
| `output_order` | string | `bip69`, `asc`, `desc`, `equal`, `mixed`, `single` |
| `change_index` | number \| null | inferred change output, `null` when ambiguous |
| `change_position` | string | `first`, `last`, `middle`, `none` |
| `change_script_type` | string \| null | script type of the inferred change output |
| `change_matches_input_type` | boolean | change type appears among input types |

Change inference is deliberately conservative: it only fires when exactly one
spendable output reuses an input script type **and** at least one other output
does not. Anything ambiguous stays `null` instead of being guessed.

## Addresses

| feature | type | meaning |
| --- | --- | --- |
| `address_reuse` | boolean | an input address also appears among the outputs |
| `distinct_input_addresses` | number | unique input addresses with a known address |
| `distinct_output_addresses` | number | unique output addresses |

## Data carriers and protocols

| feature | type | meaning |
| --- | --- | --- |
| `op_return_count` | number | number of `op_return`/`nulldata` outputs |
| `op_return_protocols` | string[] | sorted unique: `runes`, `omni`, `brc20`, `ord`, `unknown`, `empty`, `nonstandard` |
| `has_op_return` | boolean | any data-carrier output |
| `has_inscription_envelope` | boolean | a witness item carries `OP_FALSE OP_IF "ord"` |
| `has_anchor_output` | boolean | P2A/anchor output (`51024e73`) |
| `spam_kind` | string \| null | `runes`, `ordinals`, `inscription`, `data-carrier`, `dust`, or null for ordinary payments |

`spam_kind` marks protocol traffic rather than wallet behaviour, so reports can
exclude it without deleting it. Precedence: inscription envelope → runes/ordinals
→ any other non-payment OP_RETURN payload → dust output. Omni is excluded from
spam on purpose: USDT transfers are real value transfers.

## Value policy

| feature | type | meaning |
| --- | --- | --- |
| `total_input_value` | number \| null | sats, `null` when a prevout is unavailable |
| `total_output_value` | number | sats |
| `known_input_values` | boolean | every prevout value was resolvable |
| `dust_output_count` | number | outputs below the dust threshold for their script type |
| `has_dust_output` | boolean | at least one dust output |
| `equal_output_max` | number | size of the largest group of identical output values |
| `equal_output_groups` | number | number of distinct values that repeat |
| `round_outputs_1000` | number | spendable outputs with value divisible by 1 000 |
| `round_outputs_10000` | number | divisible by 10 000 |
| `all_outputs_round_1000` | boolean | every spendable output is a round 1 000 multiple |

Dust thresholds (Bitcoin Core values): `p2pkh` 546, `p2sh` 540, `v0_p2wpkh` 294,
`v0_p2wsh` 330, `v1_p2tr` 330. Unspendable outputs are never counted as dust.

## Structure heuristics

| feature | type | meaning |
| --- | --- | --- |
| `is_coinjoin_like` | boolean | ≥3 identical outputs, ≥2 inputs, and the equal group is at least `min(inputs, outputs)` |
| `is_consolidation` | boolean | ≥5 inputs and ≤2 spendable outputs (and not CoinJoin-shaped) |
| `is_payment_batching` | boolean | ≥5 spendable outputs, no large equal group, ≥4 distinct outputs |

## Research key

| feature | type | meaning |
| --- | --- | --- |
| `signature` | string | coarse cluster key over version, locktime class, sequence profile, IO script types, IO bucket, change position, ordering, OP_RETURN protocol, equal-output presence, dust and round-value flags |

Transactions with the same `signature` share every wallet-controlled property we
currently measure, which is exactly what makes them a candidate for a new
profile rather than a one-off curiosity.

## Not features: prevalence and specificity

Two derived values are attached to **profiles**, not transactions:

| value | type | meaning |
| --- | --- | --- |
| `baseRate` | number \| null | fraction of the stored corpus the profile matches; `null` until measured |
| `specificity` | number | `clamp(log2(1 / baseRate) / 4, 0, 1)` — the plausibility multiplier |

A third derived value lives on the database, not on a profile: `rules_fingerprint`
is a digest of everything that affects attribution (ids, conditions, confidences,
wallets, labels, engine version). It is stamped onto every classified row so
`stats` can tell you when the corpus was scored by an older rule set.

`specificity` is what stops a broad signature from naming a wallet. A profile
matching 60% of traffic carries 0.72 bits of self-information and therefore only
18% of full attribution weight. It is recomputed from
`SELECT value, COUNT(*) … json_each(profile_ids_json)` on every reconcile and on
`classify`, so it tracks the mempool's composition rather than being a guess.

Timelock detection walks the revealed witness script **opcode by opcode, skipping
push data**. A byte scan for `0xb1`/`0xb2` is useless — those bytes occur inside
every pushed public key — which is why the first attempt reported 5,429 "CSV"
scripts instead of 688 real ones. The witness script is the last item of a
`v0_p2wsh` witness and the second-to-last of a `v1_p2tr` script-path witness.

Observed `OP_CSV` operands cluster tightly — 1008 blocks (one week) dominates,
then 8064 (eight weeks), 144 (one day) and 2016 (two weeks) — so a timelock
value is itself a fingerprint of the product's default.

Multisig scripts are parsed from the last witness item of a `v0_p2wsh` input:
`52 21<key> 21<key> 52 ae` is 2-of-2. Wallet products with a *fixed* multisig
template (Muun's 2-of-2 accounts, Casa's 2-of-3 vaults) are attributed from this
template, which is one of the few genuinely discriminating shapes on-chain.
