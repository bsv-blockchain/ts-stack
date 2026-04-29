---
id: overlays-domain
title: Overlays
kind: meta
domain: overlays
version: "n/a"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: ["domain", "overlays"]
---

# Overlays

Run and consume overlay services that index on-chain data.

## Packages in this Domain

- [@bsv/overlay](./overlay.md) — Core overlay framework
- [@bsv/overlay-express](./overlay-express.md) — HTTP server implementation
- [@bsv/overlay-topics](./topics.md) — Topic managers (UHRP, BTMS)
- [@bsv/overlay-discovery-services](./overlay-discovery-services.md) — Service discovery
- [@bsv/gasp](./gasp-core.md) — GASP sync protocol
- [@bsv/btms-backend](./btms-backend.md) — Token overlay backend

## What You Can Do

- Index on-chain data by topic
- Serve indexed data to applications
- Validate transactions for a topic
- Manage file storage (UHRP)
- Sync state between overlays (GASP)

## When to Use

Use overlays when you're:

- Running a service that indexes data
- Querying indexed data (instead of scanning the chain)
- Storing files on BSV
- Building a token system backend

## Key Concepts

- **Overlay** — Service that indexes a topic or category of transactions
- **Topic** — A category of transactions (e.g., token transfers, files)
- **Topic Manager** — Validates and indexes transactions for a topic
- **UHRP** — Universal Hash Reference Protocol for file storage

## Next Steps

- **[@bsv/overlay](./overlay.md)** — Core framework
- **[@bsv/overlay-express](./overlay-express.md)** — Run an HTTP overlay
- **[Guide: Run an Overlay Node](../../guides/run-overlay-node.md)**
