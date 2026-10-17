import { deleteDB, openDB } from 'idb'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import type { PackedIdbSchema } from '../idbPackedFields'
import { createSyncMap } from '../schema/entities/EntityBase'
import { Brc38WorkingAllocation } from '../portable/Brc38WorkingAllocation'
import type { Brc38JsonMemberIndex } from '../portable/Brc38StructuredJson'
import { IdbSnapshotSyncJournal } from './IdbSnapshotSyncJournal'
import { snapshotSyncTables, type SnapshotSyncSource } from './SnapshotSync'
import type { PackedIdbCurrentStructuredRead } from './PackedIdbCurrentStructuredRead'
import { Brc38PrivateIdbStage } from '../portable/Brc38PrivateIdbStage'
import { Brc38StreamedSemanticStage } from '../portable/Brc38StreamedSemanticStage'
import { semanticStageFixture } from '../portable/Brc38SemanticStageFixture'
import { readBrc38JsonStream } from '../portable/Brc38JsonStream'
import { brc38IdbStructuredFieldSink } from '../portable/Brc38IdbStructuredFieldSink'
import { brc38IdbStreamedFieldSink } from '../portable/Brc38IdbStreamedFieldSink'
import { prepareBrc38IdbOccupiedHistoryStage } from '../portable/Brc38IdbOccupiedHistoryStage'
import { EntityProvenTxReq } from '../schema/entities/EntityProvenTxReq'

function same(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Independent occupied-field oracle differs')
}
async function refused(action: () => Promise<unknown>): Promise<void> {
  let failed = false
  try {
    await action()
  } catch {
    failed = true
  }
  if (!failed) throw new Error('Occupied field admitted a stale row, primary, checkpoint or resource request')
}
function utf16(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length * 2)
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    bytes[2 * i] = unit & 255
    bytes[2 * i + 1] = unit >>> 8
  }
  return bytes
}
/** Actual browser transactions, synthetic session advancement. This case does
 * not authenticate an archive, prove source semantics, merge entities or
 * activate a primary. Emulated import and real browser execution are separate. */
