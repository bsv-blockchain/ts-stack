# Reliability Levels

Every package in ts-stack carries a Reliability Level (RL) in its `BASELINE.md`. RL is a statement of current state, not a target.

| Level | Name | Definition |
|-------|------|------------|
| **RL0** | Untested | No automated tests. Build may or may not pass. |
| **RL1** | Buildable | Builds cleanly. No meaningful test coverage. |
| **RL2** | Tested | Unit tests exist and pass in CI. Coverage ≥ 50%. |
| **RL3** | Contracted | Public API has executable contracts (conformance vectors or contract tests). Lint clean. |
| **RL4** | Production-ready | RL3 + integration tests, runbook, health check, known-failure register, ≥80% coverage on public surface. |
| **RL5** | Hardened | RL4 + threat model reviewed, fuzz/property tests on parsers/crypto paths, benchmark baselines in CI, zero P0/P1 open. |

## Criticality Tiers

Tiers determine priority for reliability investment, not severity of individual bugs.

| Tier | Description | Examples |
|------|-------------|---------|
| **Tier 0** | Core protocol — failure breaks the whole stack | ts-sdk |
| **Tier 1** | Critical services — failure breaks multiple consumers | wallet-toolbox, overlay-services, auth-express-middleware |
| **Tier 2** | Important — failure degrades one domain | message-box-server, ts-paymail |
| **Tier 3** | Non-critical — failure isolated | examples, helpers, tooling |

## Phase Gates (from MBGA §16)

| Gate | Condition |
|------|-----------|
| Phase 1 → 2 | SDK domain ≥90% vector pass rate (TS) |
| Phase 2 → 3 | Every Tier 1 boundary has an executable contract or tracked exception |
| Phase 3 → 4 | Every Tier 1 service at RL4 |
| Phase 4 → 5 | Tier 0 at RL5, Tier 1 at RL4+, interop matrix healthy |

## Migration Gate (MBGA §13.3)

A package may not be considered "migrated" to ts-stack until:

- [ ] `BASELINE.md` captured (pre-migration state documented)
- [ ] Conformance runner exists and vectors pass
- [ ] Contract tests green
- [ ] Publishing rehearsed (dry-run to npm)
- [ ] Rollback documented
- [ ] 60-day deprecation notice posted in source repo
