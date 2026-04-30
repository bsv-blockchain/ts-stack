---
id: domain-middleware
title: Middleware
kind: reference
last_updated: "2026-04-30"
version: "n/a"
last_verified: "2026-04-28"
review_cadence_days: 90
status: stable
tags: [packages, middleware]
---

# Middleware Domain

Express.js middleware and client utilities for adding cryptographic authentication and micropayment gating to HTTP services. There are two distinct payment paths: `@bsv/payment-express-middleware` layers payment requirements on top of authenticated Express routes, while `@bsv/402-pay` is an independent HTTP 402 flow that can work without auth middleware.

## Packages

| Package | Purpose |
|---------|---------|
| **@bsv/auth-express-middleware** | Express middleware implementing BRC-103 peer-to-peer mutual authentication via BRC-104 HTTP transport. Verify request signatures, attach verified identity to req.auth, and optionally exchange verifiable certificates. |
| **@bsv/payment-express-middleware** | Express middleware for HTTP 402 Payment Required micropayment gating. Requires `@bsv/auth-express-middleware` first, then derives payment requirements from the authenticated identity context. |
| **@bsv/402-pay** | Independent client-side and server-side HTTP 402 payment handler. Auto-pay 402 responses on the client; validate and accept payments on the server with caching and replay protection, without requiring auth middleware. |
