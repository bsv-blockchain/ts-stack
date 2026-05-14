---
id: conformance-runner-ts
title: "TypeScript Runner"
kind: conformance
version: "1.0.0"
last_updated: "2026-05-14"
last_verified: "2026-05-14"
review_cadence_days: 30
status: stable
tags: [conformance, runner, typescript]
---

# TypeScript Runner

This repo has two TypeScript-side conformance entry points. Use the structural runner to validate the corpus itself; use the Jest runner to execute supported vectors against `@bsv/sdk`.

## Structural Runner

Root command:

```bash
pnpm conformance
```

Implementation:

```text
conformance/runner/src/runner.js
```

What it does:

- recursively loads `*.json` under `conformance/vectors/`
- checks required top-level and per-vector fields
- writes JSON and JUnit reports under `conformance/runner/reports/`
- supports selecting a different vector root

Supported flags:

| Flag | Meaning |
|---|---|
| `--validate-only` | Load and validate vector files without writing execution-style results |
| `--vectors <dir>` | Use a vector root other than `conformance/vectors` |
| `--report <path>` | Write JUnit XML to the supplied path |

Examples:

```bash
pnpm conformance --validate-only
pnpm conformance --vectors conformance/vectors/wallet/brc100
pnpm conformance --report conformance/runner/reports/results.xml
```

## TypeScript/Jest Behavior Runner

Command:

```bash
pnpm --filter @bsv/conformance-runner-ts test
```

Implementation:

```text
conformance/runner/ts/runner.test.ts
```

What it does:

- loads the same JSON vector corpus
- dispatches recognized categories into `@bsv/sdk`
- creates Jest tests keyed by vector IDs
- skips vectors marked as skipped or `parity_class: "intended"`
- treats unrecognized categories as documented gaps in that runner

This runner is useful when you want TypeScript behavior assertions. It is not the command behind `pnpm conformance`; that root command uses the structural runner above.

## Unsupported Flags

The root structural runner does not implement `--domain`, `--tag`, `--watch`, `--coverage`, `--workers`, or `--verbose`. Use `--vectors <dir>` for coarse subset runs, or Jest's own filtering when running `@bsv/conformance-runner-ts`.

## Debugging A Vector

Start by validating the smallest directory that contains the vector:

```bash
pnpm conformance --vectors conformance/vectors/wallet/brc100
```

Then inspect the fixture:

```bash
sed -n '1,220p' conformance/vectors/wallet/brc100/getpublickey.json
```

For SDK behavior mismatches, compare the vector input against the package source and package-level docs before changing expected output. For wallet interface behavior, compare against `packages/sdk/src/wallet/Wallet.interfaces.ts` and the [BRC-100 method reference](../specs/brc-100-wallet.md).

## CI Use

```yaml
- name: Validate conformance vectors
  run: pnpm conformance --report conformance/runner/reports/results.xml

- name: Run TypeScript conformance behavior tests
  run: pnpm --filter @bsv/conformance-runner-ts test

- name: Upload conformance reports
  uses: actions/upload-artifact@v4
  with:
    name: ts-conformance-reports
    path: |
      conformance/runner/reports/report.json
      conformance/runner/reports/results.xml
```

## Next Steps

- [Vector Catalog](./vectors.md) — Current corpus and coverage
- [BRC-100 Wallet Interface](../specs/brc-100-wallet.md) — Linkable wallet method reference
- [Contributing Vectors](./contributing-vectors.md) — Add or refine portable fixtures
