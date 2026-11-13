import { createHash } from 'node:crypto'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import {
  withBrc38PrivateDerivedTextVersion,
  type Brc38PrivateDerivedTextVersion
} from './Brc38PrivateDerivedTextVersionNode'
import { compareBrc38PrivateDerivedText } from './Brc38PrivateDerivedTextComparisonNode'
import {
  readBrc38NativePackedTextVersionDescriptor,
  readBrc38NativePackedTextVersionExtent,
  retireBrc38NativePackedTextVersion
} from './Brc38NativePackedTextFieldsNode'
import { nativePreparedFieldsTable } from './Brc38NativePreparedFieldSchemaNode'
import type { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import type { Brc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'
import { Brc38PrivateDerivedTextLifetimes } from './Brc38PrivateDerivedTextLifetimesNode'

function requireCase(condition: boolean): asserts condition {
  if (!condition) throw new Error('Independent private derived TEXT stored-byte/capture oracle differs')
}

/** Authored UNRUN. The complete finite native controller supplies an actual
 * authenticated private receiver and original resources. Fixture strings are
 * independent expected bytes, with different chunk boundaries and one-byte/
 * length changes; equality never uses the producer's result as its oracle.
 * Source/current/row/journal/primary qualification remains the enclosing suite. */
export async function verifyPrivateDerivedTextVersions(
  store: KnexBrc38StagingStore,
  policy: Readonly<{ expiresAt: number; workingAllocation: Brc38WorkingAllocation; signal?: AbortSignal }>,
  makeBudget: () => Brc38ImportDecodedBudget
): Promise<void> {
  const prefix = 'a'.repeat(70000),
    fixtures = [
      JSON.stringify({ x: prefix + 'α', z: '\ud800' }),
      JSON.stringify({ x: prefix + 'β', z: '\ud800' }),
      JSON.stringify({ x: 'short', z: null })
    ],
    expected = fixtures.map(value => Buffer.from(value)),
    descriptors = expected.map(bytes =>
      Object.freeze({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    )
  let escaped: Readonly<Brc38PrivateDerivedTextVersion> | undefined
  await Brc38PrivateDerivedTextLifetimes.with(store, policy, async lifetimes => {
    try {
      await withBrc38PrivateDerivedTextVersion(
        store,
        { ...policy, maximumBytes: 100000, maximumVersions: 4 },
        makeBudget(),
        async version => {
          escaped = version
          for (const [index, bytes] of expected.entries()) {
            const descriptor = { ...descriptors[index] },
              beginning = version.begin(descriptor)
            descriptor.bytes = 2
            descriptor.sha256 = '0'.repeat(64)
            await beginning
            const width = [1021, 16384, 64][index]
            for (let offset = 0; offset < bytes.length; offset += width) {
              const input = Uint8Array.from(bytes.subarray(offset, Math.min(bytes.length, offset + width))),
                pending = version.append(offset, input)
              input.fill(0)
              await pending
            }
            const actual = await version.finish()
            requireCase(actual.bytes === descriptors[index].bytes && actual.sha256 === descriptors[index].sha256)
          }
          // Reuse the already sealed first content with another replay partition.
          await version.begin(descriptors[0])
          for (let offset = 0; offset < expected[0].length; offset += 65536)
            await version.append(offset, expected[0].subarray(offset, Math.min(expected[0].length, offset + 65536)))
          requireCase((await version.finish()).sha256 === descriptors[0].sha256)
        },
        undefined,
        lifetimes
      )
      requireCase(escaped !== undefined)
      let refused = false
      try {
        await escaped.begin(descriptors[0])
      } catch {
        refused = true
      }
      requireCase(refused)
      await store.withPrivateNativeDatabase(
        true,
        async database =>
          await database.transaction(async trx => {
            store.assertPrivateNativeReadTransaction(trx)
            for (const [index, descriptor] of descriptors.entries()) {
              const actual = await readBrc38NativePackedTextVersionDescriptor(trx, descriptor.sha256)
              requireCase(actual.bytes === expected[index].length && actual.sha256 === descriptor.sha256)
              for (let offset = 0; offset < actual.bytes; offset += 997) {
                const length = Math.min(997, actual.bytes - offset),
                  bytes = await readBrc38NativePackedTextVersionExtent(
                    trx,
                    { sha256: descriptor.sha256, totalBytes: actual.bytes, offset, length },
                    policy.signal
                  )
                try {
                  requireCase(
                    bytes.length === length &&
                      Buffer.from(bytes).equals(expected[index].subarray(offset, offset + length))
                  )
                } finally {
                  bytes.fill(0)
                }
              }
            }
          })
      )
      requireCase(await compareBrc38PrivateDerivedText(store, descriptors[0], descriptors[0], policy, makeBudget()))
      requireCase(!(await compareBrc38PrivateDerivedText(store, descriptors[0], descriptors[1], policy, makeBudget())))
      requireCase(!(await compareBrc38PrivateDerivedText(store, descriptors[0], descriptors[2], policy, makeBudget())))
      let mismatchedDescriptorRefused = false
      try {
        await compareBrc38PrivateDerivedText(
          store,
          { ...descriptors[0], bytes: descriptors[0].bytes - 1 },
          descriptors[1],
          policy,
          makeBudget()
        )
      } catch {
        mismatchedDescriptorRefused = true
      }
      requireCase(mismatchedDescriptorRefused)
      // Selected DATA is captured before the queued writer starts. Retaining one
      // version protects its actual content; only this owner's obsolete holds
      // disappear. These fixtures require an otherwise isolated private store.
      const selected = [{ family: 'text' as const, sha256: descriptors[0].sha256 }],
        release = lifetimes.releaseExcept(selected)
      selected[0].sha256 = descriptors[1].sha256
      await release
      await store.withPrivateNativeDatabase(
        false,
        async database =>
          await database.transaction(async trx => {
            store.assertPrivateNativeWriteTransaction(trx)
            const holds = await trx(nativePreparedFieldsTable)
              .where({ family: 'text' })
              .whereIn(
                'sha256',
                descriptors.map(value => value.sha256)
              )
              .select('sha256')
              .orderBy('sha256')
              .limit(4)
            requireCase(holds.length === 1 && holds[0].sha256 === descriptors[0].sha256)
            const protectedVersion = await retireBrc38NativePackedTextVersion(
              trx,
              descriptors[0].sha256,
              1,
              policy.signal
            )
            requireCase(protectedVersion.chunks === 0 && !protectedVersion.complete)
          })
      )
      await lifetimes.releaseExcept([])
      await lifetimes.releaseExcept([])
      await store.withPrivateNativeDatabase(
        false,
        async database =>
          await database.transaction(async trx => {
            store.assertPrivateNativeWriteTransaction(trx)
            requireCase(
              (
                await trx(nativePreparedFieldsTable)
                  .where({ family: 'text' })
                  .whereIn(
                    'sha256',
                    descriptors.map(value => value.sha256)
                  )
                  .select('id')
                  .limit(1)
              ).length === 0
            )
            for (const descriptor of descriptors) {
              let complete = false
              for (let page = 0; page < 128 && !complete; page++)
                complete = (await retireBrc38NativePackedTextVersion(trx, descriptor.sha256, 1, policy.signal)).complete
              requireCase(complete)
            }
          })
      )
    } finally {
      for (const bytes of expected) bytes.fill(0)
    }
  })
}
