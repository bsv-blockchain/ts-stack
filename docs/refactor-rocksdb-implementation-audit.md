# refactor_rocksdb.md Implementation Audit

Date: 2026-05-16

Source objective: implement `/mnt/c/Users/nedzo/Documents/nektar-run/docs/refactor_rocksdb.md` for `wallet-toolbox-rocksdb`.

Scope correction applied after engineering review: this package remains a wallet library. Redis, BullMQ, and NATS JetStream are not runtime dependencies here. Distributed queueing, lane fanout, proof queues, and NATS-backed coordination belong in Nektar/endurance/runtime infrastructure.

## Summary

The single-instance wallet-toolbox-owned work is implemented: in-memory UTXO/header caching, event-based invalidation, fresh provider checks before cache-informed storage mutations, parallel provider broadcasting with retry-priority backpressure and queue metrics, pooled HTTP clients with owner-aware lifecycle cleanup, active broadcast drain-on-close for both broadcast modes, RocksDB prefix indexes, schema columns, faster monitor scheduling with task resource teardown, service/cache event-listener teardown, wallet-level lifecycle cleanup, Prometheus metrics, architecture dependency checks, and focused tests.

The NATS JetStream deliverables from the source document are intentionally not implemented in this repo. They remain Nektar-owned; see `docs/nektar-runtime-handoff.md` for the runtime boundary and stream handoff.

## Completion Decision

Against the literal source objective, this goal is not complete: the source document requires a NATS JetStream cluster, NATS streams, consumers, TLS auth, NATS persistence tests, NATS latency metrics, and NATS-backed task coordination. Those are deliberately excluded from wallet-toolbox-rocksdb because this package must remain a wallet library, not an application runtime.

Against the accepted single-instance wallet-toolbox scope, the implementation is present and verified. The exact departures are intentional: provider connection pooling lives in the shared undici-backed HTTP adapter instead of inside `BroadcastOrchestrator`; monitor parallelism uses bounded async task loops instead of worker threads because monitor/storage/service objects are not worker-transferable runtime state; RocksDB write-buffer and level tuning are binding-limited by `@harperfast/rocksdb-js`.

## Prompt-To-Artifact Checklist

