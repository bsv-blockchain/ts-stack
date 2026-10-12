---
id: pkg-wallet-toolbox-mobile
title: '@bsv/wallet-toolbox-mobile'
kind: package
domain: wallet
version: '2.14.7'
last_updated: '2026-10-10'
last_verified: '2026-10-10'
review_cadence_days: 30
npm: 'https://www.npmjs.com/package/@bsv/wallet-toolbox-mobile'
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox/mobile'
status: stable
tags: [wallet, react-native, mobile, storage, brc-100]
---

# @bsv/wallet-toolbox-mobile

`@bsv/wallet-toolbox-mobile` is the React Native and mobile-safe Wallet
Toolbox distribution. It includes wallet, signer, services, monitoring, and
remote storage surfaces without Knex, SQLite/MySQL, IndexedDB, or Node-only IO.
BRC-177 anchors cover both the delivery and an economic reclaim. When the
reclaim floor is larger, the protected action pays the bounded surplus as
miner fee while retaining no wallet change. Upgrade the active storage
implementation to receive this funding fix; no wire or database migration is required.

Prepared BEEF persistence remains a server-side Knex capability. Mobile remote
storage uses the canonical path, and compatible remote servers can enable the
optimization without a mobile configuration or wire change.

The built-in BRC-177 `p nosend expiry` module delegates durable expiry
monitoring and pre-signed reclaim submission to its 2.11-compatible active
remote storage service, so mobile process suspension does not restart or lose
an expiry.
Wallet snapshots are wallet-equivalent secrets and belong only in the iOS
Keychain, Android Keystore-backed encrypted storage, or a comparably trusted
store, never ordinary AsyncStorage, logs, analytics, or unprotected backups.
Remote storage and credential-bearing Arcade SSE require HTTPS except for
explicit loopback development, and transport debugging cannot expose
credentials. Spending approvals are never cached or coalesced; certificate
acquisition and identity discovery require valid certifier signatures before
storage or trust scoring.
Related mobile `noSend` chains retain local action batching, while unrelated
actions cannot join or commit the active workspace. Supported remote providers
can resume a soft-expired workspace using its exact persisted inputs.
`WalletStorageManager.getStores()` retains each remote provider's configured
`endpointURL` after production bundlers minify class names, so backup selection
and make-primary flows remain stable.
Immediate mobile actions can chain wallet-managed change from a delayed parent;
the wallet first exhausts completed and unproven liquidity and uses exact
serialized-cost comparison only for pathological settled plans. Pending funds
are never hidden. New and migrated wallets progressively prefer useful
5,000-satoshi liquidity units without gathering inputs merely to create them.
Durable permission tokens retain delayed broadcast so permission approval does
not inherit network latency.
Opt-in remote-storage timing spans retain trace and parent-span correlation in
the telemetry sink without adding headers to authenticated requests.

The mobile distribution also exposes the WAB UMP ambiguity fallback and
OTP-verified `startPhoneNumberChange` / `completePhoneNumberChange` flow. A
settings UI may submit the current number to force a fresh presentation hash;
it must persist the wallet snapshot immediately after success.
Mobile authentication accepts one verified matching UMP token as an existing
account. When no token verifies, one clean empty overlay response establishes a
new account even if other hosts fail or return malformed records.

The mobile build includes the fetch-based, credential-free ChainTracks v2
client and reconnecting SSE adapter without Node-only modules. Public defaults
cover mainnet, testnet, and TerraTestNet; STN/TSTN use an injected or configured
endpoint.

The portable local controller coalesces stale height refresh and immutable
object loads, applies failed-load backoff, and validates through the asynchronous
`InlineBulkFileDataValidator` without importing Node worker or filesystem code.

BEEF requests and schema-declared storage response bytes use the existing
negotiated compact binary JSON codec. Legacy peers retain numeric-array JSON
and identical transaction/proof bytes. Authentication and payload ceilings
remain unchanged; upgrade both clients and active storage for the savings.

Internalizing an unproven transaction new to a user attempts broadcast before
storing recipient outputs, including a sender's no-send transaction already
known to shared storage. Rejected broadcasts return a review-actions error
and store no recipient outputs. Transactions backed by a mining proof are
not rebroadcast. Upgrade active storage; no API, wire or schema migration is required.

## Backup and recovery

Recover both key material and wallet records; a manager snapshot or device
keystore alone is not a complete data backup. App removal or device loss can
remove locally retained secrets and state.
Test the independent key and data recovery paths on a replacement device.
Use the [recovery guide](../../guides/wallet-backup-recovery.md),
[BRC-38/39 integration](../../guides/wallet-data-portability.md) and
[recovery drill](../../guides/wallet-recovery-drill.md). The portable helpers
require a concrete provider and a tested consistency/resource-limit strategy.

## Install

```bash
npm install @bsv/wallet-toolbox-mobile @bsv/sdk
```

## Use

```ts
import {
  Services,
  StorageClient,
  Wallet,
  WalletSigner,
  WalletStorageManager
} from '@bsv/wallet-toolbox-mobile'
```

The package publishes `react-native`, import ESM, and CommonJS conditions with
matching declarations. Its installed-consumer gate bundles the exact tarball
with Metro, checks the mobile-safe module boundary, compiles optimized Hermes
bytecode, validates source maps, and enforces size budgets.

This single bundle also exports `WalletMonitorTask` (the base class for a
custom task passed to `Monitor.addTask`), `attemptToPostReqsToNetwork` with
its `PostReqsToNetworkResult` type, `parseJsonRpc` / `stringifyJsonRpc` (the
storage remoting wire format), and `verifyUnlockScripts` with its
`UnlockScriptVerificationResult` type, so a host no longer needs an
unsupported deep import to reach them:

```ts
import {
  WalletMonitorTask,
  attemptToPostReqsToNetwork,
  parseJsonRpc,
  stringifyJsonRpc,
  verifyUnlockScripts
} from '@bsv/wallet-toolbox-mobile'
```

Native requests are not governed by browser CORS, while WebView and hybrid
clients can be. Remote Storage should remain reachable by intended public
clients unless an operator explicitly configures an allowlist. Authentication
and authorization remain service-layer controls.

See the
[package README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox/mobile#readme)
for remote storage setup and supported runtime assumptions.

## License

Open BSV License Version 6. See the
[package license](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/wallet/wallet-toolbox/mobile/LICENSE.txt).

## Faucet output authorization

The source candidate adds exact completed-action binding for independently
validated local storage fees and change. The SDK capability marker is
`completeBoundAction.outputAuthorizationVersion=1`; upgrade the wallet and SDK together.
Existing SDK2 peers retain strict behavior. The separate SDK3 migration still
applies; SDK2 consumers need an additive backport or that migration. Serialized
wallet results do not carry local authority. The fee fix does not change signup
persistence or interrupted-funding reconciliation. See the package README and
[release and migration ledger](../../reference/package-api-migrations.md).
