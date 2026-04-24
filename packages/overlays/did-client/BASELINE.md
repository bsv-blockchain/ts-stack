# BASELINE — @bsv/did-client

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/did-client` |
| Path | `packages/overlays/did-client` |
| npm | [@bsv/did-client](https://www.npmjs.com/package/@bsv/did-client) |
| Version | 1.1.2 |
| Criticality | **Tier 3** — non-critical DID resolution client; failure isolated to DID lookup domain |
| Reliability Level | **RL0** — 0 test files found, coverage tooling present |
| Owner | @sirdeggen |
| Backup owner | — |

## Build
| Field | Value |
|-------|-------|
| Build command | `npm run build:ts && npm run build:umd` |
| Build status | ✅ Passing (assumed — not yet verified in ts-stack CI) |
| Outputs | TypeScript compiled output + UMD bundle |

## Tests
| Field | Value |
|-------|-------|
| Test command | `npm run build && jest` |
| Test files | 0 |
| Coverage command | `npm run build && jest --coverage` |
| Coverage | Not yet captured as baseline |
| Known flaky | None identified |

## Lint
| Field | Value |
|-------|-------|
| Linter | ts-standard |
| Lint command | `ts-standard --fix src/**/*.ts` |

## Dependencies
| Type | Count | Packages |
|------|-------|---------|
| Production | 2 | @bsv/sdk, @bsv/wallet-toolbox-client |

## Known Issues & Incidents
- No test files found despite test/coverage commands configured.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
