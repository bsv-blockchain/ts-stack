# Production Storage + Arcade + Monitor E2E

This manual mainnet suite validates the complete production path:

1. authenticated BRC-100 reads and writes go to the target Storage server;
2. Arcade is the first broadcaster and receives the shared callback token;
3. no-send concurrency tests are reconciled through Storage with `sendWith`;
4. the production Monitor receives Arcade SSE status events and acquires proofs;
5. every tracked action must reach `completed` in Storage and have a merkle path in Arcade.

The suite provisions deterministic child identities with BRC-29 wallet payments, so the multi-user write test uses genuinely independent, funded Storage users. It does not rely on an external funding script.

## Safety gate

The suite is skipped unless `STORAGE_E2E_ALLOW_MAINNET=true`. It requires a funded test key and spends real sats. Use a bounded, dedicated test identity where possible; never commit or print its private key or the Arcade token.

## Run

```bash
export STORAGE_E2E_ALLOW_MAINNET=true
export STORAGE_E2E_ROOT_KEY=<funded-mainnet-private-key-hex>
export STORAGE_E2E_ARCADE_TOKEN=<token-shared-with-production-monitor>
export STORAGE_E2E_TARGET_URL=https://storage.babbage.systems
export STORAGE_E2E_USER_COUNT=3
export STORAGE_E2E_TX_COUNT=3
export STORAGE_E2E_CEILING_BATCHES=2,4,8
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
| `STORAGE_E2E_TX_COUNT` | `3` | Transactions in each fixed-size write case. |
| `STORAGE_E2E_OUTPUT_SATS` | `100` | Sats in each explicit test output. |
| `STORAGE_E2E_USER_FUNDING_SATS` | `2000` | BRC-29 funding per derived identity. |
| `STORAGE_E2E_CEILING_BATCHES` | `2,4,8` | Bounded concurrent Arcade batches. |
| `STORAGE_E2E_PROOF_TIMEOUT_MS` | `2700000` | Maximum wait for mining and Monitor reconciliation. |
| `STORAGE_E2E_PROOF_POLL_MS` | `30000` | Arcade and Storage polling interval. |
| `STORAGE_E2E_EVIDENCE_FILE` | unset | Optional mode-0600 JSON evidence artifact. |

## What counts as passing

HTTP timing alone is not enough. A run passes only if every transaction created by setup and the write/SSE cases:

- is accepted through the Arcade-first service path;
- later reports `MINED` or `IMMUTABLE` with a non-empty Arcade merkle path; and
- is returned by the originating wallet's authenticated `listActions` call with status `completed`.

That final condition is the externally observable proof that Monitor updated production Storage. Operators may additionally correlate the emitted txids against Monitor logs and the `proven_tx_reqs`/`proven_txs` rows for deployment-level evidence.
