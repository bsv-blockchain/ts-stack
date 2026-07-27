---
id: guides-overview
title: 'Guides'
kind: meta
version: '1.0.0'
last_updated: '2026-07-27'
last_verified: '2026-07-27'
review_cadence_days: 30
status: stable
tags: [guides, tutorials, how-to]
---

# Guides

Comprehensive step-by-step walkthroughs for building production applications
with the ts-stack. Guides use current public APIs, runnable examples, and
explicit operational assumptions.

## Available Guides

### 1. [Build a Wallet-Aware App](./wallet-aware-app.md)

Create a TypeScript application that integrates BRC-100 wallets for transaction creation, signing, and broadcasting. Learn wallet initialization, UTXO management, transaction monitoring, and SDK integration.

**Time:** ~20 minutes | **Level:** Intermediate

### 2. [Run an Overlay Node](./run-overlay-node.md)

Deploy a production-ready overlay service that indexes and queries PushDrop data. Configure topic managers, set up MongoDB storage, enable GASP sync, and advertise via SHIP/SLAP for peer discovery.

**Time:** ~30 minutes | **Level:** Intermediate

### 3. [Peer-to-Peer Messaging](./peer-to-peer-messaging.md)

Build authenticated, encrypted messaging between peers using BRC-103 mutual authentication. Choose between store-and-forward HTTP (MessageBox) or real-time WebSocket (Authsocket) transport.

**Time:** ~25 minutes | **Level:** Intermediate

### 4. [HTTP 402 Payment Gating](./http-402-payments.md)

Monetize your API with Bitcoin SV micropayments using HTTP 402 Payment Required. Build a payment-gated Express server and an auto-paying client that transparently handles payment challenges.

**Time:** ~25 minutes | **Level:** Intermediate

### 5. [Compiled Package Boundary Examples](./compiled-package-examples.md)

See how SDK, identity, messaging, middleware, Overlay, wallet, network, and
WASM packages compose in strict TypeScript. CI compiles these examples against
the exact packed workspace artifacts.

**Time:** ~10 minutes | **Level:** Intermediate

## Recommended Learning Path

1. Start with **Wallet-Aware App** if you're new to wallets and transactions
2. Learn **P2P Messaging** to understand identity and authentication
3. Explore **Overlay Node** for understanding data indexing and discovery
4. Master **HTTP 402 Payments** to monetize your services

## Quick Links

**New to ts-stack?** Start with [Get Started](../get-started/).

**Need a spec?** Check [Specifications](../specs/).

**Looking for a package?** Browse [Packages](../packages/).

**Want to implement a protocol?** See [Conformance Testing](../conformance/).

**Looking for infrastructure examples?** Check [Infrastructure Components](../infrastructure/).
