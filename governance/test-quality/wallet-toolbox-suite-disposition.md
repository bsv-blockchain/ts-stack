# Wallet Toolbox manual-suite disposition

Last reviewed: 2026-07-29
Owner: `ts-stack-maintainers`

This ledger records the manual-suite review that separates executable tests
from operator procedures, reusable examples, diagnostics, and obsolete
placeholders. A suite is not deleted merely because a static-analysis rule
cannot recognize its assertions. Every useful capability removed from a Jest
file must have an explicit maintained destination below.

The exact inventory of manual and live tests that remain under Jest is
[`wallet-toolbox-manual-suites.json`](./wallet-toolbox-manual-suites.json).
The repository governance check fails when that inventory is stale, duplicated,
or missing a suite.

## Extracted suites

| Former Jest file                                                                 | Actual role                                        | Maintained destination                                                                                                                       | Disposition rationale                                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/monitor/__test/MonitorDaemon.man.test.ts`                                   | Operator procedure                                 | `operator/commands/monitorDaemon.ts`; deterministic lifecycle coverage in `src/monitor/__test/MonitorDaemon.test.ts`                         | Starting a credentialed daemon is an operation, while shutdown ordering is a normal unit-test concern.                                                                                                        |
| `src/services/chaintracker/chaintracks/__tests/ChaintracksCDN.man.test.ts`       | Operator export procedure                          | `operator/commands/chaintracksExport.ts`                                                                                                     | Header export creates local artifacts and may read a public network. It now has explicit paths, bounds, plans, and evidence.                                                                                  |
| `src/services/chaintracker/chaintracks/__tests/createIdbChaintracks.man.test.ts` | Operator observation procedure                     | `operator/commands/chaintracksIdbObserve.ts`                                                                                                 | The skipped test intentionally ran forever. The command validates the same Chaintracks invariants, caps observation at 24 hours, unsubscribes, and destroys the instance.                                     |
| `test/Wallet/support/janitor.man.test.ts`                                        | State-review procedure                             | `operator/commands/walletReviewOutputs.ts`                                                                                                   | Inspecting and reconciling selected wallet outputs is an operator action, not a repeatable test.                                                                                                              |
| `test/Wallet/support/operations.man.test.ts`                                     | Mixed operator toolbox                             | The wallet commands listed below                                                                                                             | The file combined unrelated reviews, repairs, aborts, and diagnostics. Each capability now has an exact command, bounded selectors, dry-run planning, confirmation gates for writes, and structured evidence. |
| `test/Wallet/support/reqErrorReview.2025.05.06.man.test.ts`                      | Dated forensic script                              | `operator/commands/walletProofHistory.ts`; parser in `operator/proofHistoryReview.ts`; parser tests in `operator/proofHistoryReview.test.ts` | Export, offline analysis, and explicit request verification are separate modes. Artifacts are versioned and bounded and omit raw transactions.                                                                |
| `test/Wallet/sync/Wallet.updateWalletLegacyTestData.man.test.ts`                 | Fixture construction plus embedded demo procedures | `operator/commands/walletLegacyFixture.ts`, `operator/commands/dojoImport.ts`, `monitor-daemon --mode once`, and `examples/sweep.ts`         | Test-chain fixture copying/purging, Dojo import, one-shot monitor execution, and a wallet-sweep recipe have different risks and ownership. They are now maintained independently.                             |
| `test/storage/StorageMySQLDojoReader.man.test.ts`                                | Dojo import procedure                              | `operator/commands/dojoImport.ts`                                                                                                            | The Jest file used a stale import flow. The operator command uses the current bounded sync-chunk API and records evidence.                                                                                    |

The former `operations.man.test.ts` capabilities map as follows:

| Capability                                       | Maintained destination              |
| ------------------------------------------------ | ----------------------------------- |
| Review invalid or missing wallet outputs         | `wallet-review-outputs`             |
| Review proof-request state                       | `wallet-review-proof-requests`      |
| Abort one selected action                        | `wallet-abort-action`               |
| Reconcile bounded stuck transactions             | `wallet-reconcile-stuck`            |
| Inspect transaction, BEEF, spend, and UTXO state | `wallet-diagnostics`                |
| Validate and repair selected proven transactions | `wallet-repair-proven-transactions` |
| Restore selected custom outputs                  | `wallet-review-custom-outputs`      |
| Re-internalize selected BRC-29 exports           | `wallet-reinternalize-exports`      |

## Extracted fragments from retained suites

| Retained suite                                                   | Extracted or retired fragment                                                      | Maintained destination or reason                                                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/storage/remoting/__test/StorageClient.man.test.ts`          | Infinite concurrent create/sign loop                                               | `operator/commands/storageClientExercise.ts`; the actual tagged-revision, availability, and authentication-replay tests remain. |
| `test/Wallet/live/walletLive.man.test.ts`                        | BRC-29 output/action recipes                                                       | `examples/walletPayment.ts`, with deterministic coverage in `test/examples/walletPayment.test.ts`.                              |
| `test/Wallet/live/walletLive.man.test.ts`                        | Production repair/diagnostic fragments                                             | Exact wallet operator commands above.                                                                                           |
| `test/Wallet/live/walletLive.man.test.ts`                        | Hard-coded funded root key and a private-key-printing generator                    | Retired. Callers now provide credentials through documented inputs; maintained code never prints or embeds keys.                |
| `test/Wallet/live/walletLive.man.test.ts`                        | Three cases iterating an array that was never populated                            | Retired as no-op placeholders; they executed no production or assertion path.                                                   |
| `test/Wallet/local/localWallet2.man.test.ts`                     | Hard-coded WIF/outpoint signing recipe                                             | `examples/spendP2pkhOutpoint.ts`; funded recovery, action, burn, and double-spend integration coverage remains.                 |
| `test/Wallet/local/localWallet2.man.test.ts`                     | Duplicate monitor, abort, invalid-output review, and empty BEEF-verifier fragments | Exact operator commands or existing asserted coverage; no unique behavior was lost.                                             |
| `test/examples/backup.man.test.ts`                               | Reusable backup implementation                                                     | `examples/backup.ts`; the governed manual suite now validates the example rather than containing it.                            |
| `test/Wallet/sync/Wallet.updateWalletLegacyTestData.man.test.ts` | Funded wallet sweep recipe                                                         | `examples/sweep.ts`, with caller-provided wallets and before/after evidence.                                                    |

