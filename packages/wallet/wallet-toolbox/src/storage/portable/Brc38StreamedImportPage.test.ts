import { createHash } from 'node:crypto'
import { importPageFixture } from './Brc38ImportPageFixture'
import {
  prepareBrc38StreamedImportPage,
  prepareBrc38StructuredImportPage,
  brc38ImportTableOrder
} from './Brc38ImportPage'
import type { Brc38AuthenticatedStreamedImportReader } from './KnexBrc38StagingStore'
import { brc38JsonBinaryField, type Brc38JsonStreamedField } from './Brc38JsonBinaryFields'
import { restoreProofFixture, restorePortableProof } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

function fixture() {
  const data = semanticStageFixture(),
    proof = restoreProofFixture()
  restorePortableProof(data, proof)
  const f = importPageFixture(data)
  const reader: Brc38AuthenticatedStreamedImportReader = {
    header: f.reader.header,
    count: f.reader.count,
    row: async (table, index) => {
      const original = await f.reader.row(table, index)
      if (original === undefined) return undefined
      const fields = { ...original },
        binaries: Record<string, Brc38JsonStreamedField> = {}
      for (const field of Object.keys(fields))
        if (brc38JsonBinaryField(table, field)) {
          const bytes =
            field === 'noSendExpiryReclaimRawTx'
              ? Buffer.from(fields[field] as number[])
              : Buffer.from(String(fields[field]), 'base64')
          binaries[field] = {
            field,
            encoding: field === 'noSendExpiryReclaimRawTx' ? 'number-array' : 'base64',
            bytes: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex')
          }
          delete fields[field]
        }
      return { fields, binaries }
    },
    chunk: async () => {
      throw new Error('Page preparation must not fetch field bytes')
    }
  }
  return {
    ...f,
    reader,
    proof,
    get scalarReads() {
      return f.scalarReads
    },
    get maximumPending() {
      return f.maximumPending
    }
  }
}
test('real SDK proof metadata is prepared without full/placeholder binary fields or native effects', async () => {
  const f = fixture(),
    page = await prepareBrc38StreamedImportPage(f.reader, f.metadata, f.admission, 1)
  if (page.data.kind !== 'table') throw new Error('Table required')
  expect(page.data.table).toBe('provenTxs')
  const row = page.data.rows[0]
  expect(row.metadata).not.toHaveProperty('rawTx')
  expect(row.metadata).not.toHaveProperty('merklePath')
  expect(row.source.fields).not.toHaveProperty('rawTx')
  expect(row.source.binaries.rawTx.bytes).toBe(f.proof.tx.toBinary().length)
  expect(row.source.binaries.rawTx.sha256).toBe(
    createHash('sha256').update(Buffer.from(f.proof.tx.toBinary())).digest('hex')
  )
  expect(page.references).toEqual([
    { entity: 'provenTx', incomingId: f.data.tables.provenTxs[0].provenTxId, required: false }
  ])
  expect(page.step).toMatchObject({ fromRow: 1, rows: 1, mappedIds: 1 })
  expect(page.budget.remaining).toBeLessThan(f.admission.maximumStepBytes)
  expect(f.maximumPending).toBe(1)
})
test('changed actual field digest alters replay identity even when metadata is identical', async () => {
  const f = fixture(),
    first = await prepareBrc38StreamedImportPage(f.reader, f.metadata, f.admission, 1),
    original = f.reader.row
  const changed: Brc38AuthenticatedStreamedImportReader = {
    ...f.reader,
    row: async (table, index) => {
      const row = await original(table, index)
      return row === undefined || table !== 'provenTxs'
        ? row
        : { ...row, binaries: { ...row.binaries, rawTx: { ...row.binaries.rawTx, sha256: 'f'.repeat(64) } } }
    }
  }
  const second = await prepareBrc38StreamedImportPage(changed, f.metadata, f.admission, 1)
  expect(second.step.pageSha256).not.toBe(first.step.pageSha256)
  expect(second.step.fromRow).toBe(first.step.fromRow)
  expect(second.step.rows).toBe(first.step.rows)
})
test('a row too small to retain both metadata and receiver preparation explicitly refuses', async () => {
  const f = fixture()
  await expect(
    prepareBrc38StreamedImportPage(f.reader, f.metadata, { ...f.admission, maximumStepBytes: 1000 }, 1)
  ).rejects.toBeInstanceOf(SnapshotResourceLimitError)
})
test('cancellation before source preparation retains identity and cannot read any field', async () => {
  const f = fixture(),
    controller = new AbortController(),
    reason = new Error('synthetic page cancellation')
  controller.abort(reason)
  await expect(prepareBrc38StreamedImportPage(f.reader, f.metadata, f.admission, 1, controller.signal)).rejects.toBe(
    reason
  )
  expect(f.calls).toEqual([])
})

