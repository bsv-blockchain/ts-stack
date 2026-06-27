# Storage + Arcade E2E Load Tests

End-to-end test suite for measuring wallet-storage-server throughput and validating Arcade SSE proof delivery. Tests run against real BSV mainnet and require a pre-funded key.

## Test Suites

| Suite | Tests | What it measures |
|-------|-------|-----------------|
| 1 · Read TPS | 1a–1e | Raw HTTP throughput, BRC-100 listOutputs, babbage baseline |
| 2 · Write TPS | 2a–2c | createAction sequential, single-user parallel (noSend + Arcade), multi-user parallel |
| 3 · SSE throughput | 3a–3c | Sequential delivery, concurrent Arcade ingestion, ceiling escalation |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STORAGE_E2E_ROOT_KEY` | **yes** | — | Funded mainnet private key hex (root/funding wallet) |
| `STORAGE_E2E_ARCADE_TOKEN` | **yes** for SSE | — | Arcade callbackToken for SSE routing |
| `STORAGE_E2E_TARGET_URL` | no | `https://storage.fletchindustries.com` | Storage server under test |
| `STORAGE_E2E_ARCADE_URL` | no | `https://arcade-v2-us-1.bsvblockchain.tech` | Arcade broadcaster base URL |
| `STORAGE_E2E_BABBAGE_URL` | no | `https://storage.babbage.systems` | Funded wallet storage backend (holds UTXOs) |
| `STORAGE_E2E_USER_COUNT` | no | `5` | Parallel wallet count for multi-user tests |
| `STORAGE_E2E_TX_COUNT` | no | `10` | Transactions per write/SSE test |
| `STORAGE_E2E_OUTPUT_SATS` | no | `300` | Satoshis per test output |

## Pre-Funding

The `ROOT_KEY` wallet (on `BABBAGE_URL`) must have enough confirmed UTXOs to fund all test transactions. Rough estimate:

```
sats_needed ≈ TX_COUNT × USER_COUNT × (OUTPUT_SATS + 200)  # 200 sats fee buffer per tx
```

For the defaults (10 txs × 5 users × 500 sats) that's ~25,000 sats minimum. Fund generously — unconfirmed UTXOs can be used with `acceptDelayedBroadcast: true`, which the suite enables automatically.

**Important**: The key is passed in plaintext via env var. Rotate it after testing. Never commit it to the repo.

## Running

### All suites

```bash
export STORAGE_E2E_ROOT_KEY=<your_funded_key_hex>
export STORAGE_E2E_ARCADE_TOKEN=<your_arcade_callback_token>

cd packages/wallet/wallet-toolbox
node_modules/.bin/jest --runTestsByPath \
  src/services/__tests/StorageE2E.man.test.ts \
  --verbose --testTimeout=900000
```

### Single suite (by name pattern)

```bash
# Read TPS only
node_modules/.bin/jest --runTestsByPath src/services/__tests/StorageE2E.man.test.ts \
  -t "1 · Read TPS" --verbose

# Write TPS only
node_modules/.bin/jest --runTestsByPath src/services/__tests/StorageE2E.man.test.ts \
  -t "2 · Write TPS" --verbose

# SSE throughput only (requires ARCADE_TOKEN)
node_modules/.bin/jest --runTestsByPath src/services/__tests/StorageE2E.man.test.ts \
  -t "3 · SSE throughput" --verbose
```

### Against a local server

```bash
export STORAGE_E2E_TARGET_URL=http://localhost:3000
export STORAGE_E2E_BABBAGE_URL=http://localhost:3000  # if self-funded
```

## Docker (local wallet-storage-server)

> **TODO**: Docker Compose for running a local wallet-storage-server instance is a planned addition. Contributions welcome — see `e2e/storage/docker-compose.yml` (not yet present).

The intent is:
1. `docker compose up` spins up wallet-storage-server + Postgres
2. Tests point `STORAGE_E2E_TARGET_URL` at `http://localhost:3000`
3. A seed script pre-funds the local wallet so no mainnet funds are needed for read/write TPS tests (SSE tests will still require Arcade + mainnet)

## Key Design Notes

- **noSend + Arcade pattern**: Suite 2b and all of Suite 3 use `createAction({ noSend: true, acceptDelayedBroadcast: true })` to obtain an AtomicBEEF, then call `arcade.postBeef(beef, [txid])` directly. This bypasses the storage server's own broadcaster (TAAL/WoC) and routes through Arcade, which is what triggers the SSE callback to `TARGET_URL/arc-ingest`.
- **Multi-user key derivation**: `deriveUserKey(rootHex, i)` uses BIP-32 child derivation (`m/0/i`) to produce deterministic per-user keys from the root key. Each user gets an independent wallet identity.
- **acceptDelayedBroadcast**: Set to `true` throughout so tests can run even when all UTXOs are unconfirmed (common after consecutive test runs).
- **SSE ceiling test (3c)**: Doubles batch size (5→10→20→40…) until ≥20% of txs fail to receive a merkle proof within the polling window. The last passing batch size is the measured throughput ceiling.

## Observed Baselines (2026-06-27, storage.fletchindustries.com)

| Metric | Value |
|--------|-------|
| Raw HTTP sequential | ~66–75 req/s |
| Raw HTTP parallel (30 concurrent) | ~65–66 req/s |
| BRC-100 listOutputs | ~6.1 req/s |
| Sequential write TPS | ~0.60–0.68 tx/s |
| Arcade broadcast latency (10 txs) | avg 138ms, p95 318ms |
| Arcade broadcast throughput | 7.2 tx/s |
| SSE delivery (10 txs, block confirm) | 10/10 proofs, ~6 min to mine |