export async function verifyOccupiedPackedIdbStructuredField(expiresAt: number): Promise<void> {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 120000)
    throw new Error('Original finite occupied-field case deadline is required')
  const deadline = performance.now() + expiresAt - Date.now(),
    check = () => {
      if (Date.now() >= expiresAt || performance.now() >= deadline)
        throw new Error('Original occupied-field deadline ended')
    },
    storage = new StorageIdb({
      ...StorageProvider.createStorageBaseOptions('test'),
      packed: {
        maximumLogicalBytes: 16777216,
        maximumRecords: 10000
      }
    }),
    identityKey = '02' + '11'.repeat(32),
    dates = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') },
    user = { ...dates, userId: 1, identityKey, activeStorage: 'target' },
    txid = 'aa'.repeat(32),
    history = JSON.stringify({ notes: [{ when: '2026-01-01T00:00:00.000Z', what: 'A'.repeat(90000) }] }),
    expected = utf16(history),
    working = new Brc38WorkingAllocation(16777216),
    limits = {
      maximumMetadataBytes: 65536,
      maximumStructuredBytes: 1048576,
      maximumReadBytes: 65536,
      maximumTemporaryIndexBytes: 2097152,
      maximumGrammarIndexBytes: 1048576,
      maximumIndexMembers: 1000,
      expiresAt
    }
  storage.dbName = 'packed-current-structured-' + crypto.randomUUID()
  let reader: PackedIdbCurrentStructuredRead | undefined
  const indexes = new Set<Brc38JsonMemberIndex>()
  try {
    check()
    await storage.migrate('Independent occupied field fixture', 'target')
    await storage.db!.put('users', user)
    const transaction = {
      ...dates,
      transactionId: 1,
      userId: 1,
      txid,
      reference: 'existing',
      status: 'completed' as const,
      isOutgoing: true,
      satoshis: 0,
      description: 'Existing source closure'
    }
    await storage.db!.put('transactions', transaction)
    const request = {
      ...dates,
      provenTxReqId: 9,
      txid,
      status: 'completed' as const,
      rawTx: [],
      attempts: 0,
      notified: true,
      history,
      notify: JSON.stringify({ transactionIds: [1] })
    }
    await storage.db!.put('proven_tx_reqs', request)
    const source: SnapshotSyncSource = {
        version: 1,
        snapshotId: 'bb'.repeat(32),
        expiresAt,
        sourceStorage: { ...(await storage.readSettings()), storageIdentityKey: 'source' },
        user: { ...user, userId: 77 }
      },
      journal = await IdbSnapshotSyncJournal.open(storage)
    let cp = await journal.begin(source, 'target')
    while (cp.tableIndex < snapshotSyncTables.indexOf('provenTxReqs')) {
      cp = (
        await journal.commit(cp, cp.tableIndex + 1, null, async writer => {
          if (snapshotSyncTables[cp.tableIndex] === 'transactions') {
            const loaded = await writer.loadMappings('transactions', {
              fromStorageIdentityKey: 'source',
              toStorageIdentityKey: 'target',
              userIdentityKey: identityKey,
              transactions: [{ ...transaction, userId: 77, transactionId: 41 }]
            })
            loaded.map.transaction.idMap[41] = 1
            await loaded.persist()
          }
          return { inserts: 0, updates: 0 }
        })
      ).checkpoint
    }
    const incomingIds = [41, 0, -1, 42, 41],
      mappingRead = journal.readNotificationMappings(cp, incomingIds, 65536)
    incomingIds[0] = 42
    same(await mappingRead, [1, undefined, undefined, undefined, 1])
    await refused(() => journal.readNotificationMappings(cp, [41], 1))
    const identity = { table: 'provenTxReqs' as const, txid },
      map = createSyncMap(),
      selected = { ...limits }
    const acquisition = journal.openCurrentStructuredField(cp, identity, map, 'history', selected, working)
    selected.maximumReadBytes = 1
    identity.txid = 'ff'.repeat(32)
    reader = await acquisition
    same(reader.metadata.fields.provenTxReqId, 9)
    same(reader.source.encoding, 'utf16le')
    same(reader.source.length, expected.length)
    same(reader.source.sha256, new SHA256().update(expected).digestHex())
    const first = await reader.source.read(65530, 17)
    same([...first], Array.from(expected.slice(65530, 65547)))
    const second = await reader.source.read(0, 16)
    same(
      [...first],
      Array.from({ length: 17 }, () => 0)
    )
    same([...second], Array.from(expected.slice(0, 16)))
    await refused(() => reader!.source.read(0, 65537))
    const one = await reader.source.openIndex()
    indexes.add(one)
    const indexPolicy = {
      sourceBytes: expected.length,
      maximumTemporaryIndexBytes: 1048576,
      maximumTemporaryPhysicalBytes: 1048576,
      maximumMembers: 1000,
      maximumAllocationBytes: working.maximum,
      workingAllocation: working,
      expiresAt
    }
    const two = await reader.openIndex(indexPolicy)
    indexes.add(two)
    await refused(() => reader!.openIndex(indexPolicy))
    await one.put(0, { key: 'notes', keyOffset: 2, start: 18, end: expected.length - 2 })
    await one.seal()
    const records = []
    for await (const record of one.entries(0)) records.push(record)
    same(records.length, 1)
    await one.close()
    indexes.delete(one)
    const replacement = await reader.openIndex(indexPolicy)
    indexes.add(replacement)
    // Retention still holds the old bytes, but a changed current target cannot
    // be used as the current occupied merge input or extend this preparation.
    await storage.db!.put('proven_tx_reqs', { ...request, history: history.replace('AAAA', 'BBBB') })
    await refused(() => reader!.source.read(0, 16))
    await refused(() => two.put(0, { key: 'stale', keyOffset: 2, start: 18, end: 20 }))
    await reader.close()
    same(working.used, 0)
    indexes.clear()
    reader = undefined
    await refused(() =>
      journal.openCurrentStructuredField(
        { ...cp, sequence: cp.sequence + 1 },
        { table: 'provenTxReqs', txid },
        map,
        'history',
        limits,
        working
      )
    )
    same(working.used, 0)
    reader = await journal.openCurrentStructuredField(
      cp,
      { table: 'provenTxReqs', txid },
      map,
      'history',
      limits,
      working
    )
    await storage.db!.put('users', { ...user, activeStorage: 'away' })
    await storage.db!.put('users', user)
    await refused(() => reader!.source.read(0, 16))
    await reader.close()
    same(working.used, 0)
    reader = undefined
    await refused(() => journal.readNotificationMappings(cp, [41], 65536))
    const inspection = await openDB<PackedIdbSchema>(storage.dbName, 7)
    try {
      same(await inspection.count('_wallet_packed_json_stages'), 0)
      same(await inspection.count('_wallet_packed_json_members'), 0)
      same(await inspection.count('_wallet_packed_leases'), 0)
    } finally {
      inspection.close()
    }
    check()
  } finally {
    try {
      for (const index of indexes) await index.close()
      await reader?.close()
    } finally {
      try {
        await storage.destroy()
      } finally {
        await deleteDB(storage.dbName)
      }
    }
  }
}

