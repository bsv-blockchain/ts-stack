import { expect } from '@jest/globals'
import type { Brc38ProfileInventoryNode } from './Brc38ProfileInventoryNode'
import type { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import type { Brc38NativeRecoveryScratchPolicy } from './Brc38NativeRecoveryScratchNode'
import {
  Brc39RecoveryAuthenticationNode,
  type Brc39RecoveryAuthenticationOptions
} from './Brc39RecoveryAuthenticationNode'
import { Brc39RecoveryIncomingComparisonNode } from './Brc39RecoveryIncomingComparisonNode'
import { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38PrivateNativeMergeNode, type Brc38PrivateNativeMergeOptions } from './Brc38PrivateNativeMergeNode'
import type { Brc38ComposedProfileReceipt } from './Brc38ComposedProfileReceiptNode'
import type { Brc38ComposedDatabaseImage } from './Brc38ComposedDatabaseImageNode'
import { brc38StagingBinding } from './Brc38StagingBinding'

/** UNRUN genuine all47 fixture case. The expected image must come from the
 * independent original semantic oracle, never a copied READY image/hash.
 * This case inspects expired recovery only; it does not activate the target. */
export async function brc39ExpiredPendingRecoveryComparisonCase(
  root: Brc38ProfileInventoryNode,
  importId: string,
  receipt: Brc38ComposedProfileReceipt,
  retired: Brc38NativeLocalBaselineSource,
  encrypted: AsyncIterable<Uint8Array>,
  password: string,
  authentication: Brc39RecoveryAuthenticationOptions,
  scratchPolicy: Brc38NativeRecoveryScratchPolicy,
  mergeOptions: Brc38PrivateNativeMergeOptions,
  expected: Readonly<Brc38ComposedDatabaseImage>
): Promise<void> {
  const original = JSON.stringify(authentication.original),
    beforeTemporary = scratchPolicy.temporaryQuota.used,
    beforeWorking = scratchPolicy.workingAllocation.used
  let escaped: Brc39RecoveryIncomingComparisonNode | undefined
  await root.withPendingComposedRecoveryCopy(
    importId,
    brc38StagingBinding(authentication.original.binding, authentication.original.limits).digest,
    authentication.executable,
    retired,
    scratchPolicy,
    async scratch => {
      await Brc39RecoveryAuthenticationNode.with(
        encrypted,
        password,
        authentication,
        async fresh =>
          await KnexBrc38StagingStore.withRecoveryComparison(
            scratch,
            fresh,
            authentication.original.limits,
            authentication.executable,
            async candidate => {
              expect(candidate.limits.expiresAt).toBe(authentication.original.limits.expiresAt)
              expect(candidate.operationExpiresAt).toBe(Math.min(scratchPolicy.expiresAt, authentication.expiresAt))
              expect(candidate.recoveryComparisonOnly).toBe(true)
              await Brc39RecoveryIncomingComparisonNode.with(
                fresh,
                candidate,
                {
                  workingAllocation: mergeOptions.workingAllocation,
                  maximumReadBytes: mergeOptions.maximumReadBytes,
                  signal: mergeOptions.signal
                },
                async comparison => {
                  escaped = comparison
                  comparison.assertRetained()
                  await Brc38PrivateNativeMergeNode.with(candidate, retired, mergeOptions, async merge => {
                    await expect(merge.step()).rejects.toThrow('comparison only')
                    await Brc38PrivateNativeMergeNode.inspectRetiredRecoveryImage(
                      merge,
                      receipt,
                      async (image, actualReceipt, policy, assertRetained) => {
                        comparison.assertRetained()
                        assertRetained()
                        expect(image).toEqual(expected)
                        expect(actualReceipt).toEqual(receipt)
                        expect(policy.expiresAt).toBe(candidate.operationExpiresAt)
                        comparison.assertRetained()
                        assertRetained()
                      }
                    )
                  })
                  comparison.assertRetained()
                }
              )
              await expect(
                candidate.withAuthenticatedPrivateStructuredDestination(
                  async () => await candidate.knex('rows').delete()
                )
              ).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
            }
          )
      )
    }
  )
  expect(JSON.stringify(authentication.original)).toBe(original)
  expect(scratchPolicy.temporaryQuota.used).toBe(beforeTemporary)
  expect(scratchPolicy.workingAllocation.used).toBe(beforeWorking)
  expect(() => escaped!.assertRetained()).toThrow()
}
