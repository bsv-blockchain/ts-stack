import fc from 'fast-check'
import { previewDestinationFixture, previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { captureBrc38KnexDestinationFence, withBrc38KnexDestinationFence } from './Brc38KnexDestinationFence'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})

jest.setTimeout(180000)
test('actual SQLite exact 64-bit revisions retain distinct stale fences beyond Number precision', async () => {
  const target = await previewDestinationFixture(),
    active = new Set<Promise<void>>()
  let failed = false,
    failure: unknown
  const selected = {
    identityKey: '02' + '11'.repeat(32),
    chain: 'test' as const,
    targetStorageIdentityKey: 'synthetic target',
    mode: 'merge' as const
  }
  const check = async (revision: bigint): Promise<void> => {
    await target
      .k('snapshot_journal_clock')
      .update({ revision: target.k.raw('CAST(? AS INTEGER)', [revision.toString()]) })
    const captured = await captureBrc38KnexDestinationFence(target.storage, selected, previewReceiptPolicy)
    expect(captured.revision).toBe(revision.toString())
    await expect(
      withBrc38KnexDestinationFence(target.storage, captured, previewReceiptPolicy, async () => 'unchanged')
    ).resolves.toBe('unchanged')
    await target
      .writer('snapshot_journal_clock')
      .update({ revision: target.writer.raw('CAST(? AS INTEGER)', [(revision + 1n).toString()]) })
    const write = jest.fn(async () => 'never')
    await expect(withBrc38KnexDestinationFence(target.storage, captured, previewReceiptPolicy, write)).rejects.toThrow(
      'changed after'
    )
    expect(write).not.toHaveBeenCalled()
    expect(await target.k('users')).toEqual([])
  }
  try {
    await fc.assert(
      fc.asyncProperty(fc.bigInt({ min: 9007199254740993n, max: 9223372036854775805n }), async revision => {
        const owned = check(revision)
        active.add(owned)
        try {
          await owned
        } finally {
          active.delete(owned)
        }
      }),
      {
        numRuns: Math.max(300, Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? 300)),
        seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026),
        path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? '',
        interruptAfterTimeLimit: 150000,
        markInterruptAsFailure: true
      }
    )
  } catch (cause) {
    failed = true
    failure = cause
  }
  const results = await Promise.allSettled(active)
  results.push(...(await Promise.allSettled([target.close()])))
  const causes = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
  if (causes.length !== 0)
    throw new AggregateError(
      [...(failed ? [failure] : []), ...causes],
      'Exact destination property and physical drain failed'
    )
  if (failed) throw failure
})
