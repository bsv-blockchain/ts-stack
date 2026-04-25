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

## Resolved in Phase 2

The following exceptions were resolved by Phase 2 spec work (2026-04-24):

| Boundary | Spec file | Resolved |
|----------|-----------|---------|
| `message-box-server` REST endpoints | [`specs/messaging/message-box-http.yaml`](messaging/message-box-http.yaml) | 2026-04-24 |
| `message-box-server` WebSocket / authsocket | [`specs/messaging/authsocket-asyncapi.yaml`](messaging/authsocket-asyncapi.yaml) | 2026-04-24 |
| BRC-31 mutual auth handshake | [`specs/auth/brc31-handshake.yaml`](auth/brc31-handshake.yaml) | 2026-04-24 |
| BRC-29 peer payment protocol | [`specs/payments/brc29-payment-protocol.yaml`](payments/brc29-payment-protocol.yaml) | 2026-04-24 |
| GASP sync protocol | [`specs/sync/gasp-asyncapi.yaml`](sync/gasp-asyncapi.yaml) | 2026-04-24 |
| UHRP resolution HTTP API | [`specs/storage/uhrp-http.yaml`](storage/uhrp-http.yaml) | 2026-04-24 |
| BRC-121 / HTTP 402 payment middleware | [`specs/payments/brc121.yaml`](payments/brc121.yaml) | 2026-04-24 |
| Merkle service REST API | [`specs/merkle/merkle-service-http.yaml`](merkle/merkle-service-http.yaml) | 2026-04-24 |
| Wallet storage adapter interface | [`specs/wallet/storage-adapter.yaml`](wallet/storage-adapter.yaml) | 2026-04-24 |

---

## Exceptions

*No open exceptions at Phase 2 gate (2026-04-24).  All previously tracked
Tier 1 boundaries now have executable contracts.*

---

## How to resolve an exception

1. Write the spec file in the appropriate `specs/<domain>/` directory.
2. Add the spec file to `specs/README.md` spec inventory.
3. Create at least one contract test in `specs/<domain>/contract-tests/`.
4. Remove the entry from this file.
5. Reference the spec in the relevant package's `RELIABILITY.md`.

---

*Last updated: 2026-04-24. Phase 2 resolved: message-box HTTP, authsocket AsyncAPI, BRC-31 handshake, BRC-29 payment protocol, GASP sync, UHRP HTTP, BRC-121 402 payments, Merkle service, wallet storage adapter.*
