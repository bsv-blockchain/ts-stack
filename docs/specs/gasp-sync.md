---
id: spec-gasp-sync
title: "GASP Sync Protocol"
kind: spec
version: "1.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [sync, protocol, overlay, gasp]
---

# GASP Sync Protocol

## Overview

GASP (Graph Aware Sync Protocol) enables overlay nodes to efficiently propagate transaction graphs. Rather than broadcasting individual transactions, GASP shares metadata about transaction dependencies, allowing peers to request only what they're missing.

## Key Concepts

### Transaction Graph

A transaction graph is a DAG (directed acyclic graph) where:
- Each transaction is a node
- Edges represent spending relationships (transaction A spends output of transaction B)

### Graph Metadata

GASP shares metadata including:
- Transaction IDs
- Input references (which outputs are spent)
- Graph topology (who spends whom)
- Availability status (whether nodes have the full transaction)

### Selective Synchronization

Nodes only request:
- Transactions they don't have
- In dependency order (dependencies first)
- From peers that have them

## Protocol Messages

### Sync Request

```json
{
  "type": "sync_request",
  "from_height": 123456,
  "graph_hash": "<merkle root of known transactions>"
}
```

### Graph Metadata Response

```json
{
  "type": "graph_metadata",
  "txids": ["<txid1>", "<txid2>", ...],
  "edges": [
    {
      "input_txid": "<txid>",
      "input_vout": 0,
      "output_txid": "<txid>"
    }
  ],
  "availability": {
    "<txid1>": true,
    "<txid2>": false
  }
}
```

### Transaction Request

```json
{
  "type": "transaction_request",
  "txids": ["<txid>", ...]
}
```

### Transaction Response

```json
{
  "type": "transaction_response",
  "transactions": [
    {
      "txid": "<txid>",
      "raw": "<hex-encoded transaction>"
    }
  ]
}
```

## Efficiency Benefits

- **Bandwidth** — Metadata is much smaller than full transactions
- **Parallelism** — Independent subgraphs can sync in parallel
- **Caching** — Repeated graph syncs reuse known transactions
- **Conditional** — Nodes can skip irrelevant subgraphs

## Specification

The complete GASP protocol is defined in AsyncAPI 3.0:

```
specs/sync/gasp-asyncapi.yaml
```

## References

- [GASP Package](/docs/packages/gasp/)
- [Overlay Express](/docs/packages/overlay-express/)
