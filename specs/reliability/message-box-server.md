<!-- Centralized reliability record. Source repo: bsv-blockchain/message-box-server -->
<!-- When message-box-server is consolidated into ts-stack (Phase 5), this file moves with it. -->

# Reliability Status

## Component
- Name: messagebox-server
- Domain: Messaging
- Criticality tier: 1
- Reliability Level (current → target): RL1 → RL4
- Owner / Backup owner: BSV Blockchain Association / Unknown

## Build and Test
- Build command: `npm run build` (tsc; prebuild: rimraf dist)
- Test command: `npm test` (node --experimental-vm-modules jest --config=jest.config.mjs)
- Lint command: `npm run lint` (ts-standard --fix .; no lint:ci target)
- Coverage command: `npm run test:coverage`
- Benchmark command: None defined
- Last baseline date: 2026-04-24
- Known flaky tests: None known

## Supported Versions
- Runtime versions: Node.js (version not pinned in CI matrix; Dockerfile target unknown)
- Package versions: messagebox-server v1.1.5
- Protocol/spec versions: BSV MessageBox protocol; BRC-auth; depends on @bsv/sdk ^2.0.7, @bsv/wallet-toolbox ^2.1.5

## Contracts
- Public APIs: REST API (Express); Swagger/OpenAPI via swagger-jsdoc + swagger-ui-express at /api-docs
- Specs: Swagger/OpenAPI spec auto-generated from JSDoc annotations
- Schemas: OpenAPI spec generated at runtime
- Contract tests: None separate from unit tests
- Conformance vectors: None formally maintained
- Codegen source: None

## Operations
- Health endpoint: None documented (no /health or /ready route visible in routes/)
- Readiness endpoint: None documented
- Metrics: None
- Logs: prettyjson used for output; no structured JSON logging
- Tracing: None
- Runbook: DEPLOYING.md exists (deployment notes)
- Dashboard: None
- Alerts: None
- SLOs: None defined
- Rollback procedure: Docker image rollback via ECR image tag pinning; Kubernetes rollout undo if deployed via K8s

## Security
- Threat model: None formally documented
- High-risk paths: Message send/receive (auth middleware @bsv/auth-express-middleware), device registration, Firebase push notification (firebase-admin), MongoDB/MySQL data access (knex)
- Signing key source: Docker image pushed to AWS ECR via GitHub Actions (manual workflow_dispatch trigger)
- SBOM location: None generated
- Last security review: Unknown

## Risks
- Known risks: No CI test/lint workflow (only Docker build-and-push workflow present); no coverage threshold enforced; no health endpoint; prettyjson logging not structured; firebase-admin dependency (broad GCP permissions)
- Recent incidents: None known
- Unsupported behavior: Integration tests (jest.config.integration.ts) require live services; not run in standard CI
- Technical debt: No CI unit test job (missing push/PR test workflow); no lint:ci gate; no health/readiness endpoints; no structured logging; no runbook beyond DEPLOYING.md

## Release Requirements
- Required checks: None automated (only Docker build-and-push is CI, triggered manually)
- Required reviewers: Unknown (not documented in repo)
- Artifact signing: Docker image pushed to AWS ECR (no signing/provenance)
- SBOM: Not generated
- Migration notes: Database migrations in src/migrations/ (knex); apply manually or via deployment scripts

---

# Baseline Snapshot
Date: 2026-04-24

## Build
- Build command: `npm run build` (tsc)
- Build result: pass
- Build time: Unknown (not measured locally)

## Tests
- Test command: `npm test` (node --experimental-vm-modules jest --config=jest.config.mjs)
- Test count: 485
- Test result: pass
- Coverage: Available via `npm run test:coverage`; no enforced threshold

## Lint
- Lint command: `npm run lint` (ts-standard --fix .)
- Result: Unknown — lint applies auto-fixes; no separate lint:ci (check-only) command defined

## Dependencies
- Dependency audit command: `npm audit`
- Known HIGH/CRITICAL CVEs: Unknown — audit not run at baseline date; no automated audit step in CI

## Known Issues
- Known flaky tests: None known
- Known failing tests: Integration tests (jest.config.integration.ts) require live DB/services; excluded from standard test run
- Technical debt notes: No CI workflow for unit tests on push/PR (only Docker build-and-push exists, triggered manually). No health/readiness endpoints. No structured logging. Firebase-admin brings in large dependency surface. knex migrations managed manually.

## Reliability Level
- Current RL: 1
- Target RL: 4
- Gaps to next level:
  - RL2: No CI unit test job on push/PR; no coverage threshold; no dep audit in CI; lint is auto-fix-only (no check-only gate)
  - RL3: No executable conformance vectors; no formal breaking-change policy; OpenAPI spec generated from JSDoc (no version-locked spec file)
  - RL4: No health/readiness endpoints; no structured logs; no metrics; no traces; no runbook (DEPLOYING.md is partial); no SLOs; no alerts; no defined rollback procedure
