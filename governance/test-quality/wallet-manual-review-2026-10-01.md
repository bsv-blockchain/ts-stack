# Wallet manual inventory review — 2026-10-01

Owner: `ts-stack-maintainers`

Review by: 2026-10-08

Source: `7539b7109de2c2cffa220b7a9df622ab807ab269` (the reviewed manual-suite bytes are unchanged in the reader working tree).

This is a static inventory and disposition review of all 30 wallet `*.man.test.ts` and `*.live.test.ts` suites. The tracked/discovered set matches the exact case-insensitive inventory with no missing or duplicate paths. Every retained suite has an explicit assertion oracle; the existing extraction destinations and retain-as-test decisions remain. No suite, assertion, skip, runtime input, required gate or execution classification rule is removed.

No manual, public-network, remote-state or funded suite was executed for this review. This record does not establish runtime success, provider readiness, restored funds, complete #544 qualification, or permission to run those operations. Existing skipped manual cases remain unexecuted. The next review is bounded to seven days.

## Corrected side-effect descriptions

Four entries understated observable operations in their existing source; all four now use `funded-state`:

- `src/storage/remoting/__test/StorageClient.man.test.ts` selects mainnet and creates/signs actions with broadcast enabled. The bounded loop is still a funded exercise.
- `src/wab-client/__tests/WABClient.man.test.ts` requests a faucet payment and asserts its amount, alongside authentication and user deletion. A localhost server address does not establish disposable funds.
- `test/Wallet/local/localWallet.man.test.ts` calls `createOneSatTestOutput` with the configured test-chain identity, changes the active cloud/local store and copies backups. The helper creates actions and sends its no-send batch. The local filename does not make the whole suite disposable.
- `test/WalletClient/LocalKVStore.man.test.ts` uses a mainnet setup and an attached WalletClient. SDK `LocalKVStore.set/remove` creates and spends one-satoshi tokens through wallet actions, so this is not disposable key-value storage.

The other 26 side-effect records remain. Fixed broadcaster timeout requests, chain/proof queries and public header subscriptions remain public-network tests; administrative statistics remain read-only remote assertions; backup-example creation remains a local-artifact operation with configured remote reads. Existing remote-state classifications cover profile/certificate/spec-operation mutations. These categories describe review scope, not an execution allowlist.

## Retained assertion oracles

Service suites assert exact transaction outcomes, error classifications, proof inclusion, bounded latency/case counts or provider/header relationships. Storage suites assert profile identity, availability, backup registration or synchronization results. Wallet action suites assert BEEF/cardinality, action outcomes, proof/signature checks and remapped identities. Certificate suites assert stored/encrypted fields and recovered cleartext. LocalKVStore asserts idempotent outpoints, retrieved values, removed token counts and empty baskets. The live Chaintracks suite compares independently requested tips, headers and stream events. These oracles justify keeping the suites as tests; they are not evidence that a current external service passes.

## Exact reviewed source inventory

Paths are relative to `packages/wallet/wallet-toolbox/`. SHA-256 binds the reviewed bytes without copying credentials, transaction fixtures or replay payloads.

