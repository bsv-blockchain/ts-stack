import { promiseFromSync } from '../../utility/promiseFromSync'
import { openDB, deleteDB } from 'idb'
import { Brc38PrivateIdbStage } from './Brc38PrivateIdbStage'
import { Brc38SemanticStage, brc38StageTables } from './Brc38SemanticStage'
import { readBrc38JsonStream } from './Brc38JsonStream'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import type { KnexBrc38StagingLimits } from './Brc38StagingBinding'
import { Brc38StreamedSemanticStage } from './Brc38StreamedSemanticStage'
import { brc38IdbStreamedFieldSink } from './Brc38IdbStreamedFieldSink'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { packedIdbStores } from '../idbPackedFields'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { prepareBrc38IdbRestoreBinary } from './Brc38IdbRestoreBinary'

// Authored UNRUN. These cases require actual browser IndexedDB and Web Locks;
// they must be selected by the governed browser harness after implementation.
function equal(actual: unknown, expected: unknown): void {
  const ordered = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(ordered)
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.keys(value)
          .sort((a, b) => Number(a > b) - Number(a < b))
          .map(key => [key, ordered(Reflect.get(value, key))])
      )
    return value
  }
  if (JSON.stringify(ordered(actual)) !== JSON.stringify(ordered(expected)))
    throw new Error('Independent browser staging oracle differs')
}
async function rejects(run: () => Promise<unknown>): Promise<void> {
  let failed = false
  try {
    await run()
  } catch {
    failed = true
  }
  if (!failed) throw new Error('Browser staging admitted a refused operation')
}
function options() {
  const data = semanticStageFixture(),
    limits: KnexBrc38StagingLimits = {
      maximumRows: 1000,
      maximumLogicalBytes: 4194304,
      maximumPhysicalBytes: 8388608,
      maximumRowBytes: 65536,
      maximumRowAllocationBytes: 1048576,
      expiresAt: Date.now() + 120000
    },
    binding = {
      archiveSha256: 'a'.repeat(64),
      identityKey: String(data.user.identityKey),
      chain: 'test' as const,
      sourceStorageIdentityKey: String(data.sourceStorage.storageIdentityKey),
      targetStorageIdentityKey: 'private-target',
      targetGeneration: 0
    }
  return { data, limits, binding }
}
export async function verifyPrivateIdbAll13AndReleasedResume(): Promise<void> {
  const f = options(),
    original = JSON.stringify(f.data),
    stage = await Brc38PrivateIdbStage.create(f.limits, f.binding, 4000)
  let owner = stage
  try {
    const semantic = new Brc38SemanticStage(stage, {
        expectedIdentityKey: f.binding.identityKey,
        expectedChain: 'test',
        expectedSourceStorageIdentityKey: f.binding.sourceStorageIdentityKey,
        maximumRows: f.limits.maximumRows
      }),
      bytes = new TextEncoder().encode(original)
    async function* chunks() {
      for (let offset = 0; offset < bytes.length; offset += 4096)
        yield Promise.resolve(bytes.slice(offset, offset + 4096))
    }
    await readBrc38JsonStream(chunks(), semantic, {
      maximumArchiveBytes: 2097152,
      maximumRowAllocationBytes: 1048576,
      maximumMetadataAllocationBytes: 65536,
      maximumInputChunkBytes: 4096,
      maximumInputChunks: 1000
    })
    const sealed = await stage.sealedMetadata()
    equal(sealed.header.user, f.data.user)
    equal(sealed.header.sourceStorage, f.data.sourceStorage)
    equal(sealed.binding, f.binding)
    equal(
      sealed.rows,
      Object.values(f.data.tables).reduce((total, rows) => total + rows.length, 0)
    )
    for (const table of brc38StageTables) equal(sealed.counts[table], f.data.tables[table].length)
    for (const table of brc38StageTables) {
      equal(await stage.count(table), f.data.tables[table].length)
      for (let index = 0; index < f.data.tables[table].length; index++)
        equal(await stage.row(table, index), f.data.tables[table][index])
    }
    equal(JSON.stringify(f.data), original)
    await rejects(() => Brc38PrivateIdbStage.resume(stage.databaseName, f.limits, f.binding, 4000))
    await stage.close()
    owner = await Brc38PrivateIdbStage.resume(stage.databaseName, f.limits, f.binding, 4000)
    equal(await owner.count('outputs'), f.data.tables.outputs.length)
    equal(await owner.row('syncStates', 0), f.data.tables.syncStates[0])
  } finally {
    await owner.discard(new Error('case cleanup'))
    await deleteDB(stage.databaseName)
  }
}
export async function verifyPrivateIdbClaimIsolation(): Promise<void> {
  const f = options(),
    owner = await Brc38PrivateIdbStage.create(f.limits, f.binding, 4000)
  try {
    await rejects(() => owner.sealedMetadata())
    await rejects(() =>
      Brc38PrivateIdbStage.resume(owner.databaseName, f.limits, { ...f.binding, targetGeneration: 1 }, 4000)
    )
    const copied = Object.create(Object.getPrototypeOf(owner)) as Brc38PrivateIdbStage
    await rejects(() => copied.sealedMetadata())
    await rejects(() => copied.count('outputs'))
    equal(await owner.count('outputs'), 0)
  } finally {
    await owner.discard(new Error('case cleanup'))
  }
}
export async function verifyPrivateIdbScalarPersistedUtf8AndOwnershipRefusals(): Promise<void> {
  for (const bytes of [
    new Uint8Array([0xc0, 0xaf]),
    new Uint8Array([0xed, 0xa0, 0x80]),
    new Uint8Array([0xf0, 0x9f])
  ]) {
    const f = options(),
      owner = await Brc38PrivateIdbStage.create(f.limits, f.binding, 4000),
      inspection = await openDB(owner.databaseName, 1),
      descriptor = {
        field: 'description',
        encoding: 'utf8' as const,
        bytes: bytes.length,
        sha256: new SHA256().update(bytes).digestHex()
      }
    try {
      await owner.beginTextField('transactions', 0, 'description', 64)
      await owner.appendTextField('transactions', 0, 'description', 0, bytes)
      // The physical hash matches the invalid original bytes. A hash-only
      // completion check would incorrectly accept this UTF-8 field.
      await rejects(() => owner.finishTextField('transactions', 0, descriptor))
      equal((await inspection.get('fields', ['transactions', 0, 'description'])).sha256, null)
      await rejects(() => owner.validateTextFields('transactions', 0, { description: descriptor }))
      await rejects(() => owner.beginTextField('transactions', 0, 'txid', 64))
      const copied = Object.create(Object.getPrototypeOf(owner)) as Brc38PrivateIdbStage
      await rejects(() => copied.readTextFieldChunks('transactions', 0, descriptor).next())
    } finally {
      inspection.close()
      await owner.discard(new Error('invalid persisted scalar cleanup'))
    }
  }
}
export async function verifyPrivateIdbRejectsExtraMetadataRecord(): Promise<void> {
  const f = options(),
    owner = await Brc38PrivateIdbStage.create(f.limits, f.binding, 4000),
    database = await openDB(owner.databaseName, 1)
  try {
    const original = await database.get('metadata', 1)
    await database.put('metadata', original, 2)
    await rejects(() => owner.count('outputs'))
    await database.delete('metadata', 2)
    equal(await owner.count('outputs'), 0)
  } finally {
    database.close()
    await owner.discard(new Error('case cleanup'))
  }
}
export async function verifyPrivateIdbDeletionDrain(): Promise<void> {
  const f = options(),
    owner = await Brc38PrivateIdbStage.create(f.limits, f.binding, 4000),
    other = await openDB(owner.databaseName, 1)
  try {
    let unblock: (() => void) | undefined
    const blocked = new Promise<void>(resolve => {
      unblock = resolve
    })
    other.addEventListener('versionchange', () => {
      void blocked.then(() => other.close())
    })
    const disposal = owner.discard(new Error('dispose'))
    // The deletion request is held by a genuine second native connection.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    unblock!()
    await disposal
    await rejects(() => Brc38PrivateIdbStage.resume(owner.databaseName, f.limits, f.binding, 4000))
  } finally {
    other.close()
    await owner.close()
    await deleteDB(owner.databaseName)
  }
}
export async function verifyExpiredPrivateIdbCleanup(): Promise<void> {
  const f = options(),
    limits = { ...f.limits, expiresAt: Date.now() + 1000 },
    owner = await Brc38PrivateIdbStage.create(limits, f.binding, 4000)
  await owner.close()
  await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, limits.expiresAt - Date.now()) + 1))
  await rejects(() => Brc38PrivateIdbStage.resume(owner.databaseName, limits, f.binding, 4000))
  await rejects(() =>
    Brc38PrivateIdbStage.discardReleased(owner.databaseName, limits, { ...f.binding, targetGeneration: 1 }, 4000)
  )
  await Brc38PrivateIdbStage.discardReleased(owner.databaseName, limits, f.binding, 4000)
  await rejects(() =>
    openDB(owner.databaseName, 1, {
      upgrade() {
        throw new Error('Private namespace was deleted')
      }
    })
  )
}
export async function verifyPrivateIdbDeletingRecovery(): Promise<void> {
  const f = options(),
    owner = await Brc38PrivateIdbStage.create(f.limits, f.binding, 4000)
  await owner.close()
  // A genuine durable deletion marker is independent input to the cleanup
  // recovery path. Actual worker termination remains separate host evidence.
  const database = await openDB(owner.databaseName, 1),
    tx = database.transaction('metadata', 'readwrite'),
    original = await tx.store.get(1)
  await tx.store.put({ ...original, state: 'deleting', owner: 'terminated-context' }, 1)
  await tx.done
  database.close()
  await rejects(() => Brc38PrivateIdbStage.resume(owner.databaseName, f.limits, f.binding, 4000))
  await Brc38PrivateIdbStage.discardReleased(owner.databaseName, f.limits, f.binding, 4000)
  await rejects(() =>
    openDB(owner.databaseName, 1, {
      upgrade() {
        throw new Error('Private namespace was deleted')
      }
    })
  )
}
export async function verifyPrivateIdbStreamedBinaryClosureAndReplay(): Promise<void> {
  const f = options(),
    data = f.data
  data.tables.outputs[0].lockingScript = 'UVFR'.repeat(32768)
  const stage = await Brc38PrivateIdbStage.create(f.limits, f.binding, 4000),
    policy = { maximumBinaryBytes: 262144, maximumChunkBytes: 4096 },
    input = new TextEncoder().encode(JSON.stringify(data))
  let owner = stage
  const parse = async (current: Brc38PrivateIdbStage) => {
    const semantic = new Brc38StreamedSemanticStage(current, {
        expectedIdentityKey: f.binding.identityKey,
        expectedChain: 'test',
        expectedSourceStorageIdentityKey: f.binding.sourceStorageIdentityKey,
        maximumRows: f.limits.maximumRows
      }),
      sink = brc38IdbStreamedFieldSink(
        current,
        policy,
        async (table, index, row) => await semantic.provisionalRow(table, index, row)
      )
    async function* source() {
      for (let offset = 0; offset < input.length; offset += 4096)
        yield Promise.resolve(input.slice(offset, offset + 4096))
    }
    await readBrc38JsonStream(
      source(),
      {
        streamedFields: sink,
        provisionalRow: () => {
          return promiseFromSync(() => {
            throw new Error('Binary metadata fell through to an ordinary row')
          })
        },
        validateCompleted: async (header, counts) => await semantic.validateCompleted(header, counts),
        discard: async cause => await current.discard(cause)
      },
      {
        maximumArchiveBytes: 1048576,
        maximumRowAllocationBytes: 1048576,
        maximumInputChunkBytes: 4096,
        maximumInputChunks: 1000,
        streamedFields: policy
      }
    )
  }
  try {
    await parse(owner)
    const row = await owner.streamedRow('outputs', 0),
      descriptor = row?.binaries.lockingScript,
      expected = new Uint8Array(98304).fill(0x51),
      nativeHash = new Uint8Array(await crypto.subtle.digest('SHA-256', expected)),
      digest = Array.from(nativeHash, byte => byte.toString(16).padStart(2, '0')).join('')
    if (
      descriptor?.bytes !== expected.length ||
      descriptor.sha256 !== digest ||
      row?.fields.lockingScript !== undefined
    )
      throw new Error('Independent native SHA/extent binary oracle differs')
    equal(await owner.binaryFieldDescriptor('outputs', 0, 'lockingScript'), descriptor)
    const profileId = crypto.randomUUID().replaceAll('-', ''),
      destination = new StorageIdb({
        ...StorageProvider.createStorageBaseOptions('test'),
        packed: { maximumLogicalBytes: 4194304, maximumRecords: 10000 },
        isolatedRestore: { profileId }
      }),
      working = new Brc38WorkingAllocation(1048576)
    try {
      await destination.migrate('Binary transfer fixture', f.binding.targetStorageIdentityKey)
      const inspection = await openDB(destination.dbName, 7)
      try {
        const before = await inspection.get(packedIdbStores.clock, 'clock'),
          refused = new Brc38WorkingAllocation(8192)
        await rejects(() =>
          prepareBrc38IdbRestoreBinary(owner, destination, 'outputs', 0, 'lockingScript', refused, f.limits.expiresAt)
        )
        equal(refused.used, 0)
        equal(await inspection.get(packedIdbStores.clock, 'clock'), before)
        const prepared = await prepareBrc38IdbRestoreBinary(
          owner,
          destination,
          'outputs',
          0,
          'lockingScript',
          working,
          f.limits.expiresAt
        )
        try {
          equal(prepared.original, descriptor)
          const content = prepared.staged.descriptor,
            stored = await inspection.get(packedIdbStores.contents, content.content)
          equal(
            [content.bytes, content.sha256, content.kind, stored.state, stored.refs],
            [expected.length, digest, 'array', 'sealed', 0]
          )
          if (stored.expiresAt > f.limits.expiresAt)
            throw new Error('Staged content renewed the original restore expiry')
          for (const [index, length] of [
            [0, 65536],
            [1, 32768]
          ]) {
            const chunk = await inspection.get(packedIdbStores.chunks, [content.content, index])
            if (
              !(chunk.data instanceof Uint8Array) ||
              chunk.data.length !== length ||
              chunk.data.some((byte: number) => byte !== 0x51)
            )
              throw new Error('Independent packed binary chunk differs')
          }
          // A retained first field must leave room for another descriptor and
          // transfer under the SAME original counter; no fresh ceiling.
          const second = await prepareBrc38IdbRestoreBinary(
            owner,
            destination,
            'provenTxs',
            0,
            'merklePath',
            working,
            f.limits.expiresAt
          )
          try {
            equal(working.used, 8192)
          } finally {
            await second.close()
          }
          equal(working.used, 4096)
        } finally {
          await prepared.close()
          await prepared.close()
        }
        equal(working.used, 0)
        await rejects(() =>
          prepareBrc38IdbRestoreBinary(owner, destination, 'outputs', 0, 'lockingScript', working, Date.now() - 1)
        )
        equal(working.used, 0)
      } finally {
        inspection.close()
      }
    } finally {
      await destination.destroy()
      await deleteDB(destination.dbName)
    }
    let count = 0
    for await (const chunk of owner.readBinaryFieldChunks('outputs', 0, descriptor)) {
      if (chunk.byteLength > 4096 || chunk.some(byte => byte !== 0x51))
        throw new Error('Private browser chunk content/bound differs')
      count += chunk.length
    }
    equal(count, expected.length)
    await rejects(() => owner.row('outputs', 0))
    await owner.close()
    owner = await Brc38PrivateIdbStage.resume(stage.databaseName, f.limits, f.binding, 4000)
    await parse(owner)
    equal((await owner.streamedRow('outputs', 0))?.binaries.lockingScript, descriptor)
  } finally {
    await owner.discard(new Error('case cleanup'))
  }
}
export async function verifyPrivateIdbBinaryReplayAndQuotaRefusal(): Promise<void> {
  const f = options(),
    owner = await Brc38PrivateIdbStage.create(f.limits, f.binding, 4000),
    bytes = new Uint8Array([1, 2, 3, 4]),
    descriptor = {
      field: 'lockingScript',
      encoding: 'base64' as const,
      bytes: bytes.length,
      sha256: new SHA256().update(bytes).digestHex()
    }
  try {
    await owner.beginBinaryField('outputs', 0, 'lockingScript', 'base64', 4)
    await rejects(() => owner.binaryFieldDescriptor('outputs', 0, 'lockingScript'))
    await owner.appendBinaryField('outputs', 0, 'lockingScript', 0, bytes)
    await owner.appendBinaryField('outputs', 0, 'lockingScript', 0, bytes)
    await rejects(() => owner.appendBinaryField('outputs', 0, 'lockingScript', 0, new Uint8Array([9, 2, 3, 4])))
    await rejects(() => owner.appendBinaryField('outputs', 0, 'lockingScript', 4, new Uint8Array([5])))
    await rejects(() => owner.finishBinaryField('outputs', 0, { ...descriptor, sha256: 'f'.repeat(64) }))
    await owner.finishBinaryField('outputs', 0, descriptor)
    await rejects(() => owner.appendBinaryField('outputs', 0, 'lockingScript', 4, new Uint8Array([5])))
    let original = 0
    for await (const chunk of owner.readBinaryFieldChunks('outputs', 0, descriptor)) {
      equal(Array.from(chunk), Array.from(bytes))
      original += chunk.length
    }
    equal(original, 4)
  } finally {
    await owner.discard(new Error('case cleanup'))
  }
}
