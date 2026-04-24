# BASELINE — @bsv/uhrp-storage-server

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/uhrp-storage-server` |
| Path | `packages/overlays/storage-server` |
| npm | [@bsv/uhrp-storage-server](https://www.npmjs.com/package/@bsv/uhrp-storage-server) |
| Version | 0.2.1 |
| Criticality | **Tier 3** — non-critical UHRP storage service |
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
| Production | 14 | @bsv/auth-express-middleware, @bsv/payment-express-middleware, @bsv/sdk, @bsv/wallet-toolbox, @bsv/wallet-toolbox-client, @bugsnag/js, @bugsnag/plugin-express, @google-cloud/storage, axios, body-parser, dotenv, express, prettyjson, semver |

## Known Issues & Incidents
- No test files found despite jest command configured.
- Uses `standard` (JavaScript linter) rather than `ts-standard` — tracked debt.
- Service with GCS (Google Cloud Storage) dependency.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
