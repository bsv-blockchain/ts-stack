---
id: install
title: Install
kind: meta
version: "n/a"
last_updated: "2026-04-29"
last_verified: "2026-04-29"
review_cadence_days: 30
status: stable
tags: ["installation", "setup"]
---

# Install

## Prerequisites

- **Node.js ≥ 22** — Check with `node --version`
- **npm, pnpm, or yarn**
- A BSV wallet browser extension (for browser apps — e.g. [MetaNet Client](https://chromewebstore.google.com/detail/metanet-client/))

## Install @bsv/simple

The recommended entry point for most developers:

```bash
npm install @bsv/simple @bsv/sdk
```

`@bsv/sdk` is a peer dependency and must be installed alongside `@bsv/simple`.

## Entry Points

| Import path | Environment | Use case |
|-------------|-------------|----------|
| `@bsv/simple/browser` | Browser | Connect to user's wallet extension |
| `@bsv/simple/server` | Node.js | Self-custodial server wallet |

### Browser

```typescript
import { createWallet, Certifier, DID, Overlay } from '@bsv/simple/browser'
import { CredentialSchema, CredentialIssuer, MemoryRevocationStore } from '@bsv/simple/browser'
```

### Server

```typescript
import { ServerWallet, FileRevocationStore } from '@bsv/simple/server'
```

In Next.js or frameworks with mixed SSR/browser bundling, use dynamic import to keep server-only deps out of the browser bundle:

```typescript
const { ServerWallet } = await import('@bsv/simple/server')
```

## TypeScript

No additional `@types/` packages needed — `@bsv/simple` ships full TypeScript declarations.

```typescript
import type { BrowserWallet } from '@bsv/simple/browser'
import type { PaymentOptions, TokenOptions } from '@bsv/simple'
```

## Framework Notes

### Next.js

Turbopack requires extra config to prevent server-only packages from being bundled for the browser. Add this to `next.config.ts`:

```typescript
const nextConfig = {
  serverExternalPackages: ['@bsv/wallet-toolbox', '@bsv/simple'],
}
export default nextConfig
```

Then import `@bsv/simple/server` only in Server Components or API routes. See the [Next.js integration guide](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/simple/docs/guides/nextjs-integration.md) for the complete setup.

### React / Vite

No special configuration needed. Import from `@bsv/simple/browser` in your components.

### Vanilla TypeScript / Node.js

No special configuration needed. Use `@bsv/simple/server` for Node.js scripts and agents.

## Protocol-Level Work

If you need direct access to cryptographic primitives, Script, transaction construction, or BEEF encoding — skip `@bsv/simple` and use the SDK directly:

```bash
npm install @bsv/sdk
```

See [@bsv/sdk](../packages/sdk/bsv-sdk.md) for the full API surface.

## Next Steps

- **[Get Started](./index.md)** — Connect a wallet and send your first payment
- **[Choose Your Stack](./choose-your-stack.md)** — Pick the right packages for your use case
- **[Key Concepts](./concepts.md)** — BEEF, BRC-100, wallets, overlays, identity
