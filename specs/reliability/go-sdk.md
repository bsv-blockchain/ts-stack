<!-- Centralized reliability record. Source repo: bsv-blockchain/go-sdk -->
<!-- When go-sdk is consolidated into ts-stack (Phase 5), this file moves with it. -->

# Reliability Status

## Component
- Name: github.com/bsv-blockchain/go-sdk
- Domain: SDK
- Criticality tier: 0
- Reliability Level (current → target): RL2 → RL5
- Owner / Backup owner: BSV Blockchain SDK team / BSV Blockchain Association

## Build and Test
- Build command: `go build ./...`
- Test command: `go test -race -coverprofile=coverage.out -covermode=atomic ./...`
- Lint command: `golangci-lint run ./...` (via .github/workflows/golangci-lint.yaml)
- Coverage command: `go tool cover -html=coverage.out`
- Benchmark command: None defined
- Last baseline date: 2026-04-24
- Known flaky tests: None known

## Supported Versions
- Runtime versions: Go 1.25
- Package versions: github.com/bsv-blockchain/go-sdk (latest, no semver tag pinned in go.mod)
- Protocol/spec versions: BRC specs (BRC-2, BRC-3, BRC-42, BRC-56, BRC-69, BRC-77, BRC-78 per package structure)

## Contracts
- Public APIs: Exported Go packages: primitives, script, transaction, wallet, auth, overlay, message, identity, spv, kvstore, storage, registry, block, chainhash, util
- Specs: BRC specifications at https://brc.dev
- Schemas: None (Go type system)
- Contract tests: None separate from unit tests
- Conformance vectors: None formally maintained
- Codegen source: None

## Operations
- Health endpoint: N/A (library, not a service)
- Readiness endpoint: N/A
- Metrics: N/A
- Logs: N/A
- Tracing: N/A
- Runbook: None
- Dashboard: None
- Alerts: None
- SLOs: None defined
- Rollback procedure: Pin consumers to prior tagged release in go.mod

## Security
- Threat model: None formally documented
- High-risk paths: primitives (key generation/derivation, ECDSA/Schnorr signing), HMAC/ECIES, transaction construction (BEEF/BUMP/Merkle), script evaluation
- Signing key source: None (no artifact signing configured)
- SBOM location: None generated
- Last security review: Unknown

## Risks
- Known risks: No fuzz or property-based tests; no formal threat model; race detection enabled in CI (good) but no coverage threshold gate
- Recent incidents: None known
- Unsupported behavior: None documented
- Technical debt: No coverage threshold enforced; no benchmark suite; no SBOM generation

## Release Requirements
- Required checks: Test and Coverage CI, golangci-lint CI, SonarQube scan (sonar.yaml)
- Required reviewers: Unknown (not documented in repo)
- Artifact signing: None
- SBOM: Not generated
- Migration notes: See CHANGELOG.md

---

# Baseline Snapshot
Date: 2026-04-24

## Build
- Build command: `go build ./...`
- Build result: pass
- Build time: Unknown (not measured locally; CI runs on ubuntu-latest)

## Tests
- Test command: `go test -race -coverprofile=coverage.out -covermode=atomic ./...`
- Test count: 577
- Test result: pass
- Coverage: coverage.out generated; uploaded to Codecov; no enforced threshold

## Lint
- Lint command: `golangci-lint run ./...` (golangci-lint v2.11.2)
- Result: pass (run in CI on every push/PR to master)

## Dependencies
- Dependency audit command: `go mod verify` + `govulncheck ./...` (govulncheck not in CI)
- Known HIGH/CRITICAL CVEs: Unknown — govulncheck not run at baseline date

## Known Issues
- Known flaky tests: None known
- Known failing tests: None known
- Technical debt notes: No fuzz or property-based tests. No coverage threshold enforced. No SBOM generation.

## Reliability Level
- Current RL: 2
- Target RL: 5
- Gaps to next level:
  - RL3: No executable conformance vectors for BRC specs; no formal breaking-change policy documented; release notes exist (CHANGELOG.md) but conformance test suite absent
  - RL4: N/A for library (no health/readiness endpoints needed), but interop test matrix not tracked
  - RL5: No fuzz/property tests; no load/soak tests; no formal threat model; no tracked security findings; no interop matrix

---

# Benchmark Baseline

Captured: 2026-04-24
Machine: arm64 (Apple M3 Pro, Darwin 25.4.0)
Runtime: Go 1.26.0 darwin/arm64

## Hot Path Baselines

