---
id: wallet-toolbox
title: '@bsv/wallet-toolbox'
kind: package
domain: wallet
npm: '@bsv/wallet-toolbox'
version: '2.6.6'
last_updated: '2026-08-10'
last_verified: '2026-08-10'
review_cadence_days: 30
status: stable
tags: ['wallet', 'brc100']
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox'
---

# @bsv/wallet-toolbox

`@bsv/wallet-toolbox` is the reference toolkit for building BRC-100 wallets. It connects `@bsv/sdk` primitives to wallet storage, key derivation, signing, services, monitoring, permissions, and authentication flows.

Use this package when you are building a wallet product, a wallet-like service, or another implementation that must match BRC-100 behavior.

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
verified tokens and lookups with no usable response remain errors; WAB
existing-account continuity still prevents replacement-wallet onboarding.

ChainTracks defaults to credential-free Arcade/go-chaintracks v2 HTTP and SSE
on mainnet, testnet, and TerraTestNet. STN and Terra Scaling TestNet require an
explicit operator endpoint. Remote header batches pass local serialization,
hash, continuity, and genesis checks; source failures fall through in priority
order; and synchronized trackers keep serving last-good local data.
WhatsOnChain is an optional, rate-limited mainnet/testnet fallback; no key is
required.

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
