# BASELINE — @bsv/uhrp-lite

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/uhrp-lite` |
| Path | `packages/overlays/lite-storage-server` |
| npm | [@bsv/uhrp-lite](https://www.npmjs.com/package/@bsv/uhrp-lite) |
| Version | 0.1.0 |
| Criticality | **Tier 3** — non-critical lightweight UHRP storage service |
| Reliability Level | **RL0** — 0 test files found, no coverage configured |
| Owner | @sirdeggen |
| Backup owner | — |

## Build
| Field | Value |
|-------|-------|
| Build command | `tsc` |
| Build status | ✅ Passing (assumed — not yet verified in ts-stack CI) |
| Outputs | Compiled JS from tsc |

## Tests
| Field | Value |
|-------|-------|
| Test command | `jest` |
| Test files | 0 |
| Coverage command | — |
| Coverage | Not yet captured as baseline |
| Known flaky | None identified |

## Lint
| Field | Value |
|-------|-------|
| Linter | standard |
| Lint command | `standard --fix .` |

## Dependencies
| Type | Count | Packages |
|------|-------|---------|
| Production | 9 | @bsv/auth-express-middleware, @bsv/payment-express-middleware, @bsv/sdk, @bsv/wallet-toolbox-client, axios, body-parser, dotenv, express, prettyjson |

## Known Issues & Incidents
- No test files found despite jest command configured.
- Uses `standard` (JavaScript linter) rather than `ts-standard` — tracked debt.
- Lightweight alternative to `storage-server`; uses local/simple storage.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
