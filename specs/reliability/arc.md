<!-- Centralized reliability record. Source repo: bsv-blockchain/arc -->
<!-- When arc is consolidated into ts-stack (Phase 5), this file moves with it. -->

# Reliability Status

## Component
- Name: github.com/bitcoin-sv/arc (ARC — Authoritative Response Component)
- Domain: Broadcast
- Criticality tier: 1
- Reliability Level (current → target): RL3 → RL4
- Owner / Backup owner: BSV Blockchain Association / Unknown

## Build and Test
- Build command: `go build ./...` (or `task build`)
- Test command: `go test -parallel=8 -coverprofile=./cov.out -covermode=atomic -race ./... -coverpkg ./...` (or `task test`)
- Lint command: `golangci-lint run -v ./...` (or `task lint`; v2.5.0 in CI)
- Coverage command: `go tool cover -html=cov.out -o coverage_report.html` (or `task coverage`)
- Benchmark command: None defined in Taskfile
- Last baseline date: 2026-04-24
- Known flaky tests: None known (integration/e2e tests require Docker services)

## Supported Versions
- Runtime versions: Go 1.25.1
- Package versions: github.com/bitcoin-sv/arc (version from git tag)
- Protocol/spec versions: ARC API v1.0.0 (OpenAPI spec in doc/arc.json); gRPC metamorph API (protobuf); BSV transaction broadcast protocol

## Contracts
- Public APIs: REST API (Echo v4) — OpenAPI spec at doc/arc.json and doc/api.md; gRPC API (internal/metamorph/metamorph_api/); Prometheus metrics endpoint
- Specs: OpenAPI 3.0 (doc/arc.json); generated via oapi-codegen
- Schemas: OpenAPI JSON schema (doc/arc.json); protobuf (internal/metamorph/metamorph_api/*.proto)
- Contract tests: E2E tests in test/ directory; run via docker-compose
- Conformance vectors: E2E test suite (test/) run via `task run_e2e_tests`
- Codegen source: `task api` generates Echo handlers from OpenAPI spec; `task gen_go` runs go generate

## Operations
- Health endpoint: Unknown — Echo framework present; no explicit /health route confirmed in source review
- Readiness endpoint: Unknown
- Metrics: Prometheus (github.com/prometheus/client_golang); go-grpc-middleware Prometheus; OTLP metrics export
- Logs: Structured (lmittmann/tint — structured colored terminal logging)
- Tracing: OpenTelemetry (go.opentelemetry.io/otel); OTLP trace export; Jaeger supported in e2e docker-compose
- Runbook: doc/README.md; DEPLOYING notes in repo; ROADMAP.md
- Dashboard: None formally maintained (Prometheus scrape endpoint available)
- Alerts: None formally defined
- SLOs: None defined
- Rollback procedure: Kubernetes rollout undo (k8s/client-go dependency); Docker image tag rollback via ECR/registry

## Security
- Threat model: None formally documented
- High-risk paths: Transaction submission and validation (internal/validator), BEEF processing (internal/beef), P2P node communication (internal/node_client, internal/p2p), key handling (pkg/keyset)
- Signing key source: Docker image build via GitHub Actions (image.yaml); no artifact signing configured
- SBOM location: None generated
- Last security review: gosec scan runs in static-analysis.yaml CI (securego/gosec) with SonarQube; results not publicly linked

## Risks
- Known risks: Large dependency surface (K8s client, Docker SDK, multiple DBs, NATS, Redis, ZeroMQ); integration/e2e tests require full Docker infrastructure
- Recent incidents: None known
- Unsupported behavior: Multicast mode (docker-compose-mcast.yaml) is experimental
- Technical debt: No formal SLOs; no formally defined health endpoint documentation; gosec runs continue-on-error (findings don't block CI)

## Release Requirements
- Required checks: Go build + vet, golangci-lint, unit tests with race detection, gofmt check, go generate check, API codegen check (all in go.yaml CI)
- Required reviewers: Unknown (not documented in repo)
- Artifact signing: None (Docker image pushed without signing)
- SBOM: Not generated
- Migration notes: See CHANGELOG.md; PostgreSQL migrations managed via golang-migrate (github.com/golang-migrate/migrate/v4)

---

# Baseline Snapshot
Date: 2026-04-24

## Build
- Build command: `go build ./...`
- Build result: pass
- Build time: Unknown (not measured locally; CI runs on ubuntu-latest)

## Tests
- Test command: `go test -parallel=8 -coverprofile=./cov.out -covermode=atomic -race ./... -coverpkg ./...`
- Test count: 97 (unit tests; e2e tests in test/ require Docker)
- Test result: pass
- Coverage: cov.out generated; uploaded to SonarQube; no enforced threshold in CI

## Lint
- Lint command: `golangci-lint run -v ./...` (v2.5.0)
- Result: pass (run in CI on push to main and PRs)

## Dependencies
- Dependency audit command: `go mod verify` + `govulncheck ./...` (govulncheck not in CI)
- Known HIGH/CRITICAL CVEs: Unknown — govulncheck not run at baseline date; gosec runs in CI but continue-on-error

## Known Issues
- Known flaky tests: E2E tests (test/ directory) are infrastructure-dependent (Docker, PostgreSQL, NATS, Redis, ZeroMQ)
- Known failing tests: None (unit tests); E2E tests not run in standard CI push workflow
- Technical debt notes: gosec security scan runs with continue-on-error (findings don't block CI). No formal SLO definitions. No SBOM. Health/readiness endpoint existence not confirmed. Large transitive dependency surface.

## Reliability Level
- Current RL: 3
- Target RL: 4
- Gaps to next level:
  - RL4: Health/readiness endpoints not confirmed/documented; no formal runbook; no defined SLOs; no configured alerts; no formally defined rollback procedure; structured logs present (tint) but no log schema documented; metrics exposed (Prometheus) but no dashboard or alert rules defined
