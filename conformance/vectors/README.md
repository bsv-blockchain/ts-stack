# Conformance Vectors

Each `.json` file under this directory is part of the language-neutral conformance corpus for the BSV TypeScript stack. These vectors are the **portable contract** that any Go, Rust, Python, or other implementation must pass to claim conformance.

**Current size (2026-05-14)**: 72 files, 6,625 vectors. Authoritative index: `conformance/META.json`.

The largest single file is `sdk/scripts/evaluation.json` (5,116 vectors) — it contains normalized SV Node and Teranode script evaluation fixtures with provenance.

## Format

All modern vector files follow the envelope defined in `VECTOR-FORMAT.md` and validated by `conformance/schema/vector.schema.json`:

```json
{
  "$schema": "../../schema/vector.schema.json",
  "id": "sdk.crypto.ecdsa",
  "name": "...",
  "brc": ["BRC-42"],
  "version": "2.0.0",
  "reference_impl": "@bsv/sdk@2.0.x",
  "parity_class": "required",
  "vectors": [ ... ]
}
```

**Regression vectors** (under `regressions/`) use a richer special format with `regression.issue` metadata for historical bug reproduction.

## Important Notes for New Language Ports

- Start with deterministic SDK vectors (`sdk/crypto`, `sdk/keys`, `sdk/transactions`, `sdk/scripts`) before attempting stateful `wallet/brc100` vectors.
- Many `wallet/brc100` success paths are intentionally marked `parity_class: intended` because they require a funded mock-chain or live overlay. See `COVERAGE.md` for the full list and justifications.
- The structural runner (`pnpm conformance --validate-only`) now cleanly supports both standard vectors and the special regression format.

See the full [Vector Catalog](../docs/conformance/vectors.md) and [Contributing Vectors](../docs/conformance/contributing-vectors.md) for details.
