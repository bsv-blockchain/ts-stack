---
id: domain-messaging
title: Messaging
kind: reference
last_updated: "2026-04-28"
version: "n/a"
last_verified: "2026-04-28"
review_cadence_days: 90
status: stable
tags: [packages, messaging]
---

# Messaging Domain

Real-time and store-and-forward messaging, identity verification, and payment address discovery for BSV. Provides BRC-103 authenticated WebSockets for live communication, MessageBox overlay service for store-and-forward delivery, and Paymail protocol for capability discovery and P2P payment routing.

## Packages

| Package | Purpose |
|---------|---------|
| **@bsv/authsocket** | Server-side BRC-103 mutual authentication wrapper for Socket.IO. Accept real-time connections from clients who cryptographically prove their identity. |
| **@bsv/authsocket-client** | Client-side BRC-103 mutual authentication wrapper for socket.io-client. Connect to authenticated servers and prove your identity via Bitcoin signature. |
| **@bsv/message-box-client** | Store-and-forward messaging and peer-to-peer payments via MessageBox overlay. Send encrypted messages and make BRC-29-derived payments with BRC-103 authentication. |
| **@bsv/paymail** | BRC-121 Paymail protocol implementation. Both client-side capability discovery and server-side router for PKI, P2P destinations, public profiles, and custom capabilities. |
