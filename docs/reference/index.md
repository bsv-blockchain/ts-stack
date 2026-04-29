---
id: reference-overview
title: "Reference"
kind: meta
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [reference, api, index]
---

# Reference

Quick reference material for API details and protocol indices.

## Contents

- **[BRC Standards Index](./brc-index.md)** — All BRC standards with links to implementations
- **[API Documentation](#)** — Links to TypeDoc for all packages

## TypeDoc Links by Package

### Core SDK
- [@bsv/sdk](../packages/sdk/) — Bitcoin protocol primitives
- [@bsv/crypto](../packages/crypto/) — Cryptographic operations
- [@bsv/script](../packages/script/) — Script parsing and execution

### Wallets & Keys
- [@bsv/wallet-toolbox](../packages/wallet-toolbox/) — Wallet implementation
- [@bsv/wab-server](../packages/wab-server/) — HTTP wallet server
- [@bsv/keys](../packages/keys/) — Key management

### Messaging
- [@bsv/authsocket](../packages/authsocket/) — WebSocket auth
- [@bsv/message-box-client](../packages/message-box-client/) — Message storage client
- [@bsv/paymail](../packages/paymail/) — Paymail protocol

### Overlay & Storage
- [@bsv/overlay](../packages/overlay/) — Overlay node framework
- [@bsv/overlay-express](../packages/overlay-express/) — Express overlay server
- [@bsv/uhrp](../packages/uhrp/) — Content-addressed storage
- [@bsv/gasp](../packages/gasp/) — Graph synchronization

### Payment & Monetization
- [@bsv/payment-express-middleware](../packages/payment-express-middleware/) — HTTP 402 middleware
- [@bsv/402-pay](../packages/402-pay/) — HTTP 402 client

### Utilities
- [@bsv/utils](../packages/utils/) — Common utilities
- [@bsv/encoding](../packages/encoding/) — Data encoding/decoding

## Quick Navigation

- [Specifications](../specs/) — Protocol details
- [Guides](../guides/) — Step-by-step tutorials
- [Infrastructure](../infrastructure/) — Deployment guides
- [Conformance](../conformance/) — Testing & vectors
