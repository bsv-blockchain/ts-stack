---
id: domain-middleware
title: Middleware
kind: reference
last_updated: '2026-07-27'
version: 'n/a'
last_verified: '2026-07-27'
review_cadence_days: 90
status: stable
tags: [packages, middleware]
---

# Middleware Domain

Express.js middleware and client utilities for adding cryptographic authentication and micropayment gating to HTTP services. There are two distinct payment paths: `@bsv/payment-express-middleware` layers payment requirements on top of authenticated Express routes, while `@bsv/402-pay` is an independent HTTP 402 flow that can work without auth middleware.

## Packages

| Package                                                          | Purpose                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [@bsv/auth](auth.md)                                             | Framework-neutral signed, expiry-bound, single-use wallet proofs with an injected replay store.        |
| [@bsv/auth-express-middleware](auth-express-middleware.md)       | Express middleware implementing BRC-103 peer-to-peer mutual authentication via BRC-104 HTTP transport. |
| [@bsv/payment-express-middleware](payment-express-middleware.md) | Authenticated legacy `x-bsv-payment` middleware with replay-safe payment acceptance.                   |
| [@bsv/402-pay](402-pay.md)                                       | Independent BRC-121 client and server HTTP 402 flow that does not require auth middleware.             |