| Operation | ns/op | allocs/op | B/op | Notes |
|-----------|------:|----------:|-----:|-------|
| ECDSA Sign | 44,970 | 68 | 4,667 | secp256k1, RFC6979 deterministic nonce |
| ECDSA Verify | 126,732 | 54 | 2,842 | secp256k1 |
| SHA-256 (32 B input) | 42 | 0 | 0 | stdlib crypto/sha256 |
| SHA-256 (1 KB input) | 361 | 0 | 0 | stdlib crypto/sha256 |
| BEEF_V1 parse (minimal) | 2,514 | 141 | 4,016 | BRC-62 minimal 2-tx chain |
| BEEF_V2 parse (multi-tx) | 10,409 | 473 | 19,352 | BRC-96 multi-tx chain |
| Transaction serialize | 225 | 7 | 1,232 | 3-input 2-output P2PKH tx |
| Script eval (P2PKH) | 194,586 | 204 | 19,520 | Full OP_CHECKSIG execution |
| OpCode parse (P2PKH script) | 47 | 2 | 56 | 25-byte P2PKH script |
| OpCode parse (100 KB data carrier) | 37 | 1 | 128 | Large OP_RETURN |
| OpCode parse (5 MB super-large) | 34 | 1 | 128 | 5 MB OP_RETURN |
| OpCode parse (1000× PUSHDATA1) | 12,835 | 1 | 65,536 | 100 kB push-heavy script |
| OpCode parse (STAS) | 17,848 | 1 | 81,920 | Real STAS script ~1751 bytes |

## Methodology

- **Go**: `go test -bench=. -benchtime=3s -benchmem .` (root package) and
  `go test -bench=. -benchtime=3s -benchmem ./script/interpreter/`
- Benchmark source: `conformance_bench_test.go` (root, package `sdk_test`) and
  `script/interpreter/opcodeparser_bench_test.go`
- Each number is the average reported by the Go testing framework over ≥3 s
  of wall-clock time (benchtime=3s); allocs/op and B/op are per-operation
  averages from `-benchmem`.

## Raw output (go test)

```
goos: darwin
goarch: arm64
pkg: github.com/bsv-blockchain/go-sdk
cpu: Apple M3 Pro
BenchmarkECDSASign-12               	   77870	     44970 ns/op	    4667 B/op	      68 allocs/op
BenchmarkECDSAVerify-12             	   28520	    126732 ns/op	    2842 B/op	      54 allocs/op
BenchmarkSHA256_32B-12              	83710060	        42.25 ns/op	       0 B/op	       0 allocs/op
BenchmarkSHA256_1KB-12              	10032589	       360.9 ns/op	       0 B/op	       0 allocs/op
BenchmarkBEEFV1Parse-12             	 1419928	      2514 ns/op	    4016 B/op	     141 allocs/op
BenchmarkBEEFV2Parse-12             	  349466	     10409 ns/op	   19352 B/op	     473 allocs/op
BenchmarkTransactionSerialize-12    	16891864	       224.8 ns/op	    1232 B/op	       7 allocs/op
BenchmarkScriptEvalP2PKH-12         	   18432	    194586 ns/op	   19520 B/op	     204 allocs/op
BenchmarkOpParseP2PKH-12            	81729564	        46.99 ns/op	      56 B/op	       2 allocs/op
PASS
ok  	github.com/bsv-blockchain/go-sdk	40.197s

goos: darwin
goarch: arm64
pkg: github.com/bsv-blockchain/go-sdk/script/interpreter
cpu: Apple M3 Pro
BenchmarkOpParseSmall-12             	38028568	        96.62 ns/op	     320 B/op	       1 allocs/op
BenchmarkOpParseLargeData-12         	98235399	        37.35 ns/op	     128 B/op	       1 allocs/op
BenchmarkOpParseSuperLargeData-12    	100000000	        34.07 ns/op	     128 B/op	       1 allocs/op
BenchmarkOpParseManyPushDatas-12     	  280543	     12835 ns/op	   65536 B/op	       1 allocs/op
BenchmarkOpParseSTAS-12              	  186734	     17848 ns/op	   81920 B/op	       1 allocs/op
PASS
ok  	github.com/bsv-blockchain/go-sdk/script/interpreter	21.411s
```

## Regression gate

A >5% regression on any Tier 0 row (ECDSA Sign, ECDSA Verify, SHA-256, BEEF
parse, Transaction serialize, Script eval P2PKH) blocks a Tier 0 release
(MBGA §16 Appendix B).
