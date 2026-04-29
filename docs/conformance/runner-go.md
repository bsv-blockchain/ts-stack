---
id: conformance-runner-go
title: "Go Runner"
kind: conformance
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [conformance, runner, go]
---

# Go Runner

Run conformance vectors in Go using the standard testing package.

## Quick Start

Run all conformance tests:

```bash
cd /Users/personal/git/ts-stack/conformance/go
go test -v ./...
```

## Usage

### Run all vectors
```bash
cd conformance/go
go test -v ./...
```

### Run specific package
```bash
go test -v ./wallet/brc100
go test -v ./sdk/crypto
```

### Run specific test
```bash
go test -v ./wallet/brc100 -run TestGetPublicKey
```

### Verbose output with timing
```bash
go test -v -json ./... > results.json
```

### Benchmarks
```bash
go test -bench=. ./...
```

### Coverage
```bash
go test -cover ./...
go test -coverprofile=coverage.out ./...
go tool cover -html=coverage.out
```

### Parallel execution
```bash
go test -parallel 8 ./...
```

### Sequential (for debugging)
```bash
go test -parallel 1 ./...
```

## Output Format

Test runner produces JSON report (with `-json` flag):

```json
{
  "Time": "2026-04-28T10:30:00Z",
  "Action": "run",
  "Package": "github.com/bsv/ts-stack/conformance/go/wallet/brc100",
  "Test": "TestGetPublicKey",
  "Output": "PASS: TestGetPublicKey (0.002s)\n"
}
```

Convert to standard format:

```bash
go test -v -json ./... | \
  jq -r 'select(.Action == "pass" or .Action == "fail") | {vector: .Test, status: .Action}' \
  > results.json
```

## Repository Structure

```
conformance/go/
  go.mod
  go.sum
  sdk/
    crypto/
      crypto_test.go
    keys/
      keys_test.go
    transactions/
      transactions_test.go
  wallet/
    brc100/
      brc100_test.go
    brc29/
      brc29_test.go
  messaging/
    brc31/
      brc31_test.go
    authsocket/
      authsocket_test.go
```

## Test Implementation

Tests use Go's `testing.T` and load vectors from JSON:

```go
func TestGetPublicKey(t *testing.T) {
  vector := loadVector(t, "getPublicKey-happy-path.json")
  
  wallet := NewWallet()
  result, err := wallet.GetPublicKey(vector.Inputs.DerivationKey)
  
  if err != nil {
    t.Fatalf("unexpected error: %v", err)
  }
  
  if result != vector.ExpectedOutput.PublicKey {
    t.Errorf("got %s, want %s", result, vector.ExpectedOutput.PublicKey)
  }
}
```

## Debugging

### Print test output
```bash
go test -v ./wallet/brc100 -run TestGetPublicKey
```

### Debug with dlv
```bash
dlv test ./wallet/brc100 -- -test.run TestGetPublicKey
```

Then use dlv commands: `continue`, `next`, `print <var>`

### Check Go version
```bash
go version
```

Must be Go 1.18 or higher.

## Environment Setup

Ensure you have:

- Go 1.18+
- Dependencies installed: `go mod download`

```bash
go version  # go version go1.21 or higher
cd conformance/go
go mod download
```

## Known Issues

### Test timeouts
Increase timeout:

```bash
go test -timeout 5m ./...
```

### Memory issues
Reduce parallel workers:

```bash
go test -parallel 1 ./...
```

### Import errors
Update modules:

```bash
go get -u
go mod tidy
```

## Continuous Integration

The runner is configured for CI in `.github/workflows/conformance.yml`:

```yaml
- name: Run Go Conformance
  run: |
    cd conformance/go
    go test -v ./...
    
- name: Upload Results
  uses: actions/upload-artifact@v3
  with:
    name: go-conformance-results
    path: conformance/results/go-results-*.json
```

## Benchmarking

Run performance benchmarks:

```bash
go test -bench=BenchmarkSign -benchmem ./sdk/crypto
```

Output shows:

```
BenchmarkSign-8    100000    10234 ns/op    256 B/op    4 allocs/op
```

- 100,000 iterations
- 10,234 nanoseconds per operation
- 256 bytes allocated per operation
- 4 allocations per operation

## Comparing with TypeScript

Compare results between runners:

```bash
# Generate results from both runners
pnpm conformance > ts-results.json
cd conformance/go && go test -json ./... > go-results.json

# Compare
cd ../..
pnpm conformance:compare ts-results.json go-results.json
```

## Next Steps

- [Vector Catalog](./vectors.md) — Browse available vectors
- [TS Runner](./runner-ts.md) — Run vectors in TypeScript
- [Contributing](./contributing-vectors.md) — Add new vectors
