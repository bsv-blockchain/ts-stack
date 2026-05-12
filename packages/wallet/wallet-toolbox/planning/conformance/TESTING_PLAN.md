# Testing Plan: Transaction Monitor and Status Recovery (TypeScript)

## Goals

1. Verify current TS behavior matches `CURRENT_STATE.md` — including the `reviewStatus` cascade and the double spend bug it causes.
2. Validate proposed changes from `PLANNED_CHANGES.md` — confirm they prevent double spend in adversarial-miner scenarios.
3. Catch regressions in the normal path (broadcast → proof → complete).
4. Provide a deterministic harness that runs without live network connections.

---

## Test Harness Architecture

### Service Mocks

All external service calls go through `WalletServices`. The harness provides a `MockWalletServices` that controls behavior per scenario:

```typescript
// tests/harness/MockWalletServices.ts

interface MerklePathResult {
  merklePath?: MerklePath
  header?: BlockHeader
  notes?: ReqHistoryNote[]
}

export class MockWalletServices implements WalletServices {
  // Per-txid control
  private merklePathResults = new Map<string, MerklePathResult[]>()
  private txStatusResults = new Map<string, string>()
  private utxoResults = new Map<string, boolean>()
  private broadcastResults = new Map<string, PostBeefResult>()

  // Recorded calls for assertions
  getMerklePathCalls: Array<{ txid: string; result: MerklePathResult }> = []
  postBeefCalls: Array<{ txids: string[] }> = []

  /** Return proof on the Nth call for this txid */
  willReturnProofOnCall(txid: string, callNumber: number, proof: MerklePath, header: BlockHeader): this

  /** Never return a proof (tx stays in mempool) */
  willNeverReturnProof(txid: string): this

  /** Reject with double spend on broadcast */
  willRejectWithDoubleSpend(txid: string): this

  /** Reject with invalid tx on broadcast */
  willRejectAsInvalid(txid: string): this

  /** Return service error on broadcast */
  willReturnServiceError(txid: string): this

  /** Report tx as known to network (for confirmDoubleSpend check) */
  willReportAsKnown(txid: string): this
}
```

### Block Simulator

Drives the proof-check cycle deterministically:

```typescript
// tests/harness/BlockSimulator.ts

export class BlockSimulator {
  private currentHeight = 800000
  private monitor: Monitor
  private minedTxIDs = new Set<string>()

  /** Advance chain tip by 1 empty block; triggers TaskNewHeader/TaskCheckForProofs */
  async mineEmptyBlock(): Promise<void>

  /** Mine a block containing these txids; makes proofs available */
  async mineBlockWithTxs(txids: string[]): Promise<void>

  /** Manually trigger TaskReviewStatus */
  async runReviewStatus(): Promise<string>

  /** Manually trigger TaskSendWaiting */
  async runSendWaiting(): Promise<string>

  /** Manually trigger TaskUnFail */
  async runUnFail(): Promise<string>

  /** Manually trigger TaskReviewDoubleSpends */
  async runReviewDoubleSpends(): Promise<string>

  /** Advance time and run all scheduled tasks */
  async advanceTime(ms: number): Promise<void>
}
```

### Scenario Builder

```typescript
// tests/harness/ScenarioBuilder.ts

export class ScenarioBuilder {
  private db: Knex
  private services: MockWalletServices
  private sim: BlockSimulator
  private storage: StorageKnex
  private monitor: Monitor

  static async create(opts?: { unprovenAttemptsLimitTest?: number }): Promise<ScenarioBuilder>

  /** Create a wallet action and broadcast it */
  async broadcastTx(opts?: { willBeDoubleSpent?: boolean }): Promise<string> // returns txid

  /** Create action but don't broadcast (stays 'unsent') */
  async createUnsentTx(): Promise<string>

  get assert(): AssertionBuilder
}
```

### Assertion Builder

```typescript
// tests/harness/AssertionBuilder.ts

export class AssertionBuilder {
  provenTxReqStatus(txid: string, expected: ProvenTxReqStatus): this
  transactionStatus(txid: string, expected: TransactionStatus): this
  attempts(txid: string, expected: number): this
  rebroadcastAttempts(txid: string, expected: number): this
  inputsAreSpendable(txid: string): this
  inputsAreConsumed(txid: string): this
  changeOutputsAreSpendable(txid: string): this
  changeOutputsAreConsumed(txid: string): this
  noDoubleSpend(txid: string): this
  broadcastCallCount(txid: string, expected: number): this
}
```

---

## Test Scenarios

### Scenario 1: Happy Path — Mined in Next Block

**Setup:** Tx broadcast, miner includes it in next block.