| Suite                                                                                   | Side effects after review | SHA-256                                                            |
| --------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| `src/services/__tests/ARC.man.test.ts`                                                  | `funded-state`            | `651ae1bf5c018cf136a421465df458ff078492e5ffa05fa4a6468bfecc9d60ba` |
| `src/services/__tests/ARC.timeout.man.test.ts`                                          | `public-network`          | `6bb23b55eef1b44a3ec5cecc6e98271c9cd71d61d373a8ad2987a4c9001fc4f9` |
| `src/services/__tests/ArcGorillaPool.man.test.ts`                                       | `funded-state`            | `389fb06ebc0d0e2988599903087f1a9b2ad678f37c6e0506a09861a105412a49` |
| `src/services/__tests/Arcade.man.test.ts`                                               | `public-network`          | `53dabf49dc9b52f168ba9c75b79417d73a260f7ea67d8832d4d673fa8a88db0d` |
| `src/services/__tests/ArcadeMainnet.man.test.ts`                                        | `funded-state`            | `2353db932b9141dbb5a14b9a1f52ab70fcddaef1684b7ad00983d2f3fc1ccea8` |
| `src/services/__tests/ArcadeProof.man.test.ts`                                          | `public-network`          | `5060ad7c87b210b04b8607317d4c2020f40351753c989490608dbed5495f33ad` |
| `src/services/__tests/StorageE2E.man.test.ts`                                           | `funded-state`            | `f91208b3847e89af15eb015892b38caccc07c8a71c72536c6fb143c80a8c7a4c` |
| `src/services/__tests/postBeef.man.test.ts`                                             | `funded-state`            | `cb31d8c772003d0c456812b6a9a00ce842d3c99cdc7bfb61782b0a789dccf22e` |
| `src/services/chaintracker/chaintracks/Ingest/__tests/WhatsOnChainServices.man.test.ts` | `public-network`          | `5bf9f5a89c9dd211cb5b7067cfe9cbdb21ce01171c36520f174836547cb30251` |
| `src/services/chaintracker/chaintracks/__tests/Chaintracks.man.test.ts`                 | `public-network`          | `edd7ea29579208caedaaa485455e6c2950dd2b535c8f670769a656d90a0a7ed9` |
| `src/services/chaintracker/chaintracks/util/__tests/ChaintracksFetch.man.test.ts`       | `public-network`          | `2678082fc38c5b50d18a610665d42d2701a1fdd71210df56416db732042ba985` |
| `src/services/providers/__tests/WhatsOnChain.man.test.ts`                               | `public-network`          | `0ee5133324f2efb3ab8daeaf71b58b50fb50d90850e92432f7f9156c828913f6` |
| `src/storage/__test/adminStats.man.test.ts`                                             | `read-only-remote`        | `d3ad0c5a9848c6b149afa0c1622c8f669781e09a30d43e46803dec152f736eaa` |
| `src/storage/remoting/__test/StorageClient.man.test.ts`                                 | `funded-state`            | `8a62b93ed38dc695cf823e43790e3f2f485338bf1b6e8dd5db4d8f6778916824` |
| `src/wab-client/__tests/WABClient.man.test.ts`                                          | `funded-state`            | `147e0ff852c83e44279266f96f26031279ea89e1545c3cf74fc6518130099476` |
| `test/Wallet/StorageClient/storageClient.man.test.ts`                                   | `remote-state`            | `b636029a0a70b4bf88e15a89dc45d95a378e1d7c2b7dc58ded77a742da2659a2` |
| `test/wallet/action/createActionToGenerateBeefs.man.test.ts`                            | `funded-state`            | `8f5629079a37335fedd03303bc001d9d52e1ac6bca9b05ff16c0a449b0e775d3` |
| `test/Wallet/action/internalizeAction.a.man.test.ts`                                    | `funded-state`            | `4eb1c876b537d06b0caf4e8b60e887f5f7b99e555008d7999f02689cd8f695e2` |
| `test/Wallet/certificate/acquireCertificate.man.test.ts`                                | `remote-state`            | `ec07917964ec8d0c3b706f7b3ebe637d6d7874e41f70a94082dbbd4b8dc9a698` |
| `test/Wallet/live/walletLive.man.test.ts`                                               | `funded-state`            | `16b13b9683460cd6eef44b1362778b5a91c155f6046e52bb6d8cd7f01f67eb1b` |
| `test/Wallet/local/localWallet.man.test.ts`                                             | `funded-state`            | `c4562e5319edb63933d6dd3c86e9300eac6dd6f0e8f224c24e7f10cc4acc9090` |
| `test/Wallet/local/localWallet2.man.test.ts`                                            | `funded-state`            | `a8dccb910a93c4f010655877f2b4d765cf9de663263fbdc9a7ecdd96af08ae83` |
| `test/Wallet/signAction/mountaintop.man.test.ts`                                        | `funded-state`            | `caff05a77fce77ede7567e3e3949ffae7a2fab3ee74466cd048db1adfe4e13f4` |
| `test/Wallet/specOps/specOps.man.test.ts`                                               | `remote-state`            | `fb132ce9e7e92904f67e33ff760e54dc1498846eff4923ccf083e65d87d7911a` |
| `test/WalletClient/LocalKVStore.man.test.ts`                                            | `funded-state`            | `ab65d322ae9a2e32c6367116da38d3240f4f45ec9864299c5a471aaaeb44013b` |
| `test/WalletClient/WERR.man.test.ts`                                                    | `remote-state`            | `d64e2164e87d0cdb1339dac516cf8d9c703b784e12e4364d0c69ec6e781512a4` |
| `test/WalletClient/staging.auth.man.test.ts`                                            | `remote-state`            | `b86a0891ed7a6bd1fe3ce9805370bd5afea32f25a123530f3bd78d1ebc58cd2b` |
| `test/examples/backup.man.test.ts`                                                      | `local-artifact`          | `273fdc5044979c1f0e56d311c9198b832ccafb7757c8e63d73055b7e84dc8583` |
| `test/services/Services.man.test.ts`                                                    | `public-network`          | `5b01e9d638d4116ef7a5267d888a760a28592381dd814f5d0e1fb865edd78cbb` |
| `src/services/chaintracker/chaintracks/__tests/GoChaintracksServiceClient.live.test.ts` | `public-network`          | `bf4b4582d8e8496e056aa8eaaf82ea9687f835341c1ca500ccd0e843cd5e1b49` |

Review totals: 14 funded-state, 1 local-artifact, 9 public-network, 1 read-only-remote, 5 remote-state.

The nine test-governance regressions pass. With the separately reviewed mutation
date patch applied, real-date `pnpm test:governance` passes and reports all 30
exact wallet dispositions, 32 total classified manual/live files and 42 actual
branch-local property/mutation targets. The mutation-policy date is owned by the
separately coordinated root review; it is not changed by this wallet inventory
review.
