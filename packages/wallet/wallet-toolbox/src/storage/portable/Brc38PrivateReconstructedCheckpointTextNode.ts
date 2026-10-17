import { createHash } from 'node:crypto'
import type { StorageKnex } from '../StorageKnex'
import { createSyncMap } from '../schema/entities/EntityBase'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import {
  withBrc38PrivateReconstructedCheckpointDatabaseDelta,
  type Brc38PrivateCurrentStructuredPolicy
} from './Brc38PrivateCurrentStructuredSourceNode'
import type { Brc38CheckpointSyncMapDeltas } from './Brc38CheckpointSyncMap'
import {
  withBrc38PrivateDerivedTextVersion,
  type Brc38PrivateDerivedTextDescriptor
} from './Brc38PrivateDerivedTextVersionNode'
import type { Brc38PrivateDerivedTextLifetimes } from './Brc38PrivateDerivedTextLifetimesNode'
import type { Brc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'
import { brc38WorkingAllocation } from './Brc38WorkingAllocation'

type Current = Readonly<{ localRowId: number }> | Readonly<{ version: Readonly<Brc38PrivateDerivedTextDescriptor> }>
function invalid(): never {
  throw new Error('Independent operational checkpoint reconstruction differs from its complete measured/replayed bytes')
}
/** Two actual original/SEALED source passes: complete measurement followed by
 * complete replay into bounded stored content. No current candidate payload is
 * an expected source; hashes are checked again by the final full-byte reader. */
export async function prepareBrc38PrivateReconstructedCheckpointText(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  source: Brc38NativeLocalBaselineSource,
  current: Current,
  selected: Brc38PrivateCurrentStructuredPolicy,
  delta: Brc38CheckpointSyncMapDeltas,
  budget: Brc38ImportDecodedBudget,
  lifetimes: Brc38PrivateDerivedTextLifetimes
): Promise<Readonly<{ output: Readonly<Brc38PrivateDerivedTextDescriptor>; maximumUpdatedAt?: string }>> {
  const policy = Object.freeze({ ...selected }),
    working = brc38WorkingAllocation(policy.workingAllocation)
  if (working === undefined) invalid()
  return await store.withPrivateNativeDatabase(
    true,
    async database =>
      await withBrc38PrivateDerivedTextVersion(
        store,
        {
          expiresAt: policy.expiresAt,
          maximumBytes: policy.maximumCanonicalBytes,
          maximumVersions: 1,
          workingAllocation: working,
          signal: policy.signal
        },
        budget,
        async version => {
          const measured = await withBrc38PrivateReconstructedCheckpointDatabaseDelta(
            store,
            storage,
            database,
            source,
            current,
            policy,
            delta,
            async chunks => {
              const hash = createHash('sha256'),
                decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
              let bytes = 0
              for await (const chunk of chunks) {
                try {
                  policy.signal?.throwIfAborted()
                  if (
                    !(chunk instanceof Uint8Array) ||
                    chunk.length < 1 ||
                    chunk.length > Math.min(65536, policy.maximumReadBytes ?? 65536) ||
                    chunk.length > policy.maximumCanonicalBytes - bytes
                  )
                    invalid()
                  decoder.decode(chunk, { stream: true })
                  hash.update(chunk)
                  bytes += chunk.length
                } finally {
                  if (chunk instanceof Uint8Array) chunk.fill(0)
                }
              }
              decoder.decode()
              return Object.freeze({ bytes, sha256: hash.digest('hex') })
            }
          )
          await version.begin(measured.value)
          const replayed = await withBrc38PrivateReconstructedCheckpointDatabaseDelta(
            store,
            storage,
            database,
            source,
            current,
            policy,
            delta,
            async chunks => {
              let offset = 0
              for await (const chunk of chunks) {
                try {
                  await version.append(offset, chunk)
                  offset += chunk.length
                } finally {
                  if (chunk instanceof Uint8Array) chunk.fill(0)
                }
              }
              if (offset !== measured.value.bytes) invalid()
            }
          )
          if (
            replayed.maximumUpdatedAt !== measured.maximumUpdatedAt ||
            replayed.prior.bytes !== measured.prior.bytes ||
            replayed.prior.sha256 !== measured.prior.sha256
          )
            invalid()
          return Object.freeze({
            output: await version.finish(),
            ...(measured.maximumUpdatedAt === undefined ? {} : { maximumUpdatedAt: measured.maximumUpdatedAt })
          })
        },
        database,
        lifetimes
      )
  )
}
/** The new-checkpoint policy has a genuine bounded initial map. It is created
 * independently of the stored checkpoint and held through final comparison. */
export async function prepareBrc38PrivateInitialCheckpointText(
  store: KnexBrc38StagingStore,
  policy: Brc38PrivateCurrentStructuredPolicy,
  budget: Brc38ImportDecodedBudget,
  lifetimes: Brc38PrivateDerivedTextLifetimes
): Promise<Readonly<Brc38PrivateDerivedTextDescriptor>> {
  const working = brc38WorkingAllocation(policy.workingAllocation)
  if (working === undefined) invalid()
  const charge = working.claim(131072)
  let bytes: Buffer | undefined
  try {
    bytes = Buffer.from(JSON.stringify(createSyncMap()))
    if (bytes.length < 2 || bytes.length > 4096 || bytes.length > policy.maximumCanonicalBytes) invalid()
    const data = bytes,
      descriptor = Object.freeze({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    return await withBrc38PrivateDerivedTextVersion(
      store,
      {
        expiresAt: policy.expiresAt,
        maximumBytes: policy.maximumCanonicalBytes,
        maximumVersions: 1,
        workingAllocation: working,
        signal: policy.signal
      },
      budget,
      async version => {
        await version.begin(descriptor)
        await version.append(0, data)
        return await version.finish()
      },
      undefined,
      lifetimes
    )
  } finally {
    bytes?.fill(0)
    charge.close()
  }
}