| Source requirement | Current artifact/evidence | Status |
| --- | --- | --- |
| Deploy 3-node NATS JetStream cluster | No NATS dependency. Enforced by `.dependency-cruiser.js` and `test/security/DependencyPolicy.test.ts`. | Nektar-owned, intentionally excluded |
| Configure `TX_BROADCAST`, `UTXO_STATUS`, `BLOCK_EVENTS`, `PROOF_REQUESTS` streams | No stream config in wallet-toolbox; ownership and adapter shape documented in `docs/nektar-runtime-handoff.md`. | Nektar-owned, intentionally excluded |
| Consumer groups, ack policies, TLS auth | No NATS consumers in wallet-toolbox. | Nektar-owned, intentionally excluded |
| Add runtime dependencies | `package.json` includes `lru-cache`, `node-cache`, `p-limit`, `p-queue`, `undici`, `prom-client`, and `eventemitter3`; `test/security/DependencyPolicy.test.ts` verifies `bullmq`, `ioredis`, `redis`, and `nats` are absent. `p-limit` and `p-queue` use CommonJS-compatible majors because the requested v5/v8 packages are ESM-only while this package builds CommonJS output. | Implemented for single instance |
| Add dependency-cruiser dev dependencies | `package.json` includes `dependency-cruiser`. The requested `@types/dependency-cruiser` package is not installed because npm returns 404 for it, and `dependency-cruiser@16.10.4` already publishes `types/dependency-cruiser.d.mts`. | Implemented with available package |
| Dependency-cruiser architecture validation | `.dependency-cruiser.js` defines single-instance layer rules, `package.json` exposes `depcheck`, `depcheck:graph`, `depcheck:html`, and `depcheck:ci`, and `.github/workflows/push.yaml` runs `depcheck:ci` with a JSON summary in CI. | Implemented |
| `src/cache/UtxoCacheManager.ts` with 10K entries and 30s TTL | `src/cache/UtxoCacheManager.ts`, defaults wired through `createDefaultWalletServicesOptions`. | Implemented |
| `src/cache/BlockHeaderCache.ts` with 1000 entries and 5 minute TTL | `src/cache/BlockHeaderCache.ts`, defaults wired through `createDefaultWalletServicesOptions`. | Implemented |
| L3 script hash cache | `src/cache/ScriptHashCache.ts`, wired through `Services.hashOutputScript` and `createDefaultWalletServicesOptions` with 10K entries and 5 minute TTL. | Implemented |
| Cache invalidation publisher | Replaced with in-process `src/events/EventBus.ts` and cache listeners. | Implemented for single instance |
| Cache listener lifecycle | Owned `UtxoCacheManager`, `BlockHeaderCache`, and `ScriptHashCache` instances expose `close()`. `Services.close()` tears down owned cache listeners and node-cache timers while preserving caller-injected cache ownership. | Implemented |
| Integrate cache with UTXO status lookups | `src/services/Services.ts` routes `getUtxoStatus` through cache unless fresh lookup is requested. | Implemented |
| Cache must not become spend authority | `confirmSpendableOutputs`, `TaskUnFail`, invalid-change `release`, and stale-input eviction use fresh provider checks before mutating or returning spend-authoritative state; read-only hints may use cache, while `Services.getUtxoStatus(..., useNext=true)` and the spend-authoritative `Services.isUtxo(output, true)` wrapper bypass cached hints. | Implemented |
| Output cache refresh metadata | Fresh provider checks that mutate output spendability stamp `cacheUpdatedAt` in invalid-change release, TaskUnFail reconciliation, and stale-input eviction. | Implemented |
| `src/broadcast/BroadcastOrchestrator.ts` | `src/broadcast/BroadcastOrchestrator.ts`. | Implemented |
| Parallel `Services.postBeef()` | `src/services/Services.ts` default `postBeefMode` is `PromiseAll`; same BEEF/txid set sent to providers, and provider exceptions are classified as service-error results without aborting other providers. `UntilSuccess` mode also records provider exceptions and continues failover. | Implemented |
| Record all provider broadcast attempts | `attemptToPostReqsToNetwork` stores aggregate history counts plus compact `providerAttempts` and `providerCount` fields on the outbox request history. | Implemented |
| Broadcast consumer | No NATS consumer in wallet-toolbox. | Nektar-owned, intentionally excluded |
| `TaskSendWaiting` publishes to NATS | `src/monitor/tasks/TaskSendWaiting.ts` uses bounded in-process queueing and direct storage processing. | Implemented for single instance |
| `TaskSendWaiting` chunk 500, trigger 1s | `src/monitor/tasks/TaskSendWaiting.ts`. | Implemented |
| Broadcast retry priority/backpressure | `TaskSendWaiting` expands distinct batches with bounded parallel reads, then `processUnsent` uses bounded `p-queue` concurrency and prioritizes higher-attempt retry work before lower-attempt work. `BroadcastOrchestrator` also preserves p-queue priority when multiple signed broadcasts are queued behind active work, drains queued broadcasts on `close()`, and rejects new broadcasts after shutdown begins. | Implemented |
| Generic storage bulk read parallelism | `StorageProvider.findOutputsByIds`, `StorageProvider.findOutputsByOutpoints`, `findOrInsertOutputBasketsBulk`, `findOrInsertOutputTagsBulk`, and the classification phase of `getReqsAndBeefToShareWithWorld` use bounded `p-limit` lookup fanout for non-SQL backends; duplicate basket/tag inputs are deduped before fanout, BEEF merge remains sequential, and `StorageKnex` keeps set-based SQL overrides. | Implemented |
| RocksDB prefix-based indexing | `src/storage/rocksdb/RocksDbWalletStore.ts` exposes prefix scans and indexed output lookups; indexed output resolution uses bounded parallel primary-record fetches. | Implemented |
| Secondary output index maintenance | `putOutput`, `deleteOutput`, `rebuildOutputIndexes` maintain script hash, spendable, basket, and outpoint indexes. | Implemented |
| RocksDB `parallelismThreads=12` | `RocksDbWalletStore.defaultParallelismThreads = 12`. | Implemented |
| RocksDB `writeBufferSize=64MB` | Current `@harperfast/rocksdb-js` public `NativeDatabaseOptions` in `node_modules/@harperfast/rocksdb-js/dist/index.d.mts` exposes `disableWAL`, `enableStats`, `noBlockCache`, `parallelismThreads`, read-only/stats/log options, but no write-buffer or level-compaction option. `RocksDbWalletStore` exposes the supported DB options plus supported `RocksDatabase.config` options instead. | Binding-limited |
| Add `script_hash` column to outputs | `src/storage/schema/KnexMigrations.ts`; `TableOutput` metadata support. | Implemented |
| Extend ARC SSE for `BLOCK_MINED` | `src/monitor/tasks/TaskArcSSE.ts` handles block mined events and routes height/hash notices through `Monitor.processBlockMinedNotice`. | Implemented |
| `src/chaintracker/SpvHeaderSync.ts` | `src/chaintracker/SpvHeaderSync.ts`. | Implemented |
| Cache invalidation on block/reorg events | `EventBus`, `UtxoCacheManager`, `BlockHeaderCache`, `SpvHeaderSync`, and `TaskArcSSE`; `SpvHeaderSync` emits reorg events even when a custom reorg handler is registered. Integration coverage proves `Monitor.processNewBlockHeader()` updates the shared `Services.blockHeaderCache` and clears `Services.utxoCache` through the shared event bus. | Implemented |
| Block event publishing to NATS | No NATS in wallet-toolbox. | Nektar-owned, intentionally excluded |
| Parallel monitor task execution | `src/monitor/Monitor.ts` uses per-task async scheduler loops and bounded `p-limit`. | Implemented |
| Worker-based parallelism | Replaced with bounded async task loops to preserve shared monitor/storage/service state without worker serialization. | Implemented by safer local design |
| Faster task configuration | `Monitor` and `TaskSendWaiting` defaults reduced to 1s where applicable; height-only block notices from SSE wake `TaskCheckForProofs`. | Implemented |
| Monitor task resource cleanup | `WalletMonitorTask.asyncDestroy`, `TaskArcadeSSE.asyncDestroy`, and `Monitor.destroy()` close realtime subscriptions and task-owned resources. | Implemented |
| Wallet lifecycle cleanup | `Wallet.destroy()` destroys monitor resources, closes service pools, then destroys storage and privileged key state. | Implemented |
| NATS-based task coordination | No NATS in wallet-toolbox. | Nektar-owned, intentionally excluded |
| Replace native provider fetch with undici Pool | `src/http/UndiciHttpClient.ts`; ARC, Bitails, WhatsOnChain, exchange rates, chaintracks service clients default to it. | Implemented |
| Replace all runtime native `fetch()` calls | `test/security/HttpClientPolicy.test.ts` rejects bare native `fetch()` in runtime TypeScript. Remaining `authClient.fetch(...)` calls are authenticated BSV SDK flows, not native provider HTTP. | Implemented |
| Connection pooling 50 connections, pipelining 10 | `UndiciHttpClient` defaults and `createDefaultWalletServicesOptions`. | Implemented |
| HTTP pool lifecycle | `src/services/Services.ts` exposes `close()` and closes string/default-options clients it owns while preserving caller-injected clients. `close()` waits for active `postBeef` operations and the internal postBeef queue to drain before closing owned resources, and rejects new broadcasts after shutdown starts. | Implemented |
| API/config surface | `WalletServicesOptions` exposes cache sizes/TTLs, shared event bus, metrics, shared pooled HTTP client, postBeef mode, postBeef soft timeouts, and postBeef queue concurrency. `RocksDbWalletStoreOptions` exposes supported RocksDB tuning options. `natsConfig` and unsupported RocksDB `writeBufferSize` are intentionally absent. | Implemented for wallet-owned knobs |
| Service provider HTTP client shape | Providers keep the SDK `HttpClient` abstraction and receive a shared undici-backed adapter instead of depending directly on `Pool`, preserving SDK compatibility while providing pooled provider HTTP. | Implemented by safer local design |
| Prometheus metrics | `src/metrics/WalletToolboxMetrics.ts`, `src/metrics/PrometheusMetrics.ts`. | Implemented |
| Broadcast latency metrics | `WalletToolboxMetrics.recordPostBeefProvider`. | Implemented |
| Broadcast backlog metrics | `WalletToolboxMetrics` exposes provider and SendWaiting queue gauges; `TaskSendWaiting` updates its queue gauges. | Implemented |
| Cache hit metrics | `WalletToolboxMetrics.recordUtxoCacheRequest` and block header equivalents export request counters, entry gauges, and direct hit-rate gauges; `UtxoCacheManager`, `BlockHeaderCache`, and `ScriptHashCache` expose local hit/miss/hit-rate stats. | Implemented |
| Storage query latency metrics | `WalletToolboxMetrics.recordStorageQuery`; `RocksDbWalletStore` wraps get, put, delete, batch, scan, and compact operations with storage query timing. | Implemented |
| NATS latency metrics | No NATS in wallet-toolbox. | Nektar-owned, intentionally excluded |
| Prometheus endpoint | `src/storage/adminServer/adminServer.ts` exposes metrics before admin auth; endpoint tests cover UTXO and block-header counters, entry gauges, and direct hit-rate gauges. | Implemented |
| Alerting rules | `docs/prometheus-alerts.yml` covers low UTXO cache hit rate, low block-header cache hit rate, provider latency, broadcast queue backlog, SendWaiting backlog, and storage query latency. Cache alerts intentionally derive recent-window hit rates from request counters instead of using process-lifetime hit-rate gauges. | Implemented for single instance |
| Rate limiting security consideration | `src/security/RateLimiter.ts`; `StorageServer` can enforce per-identity authenticated request limits through `rateLimit` options. | Implemented for storage remoting |
| `was_broadcast`, `rebroadcast_attempts` columns | `src/storage/schema/KnexMigrations.ts`; proven tx req table support. | Implemented |
| `script_hash`, `cache_updated_at` columns | `src/storage/schema/KnexMigrations.ts`; output table support. | Implemented |
| Migration script | `src/storage/schema/KnexMigrations.ts`. | Implemented |
| Load test to 1000 tx/s | `npm run loadtest:single-instance` passed on 2026-05-16 with 1000 calls, concurrency 100, peak active broadcasts 100, and observed about 51.9k mocked TPS. | Implemented as mocked harness |
| Test cache invalidation | `test/cache/CacheManagers.test.ts`, `test/services/Services.cache.test.ts`, stale-input invalidation tests. | Implemented |
| Test NATS persistence | No NATS in wallet-toolbox. | Nektar-owned, intentionally excluded |
| Test reorg handling | `test/chaintracker/SpvHeaderSync.test.ts`, `test/monitor/Monitor.parallel.test.ts`, cache tests. | Implemented |
| Validate SPV sync accuracy | `test/chaintracker/SpvHeaderSync.test.ts`. | Implemented at unit/integration level |
| Disaster recovery: NATS persistence and snapshots | No NATS in wallet-toolbox. S3 snapshots for NATS streams are Nektar/operator infrastructure. | Nektar-owned, intentionally excluded |
| Disaster recovery: RocksDB snapshots | `RocksDbWalletStore` exposes `flush()`, `compact()`, and `compactOnClose` tuning, but the current `@harperfast/rocksdb-js` binding does not expose a checkpoint/backup API. Filesystem snapshots are operator-owned. | Operator-owned / binding-limited |
| Disaster recovery: cache backup | Caches are in-memory read accelerators and are rebuildable from provider/storage state. | Implemented by design |

