---
id: wallet-domain
title: Wallet
kind: meta
domain: wallet
version: "n/a"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: ["domain", "wallet"]
---

# Wallet

Key management, balance tracking, and signing — local or via wallet service.

## Packages in this Domain

- [@bsv/wallet-toolbox](./wallet-toolbox.md) — BRC-100 wallet client library
- [@bsv/btms](./btms.md) — Binary Token Management System
- [@bsv/btms-permission-module](./btms-permission-module.md) — Token permission checking
- [@bsv/wallet-relay](./wallet-relay.md) — Broadcast and query wrapper

## What You Can Do

- Connect to a BRC-100 wallet (local or remote)
- Request signature and encryption operations
- Manage keys (if building a wallet)
- Track UTXO balance
- Issue and transfer tokens (BTMS)

## When to Use

Use wallet packages when you're:

- Building an app that integrates with user wallets
- Building a wallet itself
- Managing tokens
- Signing transactions remotely

## Key Concepts

- **BRC-100** — Standard wallet interface for signing and encryption
- **BTMS** — Token protocol for issuance and transfer
- **Relay** — Service that broadcasts transactions and queries UTXOs
- **Identity Key** — Long-lived key representing a user

## Next Steps

- **[@bsv/wallet-toolbox](./wallet-toolbox.md)** — Connect to wallets
- **[@bsv/btms](./btms.md)** — Token protocol
- **[Guide: Wallet-Aware App](../../guides/wallet-aware-app.md)** — Build with wallets
