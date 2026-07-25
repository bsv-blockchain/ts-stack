# Generated OpenAPI types

This directory contains generated TypeScript, Go, and Python models for the
repository-owned HTTP contracts:

| Contract | Specification | Generated directory |
|---|---|---|
| Overlay | `specs/overlay/overlay-http.yaml` | `overlay/` |
| ARC broadcast | `specs/broadcast/arc.yaml` | `broadcast/` |
| Message Box | `specs/messaging/message-box-http.yaml` | `messaging/` |

Do not edit `types.gen.d.ts`, `types.gen.go`, or `models.py` by hand. Change the
source specification or deterministic generator and then regenerate:

```bash
npm ci --prefix tools/codegen/node --ignore-scripts
uv sync --project tools/codegen --locked
pnpm codegen
pnpm codegen:check
```

Use Go with automatic toolchain downloads enabled and uv `0.11.32`; both
manifests reject incompatible tool versions. Python `3.12` is selected by the
locked project. The GitHub workflow installs these prerequisites exactly.

The generator is `scripts/generate-openapi-types.mjs`. Its complete toolchain is
locked in the repository:

- `openapi-typescript@7.13.0` and its TypeScript 5 tool peer in
  `tools/codegen/node/package.json` and `tools/codegen/node/package-lock.json`.
  The isolated manifest also substitutes the patched `js-yaml`, `minimatch`,
  and `brace-expansion` releases required by current advisories while the
  latest generator remains on Redocly 1.x;
- `oapi-codegen@v2.8.0` plus its transitive Go modules in
  `tools/codegen/go.mod` and `tools/codegen/go.sum`;
- `datamodel-code-generator==0.71.0` plus its transitive Python packages and
  artifact hashes in `tools/codegen/pyproject.toml` and `tools/codegen/uv.lock`;
- Go `1.26.5`, uv `0.11.32`, and Python `3.12` in the codegen workflow.

CI generates all nine files into a temporary directory and compares them
byte-for-byte with the committed copies. The workflow has read-only repository
access and never pushes directly to a protected branch. A specification PR must
include its generated changes.

The `types.rs.TODO` files are planning notes, not generated output. Rust code is
not emitted until this repository adopts a pinned Rust toolchain and an actual
consumer contract.
