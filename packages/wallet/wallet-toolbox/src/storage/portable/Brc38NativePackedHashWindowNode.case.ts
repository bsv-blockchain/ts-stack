import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { Brc38NativeBlobRead, Brc38NativeTextRead } from './Brc38NativeBlobProtocol'
import { readBrc38NativePackedDescriptor, hashBrc38NativePackedVersion } from './Brc38NativePackedFieldsNode'
import {
  readBrc38NativePackedTextDescriptor,
  hashBrc38NativePackedTextVersion
} from './Brc38NativePackedTextFieldsNode'

/** Authored UNRUN. The fresh packaged native qualification controller must
 * invoke this on its genuine currently owned retained transaction with bytes
 * from its independent fixture oracle. A real legacy SQLite transaction or
 * copied actor cannot supply that ownership. This case grants no lease/claim. */
export async function verifyNativePackedHashWindowOracle(
  k: Knex.Transaction,
  field:
    | { readonly family: 'binary'; readonly coordinate: Pick<Brc38NativeBlobRead, 'table' | 'field' | 'rowId'> }
    | { readonly family: 'text'; readonly coordinate: Pick<Brc38NativeTextRead, 'table' | 'field' | 'rowId'> },
  expected: Uint8Array,
  assertCurrent: () => void
): Promise<void> {
  if (!(expected instanceof Uint8Array) || expected.byteLength > 1048576)
    throw new RangeError('Bounded independent native hash fixture required')
  const oracle = createHash('sha256').update(expected).digest('hex'),
    actual =
      field.family === 'binary'
        ? await readBrc38NativePackedDescriptor(k, field.coordinate)
        : await readBrc38NativePackedTextDescriptor(k, field.coordinate)
  if (actual?.bytes !== expected.byteLength || actual.sha256 !== oracle)
    throw new Error('Independent packed native fixture descriptor differs')
  for (const maximum of expected.byteLength <= 128 ? [1, 17, 1024] : [1024, 4096, 8192]) {
    let transfers = 0
    const observed = (response: unknown) => {
      const rows = Array.isArray(response) ? response : [response]
      for (const row of rows) {
        if (row === null || typeof row !== 'object' || !Object.hasOwn(row, 'payload')) continue
        const value = (row as { payload: unknown }).payload
        if (!(value instanceof Uint8Array) || value.byteLength > maximum)
          throw new Error('Actual native hash transferred more than its admitted window')
        transfers++
      }
    }
    k.on('query-response', observed)
    try {
      assertCurrent()
      const hash =
        field.family === 'binary'
          ? await hashBrc38NativePackedVersion(k, actual.sha256, actual.bytes, assertCurrent, maximum)
          : await hashBrc38NativePackedTextVersion(k, actual.sha256, actual.bytes, assertCurrent, maximum)
      if (hash !== oracle || (expected.byteLength !== 0 && transfers === 0))
        throw new Error('Fresh bounded packed native whole-field oracle or transfer observation differs')
      assertCurrent()
    } finally {
      k.removeListener('query-response', observed)
    }
  }
}
