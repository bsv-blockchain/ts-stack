import { observeWalletSnapshotFieldReader } from './observeWalletSnapshotFieldReader'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import type { StorageIdb } from '../StorageIdb'
import type {
  WalletReadSnapshot,
  WalletReadSnapshotOptions,
  WalletSnapshotCursor,
  WalletSnapshotTable,
  WalletSnapshotPageLimits
} from './WalletReadSnapshot'
import { packedIdbInvalid } from '../idbPackedFields'
import { snapshotSyncTables } from './SnapshotSync'
import { closeSnapshotJournalSource } from './journal/closeSnapshotJournalSource'

const keys: Readonly<Record<string, readonly string[]>> = {
  provenTxs: ['provenTxId'],
  outputBaskets: ['basketId'],
  outputTags: ['outputTagId'],
  txLabels: ['txLabelId'],
  transactions: ['transactionId'],
  outputs: ['outputId'],
  txLabelMaps: ['txLabelId', 'transactionId'],
  outputTagMaps: ['outputTagId', 'outputId'],
  certificates: ['certificateId'],
  certificateFields: ['fieldName', 'certificateId'],
  commissions: ['commissionId'],
  provenTxReqs: ['provenTxReqId']
}

/** Version-one replica-page facade over the actual retained IndexedDB view.
 * The digest and translated cursors are DATA. Every read still goes through
 * the genuine view's current native schema/profile/primary/lease checks.
 * Native examination positions can include unrelated rows; replica cursors
 * instead name the last returned row. Empty native pages are advanced outside
 * destination ownership, with no retained pages or expanded binary arrays. */
