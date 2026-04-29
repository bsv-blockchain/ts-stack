---
id: pkg-wallet-toolbox-examples
title: "@bsv/wallet-toolbox-examples"
kind: package
domain: wallet
npm: "@bsv/wallet-toolbox-examples"
version: "1.1.156"
last_updated: "2026-04-29"
last_verified: "2026-04-29"
review_cadence_days: 30
status: stable
tags: ["wallet", "examples", "reference"]
---

# @bsv/wallet-toolbox-examples

Reference wallet implementations built with `@bsv/wallet-toolbox`. Demonstrates common wallet construction patterns across different storage backends and deployment contexts.

## Install

```bash
npm install @bsv/wallet-toolbox-examples
```

## Purpose

This package provides runnable example wallets that show how to assemble `@bsv/wallet-toolbox`'s modular components into a complete BRC-100-compliant wallet. Use it to:

- Understand the `WalletStorageManager` + storage provider composition pattern
- See how to wire `Monitor`, `Services` (ARC, Chaintracks), and key managers together
- Copy patterns for your own wallet implementation

## When to use this

- Learning how `@bsv/wallet-toolbox` components fit together
- Bootstrapping a custom wallet implementation from a working reference

## When NOT to use this

- Production wallets — use `@bsv/wallet-toolbox` directly and compose your own setup
- App development — use `@bsv/simple/server` for automated agents or `@bsv/simple/browser` for browser apps

## Related packages

- [@bsv/wallet-toolbox](./wallet-toolbox.md) — The modular toolkit these examples use
- [@bsv/simple](../helpers/simple.md) — High-level wrapper for app developers
