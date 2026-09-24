---
id: wallet-toolbox
title: '@bsv/wallet-toolbox'
kind: package
domain: wallet
npm: '@bsv/wallet-toolbox'
version: '2.14.0'
last_updated: '2026-09-24'
last_verified: '2026-09-24'
review_cadence_days: 30
status: stable
tags: ['wallet', 'brc100']
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox'
---

# @bsv/wallet-toolbox

`@bsv/wallet-toolbox` is the reference toolkit for building BRC-100 wallets. It connects `@bsv/sdk` primitives to wallet storage, key derivation, signing, services, monitoring, permissions, and authentication flows.

Use this package when you are building a wallet product, a wallet-like service, or another implementation that must match BRC-100 behavior.

## Backup and recovery

**Recoverable root key material and wallet records are both required.** A seed
alone cannot reconstruct every BRC-100 output's derivation metadata. BRC-38/39
exports preserve wallet data, not root keys or unrelated product state.

Start with [Wallet backup and recovery](../../guides/wallet-backup-recovery.md),
then use [BRC-38/39 integration](../../guides/wallet-data-portability.md), the
[recovery drill](../../guides/wallet-recovery-drill.md) and the
[agent implementation brief](../../guides/wallet-recovery-agent-brief.md).
The integration guide documents concrete-provider requirements, explicit
restore/merge modes and the limits of the current in-memory export helpers.

## Current capabilities

Wallet Toolbox 2.11 adds the built-in BRC-177 `p nosend expiry` module. It
pre-funds expiring `noSend` actions, stores a signed reclaim durably across
active/backup storage and restarts, and lets the authoritative local or remote
monitor reclaim an unbroadcast action after its time or block-height deadline.
See [Expiring noSend actions](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/wallet/wallet-toolbox/docs/no-send-expiry.md).

Knex and IndexedDB `listOutputs` providers report `totalOutputs` as the full
matching count on every page, including short final and out-of-range pages.

Knex storage can opt into prepared BEEF (COOK) for normal `createAction`
funding. Exact verified proof closures are persisted only after foreground
action work, while reads, writes, and bounded backfill remain separately
controlled and default off. Every miss or invalid artifact retains the
canonical BEEF builder.

`WalletAuthenticationManager` supports an additive WAB UMP outpoint pin for
legacy ambiguity and an OTP-verified phone-number change that always rolls the
presentation key. The same registered number is valid. A pin is ignored unless
normal verified lineage resolution remains ambiguous and the outpoint is one
of the wallet's verified candidates. Applications must persist
`saveSnapshot()` immediately after `completePhoneNumberChange()` succeeds.

Wallet-manager snapshots can carry root and privileged key material; they do
not include the Wallet Toolbox storage database. Possession of such a snapshot
is possession of the wallet's key material. Store each
complete snapshot only in an OS Keychain, hardware-backed keystore, or
comparably trusted secret store. Remote storage and credential-bearing Arcade
SSE require HTTPS except for explicit loopback development, and transport
debugging cannot log callback tokens or API credentials. Arcade status events
are validated, copied, and committed one at a time under per-event and aggregate
queue budgets; no later cursor can advance past a malformed or failed event.
The stream is silent by default and reports credential-bearing transport errors
only as a generic signal. Monitor and daemon startup await retryable ChainTracks
subscriptions, teardown closes SSE/subscriptions before storage, persisted
diagnostics are bounded, and monitor operational logging requires the additive
`MonitorOptions.logging` callback.

Spending approvals apply to one operation per prompt and are never cached or
coalesced. Spending-token accounting reads every action page before authorizing
a spend. `WalletPermissionsManager` resolves a sendMax (`maxPossibleSatoshis`)
output's funded amount from the signable transaction by locking script before
billing it, so a `createAction` call funding the wallet's full balance through
the permissions manager is authorized and verified for its real amount instead
of the unfunded sentinel. Certificate handling also fails closed: direct and
issuer-mediated acquisition require a valid certifier signature before
storage, and identity discovery verifies overlay certificates before
decrypting or trust-scoring them.

`relinquishOutput` and `internalizeAction` confirm basket membership before
mutating it. `relinquishOutput` rejects a basket argument that does not match
the output's actual current basket, or names a basket that does not exist, so
an application cannot free an outpoint it does not actually hold by basket
membership. `internalizeAction`'s basket-insertion merge path rejects
reclassifying an output that already belongs to a different real basket,
while re-internalizing into the same basket and inserting a currently
unbasketed (non-managed-change) output both keep working.

