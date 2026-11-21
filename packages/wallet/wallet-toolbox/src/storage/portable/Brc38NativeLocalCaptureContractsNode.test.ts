import { nativeTestExecutable } from './Brc38NativeTestPath'
import {
  composedFixtureChain,
  composedNativeFixture,
  withComposedNativeFixture,
  type Brc38ComposedNativeBeforeObserver
} from './Brc38ComposedNativeFixture'
import {
  verifyBrc38NativeLocalCaptureInstallation,
  verifyBrc38NativeLocalCaptureLiveReceiptRefusal
} from './Brc38NativeLocalCaptureNode.case'
import { previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import { readSnapshotJournalSqliteGeneration } from '../snapshot/journal/SnapshotJournalSqliteGeneration'
import type { Brc38NativeLocalCapturePolicy } from './Brc38NativeLocalCaptureNode'
import type { Brc38DestinationSelection } from './Brc38KnexDestinationFence'

// Admit the existing 180-second fixture owner plus 30 seconds of cleanup.
const nativeFixtureCaseTimeoutMs = 180000 + 30000

function selected(fixture: Brc38ComposedNativeBeforeObserver): {
  selection: Brc38DestinationSelection
  policy: Brc38NativeLocalCapturePolicy
} {
  fixture.check()
  return {
    selection: {
      identityKey: fixture.identityKey,
      chain: composedFixtureChain(fixture.storage),
      targetStorageIdentityKey: fixture.manager.getActiveStore(),
      mode: 'merge'
    },
    policy: {
      maximumRows: fixture.maximumRows,
      ceiling: snapshotJournalRevision('1000000'),
      maximumPageRows: 32,
      expiresAt: fixture.expiresAt,
      workingAllocation: fixture.workingAllocation
    }
  }
}

// UNRUN. Hooks run on the actual published WAL owner before the default all47
// observer. Both the admitted installation and refusal retain original actors,
// receipt policy, allocation and finite lifetime; metadata supplies no actor.
test('native local capture installs through the real source migration and resumes its bounded bootstrap', async () => {
  let observed = false
  await withComposedNativeFixture(
    async fixture => {
      expect(observed).toBe(true)
      expect(fixture.manager.getActive()).toBe(fixture.storage)
      expect(fixture.merge.workingAllocation.used).toBe(0)
    },
    nativeTestExecutable(),
    undefined,
    180000,
    undefined,
    undefined,
    async fixture => {
      const { selection, policy } = selected(fixture)
      await verifyBrc38NativeLocalCaptureInstallation(
        fixture.storage,
        selection,
        previewReceiptPolicy,
        policy,
        fixture.check
      )
      observed = true
    }
  )
}, nativeFixtureCaseTimeoutMs)

test('a real unexpired capture receipt prevents local observer migration without changing its source', async () => {
  const complete = new Error('Independent refusal assertions completed before fixture observer installation')
  let observed = false,
    returned: Awaited<ReturnType<typeof composedNativeFixture>> | undefined,
    failed = false,
    failure: unknown
  try {
    returned = await composedNativeFixture(
      nativeTestExecutable(),
      undefined,
      180000,
      undefined,
      undefined,
      async fixture => {
        const { selection, policy } = selected(fixture),
          generation = await readSnapshotJournalSqliteGeneration(fixture.storage.knex, previewReceiptPolicy),
          source = await fixture.storage.openSnapshotJournalSource(
            fixture.identityKey,
            { ceiling: generation.ceiling, receiptPolicy: previewReceiptPolicy },
            { lifetimeMs: Math.min(30000, fixture.expiresAt - Date.now()) }
          )
        let sourceFailed = false,
          sourceFailure: unknown
        try {
          fixture.check()
          expect(source.receipt.expiresAt).toBeGreaterThan(Date.now())
          await source.verifyLive()
          await verifyBrc38NativeLocalCaptureLiveReceiptRefusal(
            fixture.storage,
            selection,
            previewReceiptPolicy,
            policy,
            fixture.check
          )
          await source.verifyLive()
          observed = true
        } catch (cause) {
          sourceFailed = true
          sourceFailure = cause
        }
        try {
          await source.close()
        } catch (cause) {
          throw new AggregateError(
            sourceFailed ? [sourceFailure, cause] : [cause],
            'Native capture refusal retains its actual source cleanup'
          )
        }
        if (sourceFailed) throw sourceFailure
        // Physical source close does not expire the real durable receipt. End
        // this diagnostic fixture before the happy-path observer would run.
        throw complete
      }
    )
  } catch (cause) {
    failed = true
    failure = cause
  }
  if (returned !== undefined) {
    try {
      await returned.close()
    } catch (cause) {
      throw new AggregateError(
        failed ? [failure, cause] : [cause],
        'Unexpected native refusal fixture retains its original cleanup'
      )
    }
  }
  if (!observed && failed) throw failure
  expect(observed).toBe(true)
  expect(failed).toBe(true)
  expect(failure).toBe(complete)
}, nativeFixtureCaseTimeoutMs)
