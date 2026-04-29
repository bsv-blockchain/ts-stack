---
id: guide-http-402
title: "HTTP 402 Payment Gating"
kind: guide
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [guide, payments, http-402, brc-121, monetization]
---

# HTTP 402 Payment Gating

Monetize your API by requiring payments before access using HTTP 402.

## What You'll Learn

- HTTP 402 Payment Required protocol
- Configuring payment requirements
- Handling payment callbacks
- Verifying payment transactions
- Building payment-gated endpoints

## What You'll Build

An Express API that:
1. Requires payment for premium endpoints
2. Returns 402 with payment details
3. Accepts signed payments
4. Grants access after payment validation
5. Tracks payment history

## Prerequisites

- Node.js 18+
- Express.js knowledge
- Bitcoin address handling

## Stack

- @bsv/payment-express-middleware — Middleware
- @bsv/402-pay — Client SDK
- @bsv/sdk — Transaction utilities

## Getting Started

See full guide at `/docs/guides/http-402-payments-full/`.

## Key Concepts

### Payment Challenge (402 Response)

Server requests payment:

```http
HTTP/1.1 402 Payment Required
X-Payment-Outputs: [{"satoshis":1000,"script":"76a914..."}]
X-Payment-Reference: "req-12345"

Please pay 1000 satoshis to continue.
```

### Payment Proof

Client sends signed payment transaction:

```http
GET /api/premium HTTP/1.1
X-Payment-Transaction: "<hex-encoded tx>"
X-Payment-Signature: "<signature>"
X-Payment-Reference: "req-12345"
```

### Access Granted (200 Response)

Server validates and grants access:

```http
HTTP/1.1 200 OK
Content-Type: application/json

{ "data": "premium content" }
```

## Implementation

### Server Setup

```typescript
import express from 'express';
import { paymentMiddleware } from '@bsv/payment-express-middleware';

const app = express();

app.use(paymentMiddleware({
  publicKey: YOUR_PUBLIC_KEY,
  satoshiRate: 1000  // Price per request
}));

app.get('/api/premium', (req, res) => {
  if (req.payment?.verified) {
    res.json({ data: 'Premium data' });
  } else {
    res.status(402).send('Payment required');
  }
});
```

### Client Request

```typescript
import { PaymentClient } from '@bsv/402-pay';

const client = new PaymentClient({
  privateKey: YOUR_PRIVATE_KEY
});

const response = await client.get(
  'https://api.example.com/api/premium'
);

console.log(response.data);
```

## Payment Flow Diagram

```
Client                Server
  │                     │
  ├──GET /premium────────→
  │                     │
  │←─402 + outputs──────│
  │   + reference        │
  │                     │
  (create & sign tx)    │
  │                     │
  ├──GET + tx + sig─────→
  │                     │
  │   (verify payment)   │
  │                     │
  │←─200 + data─────────│
```

## Use Cases

- **Data access** — Charge per API call
- **API tiers** — Different prices for different endpoints
- **Metering** — Count payments to track usage
- **Sponsorship** — Allow sponsors to pay for users
- **Micropayments** — Monetize high-volume endpoints

## Monitoring

Track payment activity:

```typescript
app.get('/payments/activity', (req, res) => {
  res.json({
    totalReceived: 50000000,  // satoshis
    transactionCount: 234,
    activeUsers: 45
  });
});
```

## Next Steps

- [BRC-121 Spec](/docs/specs/brc-121-402/) — Protocol details
- [Payment Middleware Package](/docs/packages/payment-express-middleware/)
- [402-Pay Client Package](/docs/packages/402-pay/)