## Safety and correctness changes made during extraction

- Operator commands are dry-run by default. State-changing execution requires
  both `--apply` and an exact `--confirm <command>` value; mainnet commands also
  require `--allow-production`.
- Commands accept exact identifiers, endpoints, paths, bounds, and
  environment-variable names. Plans report whether a named credential exists
  but never disclose its value.
- Former infinite loops are bounded, and network/storage resources are closed
  on every exit.
- Custom-output restoration uses keyset-style selection so mutations cannot
  cause offset-based records to be skipped, and it recovers unstored locking
  scripts from known-valid raw transactions before checking UTXO state.
- BRC-29 re-internalization uses the actual exported output index rather than a
  hard-coded output zero.
- Multi-transaction BEEF tests assert the real two-result and four-result
  cardinalities.
- Monitor destruction is awaited and has deterministic regression coverage.

## Review rule

Future reviews must classify a suspicious `*.man.test.ts` block by behavior:

1. Keep it as a test when it has a reproducible assertion oracle.
2. Extract it as an operator command when its purpose is to inspect, repair,
   migrate, synchronize, or mutate a selected environment.
3. Extract it as an example when its purpose is to teach a reusable API flow.
4. Extract fixture generation from validation and constrain it to disposable
   or explicitly selected state.
5. Retire it only when it is provably empty, unreachable, redundant, stale, or
   unsafe and its useful behavior is already mapped to a maintained
   destination.

Static-analysis cleanliness is evidence to verify after this classification,
not the reason for the classification.