Action-batch workspaces now admit only explicitly connected transaction-graph
members. Unrelated actions stay on their ordinary storage path, while related
workspaces can resume an expired soft lease by reacquiring only their exact
persisted inputs under the provider's advertised reservation bound.

Immediate actions may use wallet-managed change from a transaction awaiting
background broadcast, but only after completed and unproven liquidity is
exhausted or an over-16-input settled plan is larger by exact serialized
transaction-plus-BEEF cost. Queued funds are never hidden.

Durable permission grants retain delayed broadcast, avoiding network latency in
the permission path. New and existing wallets progressively target 144 useful
5,000-satoshi change outputs, create no more than eight outputs per action, and
migrate no more than four fee-positive legacy fragments per action. Optional
shaping cannot make a formerly fundable action fail.

Completed `createAction` and `signAction` results expose Atomic BEEF as a
numeric array at the public wallet boundary. The historical shape survives
plain JSON serialization for older BRC-100 applications; typed arrays remain
supported by the `AtomicBEEF` type and binary Wallet Wire transports.

`WalletStorageManager.getStores()` reports the configured `endpointURL` for
remote providers without relying on a class name. Browser and application
bundlers may safely minify the provider constructor while backup selection and
make-primary flows continue matching the original endpoint URL.

Opt-in remote-storage timing spans retain trace and parent-span correlation in
the telemetry sink without adding headers to authenticated requests. BRC-103,
BRC-104, AuthFetch, and the storage RPC wire contract remain unchanged.

UMP account lookup accepts one verified matching token as an existing account.
When no token verifies, one clean empty overlay response establishes a new
account even if other hosts fail or return malformed records. Multiple distinct
verified tokens remain errors unless normal lineage finds one current token or
an optional WAB pin names one of the verified candidates. Lookups with no usable
response remain errors; WAB existing-account continuity still prevents
replacement-wallet onboarding.

ChainTracks defaults to credential-free Arcade/go-chaintracks v2 HTTP and SSE
on mainnet, testnet, and TerraTestNet. STN and Terra Scaling TestNet require an
explicit operator endpoint. Remote header batches pass local serialization,
hash, continuity, and genesis checks; source failures fall through in priority
order; and synchronized trackers keep serving last-good local data.
WhatsOnChain is an optional, rate-limited mainnet/testnet fallback; no key is
required.

The configured remote ChainTracks service is authoritative for chain view, but
its response representation is still adversarially validated. HTTP reads have
whole-body deadlines and byte ceilings, redirects are prohibited, SSE streams
have event and idle bounds, and network/header/reorganization results must be
canonical, proof-of-work-valid, and exactly request-bound. Local submitted and
remote live-header queues are copy-isolated and bounded to prevent a faulty or
hostile source from retaining unbounded process memory.
Remote live metadata must be complete and use positive local identities.
Reorganization deactivation lists must start at the old tip, contain no
duplicates, form a descending linked chain, and fit their declared depth before
wallet monitor callbacks receive them. Remote diagnostics are bounded and
single-line. The monitor independently authenticates and copies custom-adapter
events, verifies that every configured chain source matches the wallet network,
and retains at most 4,096 unique deactivated headers by default. Applications
can lower this with `MonitorOptions.maxQueuedDeactivatedHeaders`. Prepared-proof
invalidation is coalesced and drained during teardown, while partial event
subscriptions and rejected host callbacks are contained as bounded monitor
events. Optional Chaintracks header/reorg push subscriptions no longer gate
the scheduler: an event source that declares `supportsReorgEvents: false`
(such as the built-in HTTP-polling `ChaintracksServiceClient`) is never called,
and a source that fails to subscribe is retried opportunistically on the next
tick while every other scheduled task keeps running. A genuine configured-chain
mismatch still fails closed — subscriptions are never registered against a
`chaintracksWithEvents` source that reports the wrong chain — and is recorded
as a `chaintracksEventsError` monitor event.

The legacy `BHServiceClient` also validates current canonical headers for every
Merkle-root verdict. Its compatibility `cache` is diagnostic state only and is
never trusted, so a rejected root, caller mutation, or reorganization cannot
turn an old root into authority. Redirects, endpoints, response bodies, ranges,
hashes, linkage, and proof of work are bounded and checked before use.
ChainTracks constructors reject malformed networks, recursion limits, and
ingestor collections; logging is silent unless the host explicitly provides
the optional logger. Startup awaits and reports initialization failure, failed
attempts can retry cleanly, and destruction drains sources and storage even
before readiness. Event subscriptions are bounded, removed on unsubscribe, and
copy-isolated between listeners.