## Latest Verification

- Final spot-check on 2026-05-16: `npm run build` passed.
- Final spot-check on 2026-05-16: after adding direct UTXO and block-header cache hit-rate gauges, `npm run build` passed.
- Final spot-check on 2026-05-16: after adding direct cache hit-rate gauges, `npx jest test/metrics/WalletToolboxMetrics.test.ts test/metrics/PrometheusAlerts.test.ts test/cache/CacheManagers.test.ts --runInBand` passed: 8 tests.
- Final spot-check on 2026-05-16: after adding direct cache hit-rate gauges, `npm run depcheck` passed with 0 errors and the same 15 existing circular-dependency warnings.
- Final spot-check on 2026-05-16: after extending `/metrics` endpoint assertions for direct cache hit-rate gauges, `npm run build` and `npx jest test/storage/adminServer/AdminServer.metrics.test.ts test/metrics/WalletToolboxMetrics.test.ts --runInBand` passed: 2 tests.
- Final spot-check on 2026-05-16: after codifying that cache hit-rate alerts use recent-window request counters rather than process-lifetime gauges, `npm run build`, `npm run depcheck`, and `npx jest test/metrics/PrometheusAlerts.test.ts test/metrics/WalletToolboxMetrics.test.ts test/storage/adminServer/AdminServer.metrics.test.ts --runInBand` passed: 3 tests; depcheck reported 0 errors and the same 15 existing circular-dependency warnings.
- Final spot-check on 2026-05-16: after strengthening the single-instance load harness to verify bounded parallelism and queue close, `npm run loadtest:single-instance` passed with 1000 calls, concurrency 100, `maxActive` 100, and about 51.9k mocked TPS.
- Final spot-check on 2026-05-16: after strengthening the load harness, `npx jest test/broadcast/BroadcastOrchestrator.test.ts test/services/Services.postBeefTimeouts.test.ts --runInBand` passed: 11 tests, and `npm run depcheck` passed with 0 errors and the same 15 existing circular-dependency warnings.
- Final spot-check on 2026-05-16: source-document sections for API/config, service-provider HTTP shape, rate limiting, storage query metrics, and disaster recovery were re-audited against current code artifacts.
- Final spot-check on 2026-05-16: `npx jest test/security/RateLimiter.test.ts test/storage/remoting/StorageServer.rateLimit.test.ts --runInBand` passed: 6 tests.
- Final spot-check on 2026-05-16: `npx jest test/metrics/WalletToolboxMetrics.test.ts test/storage/RocksDbWalletStore.test.ts --runInBand` passed: 8 tests.
- Final spot-check on 2026-05-16: after adding service-level coverage that both `getUtxoStatus(..., useNext=true)` and `isUtxo(output, true)` bypass UTXO cache hints, `npx jest test/services/Services.cache.test.ts --runInBand` passed: 7 tests.
- Final spot-check on 2026-05-16: after adding service-level `useNext` cache-bypass coverage, `npm run build` and `npm run depcheck` passed; depcheck reported 0 errors and the same 15 existing circular-dependency warnings.
- Final spot-check on 2026-05-16: after aligning `BlockHeaderCache.getStats()` with UTXO/script-hash cache hit-rate stats, `npm run build` and `npx jest test/cache/CacheManagers.test.ts --runInBand` passed: 6 tests.
- Final spot-check on 2026-05-16: `npx jest test/cache/CacheManagers.test.ts test/metrics/WalletToolboxMetrics.test.ts test/metrics/PrometheusAlerts.test.ts --runInBand` passed: 8 tests.
- Final spot-check on 2026-05-16: after the cache stats change, `npm run depcheck` passed with 0 errors and the same 15 existing circular-dependency warnings.
- Final spot-check on 2026-05-16: after adding `BroadcastOrchestrator.close()`, `npm run build`, `npm run depcheck`, and `npx jest test/broadcast/BroadcastOrchestrator.test.ts test/services/Services.postBeefTimeouts.test.ts --runInBand` passed: 11 tests; depcheck reported 0 errors and 15 existing warnings.
- Final spot-check on 2026-05-16: after adding the block-header cache hit-rate alert, `npm run build` and `npx jest test/metrics/PrometheusAlerts.test.ts test/metrics/WalletToolboxMetrics.test.ts test/cache/CacheManagers.test.ts --runInBand` passed: 8 tests.
- Final spot-check on 2026-05-16: after expanding `/metrics` endpoint assertions for block-header cache metrics, `npm run build` and `npx jest test/storage/adminServer/AdminServer.metrics.test.ts test/metrics/PrometheusAlerts.test.ts test/metrics/WalletToolboxMetrics.test.ts --runInBand` passed: 3 tests.
- Final spot-check on 2026-05-16: after adding block-event-to-cache integration coverage, `npm run build` and `npx jest test/monitor/Monitor.parallel.test.ts test/cache/CacheManagers.test.ts test/chaintracker/SpvHeaderSync.test.ts --runInBand` passed: 15 tests.
- Final spot-check on 2026-05-16: after the block-event-to-cache integration coverage, `npm run depcheck` passed with 0 errors and the same 15 existing circular-dependency warnings.
- Final spot-check on 2026-05-16: `npm run build && node -e ...` verified built package exports for `UtxoCacheManager`, `BlockHeaderCache`, `ScriptHashCache`, `EventBus`, `UndiciHttpClient`, `BroadcastOrchestrator`, `WalletToolboxMetrics`, `PrometheusMetrics`, and `SpvHeaderSync`.
- Final spot-check on 2026-05-16: after `npm run build`, `require('./client/out/src/index.client.js')` and `require('./mobile/out/src/index.mobile.js')` loaded successfully, and `rg` found no `undici`/`UndiciHttpClient` references in generated client/mobile output.
- Final spot-check on 2026-05-16: inspected `@harperfast/rocksdb-js` type declarations and README; the binding exposes `parallelismThreads`, `disableWAL`, `enableStats`, and `noBlockCache`, but not the source document's requested `writeBufferSize`.
- Final spot-check on 2026-05-16: `npm run depcheck` passed with 0 errors and the 15 existing circular-dependency warnings listed below.
- Final spot-check on 2026-05-16: the CI `depcheck:ci` shell block from `.github/workflows/push.yaml` passed locally and printed `{ "errors": 0, "warnings": 15, "totalCruised": 264, "totalDependenciesCruised": 777 }`.
- Final spot-check on 2026-05-16: `npm run depcheck:graph && npm run depcheck:html` passed; generated dependency-cruiser report files are ignored by `.gitignore`.
- Final spot-check on 2026-05-16: `npx jest test/security/DependencyPolicy.test.ts test/security/HttpClientPolicy.test.ts test/services/ProviderHttpClientDefaults.test.ts test/services/UndiciHttpClient.test.ts --runInBand` passed: 8 tests.
- Final spot-check on 2026-05-16: `npx jest test/cache/CacheManagers.test.ts test/services/Services.cache.test.ts test/broadcast/BroadcastOrchestrator.test.ts test/services/Services.postBeefTimeouts.test.ts --runInBand` passed: 21 tests.
- Final spot-check on 2026-05-16: `npx jest test/storage/RocksDbWalletStore.test.ts test/storage/StorageProvider.bulkReads.test.ts test/storage/attemptToPostReqsToNetwork.history.test.ts --runInBand` passed: 12 tests.
- Final spot-check on 2026-05-16: `npx jest src/monitor/tasks/__tests/TaskSendWaiting.test.ts src/monitor/tasks/__tests/TaskSendWaiting.processUnsent.test.ts test/metrics/WalletToolboxMetrics.test.ts test/metrics/PrometheusAlerts.test.ts --runInBand` passed: 12 tests.
- Final spot-check on 2026-05-16: `npx jest test/chaintracker/SpvHeaderSync.test.ts test/monitor/Monitor.parallel.test.ts src/monitor/tasks/__tests/TaskArcSSE.test.ts --runInBand` passed: 32 tests.
- Final spot-check on 2026-05-16: `npx jest test/storage/KnexMigrations.test.ts src/storage/schema/entities/__tests/ProvenTxReqTests.test.ts --runInBand` passed: 20 tests.
- Final spot-check on 2026-05-16: `npm run loadtest:single-instance` passed: 1000 mocked calls, concurrency 100, observed about 35.8k TPS before the load harness was strengthened with peak-active verification.
- Prior verification: `npm run build` passed.
- `npx jest test/storage/RocksDbWalletStore.test.ts --runInBand` passed: 7 tests.
- `npx jest test/services/ProviderHttpClientDefaults.test.ts test/services/UndiciHttpClient.test.ts --runInBand` passed: 6 tests.
- `npx jest test/cache/CacheManagers.test.ts --runInBand` passed: 6 tests.
- `npx jest test/services/Services.cache.test.ts --runInBand` passed: 5 tests.
- `npx jest test/storage/adminServer/AdminServer.metrics.test.ts --runInBand` passed: 1 test.
- `npx jest src/monitor/tasks/__tests/TaskArcSSE.test.ts test/monitor/Monitor.parallel.test.ts --runInBand` passed: 29 tests.
- `npx jest src/monitor/tasks/__tests__/TaskUnFail.test.ts test/storage/ListOutputsSpecOp.test.ts test/services/Services.cache.test.ts --runInBand` passed: 6 tests.
- `npx jest test/storage/ListOutputsSpecOp.test.ts src/monitor/tasks/__tests__/TaskUnFail.test.ts test/storage/markStaleInputsAsSpent.test.ts --runInBand` passed: 13 tests.
- `npx jest test/storage/confirmSpendableOutputs.test.ts test/storage/ListOutputsSpecOp.test.ts src/monitor/tasks/__tests__/TaskUnFail.test.ts test/storage/markStaleInputsAsSpent.test.ts --runInBand` passed: 14 tests.
- `npx jest test/storage/StorageProvider.bulkReads.test.ts --runInBand` passed: 4 tests.
- `npx jest test/storage/StorageProvider.getReqsAndBeef.test.ts --runInBand` passed: 1 test.
- `npx jest test/chaintracker/SpvHeaderSync.test.ts test/monitor/Monitor.parallel.test.ts --runInBand` passed: 7 tests.
- `npx jest src/monitor/tasks/__tests/TaskSendWaiting.test.ts src/monitor/tasks/__tests/TaskSendWaiting.processUnsent.test.ts --runInBand` passed: 10 tests.
- `npx jest test/broadcast/BroadcastOrchestrator.test.ts --runInBand` passed: 2 tests.
- `npx jest src/monitor/tasks/__tests/TaskSendWaiting.processUnsent.test.ts src/monitor/tasks/__tests/TaskSendWaiting.test.ts test/broadcast/BroadcastOrchestrator.test.ts --runInBand` passed: 10 tests.
- `npx jest test/metrics/WalletToolboxMetrics.test.ts test/metrics/PrometheusAlerts.test.ts src/monitor/tasks/__tests/TaskSendWaiting.processUnsent.test.ts --runInBand` passed: 4 tests.
- `npx jest test/Wallet/construct/Wallet.destroy.lifecycle.test.ts test/monitor/Monitor.parallel.test.ts --runInBand` passed: 5 tests.
- `npx jest test/services/ProviderHttpClientDefaults.test.ts test/services/UndiciHttpClient.test.ts test/Wallet/construct/Wallet.destroy.lifecycle.test.ts --runInBand` passed: 7 tests.
- `npx jest test/services/Services.postBeefTimeouts.test.ts --runInBand` passed: 8 tests.
- `npx jest test/storage/attemptToPostReqsToNetwork.history.test.ts test/services/Services.postBeefTimeouts.test.ts --runInBand` passed: 7 tests.
- `npx jest test/storage/markStaleInputsAsSpent.test.ts test/storage/attemptToPostReqsToNetwork.history.test.ts --runInBand` passed: 11 tests.
- `npx jest test/security/DependencyPolicy.test.ts test/security/HttpClientPolicy.test.ts test/storage/KnexMigrations.test.ts --runInBand` passed: 8 tests.
- `npm run depcheck` passed with 0 errors and 15 existing circular-dependency warnings.
- `npm run loadtest:single-instance` passed: 1000 mocked calls, target 1000 TPS, observed about 73k TPS before the current peak-active verification was added.
- `timeout 180s npx jest --runInBand --verbose` produced no suite output before timeout, while `timeout 60s npx jest --listTests` completed and showed `test/Wallet/action/createAction2.test.ts` as the first scheduled suite.
- `timeout 180s npx jest test/Wallet/action/createAction2.test.ts --runInBand --testNamePattern="1_transaction" --verbose` passed: 1 selected test, 6 skipped, in 115.183s.
- `timeout 900s npx jest test/Wallet/action/createAction2.test.ts --runInBand --verbose` passed: 7 tests in 287.954s.
- `timeout 90s npx jest --listTests | sed -n '1,20p'` completed and showed `test/Wallet/list/listActions2.test.ts` as the first scheduled suite in the current ordering.
- `timeout 900s npx jest test/Wallet/list/listActions2.test.ts --runInBand --verbose` passed: 44 tests in 282.522s.

## Residual Gaps

- Full source-document NATS JetStream architecture is not implemented here by design.
- NATS S3 snapshots and NATS disaster-recovery operations are not implemented here by design.
- RocksDB point-in-time backup/snapshot automation is not implemented in this library; the binding exposes flush/compact/transaction snapshots, but not a checkpoint/backup API suitable for safe online backups.
- Public-network 1000 tx/s finality is not proven by the mocked load harness.
- Full `npm test` is still not completion evidence: isolated legacy suites such as `test/Wallet/action/createAction2.test.ts` and `test/Wallet/list/listActions2.test.ts` pass with longer timeouts, but each takes about 5 minutes by itself, so the full legacy suite remains too slow for current-turn completion evidence.
- `npm run lint --if-present` is not clean because of existing legacy lint violations outside this focused change set.
