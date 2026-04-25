# specs/

Machine-readable contracts for every Tier 1 service boundary in the BSV
Distributed Applications Stack. Specs are the source of truth; generated
types and client stubs are derived from them.

**Rule:** hand-rolled types for spec-defined shapes are a CI failure.
If a boundary has a spec, its types must be generated from the spec.

---

## Purpose

- Make boundaries stable and explicit (no more "read the source" to know the contract).
- Drive code generation for TypeScript, Go, Python, and Rust.
- Enable contract tests that run against any conforming implementation over HTTP.
- Enforce cross-language consistency without requiring manual synchronisation.

---

## Directory structure

```
specs/
  README.md            — this file
  errors.md            — canonical error taxonomy (categories, codes, shapes)
  EXCEPTIONS.md        — tracked boundaries without specs yet

  sdk/
    brc-100-wallet.json        — JSON Schema Draft 2020-12 for BRC-100 wallet interface
    wallet-storage-adapter.json  — (planned, see EXCEPTIONS.md)

  overlay/
    overlay-http.yaml          — OpenAPI 3.1 for overlay submit/lookup/topic-management
    gasp-protocol.md           — (planned, see EXCEPTIONS.md)
    gasp-schema.json           — (planned, see EXCEPTIONS.md)

  broadcast/
    arc.yaml                   — OpenAPI 3.1 for ARC broadcast API
    merkle-service.yaml        — (planned, see EXCEPTIONS.md)

  messaging/
    message-box-http.yaml      — (planned, see EXCEPTIONS.md)
    message-box-ws.yaml        — (planned, see EXCEPTIONS.md)

  auth/
    brc-31-handshake.yaml      — (planned, see EXCEPTIONS.md)
    brc-29-payment.yaml        — (planned, see EXCEPTIONS.md)

  payment/
    brc-121-http.yaml          — (planned, see EXCEPTIONS.md)

  storage/
    uhrp.yaml                  — (planned, see EXCEPTIONS.md)
```

---

## Spec inventory

| Spec file | Format | Status | Boundary |
|-----------|--------|--------|----------|
| `sdk/brc-100-wallet.json` | JSON Schema Draft 2020-12 | Done | BRC-100 wallet interface (all methods) |
| `overlay/overlay-http.yaml` | OpenAPI 3.1 | Done | Overlay submit, lookup, discovery, admin |
| `broadcast/arc.yaml` | OpenAPI 3.1 | Done | ARC broadcast submit, status, batch, callback |
| `errors.md` | Markdown taxonomy | Done | All error categories and codes |
| `EXCEPTIONS.md` | Tracked gaps | Done | Unspecced boundaries with reasons |
| `messaging/message-box-http.yaml` | OpenAPI 3.1 | Planned | message-box-server REST |
| `messaging/message-box-ws.yaml` | AsyncAPI 3.0 | Planned | message-box WebSocket / authsocket |
| `auth/brc-31-handshake.yaml` | AsyncAPI 3.0 | Planned | BRC-31 mutual auth handshake |
| `auth/brc-29-payment.yaml` | AsyncAPI 3.0 | Planned | BRC-29 peer payment |
| `broadcast/merkle-service.yaml` | OpenAPI 3.1 | Planned | Merkle service REST |
| `storage/uhrp.yaml` | OpenAPI 3.1 | Planned | UHRP resolution |
| `sdk/wallet-storage-adapter.json` | JSON Schema | Planned | Wallet storage adapter interface |
| `payment/brc-121-http.yaml` | OpenAPI 3.1 | Planned | BRC-121 / HTTP 402 middleware |

---

## How to add a new spec

### For an HTTP/REST boundary: OpenAPI 3.1

1. Create `specs/<domain>/<service>.yaml`.
2. Use `openapi: "3.1.0"` at the top.
3. Define all paths, request/response schemas, and error responses.
4. Reference `specs/errors.md` for error code conventions.
5. Add the spec to the inventory table in this README.
6. Create `specs/<domain>/contract-tests/` with at least one contract test.
7. If the boundary was listed in `specs/EXCEPTIONS.md`, remove it.
8. Run codegen (see below) and commit the generated output.

### For a WebSocket/event-driven boundary: AsyncAPI 3.0

1. Create `specs/<domain>/<service>.yaml` with `asyncapi: "3.0.0"`.
2. Define channels, messages, and schema components.
3. Add to the inventory and run codegen.

### For a language interface (TypeScript/Go/etc.): JSON Schema Draft 2020-12

1. Create `specs/<domain>/<interface>.json`.
2. Use `"$schema": "https://json-schema.org/draft/2020-12/schema"`.
3. Define all method request/response pairs under `$defs`.
4. Add to the inventory.

---

## Codegen commands

These commands are placeholders. They will be wired into CI once the toolchain
is configured (tracked in the codegen setup task).

```sh
# Generate TypeScript types from all OpenAPI specs
pnpm run codegen:ts

# Generate Go types from all OpenAPI specs
pnpm run codegen:go

# Generate Python types (pydantic) from all OpenAPI/JSON Schema specs
pnpm run codegen:py

# Generate Rust types from all JSON Schema specs
pnpm run codegen:rs

# Run all codegen (all languages)
pnpm run codegen
```

**Toolchain targets:**

| Output | Tool |
|--------|------|
| TypeScript types + client stubs | `openapi-typescript`, `quicktype` |
| Go types + client stubs | `oapi-codegen` |
| Python pydantic models | `datamodel-code-generator` |
| Rust types | `typify`, `progenitor` |

Generated output lands in:

```
packages/sdk/ts-sdk/src/generated/     (TypeScript)
packages/go/generated/                 (Go)
packages/py/generated/                 (Python)
packages/rs/generated/                 (Rust)
```

Generated files must be committed. CI validates that they are up to date
with the specs by re-running codegen and checking for a clean diff.

---

## Contract tests

Contract tests verify that a running implementation conforms to a spec.
They are written in TypeScript and can be pointed at any implementation
over HTTP (local or remote).

```
specs/<domain>/contract-tests/
  <service>.contract.test.ts    — Vitest contract tests
  README.md                     — how to run against a local / remote server
```

Run contract tests against a locally running overlay node:

```sh
OVERLAY_BASE_URL=http://localhost:3000 pnpm run contract-tests:overlay
```

Run contract tests against a locally running ARC:

```sh
ARC_BASE_URL=http://localhost:9090 pnpm run contract-tests:arc
```

A conforming Go, Python, or Rust implementation must pass the TS contract test
suite when pointed at its endpoint.

---

## Error codes

All stable error codes are defined in [`specs/errors.md`](./errors.md).
Implementations must use these codes (not ad hoc strings) so that contract
tests, conformance dashboards, and cross-language vectors can match on codes
rather than message strings.

---

## Unspecced boundaries

See [`specs/EXCEPTIONS.md`](./EXCEPTIONS.md) for the list of Tier 1 boundaries
that do not yet have specs, along with the reason for each gap and the planned
spec location.

---

## Contributing a spec

1. Read the relevant source code carefully — specs must reflect actual behaviour.
2. Follow the format for the boundary type (OpenAPI / AsyncAPI / JSON Schema).
3. Include all known error responses referencing codes from `errors.md`.
4. Add contract tests for at least the happy path and one error path.
5. Open a PR; the PR template will require the spec inventory to be updated.
