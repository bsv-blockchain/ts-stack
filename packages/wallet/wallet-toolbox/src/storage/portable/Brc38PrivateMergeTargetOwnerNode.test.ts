import type { Knex } from 'knex'
import { randomUUID } from 'node:crypto'
import { withBrc38NativePrivateContractFixture } from './Brc38NativePrivateContractFixture'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { nextBrc38PrivateMergeTargetAlias } from './Brc38PrivateMergeTargetsNode'

test('merge alias inspection refuses foreign, writer and escaped actual native transactions', async () => {
  await withBrc38NativePrivateContractFixture(async first => {
    const binding = first.store.binding!,
      admission: Brc38ImportJournalAdmission = {
        scope: {
          importId: randomUUID(),
          bindingSha256: binding.digest,
          archiveSha256: binding.binding.archiveSha256,
          userId: 7
        },
        previewId: randomUUID(),
        originalLimitsJson: binding.limitsJson,
        expiresAt: first.store.limits.expiresAt,
        initialDestinationSha256: '0'.repeat(64),
        totalRows: 1,
        maximumStepRows: 16,
        maximumStepBytes: first.store.limits.maximumRowAllocationBytes,
        maximumMappedIds: 1000,
        maximumJournalLogicalBytes: 516096
      }
    // Admission-shaped DATA cannot grant access before actor/schema admission.
    let escaped: Knex.Transaction | undefined
    await withBrc38NativePrivateContractFixture(async second => {
      await first.withRead(async read => {
        escaped = read
        // Both owners and this read transaction are genuine and current. A
        // different store cannot adopt the first owner's physical read lease.
        await expect(
          nextBrc38PrivateMergeTargetAlias(second.store, read, admission, 'provenTxs', 7, 0)
        ).rejects.toThrow('actual current wallet writer')
        // This fixture has no completed merge-target graph. Correct actor
        // identity must still refuse that missing graph rather than invent data.
        await expect(nextBrc38PrivateMergeTargetAlias(first.store, read, admission, 'provenTxs', 7, 0)).rejects.toThrow(
          'Private merge target lookup differs'
        )
      })
    })
    await first.withWriter(async writer => {
      await expect(nextBrc38PrivateMergeTargetAlias(first.store, writer, admission, 'provenTxs', 7, 0)).rejects.toThrow(
        'Private native read transaction requires its actual source owner'
      )
    })
    await expect(
      nextBrc38PrivateMergeTargetAlias(first.store, escaped!, admission, 'provenTxs', 7, 0)
    ).rejects.toThrow()
    first.check()
  }, 'after-journal')
}, 30000)
