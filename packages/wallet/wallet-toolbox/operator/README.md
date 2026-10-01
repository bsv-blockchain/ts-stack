# Wallet Toolbox operator commands

This directory contains explicit operational workflows that must not masquerade
as Jest tests. Commands are omitted from published package artifacts and run
only from a source checkout after Wallet Toolbox has built.

Every command is dry-run by default. A mutating or artifact-producing command
requires both `--apply` and `--confirm <exact-command>`. A plan that can affect
production state or mainnet additionally requires `--allow-production`.
Credentials are read from named environment variables and are never accepted
as command-line values or emitted in evidence.

List commands:

```sh
pnpm --filter @bsv/wallet-toolbox operator -- --help
```

Preview a Chaintracks testnet export:

```sh
pnpm --filter @bsv/wallet-toolbox operator -- \
  chaintracks-export \
  --chain test \
  --output ./operator-artifacts/chaintracks-test
```

After inspecting the exact JSON plan, perform that export:

```sh
pnpm --filter @bsv/wallet-toolbox operator -- \
  chaintracks-export \
  --chain test \
  --output ./operator-artifacts/chaintracks-test \
  --apply \
  --confirm chaintracks-export
```

Mainnet export also requires `--allow-production`. The output directory must be
explicit and empty; the command refuses the filesystem root, the current
working directory, and non-empty targets.

## Monitor daemon

Preview a testnet monitor daemon using the default
`TEST_CLOUD_MYSQL_CONNECTION` environment variable:

```sh
pnpm --filter @bsv/wallet-toolbox operator -- \
  monitor-daemon \
  --chain test
```

After inspecting the plan, start it with:

```sh
pnpm --filter @bsv/wallet-toolbox operator -- \
  monitor-daemon \
  --chain test \
  --apply \
  --confirm monitor-daemon
```

The default `--mode daemon` runs until `SIGINT` or `SIGTERM`, stops monitor
tasks, awaits their completion, closes storage and Chaintracks, and then emits
evidence. Use `--mode once` to run and await exactly one complete monitor
maintenance pass—the maintained replacement for former one-shot fixture and
wallet-review Jest snippets. Mainnet also requires `--allow-production`.
Environment-variable names can be overridden with the documented `*-env`
options; secret values never belong on the command line.

## Dojo import

The Dojo importer requires one explicit destination. Preview a bounded testnet
import into a new local SQLite database:

```sh
pnpm --filter @bsv/wallet-toolbox operator -- \
  dojo-import \
  --chain test \
  --destination-sqlite ./operator-artifacts/dojo-test.sqlite \
  --max-chunks 10000
```

The default source and identity environment variables are
`TEST_DOJO_CONNECTION` and `MY_TEST_IDENTITY`. A MySQL destination uses
`--destination-env NAME` instead of `--destination-sqlite`. Remote
destinations and mainnet require `--allow-production`; existing SQLite data is
rejected unless `--drop-existing` is explicitly present. Execution still
requires `--apply --confirm dojo-import`.

## Wallet invalid-output review

Preview a read-only review for explicit users:

```sh
pnpm --filter @bsv/wallet-toolbox operator -- \
  wallet-review-outputs \
  --chain main \
  --user-ids 202,311
```

`--scope change` is the default and checks managed wallet change.
`--scope all` checks all basket outputs. Adding `--release` changes the plan
from read-only to remote-write and marks confirmed invalid outputs
unspendable. Mainnet or release execution requires
`--allow-production`, in addition to
`--apply --confirm wallet-review-outputs`. The command verifies every released
output from storage and emits aggregate counts without logging identities,
outpoints, connection strings, or credentials.

## Failed proof-request review

Preview a bounded read-only review:

```sh
pnpm --filter @bsv/wallet-toolbox operator -- \
  wallet-review-proof-requests \
  --chain main \
  --status doubleSpend \
  --offset 0 \
  --max-records 1000
```