**Expected (current + proposed):**
- ProvenTxReq: `unsent` → `unmined` → `completed`
- Transaction: `sending` → `unproven` → `completed`
- Inputs consumed throughout
- Change UTXOs available after proof found

```typescript
it('happy path: tx mined in next block', async () => {
  const sc = await ScenarioBuilder.create()
  const txid = await sc.broadcastTx()

  await sc.sim.mineBlockWithTxs([txid])

  sc.assert
    .provenTxReqStatus(txid, 'completed')
    .transactionStatus(txid, 'completed')
    .inputsAreConsumed(txid)
})
```

---

### Scenario 2: Delayed Mining — Before Attempt Limit

**Setup:** Tx broadcast, 5 empty blocks, then mined.

**Expected (current + proposed):**
- ProvenTxReq stays `unmined` (attempts = 5), then → `completed`
- reviewStatus Step 3 sets Transaction → `completed`
- Inputs stay consumed

```typescript
it('tx delayed: mined before attempt limit', async () => {
  const sc = await ScenarioBuilder.create({ unprovenAttemptsLimitTest: 10 })
  const txid = await sc.broadcastTx()

  for (let i = 0; i < 5; i++) await sc.sim.mineEmptyBlock()

  sc.assert.provenTxReqStatus(txid, 'unmined').attempts(txid, 5)

  await sc.sim.mineBlockWithTxs([txid])
  await sc.sim.runReviewStatus()

  sc.assert
    .provenTxReqStatus(txid, 'completed')
    .transactionStatus(txid, 'completed')
    .inputsAreConsumed(txid)
})
```

---

### Scenario 3: Adversarial Miner — 10+ Empty Blocks, Tx Eventually Mined

**This is the primary regression scenario from the production incident (testnet blocks 1732666–1732683).**

**Current behavior (broken):**
- After 10 empty blocks: ProvenTxReq → `invalid`
- reviewStatus runs → Transaction → `failed` → inputs restored
- Original tx still in mempool
- Wallet creates new tx spending restored inputs → double spend

**Proposed behavior (correct):**
- After 10 empty blocks: ProvenTxReq → `unsent` (rebroadcast), attempts reset
- TaskSendWaiting rebroadcasts tx
- ProvenTxReq → `unmined` again
- GorillaNode mines block → proof found → `completed`
- No double spend

```typescript
describe('adversarial miner: 10+ empty blocks', () => {
  it('LEGACY: currently marks invalid and restores inputs (broken)', async () => {
    // This test documents CURRENT BROKEN behavior.
    // After PLANNED_CHANGES are implemented this test should be updated
    // to use the Scenario 3b expectations below.
    const sc = await ScenarioBuilder.create({ unprovenAttemptsLimitTest: 10 })
    const txid = await sc.broadcastTx()

    for (let i = 0; i < 10; i++) await sc.sim.mineEmptyBlock()

    // Current (wrong) behavior:
    sc.assert.provenTxReqStatus(txid, 'invalid')

    await sc.sim.runReviewStatus()

    // Inputs incorrectly restored:
    sc.assert
      .transactionStatus(txid, 'failed')
      .inputsAreSpendable(txid)  // BUG: should still be consumed
  })

  it('PROPOSED: rebroadcasts instead of invalidating', async () => {
    // This test validates the fix from PLANNED_CHANGES.md
    const sc = await ScenarioBuilder.create({ unprovenAttemptsLimitTest: 10 })
    const txid = await sc.broadcastTx()

    for (let i = 0; i < 10; i++) await sc.sim.mineEmptyBlock()

    // Proposed: req reset to unsent for rebroadcast
    sc.assert.provenTxReqStatus(txid, 'unsent').attempts(txid, 0)

    await sc.sim.runSendWaiting()
    sc.assert.provenTxReqStatus(txid, 'unmined')

    // GorillaNode mines the block
    await sc.sim.mineBlockWithTxs([txid])
    await sc.sim.runReviewStatus()

    sc.assert
      .provenTxReqStatus(txid, 'completed')
      .transactionStatus(txid, 'completed')
      .inputsAreConsumed(txid)
      .noDoubleSpend(txid)
  })

  it('reviewStatus step 2 does not restore inputs for live mempool txs', async () => {
    // Directly tests the fixed reviewStatus.ts Step 2
    const sc = await ScenarioBuilder.create({ unprovenAttemptsLimitTest: 10 })
    const txid = await sc.broadcastTx()

    // Force req to invalid while tx is still in mempool (simulates old behavior)
    await sc.sim.forceProvenTxReqStatus(txid, 'invalid')
    await sc.sim.forceTransactionStatus(txid, 'failed')

    await sc.sim.runReviewStatus()

    // Proposed: inputs NOT restored because live req still exists
    sc.assert.inputsAreConsumed(txid)
  })
})
```

