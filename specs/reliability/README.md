# Reliability Registry — Historical Baselines

These files preserve April 2026 MBGA point-in-time measurements. They are not
the current ts-stack status, package versions, support matrix, or work backlog.
Consolidation and later hardening invalidated many of their original gap
statements.

Use [Generated Stack Facts](../../docs/reference/stack-facts.md) for current
versions/runtime profiles, [Repository Health](../../docs/reference/repository-health.md)
for enforced controls, [Security Policy](../../.github/SECURITY.md) for current
security scope, and
[final QA issue #400](https://github.com/bsv-blockchain/ts-stack/issues/400)
for unfinished test/reliability validation. Keep the files below unchanged
except for factual archival corrections; new findings belong in current
governance or a focused issue.

## Registry

| Repo | Domain | Tier | Current RL | Target RL | File |
|------|--------|------|-----------|-----------|------|
| ts-sdk | SDK | 0 | RL2 | RL5 | [ts-sdk.md](./ts-sdk.md) |
| go-sdk | SDK | 0 | RL2 | RL5 | [go-sdk.md](./go-sdk.md) |
| wallet-toolbox | Wallet | 1 | RL2 | RL4 | [wallet-toolbox.md](./wallet-toolbox.md) |
| overlay-express | Overlay | 1 | RL2 | RL4 | [overlay-express.md](./overlay-express.md) |
| message-box-server | Messaging | 1 | RL1 | RL4 | [message-box-server.md](./message-box-server.md) |
| arc | Broadcast | 1 | RL3 | RL4 | [arc.md](./arc.md) |

## RL rubric (MBGA §4.1)

| Level | Gate |
|-------|------|
| RL0 | No baseline, no CI, may not build |
| RL1 | Clean build, CI unit tests, owner named, README |
| RL2 | Meaningful unit tests, coverage threshold, dep audit in CI |
| RL3 | Public APIs have executable specs, conformance vectors, breaking-change policy |
| RL4 | healthz/readyz, structured logs, metrics, traces, runbook, SLOs, alerts |
| RL5 | Fuzz/property tests, threat model, tracked security findings, green interop matrix |

## Notable gaps recorded on 2026-04-27

- **message-box-server** is RL1: no CI test workflow on push/PR (only a manual Docker ECR publish). Most urgent gap.
- These statements describe the historical baseline and must not be quoted as
  current status.
- arc is the most mature at RL3: OTel tracing, Prometheus metrics, E2E Docker suite, OpenAPI + protobuf contracts.
