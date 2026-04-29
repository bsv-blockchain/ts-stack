---
id: about-sources
title: "Documentation Sources"
kind: about
last_updated: "2026-04-29"
---

# Documentation Sources

Certain pages in this documentation are derived from expert audio recordings made by the BSV Blockchain team. This page lists the topics covered and which documentation pages each recording drove.

Audio provenance is cited inline on the relevant pages using HTML comments of the form `<!-- audio: <file> @ <timestamp> -->`. These comments are internal traceability markers and are not rendered to readers.

---

## Recording: ts-stack.m4a

Transcribed: 2026-04-29 · Model: mlx-whisper large-v3-turbo

| Topic | Pages informed |
|-------|---------------|
| TS stack overview — collection of libraries and applications covering the BSV blockchain distributed application stack in TypeScript | [Get Started: What is the TS Stack](../get-started/index.md) |
| WalletClient as the primary developer entry point | [Architecture: Stack Layers](../architecture/layers.md), [Choose Your Stack](../get-started/choose-your-stack.md) |
| BRC-100 separation between apps and wallets | [Key Concepts](../get-started/concepts.md), [Architecture: BRC-100](../architecture/brc-100.md) |
| Wallet Toolbox — for developers building wallets | [Architecture: Stack Layers](../architecture/layers.md), [Choose Your Stack](../get-started/choose-your-stack.md) |
| Network packages / Teranode P2P | [@bsv/teranode-listener](../packages/network/teranode-listener.md) |
| Overlay abstraction — shared context for applications | [Key Concepts: Overlays](../get-started/concepts.md#overlays) |
| GASP, Topic Manager, Lookup Service | [Key Concepts: Overlays](../get-started/concepts.md#overlays) |
| AuthExpress and PaymentExpress middleware | [@bsv/auth-express-middleware](../packages/middleware/auth-express-middleware.md), [@bsv/payment-express-middleware](../packages/middleware/payment-express-middleware.md) |

**Note:** The section of this recording covering BRC-121 / HTTP 402 produced a transcription loop and was not usable. The 402 middleware documentation was sourced from the package source code directly.

---

## Recording: Btms.m4a

Transcribed: 2026-04-29 · Model: mlx-whisper large-v3-turbo · Clean transcript.

| Topic | Pages informed |
|-------|---------------|
| BTMS = Basic Token Management System | [@bsv/btms](../packages/wallet/btms.md) |
| Per-token context: token issuer defines BTMS module for their token type | [@bsv/btms](../packages/wallet/btms.md), [@bsv/btms-permission-module](../packages/wallet/btms-permission-module.md) |
| Spend authorization modal in BSV Desktop / BSV Browser wallet UIs | [@bsv/btms-permission-module](../packages/wallet/btms-permission-module.md) |
| USD stablecoin example — user should see "$1.00" not "1 satoshi" | [@bsv/btms-permission-module](../packages/wallet/btms-permission-module.md) |
| Modular approach — no single hardcoded token spec; integrates with all BRC-100 wallets | [@bsv/btms](../packages/wallet/btms.md) |

---

## Recording: Chaintracks server.m4a

Transcribed: 2026-04-29 · Model: mlx-whisper large-v3-turbo · Clean transcript.

| Topic | Pages informed |
|-------|---------------|
| Chaintracks primitives defined in WalletToolbox; server is reference implementation | [Chaintracks Server](../infrastructure/chaintracks-server.md) |
| Teranode P2P block header ingestion | [Chaintracks Server](../infrastructure/chaintracks-server.md) |
| Bootstrap sequence: ~900,000 headers, CDN → bundled files → WhatsOnChain fallback | [Chaintracks Server](../infrastructure/chaintracks-server.md) |
| API for individual Merkle root / block height validation | [Chaintracks Server](../infrastructure/chaintracks-server.md) |
