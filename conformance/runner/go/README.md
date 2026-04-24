# BSV SDK Conformance Test Runner (Go)

Runs the conformance vector suite against the Go SDK.

## Requirements

- Go 1.21+
- Local clone of `github.com/bsv-blockchain/go-sdk` at `/Users/personal/git/go/go-sdk`

The `go.mod` uses a `replace` directive to point at the local SDK path.

## Build

```sh
cd conformance/runner/go
go mod tidy
go build ./...
```

## Usage

```sh
# Run all vectors (default: ../../vectors relative to the binary)
go run main.go

# Specify a custom vectors directory
go run main.go --vectors /path/to/vectors

# Validate JSON format only (no execution)
go run main.go --validate-only --vectors ../../vectors

# Write a JUnit XML report
go run main.go --vectors ../../vectors --report report.xml
```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--vectors <dir>` | `../../vectors` | Directory to search recursively for `*.json` vector files |
| `--report <path>` | _(none)_ | Write JUnit XML report to this path |
| `--validate-only` | false | Parse and validate JSON format; skip execution |

## Exit codes

- `0` — all executed vectors passed (skipped vectors do not count as failures)
- `1` — one or more vectors failed, or a fatal error occurred

## Implemented categories

| Category | Status |
|----------|--------|
| `sdk.crypto.sha256` | Implemented (single and double hash) |
| `sdk.crypto.ripemd160` | Implemented |
| `sdk.crypto.hash160` | Implemented |
| `sdk.crypto.hmac` | Implemented (HMAC-SHA256 and HMAC-SHA512) |
| `sdk.crypto.ecdsa` | Skipped (sign/custom-k vectors require private-key operations) |
| All others | Skipped with `not-implemented` status |
