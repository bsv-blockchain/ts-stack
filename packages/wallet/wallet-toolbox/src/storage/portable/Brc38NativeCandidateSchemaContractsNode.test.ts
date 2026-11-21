import { nativeTestExecutable } from './Brc38NativeTestPath'
import { previewPrivateFixture } from './Brc38ImportPreviewFixture'
import { verifyBrc38PrivateNativeCandidateSchemaOrder } from './Brc38PrivateNativeCandidateSchemaNode.case'
import { restoreProofFixture } from '../../../test/utils/Brc38ImportEntityRestoreFixture'

async function exerciseNativeSchema(local: boolean, maximumPhysicalBytes: number): Promise<void> {
  const fixture = await previewPrivateFixture(undefined, undefined, 65536, maximumPhysicalBytes)
  let failed = false,
    failure: unknown
  try {
    await fixture.value.reservation.store.close()
    const reservation = await fixture.root.resumeNative(
      fixture.value.reservation.id,
      fixture.selected.limits,
      fixture.selected.binding,
      nativeTestExecutable()
    )
    fixture.held.push(reservation)
    const check = (): void => {
      if (Date.now() >= fixture.selected.limits.expiresAt)
        throw new Error('Candidate schema contract exceeded its original lifetime')
    }
    await verifyBrc38PrivateNativeCandidateSchemaOrder(
      reservation.store,
      {
        receiptPolicy: { receiptLimit: 7, receiptLifetimeMs: 123456 },
        maximumStepRows: 16,
        maximumStepBytes: 65536,
        maximumMappedIds: 1000,
        maximumJournalLogicalBytes: 516096,
        services: restoreProofFixture().services
      },
      local,
      check
    )
  } catch (cause) {
    failed = true
    failure = cause
  }
  try {
    await fixture.close()
  } catch (cause) {
    throw new AggregateError(
      failed ? [failure, cause] : [cause],
      'Candidate schema contract retains original cleanup owners'
    )
  }
  if (failed) throw failure
}

test.each([false, true])(
  'actual private candidate seals after its selected layouts, local=%s',
  async local => await exerciseNativeSchema(local, 5242880),
  30000
)

async function expectNativePhysicalQuotaRefusal(local: boolean): Promise<void> {
  let refused = false
  try {
    await exerciseNativeSchema(local, 4194304)
  } catch (cause) {
    let current: unknown = cause
    for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth++) {
      if (Object.getOwnPropertyDescriptor(current, 'nativeCode')?.value === 13) {
        refused = true
        break
      }
      current = Object.getOwnPropertyDescriptor(current, 'cause')?.value
    }
    if (!refused) throw cause
  }
  expect(refused).toBe(true)
}

test('actual local candidate retains its original native physical quota refusal at 4 MiB', async () => {
  await expectNativePhysicalQuotaRefusal(true)
}, 30000)

test('actual ordinary candidate retains its native physical quota refusal at 4 MiB', async () => {
  await expectNativePhysicalQuotaRefusal(false)
}, 30000)