---

### Scenario 4: True Double Spend — Explicit Network Rejection

**Setup:** TX1 broadcast. ARC returns explicit double spend.

**Expected (current + proposed):**
- ProvenTxReq: `sending` → `doubleSpend`
- Transaction: `sending` → `failed` (immediate cascade)
- Inputs restored immediately
- reviewStatus later: no-op (already failed)

```typescript
it('true double spend: explicit network rejection', async () => {
  const sc = await ScenarioBuilder.create()
  const txid = await sc.broadcastTx({ willBeDoubleSpent: true })

  sc.assert
    .provenTxReqStatus(txid, 'doubleSpend')
    .transactionStatus(txid, 'failed')
    .inputsAreSpendable(txid)  // correctly restored on explicit rejection
})
```

---

### Scenario 5: False Positive Double Spend — TaskReviewDoubleSpends Recovery

**Setup:** TX1 marked `doubleSpend` but is actually known to the network.

**Expected:**
- ProvenTxReq: `doubleSpend` → `unfail` (via TaskReviewDoubleSpends)
- TaskUnFail finds proof → `unmined`
- Transaction → `unproven`, eventually `completed`

```typescript
it('false positive double spend: recovered via TaskReviewDoubleSpends', async () => {
  const sc = await ScenarioBuilder.create()
  const txid = await sc.broadcastTx({ willBeDoubleSpent: true })

  // Service now reports tx as known
  sc.services.willReportAsKnown(txid)

  await sc.sim.runReviewDoubleSpends()
  sc.assert.provenTxReqStatus(txid, 'unfail')

  await sc.sim.mineBlockWithTxs([txid])
  await sc.sim.runUnFail()

  sc.assert
    .provenTxReqStatus(txid, 'unmined')
    .transactionStatus(txid, 'unproven')
})
```

---

### Scenario 6: Service Error on Broadcast — Retry via TaskSendWaiting

**Setup:** Broadcast fails with service error. Service recovers. Retry succeeds.

**Expected:**
- ProvenTxReq: `sending` → `sending` (service error, attempts++) → `unmined` (retry)
- Transaction: `sending` → `sending` → `unproven`

```typescript
it('service error: retried via TaskSendWaiting', async () => {
  const sc = await ScenarioBuilder.create()
  const txid = await sc.broadcastTx()

  // First attempt fails
  sc.services.willReturnServiceError(txid)
  await sc.sim.runSendWaiting()
  sc.assert.provenTxReqStatus(txid, 'sending').attempts(txid, 1)

  // Service recovers
  sc.services.willAcceptBroadcast(txid)
  await sc.sim.runSendWaiting()
  sc.assert.provenTxReqStatus(txid, 'unmined')
})
```

---

### Scenario 7: Chain Reorg — Proof Invalidated and Re-queued

**Setup:** TX1 confirmed in block B. Reorg orphans B. TX1 re-enters mempool.

**Expected:**
- ProvenTxReq: `completed` → `reorg` → `unmined` (after requeue)
- Transaction: `completed` → `unproven`
- Eventually re-confirmed in next block

```typescript
it('chain reorg: tx re-queued and re-proven', async () => {
  const sc = await ScenarioBuilder.create()
  const txid = await sc.broadcastTx()

  await sc.sim.mineBlockWithTxs([txid])
  sc.assert.provenTxReqStatus(txid, 'completed')

  await sc.sim.triggerReorg([sc.sim.lastBlockHash])
  sc.assert.provenTxReqStatus(txid, 'reorg')

  await sc.sim.mineBlockWithTxs([txid])
  sc.assert.provenTxReqStatus(txid, 'completed')
})
```

---

### Scenario 8: `reviewStatus` Step 2 Does NOT Restore Inputs for Broadcast Txs

**Directly tests the core fix in `reviewStatus.ts`.**

```typescript
it('reviewStatus: does not restore inputs when live ProvenTxReq exists', async () => {
  const sc = await ScenarioBuilder.create()
  const txid = await sc.broadcastTx()

  // Tx is in 'unmined' state (in mempool)
  sc.assert.provenTxReqStatus(txid, 'unmined').inputsAreConsumed(txid)

  // Manually mark transaction as failed (simulating old/partial state)
  await sc.storage.updateTransaction({ txid, status: 'failed' })

  // Run reviewStatus
  await sc.sim.runReviewStatus()

  // Inputs must NOT be restored — live ProvenTxReq still exists
  sc.assert.inputsAreConsumed(txid)
})
```

---

### Scenario 9: Circuit Breaker — MaxRebroadcastAttempts Limit

