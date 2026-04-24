# BASELINE — @bsv/amountinator

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/amountinator` |
| Path | `packages/helpers/amountinator` |
| npm | [@bsv/amountinator](https://www.npmjs.com/package/@bsv/amountinator) |
| Version | 2.0.1 |
| Criticality | **Tier 2** — satoshi/fiat amount conversion utility; failure isolates to amount display domain |
| Reliability Level | **RL0** — no test files found, no coverage configured |
| Owner | @sirdeggen |
| Backup owner | — |

## Build
| Field | Value |
|-------|-------|
| Build command | `tsc --build` |
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
| Linter | — |
| Lint command | — |

## Dependencies
| Type | Count | Packages |
|------|-------|---------|
| Production | 2 | @bsv/sdk, @bsv/wallet-toolbox-client |

## Known Issues & Incidents
- No test files found despite a `jest` test command configured.
- No lint configured.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
