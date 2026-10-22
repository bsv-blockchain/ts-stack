import { promiseFromSync } from '../../src/utility/promiseFromSync'
import type {
  StorageClient,
  RemoteSnapshotJournalArchive,
  SnapshotJournalArchivePosition,
  SnapshotJournalArchiveCapabilities
} from '@bsv/wallet-toolbox'

/** Declaration consumer: the artifact remains distinct from a live SQL actor. */
export async function inspectJournal(
  client: StorageClient,
  identityKey: string,
  position?: SnapshotJournalArchivePosition
): Promise<number | undefined> {
  const capabilities: SnapshotJournalArchiveCapabilities | undefined = (await client.makeAvailable())
    .snapshotJournalArchive
  if (capabilities === undefined) return undefined
  const archive: RemoteSnapshotJournalArchive | undefined = await client.openSnapshotJournalArchive(
    identityKey,
    position
  )
  if (archive === undefined) return undefined
  try {
    return archive.frameCount
  } finally {
    await archive.close()
  }
}

import { runSnapshotJournalArchiveReconciliation } from '@bsv/wallet-toolbox'
import type { SnapshotJournalDataDestination } from '@bsv/wallet-toolbox'

export function copyJournal(archive: RemoteSnapshotJournalArchive, destination: SnapshotJournalDataDestination) {
  return runSnapshotJournalArchiveReconciliation(archive, () => promiseFromSync(() => destination))
}

import type { SnapshotJournalDataContentReceipt, SyncSessionResult } from '@bsv/wallet-toolbox'

/** A confirmed no-change result names its previous real journal ACK. */
export function previousJournalCopy(result: SyncSessionResult): SnapshotJournalDataContentReceipt | undefined {
  return result.noChangeJournalReceipt
}

import type { SnapshotJournalPrimaryContentProvider } from '@bsv/wallet-toolbox'
/** The optional local comparison contract grants no remote primary operation. */
export type LocalPrimaryComparison = Pick<
  SnapshotJournalPrimaryContentProvider,
  'confirmSnapshotJournalPrimaryContentReceipt'
>

import type {
  RemoteSnapshotJournalFieldArchive,
  RemoteSnapshotJournalFieldFrame,
  SnapshotJournalFieldArchiveCapabilities
} from '@bsv/wallet-toolbox'

/** Read-only bounded DATA consumption. Metadata and observed byte counts are
 * not a destination checkpoint, SQL source fence or financial ACK. */
export async function inspectJournalFields(client: StorageClient, identityKey: string) {
  const capabilities: SnapshotJournalFieldArchiveCapabilities | undefined = (await client.makeAvailable())
    .snapshotJournalFieldArchive
  if (capabilities === undefined || !(await client.supportsSnapshotJournalFieldArchive())) return undefined
  const archive: RemoteSnapshotJournalFieldArchive | undefined =
    await client.openSnapshotJournalFieldArchive(identityKey)
  if (archive === undefined) return undefined
  let identities = 0,
    bytesObserved = 0
  try {
    for (let ordinal = 0; ordinal < archive.frameCount; ordinal++) {
      const frame: RemoteSnapshotJournalFieldFrame = await archive.readFrame(ordinal, (_digest, _index, values) => {
          identities += values.size
        }),
        page = frame.page
      for (let index = 0; index < page.changes.length; index++) {
        const change = page.changes[index]
        if (!change.present) continue
        for (const [field, descriptor] of Object.entries(change.fields)) {
          const bytes = await archive.readFieldExtent(frame, index, field, 0, Math.min(65536, descriptor.bytes))
          bytesObserved += bytes.length
          bytes.fill(0)
        }
      }
    }
    return { identities, bytesObserved }
  } finally {
    await archive.close()
  }
}

import type {
  WalletStorageManager,
  SnapshotJournalFieldReadOptions,
  SnapshotJournalStoredFieldReader
} from '@bsv/wallet-toolbox'

/** Original operational provenance remains distinct from financial sync state.
 * All buffers are streamed and erased; a changed window rejects continuation. */
export async function inspectCopiedJournalProvenance(manager: WalletStorageManager, sourceStorageIdentity: string) {
  let options: SnapshotJournalFieldReadOptions = {},
    bytesObserved = 0
  for (;;) {
    const result = await manager.readJournalFieldProvenance(sourceStorageIdentity, options)
    for (const row of result.page.rows)
      for (const field of Object.keys(row.fields)) {
        const reader: SnapshotJournalStoredFieldReader = await manager.openJournalProvenanceField(
          sourceStorageIdentity,
          row.incomingId,
          field,
          { checkpoint: result.checkpoint }
        )
        try {
          for (let offset = 0; offset < reader.descriptor.bytes; offset += 16384) {
            const part = await reader.read(offset, Math.min(16384, reader.descriptor.bytes - offset))
            bytesObserved += part.length
            part.fill(0)
          }
        } finally {
          reader.close()
        }
      }
    if (result.page.complete) return bytesObserved
    if (result.page.after === undefined) throw new Error('Provenance keyset did not advance')
    options = { checkpoint: result.checkpoint, after: result.page.after }
  }
}
