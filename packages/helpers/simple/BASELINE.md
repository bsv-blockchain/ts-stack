# BASELINE — @bsv/simple

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/simple` |
| Path | `packages/helpers/simple` |
| npm | [@bsv/simple](https://www.npmjs.com/package/@bsv/simple) |
| Version | 0.3.0 |
| Criticality | **Tier 2** — simplified BSV interaction utilities; failure isolates to developer-facing convenience layer |
| Reliability Level | **RL1** — builds, 2 test files, no coverage command configured |
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
| Test files | 2 |
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
| Production | 4 | @bsv/message-box-client, @bsv/sdk, @bsv/wallet-toolbox, @bsv/wallet-toolbox-client |

## Known Issues & Incidents
- No coverage command configured.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
