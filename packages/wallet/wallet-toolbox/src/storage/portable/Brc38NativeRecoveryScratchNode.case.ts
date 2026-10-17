import { expect } from '@jest/globals'
import createKnex from 'knex'
import { join } from 'node:path'
import type { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38ProfileInventoryNode } from './Brc38ProfileInventoryNode'
import { Brc38NativeRecoveryScratchNode, type Brc38NativeRecoveryScratchPolicy } from './Brc38NativeRecoveryScratchNode'
import { readBrc38ComposedDatabaseImage, type Brc38ComposedDatabaseImage } from './Brc38ComposedDatabaseImageNode'

/** UNRUN positive case for the genuine all47 pending fixture. The independent
 * expected image must be derived by that fixture's original semantic oracle,
 * not by calling this recovery copy or reading its persisted receipt. */
export async function brc38PendingNativeRecoveryScratchCase(
  root: Brc38ProfileInventoryNode,
  importId: string,
  bindingSha256: string,
  executable: string,
  retired: Brc38NativeLocalBaselineSource,
  policy: Brc38NativeRecoveryScratchPolicy,
  maximumReadBytes: number,
  expected: Readonly<Brc38ComposedDatabaseImage>
): Promise<void> {
  let escaped: Brc38NativeRecoveryScratchNode | undefined
  const beforeTemporary = policy.temporaryQuota.used,
    beforeWorking = policy.workingAllocation.used
  await root.withPendingComposedRecoveryCopy(importId, bindingSha256, executable, retired, policy, async scratch => {
    escaped = scratch
    scratch.assertRetained()
    await scratch.assertPhysical()
    expect(policy.temporaryQuota.used).toBe(beforeTemporary + policy.maximumPhysicalBytes)
    expect(scratch.copy.bytes).toBe(scratch.copy.pages * 4096)
    const reader = createKnex({
      client: 'better-sqlite3',
      connection: { filename: join(scratch.directory, 'stage.sqlite'), options: { readonly: true } },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    try {
      await reader.raw('PRAGMA query_only=ON')
      await reader.transaction(async read => {
        expect(
          await readBrc38ComposedDatabaseImage(
            read,
            {
              maximumPhysicalBytes: policy.maximumPhysicalBytes,
              maximumReadBytes,
              expiresAt: policy.expiresAt,
              workingAllocation: policy.workingAllocation,
              signal: policy.signal
            },
            () => scratch.assertRetained()
          )
        ).toEqual(expected)
        await expect(read('settings').update({ storageName: 'cannot mutate copied recovery view' })).rejects.toThrow()
      })
    } finally {
      await reader.destroy()
    }
    await scratch.assertPhysical()
  })
  expect(policy.temporaryQuota.used).toBe(beforeTemporary)
  expect(policy.workingAllocation.used).toBe(beforeWorking)
  if (escaped === undefined) throw new Error('Actual pending scratch consumer did not run')
  expect(() => escaped!.assertRetained()).toThrow('unavailable')
  await expect(
    root.withPendingComposedRecoveryCopy(
      importId,
      bindingSha256,
      executable,
      Object.freeze({ ...retired }) as Brc38NativeLocalBaselineSource,
      policy,
      async () => undefined
    )
  ).rejects.toThrow()
  await expect(
    Brc38ProfileInventoryNode.prototype.withPendingComposedRecoveryCopy.call(
      Object.freeze({ ...root }) as Brc38ProfileInventoryNode,
      importId,
      bindingSha256,
      executable,
      retired,
      policy,
      async () => undefined
    )
  ).rejects.toThrow('Actual pending recovery target inventory')
}
