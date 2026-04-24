# BASELINE — @bsv/wallet-toolbox

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity

| Field | Value |
|-------|-------|
| Package | `@bsv/wallet-toolbox` |
| Path | `packages/wallet/wallet-toolbox` |
| npm | [@bsv/wallet-toolbox](https://www.npmjs.com/package/@bsv/wallet-toolbox) |
| Version | 2.1.22 |
| Criticality | **Tier 1** — critical service, failure breaks multiple consumers |
| Reliability Level | **RL2** — tests pass, coverage tooling present, no executable contracts yet |
| Owner | @sirdeggen |
| Backup owner | — |

## Build

| Field | Value |
|-------|-------|
| Build command | `tsc --build` |
| Build status | ✅ Passing |
| Outputs | Multiple tsconfig targets (all, client, mobile) |

## Tests

| Field | Value |
|-------|-------|
| Test command | `npm run build && jest --testPathIgnorePatterns=man.test.ts` |
| Test files | 77 |
| Coverage command | `npm run test:coverage` |
| Coverage | Not yet captured as baseline |
| Known flaky | `man.test.ts` excluded (manual integration tests requiring live services) |
| Known skips | `man.test.ts` pattern ignored in default test run |

## Lint

| Field | Value |
|-------|-------|
| Linter | ts-standard |
| Lint command | `ts-standard src/**/*.ts` |
| Fix command | `ts-standard --fix src/**/*.ts` |
| Status | Migrated from prettier. 3472 errors remain (see Known Issues). |

## Dependencies

| Type | Count | Packages |
|------|-------|---------|
| Production | 10 | @bsv/auth-express-middleware, @bsv/payment-express-middleware, @bsv/sdk, better-sqlite3, express, hash-wasm, idb, knex, mysql2, ws |
| Dev | — | typescript, jest, prettier, ts2md, … |

## Known Issues & Incidents

- `man.test.ts` tests require external services — not run in CI.
- ts-standard lint: 3472 errors remain after migration from prettier. Breakdown by rule:
  - `@typescript-eslint/strict-boolean-expressions`: 1232 — requires explicit boolean checks throughout
  - `@typescript-eslint/no-non-null-assertion`: 537 — `!` non-null assertions are pervasive
  - `@typescript-eslint/explicit-function-return-type`: 320 — missing return type annotations
  - `@typescript-eslint/prefer-nullish-coalescing`: 239 — `||` should be `??` in many places
  - `@typescript-eslint/no-unused-vars`: 224 — unused variables and parameters
  - `@typescript-eslint/promise-function-async`: 180 — functions returning Promise must be async
  - `@typescript-eslint/method-signature-style`: 146 — interface method style vs property style
  - `@typescript-eslint/restrict-template-expressions`: 134 — template literal type restrictions
  - `@typescript-eslint/no-floating-promises`: 94 — unhandled promises
  - Other rules: ~362 errors across eqeqeq, dot-notation, brace-style, prefer-optional-chain, etc.
  These require semantic/logic-level changes and are deferred to a future cleanup pass.

## Conformance Vectors

No vectors exist yet. Phase 2 target: wallet interface (BRC-100) contract tests.

## Migration Gate Checklist (MBGA §13.3)

- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo (bsv-blockchain/wallet-toolbox)