**Setup:** `maxRebroadcastAttempts = 2`. Tx is never mined. After 2 rebroadcast cycles, it should be marked `invalid`.

```typescript
it('circuit breaker: invalid after maxRebroadcastAttempts', async () => {
  const sc = await ScenarioBuilder.create({
    unprovenAttemptsLimitTest: 10,
    maxRebroadcastAttempts: 2
  })
  const txid = await sc.broadcastTx()

  // Cycle 1: 10 empty blocks → rebroadcast
  for (let i = 0; i < 10; i++) await sc.sim.mineEmptyBlock()
  await sc.sim.runSendWaiting()
  sc.assert.provenTxReqStatus(txid, 'unmined').rebroadcastAttempts(txid, 1)

  // Cycle 2: 10 more empty blocks → rebroadcast again
  for (let i = 0; i < 10; i++) await sc.sim.mineEmptyBlock()
  await sc.sim.runSendWaiting()
  sc.assert.provenTxReqStatus(txid, 'unmined').rebroadcastAttempts(txid, 2)

  // Cycle 3: 10 more empty blocks → circuit breaker fires → invalid
  for (let i = 0; i < 10; i++) await sc.sim.mineEmptyBlock()

  sc.assert
    .provenTxReqStatus(txid, 'invalid')
    .transactionStatus(txid, 'failed')
    .inputsAreSpendable(txid)  // OK to restore — circuit breaker confirmed tx is stuck
})
```

---

### Scenario 10: `EntityProvenTx.fromReq()` Secondary Threshold — Broadcast Tx Not Invalidated

**Directly tests the fix to `EntityProvenTx.fromReq()` (attempts > 8, age > 60 min).**

```typescript
it('EntityProvenTx.fromReq: does not mark broadcast tx invalid on secondary threshold', async () => {
  const sc = await ScenarioBuilder.create()
  const txid = await sc.broadcastTx()

  // Simulate 9 failed proof attempts + 61+ minutes age
  await sc.sim.simulateAttempts(txid, 9)
  await sc.sim.advanceTime(61 * 60 * 1000)

  // Trigger proof check
  await sc.sim.mineEmptyBlock()

  // Proposed: should NOT be invalid (was broadcast, use rebroadcast path)
  sc.assert.provenTxReqStatus(txid, 'unsent')
})
```

---

### Scenario 11: `reviewStatus` Step 1 Still Works for Never-Broadcast Txs

**Verify that the fix doesn't break the legitimate case: txs that failed before reaching `unmined`.**

```typescript
it('reviewStatus: still marks failed for never-broadcast invalid txs', async () => {
  const sc = await ScenarioBuilder.create()
  const txid = await sc.broadcastTx({ willBeRejectedAsInvalid: true })

  // Broadcast failed: ProvenTxReq 'invalid', Transaction 'failed' (immediate)
  sc.assert.provenTxReqStatus(txid, 'invalid').transactionStatus(txid, 'failed')

  await sc.sim.runReviewStatus()

  // Step 2 should restore inputs (tx was never broadcast)
  sc.assert.inputsAreSpendable(txid)
})
```

---

### Scenario 12: Unsent Tx Abandoned — `TaskFailAbandoned`

**Setup:** Tx created but not broadcast for > 5 minutes.

**Expected:**
- Transaction: `unprocessed` → `failed`
- ProvenTxReq: stays `unsent` (abandoned knownTx handled by separate cron)

```typescript
it('taskFailAbandoned: marks unprocessed txs failed after 5 min', async () => {
  const sc = await ScenarioBuilder.create()
  const txid = await sc.createUnsentTx()

  await sc.sim.advanceTime(6 * 60 * 1000)  // 6 minutes
  // TaskFailAbandoned would run here

  sc.assert.transactionStatus(txid, 'failed')
})
```

---

## Existing Test Infrastructure

Reference for integration style and mocking patterns:

```
src/monitor/tasks/__tests__/  — Unit tests for individual tasks
src/storage/methods/__tests__/ — Tests for storage methods including reviewStatus
```

Look specifically at existing mocks for `WalletServices` and `StorageKnex` to extend rather than replace.

---

## CI Integration

- All scenarios except Scenario 3 `LEGACY` must pass before merge.
- Scenario 3 `LEGACY` test must **FAIL** after PLANNED_CHANGES are implemented — update its assertions at that point to match Scenario 3 `PROPOSED`.
- Run with `--runInBand` for deterministic ordering of timer-based scenarios.
- Target: complete in < 10s on local (no network, mock services, mock Knex with `knex-mock-client` or in-memory SQLite).
- Add snapshot testing for `reviewStatus` SQL queries to prevent accidental SQL regression.
