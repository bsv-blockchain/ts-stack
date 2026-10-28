import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'

/** Original portable string columns. Coordinates are format DATA, never a
 * source, native producer, authenticated archive or semantic validation grant. */
export const brc38StreamedTextFields = Object.freeze({
  transactions: Object.freeze([
    'description',
    'noSendExpiryReclaimDerivationPrefix',
    'noSendExpiryReclaimDerivationSuffix'
  ]),
  outputs: Object.freeze([
    'outputDescription',
    'spendingDescription',
    'customInstructions',
    'derivationPrefix',
    'derivationSuffix',
    'type',
    'purpose'
  ]),
  commissions: Object.freeze(['keyOffset']),
  certificates: Object.freeze(['subject', 'revocationOutpoint', 'signature', 'verifier']),
  certificateFields: Object.freeze(['fieldValue', 'masterKey'])
})
export interface Brc38StreamedText {
  readonly encoding: 'utf8' | 'utf16le'
  readonly length: number
  readonly sha256: string
  read(offset: number, length: number): Promise<Uint8Array>
}

/** Exact ordinary JSON string spelling, including leading BOM and controls.
 * Only one <=16 KiB source loan and a bounded escaped fragment are retained.
 * The enclosing archive keeps output provisional until the complete source,
 * digest, relational closure and physical source cleanup have succeeded. */
export async function* encodeBrc38StreamedText(
  source: Readonly<Brc38StreamedText>,
  policy: Readonly<{
    maximumInputBytes: number
    maximumOutputBytes: number
    maximumChunkBytes: number
    signal?: AbortSignal
  }>
): AsyncGenerator<Uint8Array, void, void> {
  const encoding = source.encoding,
    length = source.length,
    sha256 = source.sha256,
    read = source.read,
    maximum = policy.maximumOutputBytes,
    width = policy.maximumChunkBytes,
    signal = policy.signal
  if (
    (encoding !== 'utf8' && encoding !== 'utf16le') ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    !Number.isSafeInteger(policy.maximumInputBytes) ||
    length > policy.maximumInputBytes ||
    (encoding === 'utf16le' && length % 2 !== 0) ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    typeof read !== 'function' ||
    !Number.isSafeInteger(maximum) ||
    maximum < 2 ||
    !Number.isSafeInteger(width) ||
    width < 64 ||
    width > 65536
  )
    throw new TypeError('Invalid original streamed portable TEXT admission')
  const decoder = new TextDecoder(encoding === 'utf8' ? 'utf-8' : 'utf-16le', { fatal: true, ignoreBOM: true }),
    encoder = new TextEncoder(),
    digest = new SHA256()
  let emitted = 0
  const output = (bytes: Uint8Array): Uint8Array => {
    signal?.throwIfAborted()
    if (bytes.length > maximum - emitted || bytes.length > width)
      throw new SnapshotResourceLimitError('Streamed portable TEXT exceeds its original encoded row budget')
    emitted += bytes.length
    return bytes
  }
  function* fragment(text: string): Generator<Uint8Array> {
    if (text.length === 0) return
    // Decoder produces complete Unicode scalars. JSON.stringify is applied to
    // this bounded fragment, so it preserves the ordinary format's escaping
    // without materializing the complete field or splitting a surrogate pair.
    const encoded = encoder.encode(JSON.stringify(text).slice(1, -1))
    try {
      for (let offset = 0; offset < encoded.length; offset += width) yield output(encoded.slice(offset, offset + width))
    } finally {
      encoded.fill(0)
    }
  }
  yield output(new Uint8Array([34]))
  for (let offset = 0; offset < length;) {
    signal?.throwIfAborted()
    const count = Math.min(16384, length - offset),
      supplied = await read(offset, count)
    let bytes: Uint8Array | undefined
    try {
      bytes = detachBrc38PrivateChunk(supplied, count)
      if (bytes.length !== count) throw new Error('Original streamed portable TEXT extent is truncated')
      signal?.throwIfAborted()
      digest.update(bytes)
      yield* fragment(decoder.decode(bytes, { stream: true }))
      offset += count
    } finally {
      bytes?.fill(0)
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  if (length === 0) {
    const empty = detachBrc38PrivateChunk(await read(0, 0), 0)
    try {
      if (empty.length !== 0) throw new Error('Empty portable TEXT source differs')
    } finally {
      empty.fill(0)
    }
  }
  yield* fragment(decoder.decode())
  if (digest.digestHex() !== sha256) throw new Error('Original streamed portable TEXT digest differs')
  yield output(new Uint8Array([34]))
}
