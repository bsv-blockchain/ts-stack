import { randomUUID } from 'node:crypto'
import { withBrc38NativeCandidateContractFixture } from './Brc38NativeCandidateContractFixture'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { inspectBrc38PrivateProofInventory } from './Brc38PrivateProofInventoryNode'

// Genuine source/read actors and shared allocation; missing merge history must
// still refuse. This is a scratch scheduling/refusal contract, not a completed
// proof inventory or an expired-recovery qualification.
test('proof inspection drains page scratch before claiming its own frame', async () => {
  await withBrc38NativeCandidateContractFixture(async fixture => {
    const binding = fixture.store.binding!,
      working = fixture.options.workingAllocation,
      admission: Brc38ImportJournalAdmission = {
        scope: {
          importId: randomUUID(),
          bindingSha256: binding.digest,
          archiveSha256: binding.binding.archiveSha256,
          userId: fixture.source.manager.getActiveUser().userId
        },
        previewId: randomUUID(),
        originalLimitsJson: binding.limitsJson,
        expiresAt: fixture.store.limits.expiresAt,
        initialDestinationSha256: '0'.repeat(64),
        totalRows: 1,
        maximumStepRows: 1,
        maximumStepBytes: fixture.options.maximumStepBytes,
        maximumMappedIds: fixture.options.maximumMappedIds,
        maximumJournalLogicalBytes: fixture.options.maximumJournalLogicalBytes
      }
    await fixture.withSource(async source => {
      await fixture.withRead(async read => {
        const before = working.used,
          // Concurrent owners leave room for one complete original 2 MiB
          // scratch frame and the existing journal's bounded framing.
          retained = working.claim(working.maximum - before - 2097152 - 131072),
          held = working.used
        try {
          await expect(
            inspectBrc38PrivateProofInventory(fixture.store, source, read, {
              admission,
              maximumRows: fixture.options.maximumLocalRows,
              maximumReadBytes: fixture.options.maximumReadBytes,
              workingAllocation: working
            })
          ).rejects.toThrow('Private merge page history differs')
          expect(working.used).toBe(held)
          const cancelled = new AbortController(),
            stopped = new Error('proof page inspection cancelled')
          cancelled.abort(stopped)
          await expect(
            inspectBrc38PrivateProofInventory(fixture.store, source, read, {
              admission,
              maximumRows: fixture.options.maximumLocalRows,
              maximumReadBytes: fixture.options.maximumReadBytes,
              workingAllocation: working,
              signal: cancelled.signal
            })
          ).rejects.toBe(stopped)
          expect(working.used).toBe(held)
        } finally {
          retained.close()
        }
        expect(working.used).toBe(before)
      })
    })
    fixture.check()
  })
}, 210000)