Local ChainTracks adapters also enforce stored-state integrity. In-memory
instances do not share live headers, IndexedDB and Knex require unique active
headers and consecutive parent linkage, and bounded reorganization walks fail
closed on missing or cyclic state. Knex uses a transaction-held state row to
serialize competing tip mutations. Apply all ChainTracks Knex migrations before
startup. MySQL operators should expect the derived live-header cache to be
cleared once while legacy truncating `VARBINARY(32)` fields are widened to
`VARCHAR(64)`; authenticated bulk data is retained and repopulates live state.
Before downgrading to code that predates this repair, stop all ChainTracks
writes and verify a database plus authenticated-bulk-data backup. Use the
current `ChaintracksKnexMigrations` source to roll down only the
`2026-09-17-001 repair MySQL live-header encodings and bulk blob` ledger entry;
its schema down is intentionally a no-op. Retain the repaired `VARCHAR(64)` and
`LONGBLOB` columns, the `chaintracks_state` lock row, and authenticated bulk
files, and validate that state against the older code in a non-production copy
before starting it. Never roll down the initial migration, recreate the tables,
or restore truncating `VARBINARY(32)` identifier columns.
Bulk-file additions and extensions persist before memory changes. Multi-file
replacements and initial reconciliation commit atomically in the built-in Knex
and IndexedDB adapters, and failed commits restore the manager's prior state.
Custom `ChaintracksStorageBulkFileApi` adapters must implement the additive
`replaceBulkFiles` method before multi-file changes are enabled; older custom
adapters fail closed instead of risking a durable gap or stale overlap.

WhatsOnChain is authoritative only when explicitly enabled as a fallback chain
source. Its service-discovered CDN links are untrusted locators, not operator
configuration: they must be credential-free public HTTPS, with public-address
DNS pinning in Node. Manifests, binary objects, recent-header JSON, and legacy
WebSocket frames have byte, count, ordering, handshake, and idle bounds. Every
candidate is canonical and proof-of-work-valid before its declared target can
participate in chain-work selection.

Local ChainTracks height reads now use stale-while-revalidate singleflight,
while immutable bulk objects coalesce misses and back off failed loads. Node
services can move complete length, digest, linkage, chain-work, genesis, and
proof-of-work validation into `NodeBulkFileDataValidator`; filesystem
deployments can pair content-addressed quarantine storage with a crash-safe,
per-attempt `DurableFileBulkFileDownloadBudget`. The shared ledger serializes
reservations across processes; a crash-abandoned `<stateFile>.lock` fails
closed and must be removed only after an operator proves no writer remains.
Filesystem cache reads allocate no more than the advertised object size plus
one rejection byte, and writes must match their advertised length and SHA-256.
Replacement, promotion, and quarantine serialize across processes through a
per-digest `<digest>.headers.lock`. Like the budget lock, it is never reclaimed
automatically after a crash; prove no cache writer remains before removing that
narrow directory. Cache metadata and byte inputs are snapshotted before any
lock wait.

Legacy filesystem manifests accept only path-free filenames and are never
replaced merely because a read, permission, size, parse, or integrity check
failed. Imported/exported files are bounded and must authenticate as one
contiguous genesis-anchored header chain with matching digests and chain work.

## Install

```bash
npm install @bsv/wallet-toolbox
```

Browser and mobile bundles are also published:

```bash
npm install @bsv/wallet-toolbox-client
npm install @bsv/wallet-toolbox-mobile
```

## What It Provides

| Component                  | Purpose                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| `Wallet`                   | Main BRC-100 implementation.                                                  |
| `WalletStorageManager`     | Coordinates active and backup storage providers.                              |
| Storage providers          | SQL/Knex, IndexedDB, and remote storage over HTTP.                            |
| `WalletSigner`             | Bridges wallet-controlled keys into SDK transaction signing flows.            |
| `Services`                 | Network service container for broadcast, chain tracking, and proof services.  |
| `Monitor`                  | Background wallet maintenance tasks.                                          |
| Key managers               | BRC-42/43 derivation, privileged key management, Shamir-based recovery flows. |
| `WalletPermissionsManager` | Permission gating around wallet methods and reserved protocols/baskets.       |
| `MockChain`                | Test chain utilities for wallet behavior without a live network.              |

## Source-Backed Setup Pattern

The example package uses the `Setup` class for wallet construction. Create a `.env` with `Setup.makeEnv()`, then load the environment and construct a client wallet:

```typescript
import { Setup } from '@bsv/wallet-toolbox'

const env = Setup.getEnv('test')
const setup = await Setup.createWalletClient({
  env,
  endpointUrl: 'https://store-us-1.bsvb.tech'
})

const { publicKey } = await setup.wallet.getPublicKey({
  identityKey: true
})

console.log(publicKey)
```

`setup.wallet` is the BRC-100 wallet. The surrounding `setup` object exposes the constructed `rootKey`, `identityKey`, `keyDeriver`, `storage`, `services`, and `monitor` so wallet builders can inspect or replace pieces while developing.

## Permission modules

`WalletPermissionsManager` registers BRC-98/99/111 modules by the scheme after
the `p` prefix. Existing modules can transform calls with `onRequest` and
`onResponse`. A semantic module can instead implement
`handleRequest(request, next)` and return the conforming BRC-100 result itself;
if it needs the underlying wallet operation, `next` is guarded to one call.

The separate [@bsv/ecpm-permission-module](./ecpm-permission-module.md) uses
this hook to implement point multiplication under `p ecpm` while keeping
`getPublicKey` as the public wallet method.

## Action Flow

When every input can be signed by the wallet, `createAction` can return a completed action:

```typescript
export async function createP2pkhOutput(recipientAddress: string) {
  const lockingScript = Setup.getLockP2PKH(recipientAddress).toHex()

  const result = await setup.wallet.createAction({
    description: 'Create payment',
    labels: ['payment'],
    outputs: [
      {
        lockingScript,
        satoshis: 1000,
        outputDescription: 'Payment output'
      }
    ],
    options: {
      randomizeOutputs: false,
      acceptDelayedBroadcast: false
    }
  })

  console.log(result.txid, result.tx)
}

await createP2pkhOutput('1EvmsbpAY7nESLkN4ajLTMbvsaQ1HpJPGX')
```

When an explicit input needs an unlocking script supplied by the caller, `createAction` returns `signableTransaction`, then `signAction` completes it:

```typescript
export async function finishCustomSpend(args: {
  inputBEEF: number[]
  outpoint: string
  lockingScript: string
  unlockingScript: string
}) {
  const created = await setup.wallet.createAction({
    description: 'Spend custom input',
    inputBEEF: args.inputBEEF,
    inputs: [
      {
        outpoint: args.outpoint,
        unlockingScriptLength: 108,
        inputDescription: 'Custom input'
      }
    ],
    outputs: [
      {
        lockingScript: args.lockingScript,
        satoshis: 1000,
        outputDescription: 'Payment output'
      }
    ]
  })

  await setup.wallet.signAction({
    reference: created.signableTransaction!.reference,
    spends: {
      0: { unlockingScript: args.unlockingScript }
    },
    options: { acceptDelayedBroadcast: false }
  })
}
```

See `packages/wallet/wallet-toolbox-examples/src/p2pkh.ts`, `brc29.ts`, `pushdrop.ts`, and `nosend.ts` for complete source-backed flows.

## Storage Models

| Model          | Use                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| SQL/Knex       | Node.js wallets and servers with SQLite, MySQL, or another Knex-supported database.                     |
| IndexedDB      | Browser and mobile wallets that keep state on-device.                                                   |
| Remote storage | Wallet clients that delegate storage to a Wallet Infra endpoint such as `https://store-us-1.bsvb.tech`. |

## When to Use This

- You are building a BRC-100 wallet.
- You need to implement wallet storage, signing, permissions, or monitoring.
- You want source-backed examples for `createAction`, `signAction`, `listOutputs`, `internalizeAction`, and no-send batching.
- You are porting wallet concepts to another language and need a TypeScript reference.

## When Not to Use This

- Use [`@bsv/simple/browser`](../helpers/simple.md) for ordinary web app integration.
- Use [`@bsv/simple/server`](../helpers/simple.md) for a backend agent with a private key.
- Use [`@bsv/sdk`](../sdk/bsv-sdk.md) for raw crypto, scripts, transactions, BEEF, or the BRC-100 interface types.

## Related

- [BRC-100 Wallet Interface](../../specs/brc-100-wallet.md)
- [Wallet domain overview](./index.md)
- [Wallet toolbox examples](./wallet-toolbox-examples.md)
- [Conformance vectors](../../conformance/vectors.md#wallet-brc-100)
- [Managed-change liquidity policy](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/wallet/wallet-toolbox/docs/managed-change-liquidity.md)
