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

> Command-line faucet/funding tool for development and testing — funds a remote wallet with satoshis from a local Metanet Desktop wallet via private key derivation.

## Install

```bash
npm install @bsv/fund-wallet
```

## Quick start

```bash
# Check balance only
npx fund-metanet \
  --chain main \
  --private-key 0123456789abcdef...

# Fund with 10,000 satoshis
npx fund-metanet \
  --chain test \
  --private-key <hex> \
  --satoshis 10000

# Custom storage provider
npx fund-metanet \
  --chain main \
  --private-key <hex> \
  --storage-url https://custom-store.example.com \
  --satoshis 5000

# Interactive mode (no args)
npx fund-metanet
# Prompts: chain? storage URL? private key? satoshis?
```

## What it provides

- **CLI-only tool** — No TypeScript programmatic API; command-line only
- **Balance check** — Query remote wallet balance without signing
- **Funding** — Send satoshis from local Metanet Desktop wallet to remote wallet
- **Private key support** — Hex-encoded private keys for local source wallet
- **Network selection** — Support for testnet or mainnet
- **Custom storage** — Specify custom storage provider URL
- **Interactive mode** — Prompts if no arguments provided
- **Transaction details** — Prints TXID and WhatsOnChain link on success

## Common patterns

### Check balance only (no Metanet Desktop needed)
```bash
npx fund-metanet \
  --chain main \
  --private-key <hex>
```

### Fund wallet (Metanet Desktop must be running)
```bash
npx fund-metanet \
  --chain test \
  --private-key <hex> \
  --satoshis 10000
```

### Using custom storage provider
```bash
npx fund-metanet \
  --chain main \
  --private-key <hex> \
  --storage-url https://custom-store.example.com \
  --satoshis 5000
```

### Interactive mode
```bash
npx fund-metanet
# Answer prompts for chain, key, satoshis, etc.
```

## Key concepts

- **Metanet Desktop** — Local BRC-100 wallet application; must be running to send funds
- **Remote Wallet** — The destination wallet at `--storage-url`
- **Balance Check** — Read-only; queries remote storage without signing
- **Key Derivation** — Derives identity key from private key via @bsv/sdk
- **Transaction Internalization** — Remote wallet internalizes the BEEF transaction into its baskets
- **Test vs Main** — Argument determines network; affects key derivation and endpoints

## When to use this

- Testing applications that need funded wallets
- CI/CD pipelines for integration tests
- Development environments needing test funds
- Quick balance checks on remote wallets
- Seeding wallets for local testing

## When NOT to use this

- For production applications — use real funds
- When Metanet Desktop is not available — balance check only works then
- For long-term fund storage — faucets are temporary
- On mainnet with real funds — only for testnet/stagenet

## Spec conformance

- **BRC-100** — Wallet interface (Metanet Desktop provider)
- **BRC-29** — Key derivation (identity key from private key)
- **BEEF** — Broadcast-Everything-BEEF transaction format
- **BSV Testnet/Mainnet** — Network selection via `--chain` flag

## Common pitfalls

- **Metanet Desktop not running** — If `--satoshis` provided but Metanet Desktop not running, tool fails
- **Private key format** — Must be valid hex string; invalid format rejected upfront
- **Network mismatch** — Testnet key used with main network storage = 0 balance
- **Storage URL validation** — Must start with `https://`; HTTP not allowed for security
- **Interactive mode parsing** — Yes/No prompts are case-insensitive; numeric inputs must be valid integers

## Related packages

- [@bsv/amountinator](amountinator.md) — Could enhance output with currency conversion
- [@bsv/simple](simple.md) — Wallet that may use funded address
- [@bsv/sdk](https://github.com/bsv-blockchain/sdk-ts) — Private key and transaction utilities

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/fund-wallet/)
- [Source on GitHub](https://github.com/bsv-blockchain/fund-wallet)
- [npm](https://www.npmjs.com/package/@bsv/fund-wallet)
