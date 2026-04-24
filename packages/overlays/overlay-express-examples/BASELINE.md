# BASELINE — overlay-express-examples

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `overlay-express-examples` |
| Path | `packages/overlays/overlay-express-examples` |
| npm | [overlay-express-examples](https://www.npmjs.com/package/overlay-express-examples) |
| Version | 2.1.6 |
| Criticality | **Tier 3** — non-critical example code; no production consumers |
| Reliability Level | **RL0** — no tests, no lint configured |
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
| Test command | — |
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
| Production | 7 | @bsv/overlay, @bsv/overlay-discovery-services, @bsv/overlay-express, @bsv/sdk, dotenv, mongodb, mysql2 |

## Known Issues & Incidents
- Example code only — not intended for production use.
- No tests or lint configured.
- Unprefixed package name — not in BSV org namespace.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
