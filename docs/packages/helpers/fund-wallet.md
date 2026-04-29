---
id: pkg-fund-wallet
title: "@bsv/fund-wallet"
kind: package
domain: helpers
version: "1.3.1"
source_repo: "bsv-blockchain/fund-wallet"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/fund-wallet"
repo: "https://github.com/bsv-blockchain/fund-wallet"
status: stable
tags: [helpers, testing, faucet, development]
---

# @bsv/fund-wallet

Dev/test utility for funding BSV wallets from a faucet — useful in CI, development, and testing environments.

## Install

```bash
npm install @bsv/fund-wallet
```

## Quick start

```typescript
import { fundWallet } from '@bsv/fund-wallet';

// Fund a test wallet
const txid = await fundWallet({
  address: 'your-test-address',
  amount: 10000, // satoshis
  faucetUrl: 'https://faucet.example.com'
});

console.log('Funded with transaction:', txid);

// Wait for confirmation
const confirmed = await fundWallet.waitForConfirmation(txid, {
  timeout: 30000 // 30 seconds
});

console.log('Confirmed:', confirmed);
```

## What it provides

- **Faucet funding** — Request satoshis from a test faucet
- **Multiple faucets** — Support various faucet APIs
- **Amount control** — Request specific amounts
- **Confirmation wait** — Wait for funding confirmation
- **Error handling** — Graceful handling of faucet failures
- **Rate limiting** — Respect faucet rate limits
- **Retry logic** — Automatic retry on transient failures
- **Testnet/mainnet** — Support different networks

## When to use

- Testing applications that need funded wallets
- CI/CD pipelines for integration tests
- Development environments needing test funds
- Automated testing of transaction flows
- Creating test fixtures with funded addresses

## When not to use

- For production applications — use real funds
- On mainnet in production — only for real testnet/stagenet
- For long-term fund storage — faucets are temporary
- When you need precise amount control — use manual funding

## API reference

Full TypeScript API documentation: [TypeDoc](https://bsv-blockchain.github.io/ts-stack/api/fund-wallet/)

## Related packages

- @bsv/wallet-toolbox — Wallet being funded
- @bsv/sdk — Transaction verification
- @bsv/teranode-listener — Monitor funded transactions
- @bsv/simple — Simple transactions with funded wallets
