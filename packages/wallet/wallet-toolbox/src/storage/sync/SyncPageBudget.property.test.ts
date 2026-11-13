import fc from 'fast-check'
import { SyncPageBudget } from './SyncPageBudget'
import type { RequestSyncChunkArgs, SyncChunk } from '../../sdk/WalletStorage.interfaces'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

test('generated table and payload changes preserve caller limits and charge-aware requests', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 1000 }),
      fc.integer({ min: 4096, max: 1048576 }),
      fc.array(
        fc.record({
          rows: fc.integer({ min: 1, max: 512 }),
          rowBytes: fc.integer({ min: 8, max: 4096 }),
          fixedRead: fc.integer({ min: 0, max: 50000 }),
          fixedCommit: fc.integer({ min: 0, max: 20000 }),
          rowRead: fc.integer({ min: 0, max: 100 }),
          rowCommit: fc.integer({ min: 0, max: 200 }),
          proof: fc.boolean()
        }),
        { minLength: 1, maxLength: 6 }
      ),
      (maxItems, maxRoughSize, phases) => {
        const original = {
          identityKey: 'synthetic',
          fromStorageIdentityKey: 'source',
          toStorageIdentityKey: 'destination',
          maxItems,
          maxRoughSize,
          offsets: [{ name: 'transaction', offset: 27 }]
        } as RequestSyncChunkArgs
        const snapshot = JSON.stringify(original)
        const budget = new SyncPageBudget()
        for (const [index, phase] of phases.entries()) {
          const metadataTable = index % 2 === 0 ? 'transactions' : 'outputs'
          const table = phase.proof ? 'provenTxs' : metadataTable
          const byteRows = Math.floor(maxRoughSize / phase.rowBytes)
          let remaining = phase.rows
          while (remaining > 0) {
            const request = budget.apply(original, table)
            expect(request.maxItems).toBeGreaterThanOrEqual(1)
            expect(request.maxItems).toBeLessThanOrEqual(maxItems)
            expect(request.maxRoughSize).toBe(maxRoughSize)
            expect(request.offsets).toBe(original.offsets)
            const count = Math.min(request.maxItems, byteRows, remaining)
            const page = {
              userIdentityKey: original.identityKey,
              fromStorageIdentityKey: original.fromStorageIdentityKey,
              toStorageIdentityKey: original.toStorageIdentityKey,
              [table]: Array.from({ length: count }, () => ({}))
            } as SyncChunk
            const read = phase.fixedRead + count * phase.rowRead
            const commit = phase.fixedCommit + count * phase.rowCommit
            budget.committed(page, read + commit, read, count * phase.rowBytes)
            const next = budget.apply(original, table)
            expect(next.maxItems).toBeLessThanOrEqual(byteRows)
            if (phase.proof) expect(next.maxItems).toBeLessThanOrEqual(128)
            remaining -= count
          }
        }
        expect(JSON.stringify(original)).toBe(snapshot)
        expect(new SyncPageBudget().apply(original).maxItems).toBe(Math.min(64, maxItems))
      }
    ),
    { interruptAfterTimeLimit: 150000, markInterruptAsFailure: true }
  )
}, 180000)
