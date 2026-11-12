import { SHA256 } from '@bsv/sdk/primitives/Hash'
import type { Brc38WorkingAllocation } from '../portable/Brc38WorkingAllocation'
import type {
  WalletReadSnapshot,
  WalletSnapshotCursor,
  WalletSnapshotFieldDescriptor,
  WalletSnapshotTable
} from './WalletReadSnapshot'

/** Materialize only a bounded scalar needed by the metadata policy. Payload
 * text uses stages instead. The original source and resource owner are checked
 * on every transfer; a descriptor identifies DATA, never admission. */
export async function snapshotSyncSmallText(
  source: WalletReadSnapshot,
  table: WalletSnapshotTable,
  cursor: WalletSnapshotCursor,
  field: string,
  descriptor: Readonly<WalletSnapshotFieldDescriptor>,
  working: Brc38WorkingAllocation,
  check: () => void
): Promise<string> {
  if (
    source.fieldReader === undefined ||
    descriptor.kind === 'binary' ||
    descriptor.bytes > 8192 ||
    (descriptor.kind === 'utf16le' && descriptor.bytes % 2 !== 0)
  )
    throw new Error('Snapshot scalar text exceeds its original bound')
  const allowance = working.claim(65536),
    hash = new SHA256(),
    decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let result = ''
  try {
    for (let offset = 0; offset < descriptor.bytes;) {
      check()
      const length = Math.min(4096, descriptor.bytes - offset),
        bytes = await source.fieldReader.readFieldExtent(table, cursor, field, offset, length, descriptor)
      try {
        check()
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length)
          throw new Error('Snapshot scalar extent changed')
        hash.update(bytes)
        if (descriptor.kind === 'utf8') result += decoder.decode(bytes, { stream: true })
        else
          for (let index = 0; index < bytes.length; index += 2)
            result += String.fromCodePoint(bytes[index] | (bytes[index + 1] << 8))
        offset += length
      } finally {
        if (bytes instanceof Uint8Array) bytes.fill(0)
      }
    }
    if (descriptor.kind === 'utf8') result += decoder.decode()
    check()
    if (result.length > 4096 || (descriptor.sha256 !== undefined && hash.digestHex() !== descriptor.sha256))
      throw new Error('Snapshot scalar text digest or decoded bound differs')
    return result
  } finally {
    allowance.close()
  }
}
