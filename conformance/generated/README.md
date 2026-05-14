# conformance/generated

This directory contains **generated type definitions** for the HTTP/AsyncAPI contracts defined in `specs/`. It supports multiple languages as the ts-stack is prepared for cross-language SDK ports (Go, Rust, Python).

**Do not edit files in this directory by hand** — they will be overwritten by codegen workflows.

## Current Contents

| Language | Files | Purpose |
|----------|-------|---------|
| TypeScript | `*.d.ts` | Ambient declarations for overlay, broadcast (ARC), and messaging clients |
| Rust (planned) | `types.rs.TODO` | Placeholder instructions for `typify` / `serde` generation |
| Go (historical) | (removed) | Previously generated via `oapi-codegen`; now superseded by multi-lang strategy |

## How Generation Works

The `.github/workflows/codegen.yml` (or equivalent) workflow should regenerate types whenever `specs/**/*.yaml` changes.

### TypeScript (current)
Types are hand-maintained or generated via `openapi-typescript` / custom scripts into the `.d.ts` files for use by the TS clients in `packages/`.

### Rust (target)
Use `typify` (recommended) or `serde` + `schemars`:

```bash
cargo install typify-cli
typify specs/overlay/overlay-http.yaml > conformance/generated/overlay/types.rs
# Repeat for broadcast/arc.yaml and messaging/message-box-http.yaml
```

### Go (optional / historical)
```bash
go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@latest

oapi-codegen -generate types -package overlay \
  specs/overlay/overlay-http.yaml > conformance/generated/overlay/types.gen.go
# ... same for broadcast and messaging
```

### Python (future)
Use `datamodel-code-generator` or `pydantic` + OpenAPI:

```bash
pip install datamodel-code-generator
datamodel-codegen --input specs/overlay/overlay-http.yaml \
  --output conformance/generated/overlay/models.py
```

## Specs Currently Covered

- `specs/overlay/overlay-http.yaml` — Overlay submit/lookup/topic management
- `specs/broadcast/arc.yaml` — ARC broadcast + Merkle service
- `specs/messaging/message-box-http.yaml` — Message Box HTTP API
- `specs/auth/brc31-handshake.yaml`, `specs/payments/*.yaml`, `specs/storage/uhrp-http.yaml`, `specs/sync/gasp-asyncapi.yaml`, `specs/merkle/merkle-service-http.yaml` — additional contracts

When adding a new language implementation, add the appropriate generation command + output path here and update the workflow.

