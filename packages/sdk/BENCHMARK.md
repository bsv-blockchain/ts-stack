# Performance benchmarks — `@bsv/sdk`

The SDK has twelve dependency-free Node benchmark programs under
`benchmarks/`. They exercise atomic BEEF, BigNumber arithmetic and
serialization, elliptic-curve scalar/signature work, hashing, large wallet
payloads, readers/writers, script deletion and serialization, symmetric
encryption, transaction operations, and the end-to-end transaction pipeline.

Build the ESM artifact before running a benchmark:

```bash
pnpm build:ts
node benchmarks/hash-bench.js
node benchmarks/transaction-bench.js
node benchmarks/transaction-pipeline-bench.js
```

Every `*-bench.js` file is independently runnable. Most use
`benchmarks/lib/benchmark-runner.js`, whose sampling can be adjusted with
`BENCH_WARMUP`, `BENCH_SAMPLES`, `BENCH_MIN_SAMPLE_MS`, and
`BENCH_MIN_ITERATIONS`. The large-data programs use fixed scenarios and emit
their own timing summaries.

These programs are diagnostics, not a blocking performance claim. Hardware,
power mode, thermal state, Node/V8 patch level, and background load materially
affect results. The final QA phase tracked by GitHub issue #400 owns stable
hosted hardware, machine-readable baselines, variance policy, historical
artifacts, and any future regression threshold. Until that work is complete,
do not copy a local result into documentation as a universal SDK baseline.

Correctness, public API compatibility, serialization, and consensus behavior
remain blocking regardless of benchmark movement. A performance
“optimization” must pass the complete cryptographic, transaction, script,
packed-consumer, browser, and conformance gates before it can be accepted.
