---
id: pkg-payment-express-middleware
title: "@bsv/payment-express-middleware"
kind: package
domain: middleware
version: "2.0.2"
source_repo: "bsv-blockchain/payment-express-middleware"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/payment-express-middleware"
repo: "https://github.com/bsv-blockchain/payment-express-middleware"
status: stable
tags: [middleware, express, payment, brc-121, 402]
---

# @bsv/payment-express-middleware

Express middleware for HTTP 402 payment gating — require on-chain payment before serving a response to clients.

## Install

```bash
npm install @bsv/payment-express-middleware
```

## Quick start

```typescript
import express from 'express';
import { paymentMiddleware } from '@bsv/payment-express-middleware';

const app = express();

// Protect routes with payment requirement
app.get('/premium/data', 
  paymentMiddleware({ amount: 1000 }), // 1000 satoshis
  (req, res) => {
    res.json({
      data: 'This content requires payment'
    });
  }
);

app.listen(3000);
```

## What it provides

- **HTTP 402 response** — Send 402 Payment Required with invoice
- **Invoice generation** — Create payment invoices for requests
- **Payment verification** — Verify on-chain payments before serving
- **Amount configuration** — Set per-route or global payment amounts
- **Payment timeout** — Wait for payment with timeout
- **Multiple outputs** — Specify multiple payment destinations
- **Custom metadata** — Embed request metadata in invoice
- **Broadcast integration** — Verify payments via Teranode or similar

## When to use

- Monetizing API endpoints with micropayments
- Creating pay-per-request services
- Building content that requires payment to access
- Implementing dynamic pricing based on request
- Creating subscription-like services with per-use charges

## When not to use

- For traditional subscription billing — use Stripe or similar
- If you need complex payment workflows — use a payment processor
- For free public APIs — skip this middleware
- For offline payment tracking — use a database instead

## API reference

Full TypeScript API documentation: [TypeDoc](https://bsv-blockchain.github.io/ts-stack/api/payment-express-middleware/)

## Related packages

- @bsv/402-pay — Client for paying 402 responses
- @bsv/auth-express-middleware — Authentication middleware
- @bsv/sdk — Transaction building for invoices
- @bsv/teranode-listener — Payment verification
