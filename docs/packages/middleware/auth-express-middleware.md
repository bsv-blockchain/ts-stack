---
id: pkg-auth-express-middleware
title: "@bsv/auth-express-middleware"
kind: package
domain: middleware
version: "2.0.5"
source_repo: "bsv-blockchain/auth-express-middleware"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/auth-express-middleware"
repo: "https://github.com/bsv-blockchain/auth-express-middleware"
status: stable
tags: [middleware, express, auth, brc-31]
---

# @bsv/auth-express-middleware

Express middleware for BRC-31 mutual authentication — verify request signatures and attach verified identity to req.auth for downstream handlers.

## Install

```bash
npm install @bsv/auth-express-middleware
```

## Quick start

```typescript
import express from 'express';
import { authMiddleware } from '@bsv/auth-express-middleware';

const app = express();

// Add authentication middleware
app.use(authMiddleware({
  publicOnly: false // require authentication
}));

// Protected route
app.get('/user/profile', (req, res) => {
  // req.auth contains verified identity info
  res.json({
    identity: req.auth.identity,
    pubkey: req.auth.publicKey
  });
});

app.listen(3000);
```

## What it provides

- **BRC-31 signature verification** — Verify request signatures from clients
- **Identity extraction** — Extract and verify identity from Authorization header
- **Public key verification** — Validate signatures against claimed public keys
- **Optional authentication** — Support both public and protected endpoints
- **Custom validation** — Hook to validate identities (e.g., whitelist)
- **Error handling** — Standard error responses for auth failures
- **Timestamp validation** — Prevent replay attacks
- **Multiple signature schemes** — Support various signature formats

## When to use

- Protecting REST API endpoints with Bitcoin signature authentication
- Building servers that need to verify user identity without passwords
- Implementing APIs where requests prove their identity cryptographically
- Replacing JWT/session auth with signature-based auth
- Building peer-to-peer communication with mutual authentication

## When not to use

- For WebSocket authentication — use @bsv/authsocket instead
- If you need traditional password/session auth — use passport.js
- For public APIs without authentication — skip this middleware
- For bearer token auth — use standard OAuth middleware

## API reference

Full TypeScript API documentation: [TypeDoc](https://bsv-blockchain.github.io/ts-stack/api/auth-express-middleware/)

## Related packages

- @bsv/authsocket — WebSocket authentication
- @bsv/payment-express-middleware — HTTP 402 payment gating
- @bsv/sdk — Signature verification primitives
- @bsv/wallet-toolbox — Wallet for signing requests