function structuredFixture() {
  const f = fixture(),
    original = f.reader.row
  const reader: Brc38AuthenticatedStreamedImportReader = {
    ...f.reader,
    row: async (table, index) => {
      const row = await original(table, index)
      if (row === undefined || table !== 'provenTxReqs') return row
      const fields = { ...row.fields }
      delete fields.history
      return {
        ...row,
        fields,
        structured: { history: { field: 'history', encoding: 'utf8-json', bytes: 1000000000, sha256: 'a'.repeat(64) } }
      }
    }
  }
  const cursor = async (): Promise<number> => {
    let result = 1
    for (const table of brc38ImportTableOrder) {
      if (table === 'provenTxReqs') return result
      result += await reader.count(table)
    }
    throw new Error('Request table is missing from independent source order')
  }
  return { ...f, reader, cursor }
}
test('explicit structured page retains a billion-byte descriptor without fetching its field or emitting a placeholder', async () => {
  const f = structuredFixture(),
    fromRow = await f.cursor(),
    page = await prepareBrc38StructuredImportPage(f.reader, f.metadata, f.admission, fromRow)
  if (page.data.kind !== 'table') throw new Error('Expected request table')
  expect(page.data.table).toBe('provenTxReqs')
  expect(page.data.rows[0].source.structured?.history).toEqual({
    field: 'history',
    encoding: 'utf8-json',
    bytes: 1000000000,
    sha256: 'a'.repeat(64)
  })
  expect(page.data.rows[0].metadata).not.toHaveProperty('history')
  expect(page.step.bytes).toBeLessThan(f.admission.maximumStepBytes)
  // This is descriptor preparation DATA only, not authenticated/native proof.
})
test('binary-only preparation explicitly refuses structured descriptors', async () => {
  const f = structuredFixture()
  await expect(prepareBrc38StreamedImportPage(f.reader, f.metadata, f.admission, await f.cursor())).rejects.toThrow()
})
test('actual structured descriptor SHA changes the separate structured page replay identity', async () => {
  const f = structuredFixture(),
    fromRow = await f.cursor(),
    first = await prepareBrc38StructuredImportPage(f.reader, f.metadata, f.admission, fromRow),
    original = f.reader.row,
    reader: Brc38AuthenticatedStreamedImportReader = {
      ...f.reader,
      row: async (table, index) => {
        const row = await original(table, index)
        return row?.structured === undefined
          ? row
          : {
              ...row,
              structured: {
                ...row.structured,
                history: { ...row.structured.history, sha256: 'b'.repeat(64) }
              }
            }
      }
    }
  const changed = await prepareBrc38StructuredImportPage(reader, f.metadata, f.admission, fromRow)
  expect(changed.step.pageSha256).not.toBe(first.step.pageSha256)
  expect(changed.step.rows).toBe(first.step.rows)
})
test.each(['overlap', 'wrong-field', 'short-content', 'wrong-encoding'] as const)(
  'structured preparation rejects descriptor/metadata inconsistency: %s',
  async variant => {
    const f = structuredFixture(),
      original = f.reader.row,
      reader: Brc38AuthenticatedStreamedImportReader = {
        ...f.reader,
        row: async (table, index) => {
          const row = await original(table, index)
          if (row?.structured === undefined) return row
          const field = {
            ...row.structured.history,
            ...(variant === 'wrong-field' ? { field: 'notAField' } : {}),
            ...(variant === 'short-content' ? { bytes: 1 } : {}),
            ...(variant === 'wrong-encoding' ? { encoding: 'base64' } : {})
          }
          return {
            ...row,
            fields: variant === 'overlap' ? { ...row.fields, history: {} } : row.fields,
            structured: { history: field }
          } as unknown as NonNullable<Awaited<ReturnType<typeof original>>>
        }
      }
    await expect(prepareBrc38StructuredImportPage(reader, f.metadata, f.admission, await f.cursor())).rejects.toThrow()
  }
)

test('structured preparation accepts bounded original inline proof bytes while the ordinary streamed path stays explicit', async () => {
  const f = importPageFixture(),
    source: Brc38AuthenticatedStreamedImportReader = {
      header: f.reader.header,
      count: f.reader.count,
      row: async (table, index) => {
        const fields = await f.reader.row(table, index)
        return fields === undefined ? undefined : { fields, binaries: {} }
      },
      chunk: async () => {
        throw new Error('page must not read binary content')
      }
    }
  const page = await prepareBrc38StructuredImportPage(source, f.metadata, f.admission, 1)
  if (page.data.kind !== 'table') throw new Error('expected proof table')
  expect(page.data.rows[0].source.fields.rawTx).toEqual(f.data.tables.provenTxs[0].rawTx)
  expect(page.data.rows[0].metadata.rawTx).toEqual(
    Buffer.from(String(f.data.tables.provenTxs[0].rawTx), 'base64').toJSON().data
  )
  await expect(prepareBrc38StreamedImportPage(source, f.metadata, f.admission, 1)).rejects.toThrow()
})
