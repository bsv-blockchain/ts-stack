# Production Storage + Arcade + Monitor E2E

This manual mainnet suite validates the complete production path:

1. authenticated BRC-100 reads and writes go to the target Storage server;
2. Arcade is the first broadcaster and receives the shared callback token;
3. no-send concurrency tests are reconciled through Storage with `sendWith`;
4. the production Monitor receives Arcade SSE status events and acquires proofs;
5. every tracked action must reach `completed` in Storage and have a merkle path in Arcade.

The suite provisions deterministic child identities with enough independent BRC-29 wallet-payment UTXOs for the configured load. When it creates a funding fan-out, it waits for that transaction to mine and complete in Storage before measuring writes. This prevents parent-propagation latency from being mislabeled as a throughput limit and does not rely on an external funding script.

Before it creates any new transaction, the suite also verifies that every Storage-reported spendable default-basket output belongs to a `completed` action and remains an actual network UTXO. It stops instead of spending when Storage and the network disagree. Use a dedicated, clean root key and a fresh `STORAGE_E2E_USER_OFFSET` for comparison runs.

## Safety gate

The suite is skipped unless `STORAGE_E2E_ALLOW_MAINNET=true`. It requires a funded test key and spends real sats. Use a bounded, dedicated test identity where possible; never commit or print its private key or the Arcade token.

## Run

```bash
export STORAGE_E2E_ALLOW_MAINNET=true
export STORAGE_E2E_ROOT_KEY=<funded-mainnet-private-key-hex>
export STORAGE_E2E_ARCADE_TOKEN=<token-shared-with-production-monitor>
export STORAGE_E2E_TARGET_URL=https://storage.babbage.systems
export STORAGE_E2E_USER_COUNT=3
export STORAGE_E2E_USER_OFFSET=0
export STORAGE_E2E_USER_FUNDING_SATS=400
export STORAGE_E2E_TX_COUNT=3
export STORAGE_E2E_CEILING_BATCHES=2,4,8
export STORAGE_E2E_LOAD_REPEATS=1
export STORAGE_E2E_MULTI_USER_ROUNDS=1
export STORAGE_E2E_EVIDENCE_FILE=/tmp/storage-e2e-evidence.json

cd packages/wallet/wallet-toolbox
pnpm exec jest --runTestsByPath \
  src/services/__tests/StorageE2E.man.test.ts \
  --runInBand --verbose
```

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `STORAGE_E2E_TARGET_URL` | `https://storage.babbage.systems` | The only Storage backend used by authenticated cases. |
| `STORAGE_E2E_ARCADE_URL` | mainnet Arcade | Arcade broadcaster and proof API. |
| `STORAGE_E2E_USER_COUNT` | `3` | Independent derived identities. |
| `STORAGE_E2E_USER_OFFSET` | `0` | Offset added to deterministic child derivation indexes; use a new offset to isolate a load run from prior wallet state. |
| `STORAGE_E2E_TX_COUNT` | `3` | Transactions in each fixed-size write case. |
| `STORAGE_E2E_OUTPUT_SATS` | `100` | Sats in each explicit test output. |
| `STORAGE_E2E_USER_FUNDING_SATS` | `400` | Sats in each independent BRC-29 funding UTXO. |
| `STORAGE_E2E_MULTI_USER_ROUNDS` | `1` | Full `createAction` rounds run concurrently across the derived identities. |
| `STORAGE_E2E_CEILING_BATCHES` | `2,4,8` | Transaction counts for single-identity and sharded phase load. |
| `STORAGE_E2E_LOAD_REPEATS` | `1` | Repetitions per phase-load batch size; use at least 3 for comparison runs. |
| `STORAGE_E2E_PROOF_TIMEOUT_MS` | `2700000` | Maximum wait for mining and Monitor reconciliation. |
| `STORAGE_E2E_PROOF_POLL_MS` | `30000` | Arcade and Storage polling interval. |
| `STORAGE_E2E_EVIDENCE_FILE` | unset | Optional mode-0600 JSON evidence artifact. |

## What counts as passing

HTTP timing alone is not enough. A run passes only if every transaction created by setup and the write/SSE cases:

- is accepted through the Arcade-first service path;
- later reports `MINED` or `IMMUTABLE` with a non-empty Arcade merkle path; and
- is returned by the originating wallet's authenticated `listActions` call with status `completed`.

