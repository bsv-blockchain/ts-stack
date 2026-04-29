---
id: btms-permission-module
title: "@bsv/btms-permission-module"
kind: package
domain: wallet
npm: "@bsv/btms-permission-module"
version: "1.0.1"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
status: stable
tags: ["tokens", "permissions"]
github_repo: "https://github.com/bsv-blockchain/ts-stack"
---

# @bsv/btms-permission-module

The core permission module for BTMS token operations. Framework-agnostic with no UI dependencies. <!-- audio: Btms.m4a @ 00:45 -->

BSV Desktop and BSV Browser show a spend authorization modal whenever BSV is spent. For a BTMS token output the raw satoshi value is typically 1 sat — not the token's actual denomination. This module gives the wallet enough context to show the correct value to the user and gate authorization appropriately. A USD stablecoin issuer, for example, ships a module that causes the modal to display "$1.00 USD" rather than "1 satoshi."

`@bsv/btms-permission-module` implements the BRC-98/99 permission hooks interface to intercept BTMS token spend and burn operations, prompt users via a callback, and enforce authorization decisions. Works with any UI framework (React, Vue, Angular, vanilla JS, or no UI at all).

## Install

```bash
npm install @bsv/btms-permission-module
```

## Quick start

```typescript
import { BasicTokenModule } from '@bsv/btms-permission-module'

const requestTokenAccess = async (app: string, message: string): Promise<boolean> => {
  const details = JSON.parse(message)
  
  const approved = confirm(
    `${app} wants to ${details.operation} ${details.sendAmount || details.burnAmount} of "${details.tokenName}"`
  )
  
  return approved
}

const basicTokenModule = new BasicTokenModule(requestTokenAccess)
```

## What it provides

- **Permission module** — `BasicTokenModule` implementing BRC-98/99 `canPerform()` and `promptUser()` hooks
- **Factory function** — `createBtmsModule()` for convenient BTMS + module initialization
- **Async prompting** — `PermissionPromptHandler` callback pattern for custom UI integration
- **JSON message parsing** — Standard schema with token details (assetId, operation, amounts, recipient)
- **Framework agnostic** — No UI dependencies; you control prompt display (modal, alert, web component, etc.)

## Common patterns

### Simple prompt with confirm dialog (vanilla JS)

```typescript
import { BasicTokenModule } from '@bsv/btms-permission-module'

const requestTokenAccess = async (app: string, message: string): Promise<boolean> => {
  const details = JSON.parse(message)
  
  const approved = confirm(
    `${app} wants to ${details.operation} ${details.sendAmount || details.burnAmount} of "${details.tokenName}"`
  )
  
  return approved
}

const basicTokenModule = new BasicTokenModule(requestTokenAccess)
```

### Deny-all for programmatic use (no UI needed)

```typescript
import { createBtmsModule } from '@bsv/btms-permission-module'

// Create module with no prompt handler — all requests denied
const module = createBtmsModule({
  wallet,
  // No promptHandler → defaults to deny all
})

// Useful for server-side or automated workflows
```

### Register with wallet permissions manager

```typescript
import { WalletPermissionsManager } from '@bsv/wallet-toolbox'
import { BasicTokenModule } from '@bsv/btms-permission-module'

const tokenModule = new BasicTokenModule(myPromptHandler)

const permissionsManager = new WalletPermissionsManager(wallet, appOrigin, {
  permissionModules: {
    btms: tokenModule  // Register under 'btms' key
  }
})

// Now when app tries to spend BTMS tokens, permission system will:
// 1. Check if app has permission for 'btms' protocol
// 2. Call module's promptUser() if permission not cached
// 3. Ask user via your prompt handler
// 4. Cache decision for session
```

## Key concepts

- **BRC-98/99 Hooks** — Standard permission module interface. Wallets invoke hooks when apps request special operations.
- **Permission Caching** — Wallet-toolbox's `WalletPermissionsManager` caches yes/no decisions per (app, protocol) for the session.
- **Framework Agnostic** — Module is pure TypeScript with no UI dependencies. You control how prompts appear.
- **JSON Message Format** — Token details are serialized as JSON: `{ tokenName?, assetId, sendAmount?, burnAmount?, recipientKey?, operation: 'spend' | 'burn' }`
- **Async Prompt** — Handler returns a Promise so you can show UI, wait for user input, then resolve with decision.

## When to use this

- You're building a wallet that integrates BTMS token operations
- You need fine-grained permission control over token spending
- You want users to explicitly approve token operations
- You're using [@bsv/wallet-toolbox](./wallet-toolbox.md) and integrating BTMS

## When NOT to use this

- Use [@bsv/btms](./btms.md) directly if you don't need permission control
- Use [@bsv/wallet-toolbox](./wallet-toolbox.md) permission system without BTMS if tokens aren't involved

## Spec conformance

- **BRC-98/99** — Permission module interface (`canPerform()` and `promptUser()`)
- **BRC-100** — Uses standard wallet interface for token validation
- **BTMS** — Understands BTMS token operations (spend, burn)

## Common pitfalls

> **JSON parse errors** — If the message format is wrong, `JSON.parse()` will throw. Always wrap in try/catch in production handlers.

> **Async handler blocking** — If your prompt handler takes too long, the wallet operation times out. Keep handlers responsive.

> **Promise never resolving** — If your handler never calls `resolve()`, the wallet operation hangs. Always ensure resolve/reject is called.

> **Handler called multiple times** — For a single token send, handler may be called once per output. Batch prompts if possible in your UI.

> **No token name available** — If asset hasn't been discovered yet, tokenName may be undefined. Use assetId as fallback for display.

## Related packages

- [@bsv/wallet-toolbox](./wallet-toolbox.md) — Wallet that hosts the permission manager
- [@bsv/btms](./btms.md) — Token protocol that triggers permission checks
- [@bsv/sdk](../sdk/bsv-sdk.md) — Cryptographic and wallet interface types

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/btms-permission-module/)
- [Source on GitHub](https://github.com/bsv-blockchain/ts-stack)
- [npm](https://www.npmjs.com/package/@bsv/btms-permission-module)
