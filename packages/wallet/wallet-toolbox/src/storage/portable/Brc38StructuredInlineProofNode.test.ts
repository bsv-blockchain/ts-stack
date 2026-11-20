import { createHash } from 'node:crypto'
import { brc38StructuredInlineProofFields, brc38StructuredInlineProofReader } from './Brc38StructuredInlineProofNode'
import { restoreProofFixture } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import type { Brc38AuthenticatedStreamedImportReader } from './KnexBrc38StagingStore'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

test('bounded inline SDK proof bytes retain exact content and are read afresh after a source change', async () => {
  const proof = restoreProofFixture(),
    raw = Buffer.from(proof.tx.toBinary()),
    merkle = Buffer.from(proof.path.toBinary())
  let value = raw
  const read = jest.fn(async () => ({
      fields: { rawTx: value.toString('base64'), merklePath: merkle.toString('base64') },
      binaries: {}
    })),
    source: Brc38AuthenticatedStreamedImportReader = {
      header: async () => {
        throw new Error('unused')
      },
      count: async () => 1,
      row: read,
      chunk: async () => {
        throw new Error('inline chunk cannot use streamed SQL')
      }
    },
    reader = brc38StructuredInlineProofReader(source, 1048576),
    first = await reader.row('provenTxs', 0),
    chunk = await reader.chunk('provenTxs', 0, 'rawTx', 0)
  expect(first?.fields).not.toHaveProperty('rawTx')
  expect(first?.binaries.rawTx.sha256).toBe(createHash('sha256').update(raw).digest('hex'))
  expect(Buffer.from(chunk!.bytes)).toEqual(raw)
  value = Buffer.from(raw)
  value[value.length - 1] ^= 1
  expect((await reader.row('provenTxs', 0))?.binaries.rawTx.sha256).not.toBe(first?.binaries.rawTx.sha256)
  expect(read).toHaveBeenCalledTimes(3)
})
test('inline proof allocation and mixed representations refuse before exposing a decoded row', () => {
  const source = { fields: { rawTx: Buffer.alloc(4096).toString('base64') }, binaries: {} }
  expect(() => brc38StructuredInlineProofFields(source, 1024)).toThrow(SnapshotResourceLimitError)
  expect(() =>
    brc38StructuredInlineProofFields(
      {
        ...source,
        binaries: {
          rawTx: {
            field: 'rawTx',
            encoding: 'base64',
            bytes: 4096,
            sha256: 'a'.repeat(64)
          }
        }
      },
      1048576
    )
  ).toThrow('overlaps')
})
test('inline reader cancellation preserves its cause and performs no source read', async () => {
  const controller = new AbortController(),
    cause = new Error('cancel inline proof'),
    row = jest.fn()
  controller.abort(cause)
  const reader = brc38StructuredInlineProofReader(
    { row } as unknown as Brc38AuthenticatedStreamedImportReader,
    1048576,
    controller.signal
  )
  await expect(reader.row('provenTxs', 0)).rejects.toBe(cause)
  expect(row).not.toHaveBeenCalled()
})
