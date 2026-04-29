---
id: domain-middleware
title: Middleware
kind: domain
last_updated: "2026-04-28"
---

# Middleware Domain

Express.js middleware and client utilities for adding cryptographic authentication and micropayment gating to HTTP services. Implements BRC-103 mutual authentication over HTTP (BRC-104) and HTTP 402 Payment Required (BRC-121) for monetizing APIs with Bitcoin SV micropayments.

## Packages

| Package | Purpose |
|---------|---------|
| **@bsv/auth-express-middleware** | Express middleware implementing BRC-103 peer-to-peer mutual authentication via BRC-104 HTTP transport. Verify request signatures, attach verified identity to req.auth, and optionally exchange verifiable certificates. |
| **@bsv/payment-express-middleware** | Express middleware for HTTP 402 Payment Required micropayment gating. Builds on top of BRC-103 auth middleware to require BSV satoshi payments derived using BRC-29 key derivation. |
| **@bsv/402-pay** | Client-side and server-side HTTP 402 payment handler. Auto-pay 402 responses on the client; validate and accept payments on the server with caching and replay protection. |
