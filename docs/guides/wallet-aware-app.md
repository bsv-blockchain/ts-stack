---
id: guide-wallet-aware
title: "Build a Wallet-Aware App"
kind: guide
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [guide, wallet, brc-100, typescript]
---

# Build a Wallet-Aware App

> Learn how to integrate the BRC-100 wallet standard into your TypeScript application. You'll connect to wallet storage, create transactions, sign them, and broadcast to the network.

**Time:** ~20 minutes
**Prerequisites:** Node.js ≥ 20, basic TypeScript, familiarity with Bitcoin transactions

## What you'll build

A complete Node.js application that initializes a wallet, creates a transaction that sends satoshis to an address, signs it, and broadcasts it to the network. By the end, you'll understand how to integrate wallet functionality into any app.

## Prerequisites

- Node.js 20+ installed
- npm or pnpm package manager
- Basic understanding of Bitcoin transactions and UTXOs
- A test environment (we'll use testnet by default)

## Step 1 — Install wallet-toolbox and SDK

Initialize a new project and add the required packages.

```bash
mkdir my-wallet-app && cd my-wallet-app
npm init -y
npm install @bsv/sdk @bsv/wallet-toolbox typescript ts-node @types/node
npx tsc --init
```

Create a `tsconfig.json` with ES2020 target:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

## Step 2 — Set up a wallet with default storage

Create a file `wallet.ts` that initializes a wallet with SQLite storage (default for Node.js):

```typescript
import { SetupWallet } from '@bsv/wallet-toolbox'

export async function initializeWallet() {
  const wallet = await SetupWallet({
    env: 'test'  // testnet
  })
  
  console.log('Wallet initialized with default storage')
  return wallet
}
```

The `SetupWallet` factory function creates a fully initialized wallet with sensible defaults, including:
- SQLite storage (stored in `./wallet.db`)
- Test network (testnet) configuration
- Automatic service discovery (ARC, WhatsOnChain, Chaintracks)
- Built-in monitoring daemon

## Step 3 — Create a transaction action

Create `createPayment.ts` to define a function that creates a transaction action:

```typescript
import { SetupWallet } from '@bsv/wallet-toolbox'

export async function createPaymentAction(wallet: any) {
  // Create an action: this is a transaction intent before signing
  const action = await wallet.createAction({
    description: 'Send test payment',
    outputs: [{
      satoshis: 5000,  // 5000 satoshis
      lockingScript: '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac',  // P2PKH example
      outputDescription: 'payment to recipient'
    }]
  })
  
  console.log('Action created:', action)
  return action
}
```

An `Action` in the wallet is a high-level transaction intent. The wallet:
- Selects appropriate UTXOs automatically
- Calculates fees
- Constructs the full transaction
- Returns a `SignableTransaction` reference

This design protects privacy: the app doesn't see which UTXOs were selected, and the wallet can optimize coin selection.

## Step 4 — Sign the action with the wallet

Create `signPayment.ts` to sign the action:

```typescript
import { SetupWallet } from '@bsv/wallet-toolbox'

export async function signAndBroadcast(wallet: any, action: any) {
  // Sign the action using wallet keys
  const signedAction = await wallet.signAction({
    reference: action.signableTransaction.reference
  })
  
  console.log('Action signed:', signedAction)
  
  // The wallet now has a signed transaction ready to broadcast
  return signedAction
}
```

When you call `signAction()`, the wallet:
1. Retrieves the signed transaction from storage
2. Verifies all signatures are present
3. Returns the fully signed transaction (ready for broadcast)

## Step 5 — Query wallet balance and UTXOs

Add a function to check available outputs before creating an action:

```typescript
export async function checkBalance(wallet: any) {
  // List all unspent outputs (UTXOs)
  const outputs = await wallet.listOutputs({
    includeSpent: false,  // Only unspent outputs
    basket: 'default'
  })
  
  // Calculate total satoshis available
  const totalSats = outputs.reduce((sum: number, output: any) => 
    sum + output.satoshis, 0)
  
  console.log(`Available balance: ${totalSats} satoshis`)
  console.log(`Available UTXOs: ${outputs.length}`)
  
  return { outputs, totalSats }
}
```

`listOutputs()` queries the wallet's stored outputs and their spent status. This lets you:
- See how many satoshis are available
- Check which outputs can be spent
- Understand the wallet's coin composition

## Step 6 — Monitor transaction confirmations

Add background monitoring to track when transactions confirm:

```typescript
import { Monitor } from '@bsv/wallet-toolbox'

export async function setupMonitoring(wallet: any) {
  // Create a monitor daemon
  const monitor = new Monitor(wallet.storage, wallet.services, {
    pollIntervalMs: 10000  // Check every 10 seconds
  })
  
  // Start monitoring
  await monitor.startTasks()
  
  console.log('Monitor started — will track confirmations automatically')
  
  // Monitor will automatically:
  // - Detect when pending transactions confirm
  // - Acquire merkle proofs for SPV verification
  // - Rebroadcast transactions that stalled
  // - Update wallet state without app intervention
  
  return monitor
}
```

The Monitor daemon runs in the background and continuously:
1. Polls pending transactions for confirmation
2. Detects chain reorganizations
3. Acquires merkle proofs
4. Updates wallet state automatically

This eliminates polling boilerplate from your application code.

## Step 7 — Integrate with the SDK's Transaction API

For advanced use cases, bridge the wallet to the SDK's `Transaction` class:

```typescript
import { Transaction } from '@bsv/sdk'
import { WalletSigner } from '@bsv/wallet-toolbox'

export async function advancedSigning(wallet: any) {
  // Create a WalletSigner adapter
  const signer = new WalletSigner(wallet)
  
  // Create a transaction using SDK
  const tx = new Transaction()
  // ... add inputs/outputs to tx ...
  
  // Sign using wallet (private keys stay in wallet)
  await tx.sign([signer])
  
  // Broadcast to network
  const result = await tx.broadcast()
  console.log('Broadcast result:', result)
  
  return result
}
```

`WalletSigner` is an adapter that bridges the wallet's private keys to the SDK's transaction signing interface, allowing you to use SDK `Transaction` objects while keeping keys secure in the wallet.

## Putting it all together

Create `main.ts` that ties everything together:

```typescript
import { SetupWallet } from '@bsv/wallet-toolbox'
import { Monitor } from '@bsv/wallet-toolbox'

async function main() {
  // Step 1: Initialize wallet
  console.log('Step 1: Initializing wallet...')
  const wallet = await SetupWallet({
    env: 'test'  // testnet
  })
  
  // Step 2: Check balance before creating action
  console.log('\nStep 2: Checking balance...')
  const balance = await wallet.listOutputs({
    includeSpent: false,
    basket: 'default'
  })
  
  const totalSats = balance.reduce((sum: number, output: any) => 
    sum + output.satoshis, 0)
  console.log(`Available: ${totalSats} satoshis across ${balance.length} UTXOs`)
  
  // Step 3: Create a transaction action
  console.log('\nStep 3: Creating payment action...')
  const action = await wallet.createAction({
    description: 'Send 5000 satoshis',
    outputs: [{
      satoshis: 5000,
      lockingScript: '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac',
      outputDescription: 'recipient payment'
    }]
  })
  console.log('Action created with ID:', action.id)
  
  // Step 4: Sign the action
  console.log('\nStep 4: Signing action...')
  const signed = await wallet.signAction({
    reference: action.signableTransaction.reference
  })
  console.log('Action signed and ready to broadcast')
  
  // Step 5: Start background monitoring
  console.log('\nStep 5: Starting transaction monitor...')
  const monitor = new Monitor(wallet.storage, wallet.services, {
    pollIntervalMs: 10000  // Check every 10 seconds
  })
  await monitor.startTasks()
  console.log('Monitor running — will track confirmations automatically')
  
  // Step 6: Query transaction history
  console.log('\nStep 6: Listing recent actions...')
  const actions = await wallet.listActions({
    limit: 5
  })
  console.log(`Found ${actions.length} recent transactions`)
  
  console.log('\nWallet app complete! Monitor is running in background.')
  console.log('Press Ctrl+C to stop.')
  
  // Keep process alive while monitor runs
  await new Promise(() => {})
}

main().catch(console.error)
```

Run this with:

```bash
npx ts-node main.ts
```

This complete example:
1. Initializes a wallet with SQLite storage
2. Checks available balance
3. Creates a transaction action
4. Signs it with wallet keys
5. Starts background monitoring for confirmations
6. Queries the action history

## Troubleshooting

**"Module not found: @bsv/wallet-toolbox"**
→ Run `npm install @bsv/wallet-toolbox` and verify the package is listed in package.json

**"Storage backend mismatch" error**
→ Don't try to use `KnexWalletStorage` with IndexedDB in browser; use `SetupClient` for browser wallets instead

**Monitor not updating confirmations**
→ Ensure the monitor is running (`await monitor.startTasks()`). Without it, you must manually poll `listActions()` for status updates

**Wallet state seems stale**
→ Multiple monitor instances on the same storage will race and corrupt state. Use only one monitor per wallet instance

**"Key manager initialization order" error**
→ If using a custom `PrivilegedKeyManager`, initialize it *before* calling `Setup()`

**Action reference not valid**
→ `SignableTransaction` references expire quickly. Create a new action and sign immediately; don't cache the reference

## What to read next

- **[Wallet-Toolbox Package Reference](../packages/wallet/wallet-toolbox.md)** — Full API documentation and configuration options
- **[BRC-100 Wallet Standard](../specs/brc-100-wallet.md)** — The standard your wallet implements
- **[HTTP 402 Payments Guide](http-402-payments.md)** — Monetize your app by accepting payments
- **[SDK Documentation](../packages/sdk)** — The @bsv/sdk crypto primitives and transaction API