export async function openPackedIdbSyncSource(
  storage: StorageIdb,
  identityKey: string,
  selected: WalletReadSnapshotOptions = {}
): Promise<WalletReadSnapshot> {
  const options = Object.freeze({ ...selected }),
    view = await storage.openWalletReadSnapshot(identityKey, options)
  try {
    await view.validateClosure()
    const snapshotId = new SHA256()
      .update(new TextEncoder().encode('packed-idb-sync-source/v1\n' + view.snapshotId))
      .digestHex()
    let reading = false
    const nativeCursor = (
      table: WalletSnapshotTable,
      input?: WalletSnapshotCursor
    ): WalletSnapshotCursor | undefined => {
      if (!(snapshotSyncTables as readonly WalletSnapshotTable[]).includes(table)) packedIdbInvalid()
      if (input === undefined) return undefined
      if (
        input.version !== 1 ||
        input.snapshotId !== snapshotId ||
        input.table !== table ||
        input.archivePosition !== undefined ||
        !Array.isArray(input.after) ||
        input.after.length !== keys[table].length ||
        input.after.some(value =>
          typeof value === 'number'
            ? !Number.isSafeInteger(value) || value < 1
            : typeof value !== 'string' || value.length < 1 || value.length > 4096
        )
      )
        packedIdbInvalid()
      return {
        version: 1,
        snapshotId: view.snapshotId,
        table,
        after: table === 'certificateFields' ? [input.after[1], input.after[0]] : [...input.after]
      }
    }
    const replicaCursor = (table: WalletSnapshotTable, input: WalletSnapshotCursor): WalletSnapshotCursor => {
      if (
        input.version !== 1 ||
        input.snapshotId !== view.snapshotId ||
        input.table !== table ||
        input.archivePosition !== undefined ||
        input.after.length !== keys[table].length
      )
        packedIdbInvalid()
      return {
        version: 1,
        snapshotId,
        table,
        after: table === 'certificateFields' ? [input.after[1], input.after[0]] : [...input.after]
      }
    }
    const limits = (selectedLimits?: WalletSnapshotPageLimits) => {
      const maxRows = selectedLimits?.maxRows ?? 128,
        maxBytes = selectedLimits?.maxBytes ?? 262144
      if (
        !Number.isSafeInteger(maxRows) ||
        maxRows < 1 ||
        maxRows > 1000 ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > 16777216
      )
        packedIdbInvalid()
      return { maxRows: Math.min(256, maxRows), maxBytes, order: 'replica' as const }
    }
    const ownedRead = async <T>(read: () => Promise<T>): Promise<T> => {
      if (reading || !view.isOpen) packedIdbInvalid()
      reading = true
      try {
        options.signal?.throwIfAborted()
        const result = await read()
        options.signal?.throwIfAborted()
        if (!view.isOpen) packedIdbInvalid()
        return result
      } finally {
        reading = false
      }
    }
    const advance = async (previous: WalletSnapshotCursor | undefined, next?: WalletSnapshotCursor) => {
      if (next === undefined || JSON.stringify(next) === JSON.stringify(previous)) packedIdbInvalid()
      options.signal?.throwIfAborted()
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      options.signal?.throwIfAborted()
      return next
    }
    return {
      version: 1,
      snapshotId,
      get sourceStorage() {
        return structuredClone(view.sourceStorage)
      },
      get user() {
        return structuredClone(view.user)
      },
      ...(view.readContentRevision === undefined
        ? {}
        : {
            readContentRevision: (since: Parameters<NonNullable<WalletReadSnapshot['readContentRevision']>>[0]) =>
              ownedRead(() => view.readContentRevision!(since))
          }),
      expiresAt: view.expiresAt,
      get isOpen() {
        return view.isOpen
      },
      closed: view.closed,
      close: () => view.close(),
      fieldReader: observeWalletSnapshotFieldReader({
        readMetadataPage: async (table, input, selectedLimits) => {
          let native = nativeCursor(table, input)
          const selected = limits(selectedLimits),
            prior = native === undefined ? undefined : replicaCursor(table, native)
          return await ownedRead(async () => {
            while (true) {
              const page = await view.fieldReader.readMetadataPage(table, native, selected)
              if (page.rows.length !== 0) {
                const rows = page.rows.map(row => ({ ...row, cursor: replicaCursor(table, row.cursor) }))
                return { rows, payloadBytes: page.payloadBytes, done: page.done, cursor: rows[rows.length - 1].cursor }
              }
              if (page.done)
                return {
                  rows: page.rows,
                  payloadBytes: page.payloadBytes,
                  done: true,
                  ...(prior === undefined ? {} : { cursor: prior })
                }
              native = await advance(native, page.cursor)
            }
          })
        },
        readFieldExtent: async (table, input, field, offset, length, selectedExpected) => {
          const native = nativeCursor(table, input)
          if (native === undefined) packedIdbInvalid()
          const expected = Object.freeze({
            kind: selectedExpected.kind,
            bytes: selectedExpected.bytes,
            ...(selectedExpected.sha256 === undefined ? {} : { sha256: selectedExpected.sha256 })
          })
          return await ownedRead(
            async () => await view.fieldReader.readFieldExtent(table, native, field, offset, length, expected)
          )
        }
      }),
      readPage: async (table, input, selectedLimits) => {
        let native = nativeCursor(table, input)
        const selected = limits(selectedLimits),
          fields = keys[table],
          prior = native === undefined ? undefined : replicaCursor(table, native)
        return await ownedRead(async () => {
          while (true) {
            options.signal?.throwIfAborted()
            const page = await view.readPage(table, native, selected)
            if (page.rows.length !== 0) {
              const row = page.rows[page.rows.length - 1] as unknown as Record<string, unknown>,
                position = fields.map(field => row[field])
              if (position.some(value => typeof value !== 'number' && typeof value !== 'string')) packedIdbInvalid()
              return {
                rows: page.rows,
                payloadBytes: page.payloadBytes,
                done: page.done,
                cursor: { version: 1, snapshotId, table, after: position as Array<number | string> }
              }
            }
            if (page.done)
              return {
                rows: page.rows,
                payloadBytes: page.payloadBytes,
                done: true,
                ...(prior === undefined ? {} : { cursor: prior })
              }
            native = await advance(native, page.cursor)
          }
        })
      }
    }
  } catch (cause) {
    try {
      await closeSnapshotJournalSource(view, options.signal)
    } catch (error_) {
      throw new AggregateError([cause, error_], 'Packed sync source and native lease cleanup failed', { cause })
    }
    throw cause
  }
}
