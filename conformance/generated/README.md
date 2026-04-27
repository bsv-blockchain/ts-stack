# conformance/generated

This directory contains Go type definitions that are **automatically generated** from the OpenAPI specs in `specs/`.

Do not edit files in this directory by hand — they will be overwritten the next time the codegen workflow runs.

## How generation works

The `.github/workflows/codegen.yml` workflow runs `oapi-codegen` against each OpenAPI spec whenever a `*.yaml` file under `specs/` changes on the `main` branch (or on manual dispatch):

| Spec | Generated package | Output path |
|------|-------------------|-------------|
| `specs/overlay/overlay-http.yaml` | `overlay` | `conformance/generated/overlay/types.gen.go` |
| `specs/broadcast/arc.yaml` | `broadcast` | `conformance/generated/broadcast/types.gen.go` |
| `specs/messaging/message-box-http.yaml` | `messaging` | `conformance/generated/messaging/types.gen.go` |

## Regenerating locally

```bash
go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@latest

oapi-codegen -generate types -package overlay \
  specs/overlay/overlay-http.yaml \
  > conformance/generated/overlay/types.gen.go

oapi-codegen -generate types -package broadcast \
  specs/broadcast/arc.yaml \
  > conformance/generated/broadcast/types.gen.go

oapi-codegen -generate types -package messaging \
  specs/messaging/message-box-http.yaml \
  > conformance/generated/messaging/types.gen.go
```
