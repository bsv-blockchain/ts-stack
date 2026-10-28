import { sha256 } from '@bsv/sdk/primitives/Hash'
import { toHex } from '@bsv/sdk/primitives/utils'
import type { TableSettings, TableUser } from '../schema/tables'
import { createSnapshotSyncClockContentRevision } from './SnapshotSyncContentRevision'

/** DATA derivation only. Its caller owns and freshly validates the actual
 * IndexedDB connection/schema/profile and either retained lease or writer.
 * The existing MVCC counter observes all normal wallet writes, including
 * tombstones and writes through another conforming connection. This global
 * counter can conservatively decline reuse after another profile changes. */
export function packedIdbSnapshotContentRevision(input: {
  epoch: string
  revision: number
  userRevision: number
  databaseName: string
  databaseVersion: number
  sourceStorage: TableSettings
  user: TableUser
}) {
  if (
    !/^[0-9a-f]{32}$/.test(input.epoch) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    !Number.isSafeInteger(input.userRevision) ||
    input.userRevision < 1 ||
    input.userRevision > input.revision ||
    typeof input.databaseName !== 'string' ||
    input.databaseName.length < 1 ||
    input.databaseName.length > 4096 ||
    !Number.isSafeInteger(input.databaseVersion) ||
    input.databaseVersion < 1
  )
    throw new TypeError('Invalid actual packed IndexedDB content coordinates')
  const binding = toHex(
    sha256(
      new TextEncoder().encode(
        'packed-idb-snapshot-content-binding-v1\n' +
          JSON.stringify([
            input.epoch,
            input.databaseName,
            input.databaseVersion,
            input.sourceStorage.storageIdentityKey,
            input.user.userId,
            input.user.identityKey,
            input.sourceStorage.chain
          ])
      )
    )
  )
  return createSnapshotSyncClockContentRevision({
    binding,
    highWater: String(input.revision),
    sourceStorage: input.sourceStorage,
    user: input.user,
    primaryEpoch: String(input.userRevision)
  })
}