That final condition is the externally observable proof that Monitor updated production Storage. Operators may additionally correlate the emitted txids against Monitor logs and the `proven_tx_reqs`/`proven_txs` rows for deployment-level evidence.

## Throughput methodology

The suite reports several rates because there is no honest single “Storage TPS” number for this path:

| Metric | Timed boundary | What it isolates |
|---|---|---|
| Raw HTTPS req/s | unauthenticated `GET /` | ingress, TLS, and the Node HTTP server; not Storage work |
| Authenticated read req/s | concurrent BRC-100 `listOutputs` | mutual-auth signing/verification plus Storage lookup/query work |
| Full wallet write tx/s | `createAction` start through its response | client wallet work, two authenticated Storage phases, database work, and broadcaster latency |
| Preparation tx/s | no-send `createAction` calls | wallet construction/signing and Storage persistence without network broadcast |
| Arcade submission tx/s | one merged `postBeef` call through all per-tx Arcade HTTP responses | EF construction plus the broadcaster round trips; `Arcade.postBeef` caps independent concurrency at 4 and preserves parent-before-child order |
| Storage reconciliation tx/s | concurrent per-identity `sendWith` RPCs | Storage batch lookup/verification, database state changes, and Storage's own broadcaster calls |
| Submission-through-Storage tx/s | Arcade submission plus Storage reconciliation | externally submitted transactions accepted back into the Storage lifecycle |
| Client end-to-end tx/s | preparation plus submission plus reconciliation | the rate one harness process achieved for the complete pre-proof path |

Each load size runs once by default to limit mainnet cost. For a comparison with less small-sample noise, use at least three repeats and preserve the JSON artifact:

```bash
export STORAGE_E2E_USER_COUNT=8
export STORAGE_E2E_USER_OFFSET=100
export STORAGE_E2E_MULTI_USER_ROUNDS=3
export STORAGE_E2E_CEILING_BATCHES=4,8,16
export STORAGE_E2E_LOAD_REPEATS=3
```

Increase only one dimension at a time, record client location and deployed image/version, and compare both single-identity and sharded results. A plateau in both modes points toward a shared service dependency. A sharded improvement with a flat single-identity rate points toward per-wallet state, authentication session, or per-user database serialization. Do not treat proof convergence as transaction-submission TPS: block cadence and Monitor polling dominate that elapsed time.

## Known bottleneck boundaries

- `Arcade.postBeef` must turn a merged BEEF into one EF request per txid. This branch uses a dependency-aware, bounded four-request worker pool: independent transactions can overlap, while chained transactions remain parent-before-child. The prior serial loop made even independent `sendWith` work pay one external round trip after another; naïvely parallelizing a chain causes Arcade to accept first and later reject children.
- A full `createAction` is intentionally more expensive than an Arcade submission. It performs wallet coin selection/signing, authenticated Storage create/process RPCs, transactional database updates, BEEF verification, and broadcaster work.
- Throughput batches intentionally use independent, mined UTXOs. Passing `noSendChange` creates a dependency chain; a child can reach Arcade before its parent has propagated even when HTTP requests are sent in order, so chained submission is a propagation-latency test rather than an independent-TPS test.
- One identity has wallet and UTXO state that cannot be mutated arbitrarily in parallel. The single-identity load uses one dedicated derived wallet; the sharded case uses the remaining identities so their unsettled outputs do not contaminate each other.
- Authentication and database work are absent from raw HTTP measurements. Compare raw, authenticated, and no-send phases before attributing a plateau to ingress or Arcade.
- An Arcade `REJECTED` SSE event is not necessarily terminal. Production has emitted `REJECTED` and later `SEEN_MULTIPLE_NODES` for the same txid. Releasing that transaction's inputs on the first event creates false double-spend pressure and invalidates later TPS samples; the Monitor must retain the reservation until proof/rebroadcast processing reaches an authoritative result.
- Storage's default output query includes unproven outputs. The harness preflight therefore correlates output parents with completed actions and asks the configured UTXO service to confirm each outpoint before funding or load; a raw wallet balance alone is not a safe load-test prerequisite.
- Deployment topology and database pool size can become ceilings outside this repository. Capture the replica count, process model, CPU/memory use, and connection-pool configuration alongside production load results before tuning them.