The only accepted statuses are `doubleSpend` and `invalid`. The command checks
the selected requests against current chain services and reports aggregate
candidate counts. Adding `--unfail` makes it a remote-write plan; each updated
request is read back and verified. Mainnet or mutation requires
`--allow-production`; all execution requires
`--apply --confirm wallet-review-proof-requests`.

## Abort one wallet action

`wallet-abort-action` replaces hard-coded transaction and user IDs with required
`--reference` and `--user-id` inputs. It first resolves exactly one matching
transaction, records its prior status, aborts it, and verifies the persisted
`failed` status. It is always a production-affecting plan, even on testnet, and
therefore requires `--allow-production --apply --confirm wallet-abort-action`.

## Reconcile stale wallet transactions

`wallet-reconcile-stuck` reviews either `sending` or `unproven` transactions,
bounded by `--max-records` and `--older-than-hours`. It is read-only unless
`--repair` is supplied. Repair marks stale unknown transactions failed and
re-enters mined transactions without proof records into the standard unmined
proof-request pipeline. Both changes are read back and verified. An optional
`--transaction-id` narrows the operation to one record. Repair or mainnet
execution requires `--allow-production`, and all execution requires
`--apply --confirm wallet-reconcile-stuck`.

### Read-only wallet diagnostics

`wallet-diagnostics` replaces hard-coded forensic Jest cases with four bounded
reports: `recent-transactions`, `merged-beef`, `downstream-spends`, and
`input-utxos`. Each report accepts only its required selector (`--user-id`,
`--txids`, or `--raw-transaction-file`) and rejects ambiguous combinations.
The result is structured evidence rather than assertion-free console output.

### Proven-transaction proof repair

`wallet-repair-proven-transactions` reviews an explicit block-height range
(at most 1,000 heights) and independently validates the external header,
merkle root, leaf, index, and serialized path. It is read-only by default;
`--repair` writes only mismatched fields and verifies the exact persisted
record.

### Custom-output review and restoration

`wallet-review-custom-outputs` scans completed custom outputs marked
unspendable using stable output-ID pagination. It checks their current UTXO
status and remains read-only unless `--restore` is supplied. Restored rows are
read back and verified individually.

### BRC-29 export recovery

`wallet-reinternalize-exports` replaces the historical hard-coded WUI export
repair. It requires one source user and an explicit bounded destination-user
list, validates BRC-29 instructions and the intended payee, skips existing
destination outputs, and is read-only unless `--internalize` is supplied. The
destination output index is taken from the source record rather than assumed
to be zero, and every write is verified.

### Proof-history forensics

`wallet-proof-history` replaces the dated request-history Jest script. `export`
writes a versioned, bounded JSON artifact without raw transactions; `analyze`
validates that artifact and classifies meaningful status contradictions; and
`verify` checks an explicit request-ID list for complete inputs and valid
scripts. The parser is separately unit-tested, and export will not overwrite an
existing artifact unless `--overwrite` is explicit.

### Legacy fixture construction

`wallet-legacy-fixture` replaces the chained fixture-generation Jest file. It
is deliberately test-chain-only and has two exact modes: copy one public
identity from a named source database into one explicit SQLite/MySQL
destination, or purge transient records from one named fixture database.
Existing SQLite files are refused unless `--drop-existing` is explicit. Dojo
imports remain in `dojo-import`, monitor execution remains in
`monitor-daemon`, and the old funded sweep snippet is maintained separately as
the configuration-agnostic `examples/sweep.ts` recipe.

### Storage-client exercise

`storage-client-exercise` replaces the infinite concurrent loop previously
embedded in the tagged-revision manual suite. It requires one exact HTTPS
endpoint and a root-key environment-variable name, caps iterations at 100 and
concurrency at 32, verifies every create/sign result, and always requires the
normal apply/confirmation gate (plus production opt-in on mainnet).

### IndexedDB Chaintracks observation

`chaintracks-idb-observe` replaces the skipped infinite IndexedDB Chaintracks
Jest loop. It validates tip/hash/header/chainwork consistency, records observed
headers, caps observation at 24 hours, unsubscribes its listener, and destroys
the Chaintracks instance on every exit.
