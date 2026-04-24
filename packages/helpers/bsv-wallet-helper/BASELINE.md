# BASELINE — @bsv/wallet-helper

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/wallet-helper` |
| Path | `packages/helpers/bsv-wallet-helper` |
| npm | [@bsv/wallet-helper](https://www.npmjs.com/package/@bsv/wallet-helper) |
| Version | 0.0.6 |
| Criticality | **Tier 2** — wallet helper utilities; failure isolates to wallet convenience layer |
| Reliability Level | **RL2** — 7 test files found, no coverage command configured |
| Owner | @sirdeggen |
| Backup owner | — |

## Build
| Field | Value |
|-------|-------|
| Build command | `tsup` |
| Build status | ✅ Passing (assumed — not yet verified in ts-stack CI) |
| Outputs | tsup bundled output |

## Tests
| Field | Value |
|-------|-------|
| Test command | `jest` |
| Test files | 7 |
| Coverage command | — |
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
- No coverage command configured — RL2 assigned on test file count; coverage tooling not yet wired.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
