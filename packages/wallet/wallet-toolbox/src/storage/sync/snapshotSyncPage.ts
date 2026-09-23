import type { RequestSyncChunkArgs, SyncChunk } from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'

/** Detach flat sync records, dates and byte arrays without a JSON-sized intermediate string. */
function recordCopy<T extends object>(record: T): T {
  const result = { ...record }
  for (const key of Object.keys(result) as Array<keyof T>) {
    const value = result[key]
    let copy: unknown = value
    if (Array.isArray(value)) copy = value.slice()
    else if (value instanceof Uint8Array) copy = new Uint8Array(value)
    else if (value != null && typeof value === 'object') {
      // Date's internal-slot check also accepts dates returned by an IndexedDB
      // implementation in another realm; arbitrary nested objects are invalid.
      try {
        copy = new Date(Date.prototype.getTime.call(value))
      } catch {
        throw new WERR_INVALID_PARAMETER('chunk', 'flat table records with dates and byte arrays')
      }
    }
    result[key] = copy as T[keyof T]
  }
  return result
}

export function snapshotSyncPage(
  args: RequestSyncChunkArgs,
  chunk: SyncChunk
): { args: RequestSyncChunkArgs; chunk: SyncChunk } {
  const snapshot = { ...chunk }
  for (const key of Object.keys(snapshot) as Array<keyof SyncChunk>) {
    const value = snapshot[key]
    if (Array.isArray(value)) Object.assign(snapshot, { [key]: value.map(record => recordCopy(record)) })
  }
  if (chunk.user != null) snapshot.user = recordCopy(chunk.user)
  return {
    args: {
      ...args,
      since: args.since == null ? undefined : new Date(args.since),
      offsets: args.offsets.map(offset => ({ ...offset }))
    },
    chunk: snapshot
  }
}
