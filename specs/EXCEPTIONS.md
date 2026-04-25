# Tracked Spec Exceptions

This file records Tier 1 service boundaries that do **not yet** have an
executable contract (OpenAPI, AsyncAPI, or JSON Schema) in `specs/`.
Every exception must have a stated reason and a tracking reference.

The Phase 2 gate requires that **every Tier 1 boundary has an executable
contract OR a tracked exception here**. This file satisfies the "tracked
exception" requirement.

When a spec is created for one of the boundaries below, remove the entry
from this file and add a link to the spec file instead.

---

## Exceptions

### 1. message-box HTTP API

| Field | Value |
|-------|-------|
| **Boundary** | `message-box-server` REST endpoints |
| **Spec type needed** | OpenAPI 3.1 |
| **Status** | No spec yet |
| **Reason** | The message-box-server HTTP API surface is still evolving. A stable spec will be written once the endpoint set is frozen. |
| **Tracking** | Add issue link here when created |
| **Expected spec location** | `specs/messaging/message-box-http.yaml` |
| **Priority** | High — MBGA §6 Workstream C item 3 |

### 2. message-box WebSocket / authsocket

| Field | Value |
|-------|-------|
| **Boundary** | `message-box-server` WebSocket protocol; `authsocket` / `authsocket-client` |
| **Spec type needed** | AsyncAPI 3.0 |
| **Status** | No spec yet |
| **Reason** | AsyncAPI 3.0 spec requires careful mapping of WebSocket message shapes and channel definitions. The authsocket protocol is closely tied to BRC-31 and should be specced together with the auth handshake. |
| **Tracking** | Add issue link here when created |
| **Expected spec location** | `specs/messaging/message-box-ws.yaml` |
| **Priority** | High — MBGA §6 Workstream C item 4 |

### 3. BRC-31 auth handshake

| Field | Value |
|-------|-------|
| **Boundary** | BRC-31 mutual authentication request/response protocol used by `auth-express-middleware` and `authsocket` |
| **Spec type needed** | AsyncAPI 3.0 + sequence diagrams + JSON Schema for each message type |
| **Status** | No spec yet |
| **Reason** | The handshake involves a multi-step challenge/response that is best modelled with AsyncAPI channels. The exact message shapes need to be extracted from `auth-express-middleware` source and the BRC-31 document reconciled with the implementation. |
| **Tracking** | Add issue link here when created |
| **Expected spec location** | `specs/auth/brc-31-handshake.yaml` |
| **Priority** | High — MBGA §6 Workstream C item 5 |

### 4. BRC-29 peer payment

| Field | Value |
|-------|-------|
| **Boundary** | BRC-29 direct peer payment flow (derivation prefix/suffix negotiation, remittance envelope) |
| **Spec type needed** | AsyncAPI 3.0 + JSON Schema for WalletPayment and remittance envelope |
| **Status** | No spec yet |
| **Reason** | BRC-29 is primarily a protocol doc; the data shapes are partially captured in `specs/sdk/brc-100-wallet.json` (WalletPayment, BasketInsertion, InternalizeOutput) but the full peer-to-peer negotiation flow has not been modelled as a sequence spec. |
| **Tracking** | Add issue link here when created |
| **Expected spec location** | `specs/auth/brc-29-payment.yaml` |
| **Priority** | Medium — MBGA §6 Workstream C item 6 |

### 5. GASP sync protocol

| Field | Value |
|-------|-------|
| **Boundary** | GASP (Graph-Aware Sync Protocol) cross-node synchronization messages exchanged via `/requestSyncResponse` and `/requestForeignGASPNode` |
| **Spec type needed** | Protocol document + JSON Schema for GASPInitialRequest, GASPNode, GASPSyncResponse |
| **Status** | Partially modelled as opaque objects in `specs/overlay/overlay-http.yaml` |
| **Reason** | The exact GASP message shapes are defined in `gasp-core` and not yet formally documented. The two overlay endpoints are specced but their request/response bodies are marked `additionalProperties: true` pending a full GASP protocol spec. |
| **Tracking** | Add issue link here when created |
| **Expected spec location** | `specs/overlay/gasp-protocol.md` + `specs/overlay/gasp-schema.json` |
| **Priority** | Medium — MBGA §6 Workstream C item 11 |

### 6. UHRP

| Field | Value |
|-------|-------|
| **Boundary** | UHRP (Universal Hash Resolution Protocol) content-addressed storage lookup |
| **Spec type needed** | JSON Schema for UHRP URL format + OpenAPI for the UHRP resolution HTTP endpoint |
| **Status** | No spec yet |
| **Reason** | UHRP is used by `uhrp-ui`, `uhrp-react`, and `go-uhrp-storage-server` but the resolution protocol has not been specced from these implementations. Depends on identifying the canonical server implementation. |
| **Tracking** | Add issue link here when created |
| **Expected spec location** | `specs/storage/uhrp.yaml` |
| **Priority** | Low — MBGA §6 Workstream C item 12 |

### 7. BRC-121 / HTTP 402 payment middleware

| Field | Value |
|-------|-------|
| **Boundary** | `payment-express-middleware` and `402-pay` — HTTP 402 payment-required flow |
| **Spec type needed** | OpenAPI 3.1 for the 402 negotiation headers + JSON Schema for payment token |
| **Status** | No spec yet |
| **Reason** | The 402 middleware is part of MBGA §6 Workstream C item 7. The token shape needs to be extracted from `402-pay` source before speccing. |
| **Tracking** | Add issue link here when created |
| **Expected spec location** | `specs/payment/brc-121-http.yaml` |
| **Priority** | Medium — MBGA §6 Workstream C item 7 |

### 8. Merkle service API

| Field | Value |
|-------|-------|
| **Boundary** | `merkle-service` (Go) REST API for retrieving Merkle paths |
| **Spec type needed** | OpenAPI 3.1 |
| **Status** | No spec yet |
| **Reason** | The Merkle service is a Go service. The HTTP API surface needs to be reviewed against the Go source before a spec can be written. |
| **Tracking** | Add issue link here when created |
| **Expected spec location** | `specs/broadcast/merkle-service.yaml` |
| **Priority** | Medium — MBGA §6 Workstream C item 9 |

### 9. Storage adapter (wallet)

| Field | Value |
|-------|-------|
| **Boundary** | Wallet storage adapter interface (TypeScript) used by `wallet-toolbox` and `storage-server` |
| **Spec type needed** | JSON Schema (derived from TS interface) |
| **Status** | No spec yet |
| **Reason** | The storage adapter interface is complex and includes ~20 methods. A dedicated spec session is needed to cover all CRUD operations and migration hooks. |
| **Tracking** | Add issue link here when created |
| **Expected spec location** | `specs/sdk/wallet-storage-adapter.json` |
| **Priority** | Medium — MBGA §6 Workstream C item 10 |

---

## How to resolve an exception

1. Write the spec file in the appropriate `specs/<domain>/` directory.
2. Add the spec file to `specs/README.md` spec inventory.
3. Create at least one contract test in `specs/<domain>/contract-tests/`.
4. Remove the entry from this file.
5. Reference the spec in the relevant package's `RELIABILITY.md`.

---

*Last updated: 2026-04-24. Phase 2 target: all exceptions resolved or explicitly deferred to Phase 3.*
