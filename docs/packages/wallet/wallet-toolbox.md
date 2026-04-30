---
id: wallet-toolbox
title: "@bsv/wallet-toolbox"
kind: package
domain: wallet
npm: "@bsv/wallet-toolbox"
version: "2.1.22"
last_updated: "2026-04-30"
last_verified: "2026-04-30"
status: stable
tags: ["wallet", "brc100"]
github_repo: "https://github.com/bsv-blockchain/ts-stack"
---

# @bsv/wallet-toolbox

`@bsv/wallet-toolbox` is the reference toolkit for building BRC-100 wallets. It connects `@bsv/sdk` primitives to wallet storage, key derivation, signing, services, monitoring, permissions, and authentication flows.

Use this package when you are building a wallet product, a wallet-like service, or another implementation that must match BRC-100 behavior.

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

| Component | Purpose |
|-----------|---------|
| `Wallet` | Main BRC-100 implementation. |
| `WalletStorageManager` | Coordinates active and backup storage providers. |
| Storage providers | SQL/Knex, IndexedDB, and remote storage over HTTP. |
| `WalletSigner` | Bridges wallet-controlled keys into SDK transaction signing flows. |
| `Services` | Network service container for broadcast, chain tracking, and proof services. |
| `Monitor` | Background wallet maintenance tasks. |
| Key managers | BRC-42/43 derivation, privileged key management, Shamir-based recovery flows. |
| `WalletPermissionsManager` | Permission gating around wallet methods and reserved protocols/baskets. |
| `MockChain` | Test chain utilities for wallet behavior without a live network. |

## Source-Backed Setup Pattern

The example package uses the `Setup` class for wallet construction. Create a `.env` with `Setup.makeEnv()`, then load the environment and construct a client wallet:

```typescript
import { PublicKey } from '@bsv/sdk'
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
export async function createP2pkhOutput(toIdentityKey: string) {
  const lockingScript = Setup
    .getLockP2PKH(PublicKey.fromString(toIdentityKey).toAddress())
    .toHex()

  const result = await setup.wallet.createAction({
    description: 'Create payment',
    labels: ['payment'],
    outputs: [{
      lockingScript,
      satoshis: 1000,
      outputDescription: 'Payment output'
    }],
    options: {
      randomizeOutputs: false,
      acceptDelayedBroadcast: false
    }
  })

  console.log(result.txid, result.tx)
}
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
    inputs: [{
      outpoint: args.outpoint,
      unlockingScriptLength: 108,
      inputDescription: 'Custom input'
    }],
    outputs: [{
      lockingScript: args.lockingScript,
      satoshis: 1000,
      outputDescription: 'Payment output'
    }]
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

| Model | Use |
|-------|-----|
| SQL/Knex | Node.js wallets and servers with SQLite, MySQL, or another Knex-supported database. |
| IndexedDB | Browser and mobile wallets that keep state on-device. |
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