/** Genuine private source, occupied operational journal and physical staged
 * UTF16 postimage. This prepares bytes only: it grants no archive authentication,
 * destination commit, provenance adoption or primary activation. */
export async function verifyOccupiedPackedIdbHistoryStaging(): Promise<void> {
  const expiresAt = Date.now() + 30000,
    identityKey = '02' + '11'.repeat(32),
    txid = 'aa'.repeat(32),
    working = new Brc38WorkingAllocation(16777216),
    storage = new StorageIdb({
      ...StorageProvider.createStorageBaseOptions('test'),
      packed: { maximumLogicalBytes: 16777216, maximumRecords: 10000 }
    }),
    dates = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-02') },
    prior = { notes: [{ when: '2026-01-01T00:00:00.000Z', what: 'A'.repeat(33000) }], local: null },
    incoming = { notes: [{ when: '2026-01-02T00:00:00.000Z', what: 'B'.repeat(33000) }], ignored: true },
    data = semanticStageFixture()
  storage.dbName = 'occupied-history-stage-' + crypto.randomUUID()
  data.user.identityKey = identityKey
  data.sourceStorage.storageIdentityKey = 'source'
  data.tables.provenTxReqs[0].txid = txid
  data.tables.provenTxReqs[0].history = incoming
  const sourceLimits = {
      maximumRows: 1000,
      maximumLogicalBytes: 4194304,
      maximumPhysicalBytes: 8388608,
      maximumRowBytes: 65536,
      maximumRowAllocationBytes: 1048576,
      expiresAt
    },
    stage = await Brc38PrivateIdbStage.create(
      sourceLimits,
      {
        archiveSha256: 'c'.repeat(64),
        identityKey,
        chain: 'test',
        sourceStorageIdentityKey: 'source',
        targetStorageIdentityKey: 'target',
        targetGeneration: 0
      },
      4000
    ),
    sourcePolicy = {
      databaseName: stage.databaseName,
      maximumTemporaryIndexBytes: 1048576,
      maximumIndexMembers: 1000,
      maximumStructuredBytes: 1048576,
      maximumCanonicalBytes: 1048576
    },
    fieldPolicy = { maximumStructuredBytes: 1048576, maximumChunkBytes: 4096 }
  let prepared: Awaited<ReturnType<typeof prepareBrc38IdbOccupiedHistoryStage>> | undefined
  try {
    const semantic = new Brc38StreamedSemanticStage(
        stage,
        {
          expectedIdentityKey: identityKey,
          expectedChain: 'test',
          expectedSourceStorageIdentityKey: 'source',
          maximumRows: 1000
        },
        undefined,
        sourcePolicy
      ),
      row = async (
        table: Parameters<typeof semantic.provisionalRow>[0],
        index: number,
        value: Parameters<typeof semantic.provisionalRow>[2]
      ) => await semantic.provisionalRow(table, index, value),
      sink = brc38IdbStructuredFieldSink(stage, fieldPolicy, row),
      binaryPolicy = { maximumBinaryBytes: 262144, maximumChunkBytes: 4096 },
      bytes = new TextEncoder().encode(JSON.stringify(data))
    async function* chunks() {
      for (let at = 0; at < bytes.length; at += 4096) yield bytes.slice(at, at + 4096)
    }
    await readBrc38JsonStream(
      chunks(),
      {
        streamedStructuredFields: sink,
        streamedFields: brc38IdbStreamedFieldSink(stage, binaryPolicy, row),
        provisionalRow: async () => {
          throw new Error('Private streamed fixture fell through to a materialized row')
        },
        validateCompleted: async (header, counts) => await semantic.validateCompleted(header, counts),
        discard: async cause => await stage.discard(cause)
      },
      {
        maximumArchiveBytes: 1048576,
        maximumRowAllocationBytes: 1048576,
        maximumInputChunkBytes: 4096,
        maximumInputChunks: 1000,
        streamedStructuredFields: fieldPolicy,
        streamedFields: binaryPolicy
      }
    )
    bytes.fill(0)
    await storage.migrate('Occupied history staging fixture', 'target')
    const user = { ...dates, userId: 1, identityKey, activeStorage: 'target' },
      request = {
        ...dates,
        provenTxReqId: 9,
        txid,
        status: 'completed' as const,
        rawTx: [],
        attempts: 0,
        notified: true,
        history: JSON.stringify(prior),
        notify: '{}'
      }
    await storage.db!.put('users', user)
    await storage.db!.put('proven_tx_reqs', request)
    const journal = await IdbSnapshotSyncJournal.open(storage)
    let checkpoint = await journal.begin(
      {
        version: 1,
        snapshotId: 'bb'.repeat(32),
        expiresAt,
        sourceStorage: { ...(await storage.readSettings()), storageIdentityKey: 'source' },
        user: { ...user, userId: 77 }
      },
      'target'
    )
    while (checkpoint.tableIndex < snapshotSyncTables.indexOf('provenTxReqs'))
      checkpoint = (
        await journal.commit(checkpoint, checkpoint.tableIndex + 1, null, async () => ({ inserts: 0, updates: 0 }))
      ).checkpoint
    const currentPolicy = {
        maximumMetadataBytes: 65536,
        maximumStructuredBytes: 1048576,
        maximumReadBytes: 4096,
        maximumTemporaryIndexBytes: 8388608,
        maximumGrammarIndexBytes: 1048576,
        maximumIndexMembers: 1000,
        expiresAt
      },
      projection = {
        maximumTemporaryIndexBytes: 6291456,
        maximumMembers: 1000,
        maximumOutputBytes: 1048576,
        maximumIndexAllocationBytes: 1048576,
        maximumGrammarAllocationBytes: 1048576,
        maximumReadBytes: 4096,
        workingAllocation: working,
        expiresAt
      },
      legacy = new EntityProvenTxReq({ ...request })
    // A global proof request alone is outside this user's retained closure.
    // Preserve that refusal, then establish the actual occupied transaction
    // relationship required by the positive history preparation fixture.
    let orphan: PackedIdbCurrentStructuredRead | undefined
    try {
      await refused(async () => {
        orphan = await journal.openCurrentStructuredField(
          checkpoint,
          { table: 'provenTxReqs', txid },
          createSyncMap(),
          'history',
          currentPolicy,
          working
        )
        return await orphan.source.read(0, 2)
      })
    } finally {
      await orphan?.close()
    }
    same(working.used, 0)
    await storage.db!.put('transactions', {
      ...dates,
      transactionId: 1,
      userId: 1,
      txid,
      reference: 'occupied-history-target',
      status: 'completed',
      isOutgoing: true,
      satoshis: 0,
      description: 'Original occupied request closure'
    })
    legacy.mergeHistory({ ...request, history: JSON.stringify(incoming) })
    const expected = utf16(JSON.stringify(legacy.history)),
      hash = new SHA256().update(expected).digestHex()
    prepared = await prepareBrc38IdbOccupiedHistoryStage(
      stage,
      0,
      storage,
      journal,
      checkpoint,
      txid,
      sourcePolicy,
      currentPolicy,
      projection,
      1048576
    )
    same(prepared.addedNotes, 1)
    same(prepared.bytes, expected.length)
    same(prepared.sha256, hash)
    const descriptor = prepared.staged.descriptor
    same(
      { kind: descriptor.kind, bytes: descriptor.bytes, sha256: descriptor.sha256 },
      { kind: 'utf16', bytes: expected.length, sha256: hash }
    )
    // Read the actual sealed content, rather than trusting a copied descriptor
    // or repeating the implementation's measurement as the oracle.
    for (let offset = 0; offset < expected.length; offset += 4096) {
      const actual = await prepared.staged.read(offset, Math.min(4096, expected.length - offset))
      try {
        same([...actual], Array.from(expected.slice(offset, offset + actual.length)))
      } finally {
        actual.fill(0)
      }
    }
    same((await storage.db!.get('proven_tx_reqs', 9))!.history, request.history)
    await prepared.close()
    prepared = undefined
    same(working.used, 0)
    same(await journal.checkpoint(identityKey, 'source'), checkpoint)
  } finally {
    try {
      await prepared?.close()
    } finally {
      try {
        await stage.discard(new Error('occupied history staging fixture cleanup'))
      } finally {
        try {
          await storage.destroy()
        } finally {
          await deleteDB(storage.dbName)
        }
      }
    }
  }
}
