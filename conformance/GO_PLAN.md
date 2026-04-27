# Go Conformance Runner Migration Plan

## Status: Lay-Away (not started)

Go runner has been removed from ts-stack CI. Code preserved at
`conformance/runner/go/` — do not delete until migration is complete.

## Background

Vectors are the canonical truth and live in ts-stack. Each SDK repo should
own its own runner and run conformance on every PR against the shared vector
corpus. The Go runner was previously running in ts-stack CI, which meant:

- Go SDK changes only surfaced conformance failures when ts-stack CI ran
- No feedback loop on go-sdk PRs
- Dead code: `ci.yml` checked out `bsv-blockchain/go-sdk` for a `replace`
  directive that never existed in `go.mod`

## Target Architecture

```
ts-stack                    go-sdk
├── conformance/            ├── conformance/
│   ├── vectors/  ──────▶  │   └── runner/
│   ├── schema/             │       └── main.go  (moved here)
│   └── runner/             └── .github/workflows/
│       └── ts/                 └── conformance.yml
│           └── runner.test.ts      (fetches vectors from ts-stack)
└── .github/workflows/
    └── conformance.yml
        (TS runner only, vectors artifact published on main)
```

## Steps to Complete

### 1. Move Go runner to go-sdk

Copy `conformance/runner/go/` into `bsv-blockchain/go-sdk` repo at an
agreed path (e.g. `conformance/runner/`). Delete from ts-stack once CI
is green on go-sdk.

### 2. Vector consumption in go-sdk CI

Two options:

**Option A — Download artifact (preferred while vectors are actively changing)**

Use `dawidd6/action-download-artifact@v9` to pull the `conformance-vectors`
artifact published by ts-stack's conformance workflow on every main push.
Vectors are retained for 90 days.

```yaml
- uses: dawidd6/action-download-artifact@v9
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    workflow: conformance.yml
    repo: bsv-blockchain/ts-stack
    branch: main
    name: conformance-vectors
    path: conformance/vectors
```

**Option B — Sparse checkout**

```yaml
- uses: actions/checkout@v4
  with:
    repository: bsv-blockchain/ts-stack
    sparse-checkout: conformance/vectors
    sparse-checkout-cone-mode: false
    path: ts-stack-vectors
```

Then pass `--vectors ts-stack-vectors/conformance/vectors` to the runner.

Option B is simpler with no third-party action dependency. Option A
decouples from main-branch churn if vectors are being actively edited.

### 3. go-sdk conformance workflow

Create `.github/workflows/conformance.yml` in go-sdk that:
- Runs on push to main and PRs to main
- Checks out go-sdk
- Fetches vectors (Option A or B above)
- Builds and runs the Go runner
- Uploads report artifact

### 4. Cleanup in ts-stack

Once go-sdk CI is green:
- Delete `conformance/runner/go/`
- Remove this file
- The `conformance-vectors` artifact publish step can stay — useful for
  any future SDK migrations

## Go Runner Entry Point

Current location: `conformance/runner/go/main.go` (2943 lines)

Module: `github.com/bsv-blockchain/ts-stack/conformance/runner/go`

Rename module to `github.com/bsv-blockchain/go-sdk/conformance/runner`
after move.

Dependency: `github.com/bsv-blockchain/go-sdk v1.2.23` — update to
`workspace:` or `replace` directive pointing at the local repo once moved.

## Related Issues

Regression vectors tied to go-sdk bugs:
- `go-sdk#306` — merkle path odd node
- `go-sdk#298` — UHRP URL parity
- `go-sdk#310` — BEEF v2 txid panic
- `go-sdk#267`, `go-sdk#286`, `go-sdk#167` — additional regressions
- `go-sdk#211`, `go-sdk#96`, `go-sdk#74`, `go-sdk#261` — queued, not
  yet converted to vectors (see `REGRESSION_QUEUE.md`)
