import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { BRC38WalletData } from './index'
import type { TableProvenTx } from '../schema/tables/TableProvenTx'
import {
  assertSyncProofReplacementAuthorized,
  StaleSyncProofError,
  validateSyncProof
} from '../methods/validateSyncProof'
import { restorePortableProof, restoreProofFixture } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import {
  authenticatedStageOptions,
  authenticatedStagePassword,
  encrypted
} from './Brc38AuthenticatedPrivateStageFixture'
import { Brc38StagingAdmissionNode, type Brc38StagingReservation } from './Brc38StagingAdmissionNode'
import { stageAuthenticatedBrc39PrivateImport } from './Brc38AuthenticatedPrivateStageNode'
import { previewDestinationFixture, previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { previewBrc38PrivateImport } from './Brc38PrivateImportPreviewNode'
import {
  inspectBrc38AuthenticatedStreamedProof,
  inspectBrc38AuthenticatedStreamedProofReader
} from './Brc38AuthenticatedStreamedProofNode'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

const policy = Object.freeze({
  maximumRawBytes: 262144,
  maximumChunks: 10000,
  maximumMerkleBytes: 1048576,
  maximumDecodedMerkleBytes: 16777216
})
let directory: string,
  root: Brc38StagingAdmissionNode,
  target: Awaited<ReturnType<typeof previewDestinationFixture>>,
  held: Brc38StagingReservation[]
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'brc38-streamed-proof-'))
  root = await Brc38StagingAdmissionNode.create(directory, {
    maximumImports: 1,
    maximumPhysicalBytes: 7340032,
    maximumLogicalBytes: 1048576
  })
  held = []
  target = await previewDestinationFixture()
})
afterEach(async () => {
  jest.restoreAllMocks()
  const results = await Promise.allSettled(held.map(value => value.store.close()))
  results.push(...(await Promise.allSettled([root.close(), target.close()])))
  const failures = results.flatMap(value => (value.status === 'rejected' ? [value.reason] : []))
  if (failures.length !== 0) throw new AggregateError(failures, 'Streamed proof fixture retains cleanup')
  await fs.rm(directory, { recursive: true, force: true })
})
async function stage(transform?: (data: BRC38WalletData) => void) {
  const data = semanticStageFixture(),
    proof = restoreProofFixture()
  restorePortableProof(data, proof)
  transform?.(data)
  const bytes = await encrypted(data),
    options = {
      ...authenticatedStageOptions(bytes),
      streamedFields: { maximumBinaryBytes: 262144, maximumChunkBytes: 65536 }
    }
  async function* chunks() {
    for (let offset = 0; offset < bytes.length; offset += 137) yield bytes.slice(offset, offset + 137)
  }
  const value = await stageAuthenticatedBrc39PrivateImport(chunks(), authenticatedStagePassword, root, options)
  held.push(value.reservation)
  await previewBrc38PrivateImport(value.reservation.store, target.storage, 'restore', previewReceiptPolicy)
  return { store: value.reservation.store, proof, data }
}
test('actual authenticated fields agree with the independent SDK and original full proof oracle without granting replacement authority', async () => {
  const { store, proof, data } = await stage(),
    storage = { getServices: () => proof.services },
    candidate: TableProvenTx = {
      provenTxId: 12,
      created_at: new Date(0),
      updated_at: new Date(0),
      txid: proof.txid,
      height: 100,
      index: 0,
      rawTx: proof.tx.toBinary(),
      merklePath: proof.path.toBinary(),
      blockHash: String(data.tables.provenTxs[0].blockHash).toLowerCase(),
      merkleRoot: proof.txid
    }
  const result = await inspectBrc38AuthenticatedStreamedProof(store, storage, 0, policy)
  expect(result).toEqual({
    txid: proof.tx.id('hex'),
    height: proof.path.blockHeight,
    index: 0,
    merkleRoot: proof.path.computeRoot(proof.txid),
    blockHash: candidate.blockHash,
    rawBytes: candidate.rawTx.length,
    rawSha256: createHash('sha256').update(Buffer.from(candidate.rawTx)).digest('hex'),
    merkleBytes: candidate.merklePath.length,
    merkleSha256: createHash('sha256').update(Buffer.from(candidate.merklePath)).digest('hex')
  })
  expect(() => assertSyncProofReplacementAuthorized(candidate)).toThrow('active-chain validation')
  await validateSyncProof(storage, candidate)
  expect(() => assertSyncProofReplacementAuthorized(candidate)).not.toThrow()
  expect(proof.isValidRootForHeight).toHaveBeenCalledWith(proof.txid, 100)
  expect(await target.writer('proven_txs')).toEqual([])
  expect(await target.writer('users')).toEqual([])
})
test.each(['height', 'index', 'root', 'block', 'raw', 'merkle'] as const)(
  'refuses authenticated but invalid %s proof content before destination writes',
  async kind => {
    const { store, proof } = await stage(data => {
      const row = data.tables.provenTxs[0]
      if (kind === 'height') row.height = 101
      if (kind === 'index') row.index = 1
      if (kind === 'root') row.merkleRoot = 'e'.repeat(64)
      if (kind === 'block') row.blockHash = 'e'.repeat(64)
      if (kind === 'raw') row.rawTx = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64')
      if (kind === 'merkle') row.merklePath = Buffer.from([100, 1, 253, 255, 255]).toString('base64')
    })
    await expect(
      inspectBrc38AuthenticatedStreamedProof(store, { getServices: () => proof.services }, 0, policy)
    ).rejects.toThrow()
    expect(await target.writer('proven_txs')).toEqual([])
    expect(await target.writer('users')).toEqual([])
  }
)
test('preserves the original inactive-chain refusal and never requests a header', async () => {
  const { store, proof } = await stage(),
    header = jest.spyOn(proof.services, 'getHeaderForHeight')
  proof.isValidRootForHeight.mockResolvedValue(false)
  await expect(
    inspectBrc38AuthenticatedStreamedProof(store, { getServices: () => proof.services }, 0, policy)
  ).rejects.toBeInstanceOf(StaleSyncProofError)
  expect(header).not.toHaveBeenCalled()
})
test.each(['length', 'root', 'hash'] as const)('refuses an active-chain %s header mismatch', async kind => {
  const { store, proof } = await stage(),
    bytes = [...proof.header]
  if (kind === 'length') bytes.pop()
  if (kind === 'root') bytes[36] ^= 1
  if (kind === 'hash') bytes[0] ^= 1
  jest.spyOn(proof.services, 'getHeaderForHeight').mockResolvedValue(bytes)
  await expect(
    inspectBrc38AuthenticatedStreamedProof(store, { getServices: () => proof.services }, 0, policy)
  ).rejects.toThrow('active')
})
test('refuses declared and decoded Merkle allocation limits before the SDK or network oracle', async () => {
  const { store, proof } = await stage(),
    storage = { getServices: () => proof.services }
  await expect(
    inspectBrc38AuthenticatedStreamedProof(store, storage, 0, { ...policy, maximumMerkleBytes: 1 })
  ).rejects.toBeInstanceOf(SnapshotResourceLimitError)
  await expect(
    inspectBrc38AuthenticatedStreamedProof(store, storage, 0, { ...policy, maximumDecodedMerkleBytes: 4096 })
  ).rejects.toBeInstanceOf(SnapshotResourceLimitError)
  expect(proof.isValidRootForHeight).not.toHaveBeenCalled()
})
test('checks actual retained chunk bytes and refuses changed source content', async () => {
  const { store, proof } = await stage()
  await expect(
    store
      .knex('private_binary_chunks')
      .where({ tableName: 'provenTxs', position: 0, field: 'rawTx', offset: 0 })
      .update({ payload: Buffer.from(proof.tx.toBinary()).fill(0) })
  ).rejects.toThrow('Authenticated private source is immutable')
  // Corrupt the actual scoped read without disabling the persisted source seal.
  // Keep its original descriptor so the independent byte/hash proof must refuse.
  const changedRead = jest.fn()
  await expect(
    store.withAuthenticatedStreamedImportRead(async (_json, _metadata, reader) =>
      inspectBrc38AuthenticatedStreamedProofReader(
        {
          ...reader,
          chunk: async (table, position, field, offset) => {
            const actual = await reader.chunk(table, position, field, offset)
            if (actual !== undefined && field === 'rawTx') {
              changedRead()
              return { ...actual, bytes: new Uint8Array(actual.bytes.byteLength) }
            }
            return actual
          }
        },
        { getServices: () => proof.services },
        0,
        policy,
        store.limits.expiresAt
      )
    )
  ).rejects.toThrow()
  expect(changedRead).toHaveBeenCalled()
  expect(proof.isValidRootForHeight).not.toHaveBeenCalled()
})
test('awaits a pending chain request through cancellation and retains the exact cancellation reason', async () => {
  const { store, proof } = await stage(),
    controller = new AbortController(),
    reason = new Error('proof cancellation'),
    header = jest.spyOn(proof.services, 'getHeaderForHeight')
  let enter!: () => void,
    finish!: (value: boolean) => void,
    settled = false
  const entered = new Promise<void>(resolve => {
      enter = resolve
    }),
    pending = new Promise<boolean>(resolve => {
      finish = resolve
    })
  proof.isValidRootForHeight.mockImplementation(async () => {
    enter()
    return await pending
  })
  const result = inspectBrc38AuthenticatedStreamedProof(store, { getServices: () => proof.services }, 0, {
    ...policy,
    signal: controller.signal
  })
  void result.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await entered
  controller.abort(reason)
  await Promise.resolve()
  expect(settled).toBe(false)
  await expect(store.close()).rejects.toThrow('Wait for owned')
  finish(true)
  await expect(result).rejects.toBe(reason)
  expect(header).not.toHaveBeenCalled()
})
test('retains the original source deadline through active-chain work', async () => {
  const { store, proof } = await stage(),
    header = jest.spyOn(proof.services, 'getHeaderForHeight')
  proof.isValidRootForHeight.mockImplementation(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(store.limits.expiresAt)
    return true
  })
  await expect(
    inspectBrc38AuthenticatedStreamedProof(store, { getServices: () => proof.services }, 0, policy)
  ).rejects.toBeInstanceOf(SnapshotResourceLimitError)
  expect(header).not.toHaveBeenCalled()
})
