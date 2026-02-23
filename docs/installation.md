# Installation

## NPM

```bash
npm install @bsv/simple @bsv/sdk
```

`@bsv/sdk` is a peer dependency — it must be installed alongside `@bsv/simple`.

## Entry Points

The library provides three entry points:

| Import Path | Environment | Use Case |
|-------------|-------------|----------|
| `@bsv/simple` | Browser | Default browser-safe entrypoint (same as `@bsv/simple/browser`) |
| `@bsv/simple/browser` | Browser | Connect to user's wallet extension |
| `@bsv/simple/server` | Node.js | Server wallet with private key (includes server-only deps) |

### Browser

```typescript
import { createWallet, Certifier, DID, Overlay } from '@bsv/simple/browser'
import { CredentialSchema, CredentialIssuer, MemoryRevocationStore } from '@bsv/simple/browser'
```

### Server (Node.js)

```typescript
import { ServerWallet, FileRevocationStore } from '@bsv/simple/server'
```

Or with dynamic import (recommended in frameworks like Next.js):

```typescript
const { ServerWallet } = await import('@bsv/simple/server')
```

## TypeScript

The library ships with full TypeScript declarations. No additional `@types/` packages are needed.

```typescript
import type { BrowserWallet } from '@bsv/simple/browser'
import type { PaymentOptions, TokenOptions, SendOptions } from '@bsv/simple'
```

## Framework-Specific Setup

### Next.js

Next.js with Turbopack requires additional configuration to prevent server-only packages from being bundled for the browser. See the [Next.js Integration Guide](guides/nextjs-integration.md) for the required `next.config.ts` setup.

### React / Vite

No special configuration needed. Import from `@bsv/simple/browser` in your components.

### Vanilla TypeScript / Node.js

No special configuration needed. Use `@bsv/simple/browser` for browser apps or `@bsv/simple/server` for Node.js scripts.
