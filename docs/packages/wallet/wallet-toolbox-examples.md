---
id: pkg-wallet-toolbox-examples
title: '@bsv/wallet-toolbox-examples'
kind: package
domain: wallet
version: '1.1.157'
last_updated: '2026-09-24'
last_verified: '2026-09-24'
review_cadence_days: 30
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox-examples'
status: stable
tags: ['wallet', 'examples', 'reference']
---

# @bsv/wallet-toolbox-examples

Reference wallet implementations built with `@bsv/wallet-toolbox`. Demonstrates common wallet construction patterns across different storage backends and deployment contexts.

## Run from the workspace

This is a private examples workspace, not a supported npm installation target.
Follow the [workspace README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox-examples)
for setup and safety requirements.

## Backup example coverage

The [SQLite backup example](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/wallet/wallet-toolbox-examples/src/backup.ts)
copies sensitive wallet data. It does not back up the root key, establish a
retention policy or prove device-loss recovery. Use the
[complete recovery guide](../../guides/wallet-backup-recovery.md) and
[drill checklist](../../guides/wallet-recovery-drill.md).

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
