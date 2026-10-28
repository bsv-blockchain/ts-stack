import type { WalletSnapshotFieldReader } from './WalletReadSnapshot'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'

/** Telemetry on one actual source reader. Every read still invokes the original
 * actor with its original receiver, coordinates, limits and lifecycle checks.
 * No payload copy, retained result, queue, schema or semantic verdict is kept. */
export function observeWalletSnapshotFieldReader(reader: WalletSnapshotFieldReader): WalletSnapshotFieldReader {
  let extentBytesRead = 0
  const observed: WalletSnapshotFieldReader = {
    get extentBytesRead() {
      return extentBytesRead
    },
    readMetadataPage: (table, cursor, limits) => reader.readMetadataPage(table, cursor, limits),
    readFieldExtent: async (table, cursor, field, offset, length, expected) => {
      const bytes = await reader.readFieldExtent(table, cursor, field, offset, length, expected)
      if (!(bytes instanceof Uint8Array))
        throw new WERR_INVALID_OPERATION('Snapshot field reader returned an invalid extent')
      const next = extentBytesRead + bytes.byteLength
      if (!Number.isSafeInteger(next)) {
        if (bytes instanceof Uint8Array) bytes.fill(0)
        throw new WERR_INVALID_OPERATION('Snapshot field read telemetry exceeded its original integer range')
      }
      extentBytesRead = next
      return bytes
    }
  }
  return Object.freeze(observed)
}
