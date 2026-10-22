import { promiseFromSync } from '../../utility/promiseFromSync'
import { Brc38PrivateIdbStage } from './Brc38PrivateIdbStage'
import { Brc38StreamedSemanticStage } from './Brc38StreamedSemanticStage'
import { brc38IdbStreamedFieldSink } from './Brc38IdbStreamedFieldSink'
import { brc38IdbStructuredFieldSink } from './Brc38IdbStructuredFieldSink'
import { readBrc38JsonStream } from './Brc38JsonStream'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import { brc38StageTables } from './Brc38SemanticStage'
import { openDB } from 'idb'
import { deleteDB } from 'idb'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { getPackedIdbConnection } from '../idbPackedConnection'
import { Brc38IdbImportJournal } from './Brc38IdbImportJournal'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { prepareBrc38IdbStructuredHistory } from './Brc38IdbStructuredHistory'
import { prepareBrc38IdbRestoreText } from './Brc38IdbRestoreText'
import { packedIdbStores } from '../idbPackedFields'
import type { Brc38ImportJournalAdmission, Brc38ImportJournalStep } from './Brc38ImportJournalContract'

// Authored UNRUN. Real browser IndexedDB/Web Locks only. Materializing these
// bounded fixture oracles does not qualify production memory or host recovery.
function setup() {
  const data = semanticStageFixture(),
    limits = {
      maximumRows: 1000,
      maximumLogicalBytes: 8388608,
      maximumPhysicalBytes: 16777216,
      maximumRowBytes: 65536,
      maximumRowAllocationBytes: 1048576,
      expiresAt: Date.now() + 180000
    },
    binding = {
      archiveSha256: 'a'.repeat(64),
      identityKey: String(data.user.identityKey),
      chain: 'test' as const,
      sourceStorageIdentityKey: String(data.sourceStorage.storageIdentityKey),
      targetStorageIdentityKey: 'private-browser-target',
      targetGeneration: 0
    }
  const history = { notes: [{ when: '2026-09-30T00:00:00.000Z', what: 'x'.repeat(100000) }] }
  data.tables.provenTxReqs[0].history = history
  const visibleNotify = { transactionIds: [14, 999], unicode: { '😀': 1, 雪: 2 } },
    rawNotify = '{"transactionIds":[null],"transactionIds":[14,999],"unicode":{"😀":1,"雪":2}}',
    body = JSON.stringify(data).replace(
      '"notify":' + JSON.stringify(data.tables.provenTxReqs[0].notify),
      '"notify":' + rawNotify
    )
  if (!body.includes(rawNotify)) throw new Error('Independent raw duplicate-key fixture was not constructed')
  return { data, limits, binding, history, visibleNotify, rawNotify, body }
}
async function parse(owner: Brc38PrivateIdbStage, f: ReturnType<typeof setup>, body = f.body) {
  const structured = { maximumStructuredBytes: 262144, maximumChunkBytes: 4096 },
    policy = {
      databaseName: owner.databaseName,
      maximumTemporaryIndexBytes: 1048576,
      maximumIndexMembers: 1000,
      maximumStructuredBytes: 262144,
      maximumCanonicalBytes: 262144
    },
    semantic = new Brc38StreamedSemanticStage(
      owner,
      {
        expectedIdentityKey: f.binding.identityKey,
        expectedChain: 'test',
        expectedSourceStorageIdentityKey: f.binding.sourceStorageIdentityKey,
        maximumRows: f.limits.maximumRows
      },
      undefined,
      policy
    ),
    row = async (
      table: Parameters<typeof semantic.provisionalRow>[0],
      index: number,
      value: Parameters<typeof semantic.provisionalRow>[2]
    ) => await semantic.provisionalRow(table, index, value),
    binary = { maximumBinaryBytes: 262144, maximumChunkBytes: 4096 },
    input = new TextEncoder().encode(body)
  async function* source() {
    for (let at = 0; at < input.length; at += 4096) yield Promise.resolve(input.slice(at, at + 4096))
  }
  await readBrc38JsonStream(
    source(),
    {
      streamedFields: brc38IdbStreamedFieldSink(owner, binary, row),
      streamedStructuredFields: brc38IdbStructuredFieldSink(owner, structured, row),
      provisionalRow: () => {
        return promiseFromSync(() => {
          throw new Error('Structured row fell through to materialized staging')
        })
      },
      validateCompleted: async (header, counts) => await semantic.validateCompleted(header, counts),
      discard: async cause => await owner.discard(cause)
    },
    {
      maximumArchiveBytes: 1048576,
      maximumRowAllocationBytes: 1048576,
      maximumInputChunkBytes: 4096,
      maximumInputChunks: 1000,
      streamedFields: binary,
      streamedStructuredFields: structured
    }
  )
}
async function raw(owner: Brc38PrivateIdbStage, field: string) {
  const descriptor = (await owner.streamedRow('provenTxReqs', 0))?.structured?.[field]
  if (descriptor === undefined) throw new Error('Actual browser structured descriptor is missing')
  const decoder = new TextDecoder('utf-8', { fatal: true }),
    parts: string[] = []
  for await (const chunk of owner.readStructuredFieldChunks('provenTxReqs', 0, descriptor)) {
    if (chunk.length > 4096) throw new Error('Actual browser structured chunk exceeds its original bound')
    parts.push(decoder.decode(chunk, { stream: true }))
  }
  parts.push(decoder.decode())
  return { text: parts.join(''), descriptor }
}
export async function verifyBrowserStructuredClosureDuplicateSelectionAndReplay(): Promise<void> {
  const f = setup(),
    stage = await Brc38PrivateIdbStage.create(f.limits, f.binding, 4000)
  let owner = stage
  try {
    await parse(owner, f)
    const notify = await raw(owner, 'notify'),
      history = await raw(owner, 'history'),
      native = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(f.rawNotify))),
      hash = Array.from(native, byte => byte.toString(16).padStart(2, '0')).join('')
    if (
      notify.text !== f.rawNotify ||
      notify.descriptor.sha256 !== hash ||
      JSON.stringify(JSON.parse(notify.text)) !== JSON.stringify(f.visibleNotify) ||
      JSON.stringify(JSON.parse(history.text)) !== JSON.stringify(f.history)
    )
      throw new Error('Independent raw/visible browser structured oracle differs')
    for (const table of brc38StageTables)
      if ((await owner.count(table)) !== f.data.tables[table].length)
        throw new Error('All-thirteen browser structured closure count differs')
    await owner.close()
    owner = await Brc38PrivateIdbStage.resume(stage.databaseName, f.limits, f.binding, 4000)
    await parse(owner, f)
    if ((await raw(owner, 'notify')).text !== notify.text) throw new Error('Original structured browser replay differs')
  } finally {
    await owner.discard(new Error('case cleanup'))
  }
}
export async function verifyBrowserStructuredVisibleNullRefusal(): Promise<void> {
  const f = setup(),
    owner = await Brc38PrivateIdbStage.create(f.limits, f.binding, 4000),
    invalid = f.body.replace(f.rawNotify, '{"transactionIds":[14,null]}')
  let failed = false
  try {
    await parse(owner, f, invalid)
  } catch {
    failed = true
  } finally {
    await owner.close()
  }
  if (!failed) throw new Error('Visible null array element was admitted by browser structured semantics')
}
export async function verifyBrowserStructuredStaleIndexRetirement(): Promise<void> {
  const f = setup(),
    stage = await Brc38PrivateIdbStage.create(f.limits, f.binding, 4000)
  let owner = stage
  let released = false
  try {
    await parse(owner, f)
    const descriptor = (await raw(owner, 'notify')).descriptor
    await owner.close()
    released = true
    // Independent durable scratch input using actual native stores. This is
    // source recovery coverage, not actual worker-termination qualification.
    const database = await openDB(stage.databaseName, 1),
      tx = database.transaction(['metadata', 'jsonIndexes', 'jsonMembers'], 'readwrite'),
      meta = await tx.objectStore('metadata').get(1),
      id = '0'.repeat(32),
      key = 'transactionIds',
      charge = 256 + 2 * key.length,
      keyOffset = f.rawNotify.lastIndexOf('"transactionIds"'),
      start = f.rawNotify.indexOf('[14,999]'),
      end = start + '[14,999]'.length
    await tx.objectStore('jsonIndexes').add(
      {
        table: 'provenTxReqs',
        position: 0,
        field: 'notify',
        sourceBytes: descriptor.bytes,
        sha256: descriptor.sha256,
        maximumBytes: 1048576,
        maximumMembers: 1000,
        members: 1,
        bytes: charge,
        state: 'sealed'
      },
      id
    )
    await tx
      .objectStore('jsonMembers')
      .add({ key, keyOffset, start, end, firstKeyOffset: f.rawNotify.indexOf('"transactionIds"'), charge }, [
        id,
        0,
        key
      ])
    await tx.objectStore('metadata').put(
      {
        ...meta,
        jsonIndexes: meta.jsonIndexes + 1,
        jsonMembers: meta.jsonMembers + 1,
        logicalBytes: meta.logicalBytes + 512 + charge
      },
      1
    )
    await tx.done
    database.close()
    owner = await Brc38PrivateIdbStage.resume(stage.databaseName, f.limits, f.binding, 4000)
    await parse(owner, f)
    if ((await raw(owner, 'notify')).text !== f.rawNotify)
      throw new Error('Stale-index retirement changed original field bytes')
  } finally {
    if (owner === stage && released)
      await Brc38PrivateIdbStage.discardReleased(stage.databaseName, f.limits, f.binding, 4000)
    else await owner.discard(new Error('case cleanup'))
  }
}

async function independentDigest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
async function historyJournal(f: ReturnType<typeof setup>, maximumWorking = 4194304) {
  const profileId = crypto.randomUUID().replaceAll('-', ''),
    storage = new StorageIdb({
      ...StorageProvider.createStorageBaseOptions('test'),
      isolatedRestore: { profileId },
      packed: { maximumLogicalBytes: 8388608, maximumRecords: 10000 }
    }),
    initial = await independentDigest('independent empty history fixture'),
    working = new Brc38WorkingAllocation(maximumWorking),
    admission: Brc38ImportJournalAdmission = {
      scope: {
        importId: crypto.randomUUID(),
        bindingSha256: await independentDigest('history fixture binding'),
        archiveSha256: await independentDigest('fixture only, no encrypted source authentication'),
        userId: 1
      },
      previewId: crypto.randomUUID(),
      expiresAt: f.limits.expiresAt,
      originalLimitsJson: JSON.stringify([1000, 8388608, 16777216, 65536, maximumWorking, f.limits.expiresAt]),
      initialDestinationSha256: initial,
      totalRows: 2,
      maximumStepRows: 1,
      maximumStepBytes: 65536,
      maximumMappedIds: 1,
      maximumJournalLogicalBytes: 8192
    }
  let ownedJournal: Brc38IdbImportJournal | undefined
  try {
    await storage.migrate('Actual inactive browser history fixture', f.binding.targetStorageIdentityKey)
    const owner = getPackedIdbConnection(storage.db!)
    if (owner === undefined) throw new Error('Actual isolated provider is missing')
    const journal = await Brc38IdbImportJournal.open(owner, admission, {
      profile: {
        chain: 'test',
        identityKey: f.binding.identityKey,
        targetStorageIdentityKey: f.binding.targetStorageIdentityKey
      },
      maximumOriginalLogicalBytes: 8388608,
      maximumOriginalRowBytes: 65536,
      workingAllocation: working
    })
    ownedJournal = journal
    const user = {
        userId: 1,
        identityKey: f.binding.identityKey,
        activeStorage: '',
        created_at: new Date('2026-01-01'),
        updated_at: new Date('2026-01-01')
      },
      transaction = {
        ...f.data.tables.transactions[0],
        transactionId: 4,
        userId: 1,
        created_at: new Date(f.data.tables.transactions[0].created_at as string),
        updated_at: new Date(f.data.tables.transactions[0].updated_at as string)
      },
      originalHeader = JSON.stringify({ identityKey: f.binding.identityKey }),
      originalRow = JSON.stringify({ originalTransactionId: 14 }),
      headerStep: Brc38ImportJournalStep = {
        fromRow: 0,
        rows: 1,
        bytes: new TextEncoder().encode(originalHeader).length,
        mappedIds: 0,
        pageSha256: await independentDigest(originalHeader)
      },
      rowStep: Brc38ImportJournalStep = {
        fromRow: 1,
        rows: 1,
        bytes: new TextEncoder().encode(originalRow).length,
        mappedIds: 1,
        pageSha256: await independentDigest(originalRow)
      },
      prepared = await journal.prepare(initial),
      headerHash = await independentDigest('independent fixture user'),
      header = await journal.commit(headerStep, prepared.destinationSha256, async writer => {
        await writer.transaction.objectStore('users').add(user)
        await writer.original('header', 0, originalHeader)
        return headerHash
      }),
      finalHash = await independentDigest('independent fixture transaction'),
      complete = await journal.commit(rowStep, header.destinationSha256, async writer => {
        await writer.transaction.objectStore('transactions').add(transaction)
        await writer.map('transaction', 14, 4)
        await writer.original('transactions', 0, originalRow)
        return finalHash
      })
    return { storage, journal, working, header, complete }
  } catch (cause) {
    await ownedJournal?.close()
    await storage.destroy()
    await deleteDB(storage.dbName)
    throw cause
  }
}

/** Actual native browser integration, authored UNRUN. Fixture journals and
 * plaintext stages do not claim encrypted-source or activation qualification. */
export async function verifyBrowserLargeHistoryProjectionAndCurrentJournal(): Promise<void> {
  const f = setup()
  f.limits.maximumRowAllocationBytes = 4194304
  const largeNotify =
      '{"transactionIds":[null],"transactionIds":[14,999,14],"memo":' + JSON.stringify('雪'.repeat(24000)) + '}',
    syncMap = {
      transaction: {
        entityName: 'archived ' + 'x'.repeat(70000),
        count: 7,
        maxUpdated_at: '2026-01-01',
        idMap: { '1': 999, '01': 14, '-5': 14 }
      }
    },
    body = f.body
      .replace(f.rawNotify, largeNotify)
      .replace(
        '"syncMap":' + JSON.stringify(f.data.tables.syncStates[0].syncMap),
        '"syncMap":' + JSON.stringify(syncMap)
      ),
    stage = await Brc38PrivateIdbStage.create(f.limits, f.binding, 4000)
  let fixture: Awaited<ReturnType<typeof historyJournal>> | undefined
  try {
    await parse(stage, f, body)
    fixture = await historyJournal(f)
    const sourcePolicy = {
        databaseName: stage.databaseName,
        maximumTemporaryIndexBytes: 4194304,
        maximumIndexMembers: 1000,
        maximumStructuredBytes: 262144,
        maximumCanonicalBytes: 262144
      },
      policy = {
        maximumTemporaryIndexBytes: 2097152,
        maximumMembers: 1000,
        maximumOutputBytes: 262144,
        maximumIndexAllocationBytes: 1048576,
        maximumGrammarAllocationBytes: 1048576,
        workingAllocation: fixture.working,
        maximumReadBytes: 4096,
        expiresAt: f.limits.expiresAt
      },
      inspection = await openDB(fixture.storage.dbName, 7),
      before = await inspection.get('_wallet_packed_clock', 'clock')
    inspection.close()
    const collect = async (field: 'notify' | 'syncMap') => {
      const projection = await prepareBrc38IdbStructuredHistory(
        stage,
        fixture!.journal,
        fixture!.complete,
        field === 'notify' ? 'provenTxReqs' : 'syncStates',
        0,
        field,
        sourcePolicy,
        { ...policy, maximumScalarBytes: 4096 }
      )
      const decoder = new TextDecoder('utf-8', { fatal: true }),
        parts: string[] = [],
        missing = projection.unmappedIds
      try {
        for await (const bytes of projection.chunks(4096)) {
          if (bytes.length > 4096) throw new Error('Large history exceeded its original transfer window')
          parts.push(decoder.decode(bytes, { stream: true }))
        }
        parts.push(decoder.decode())
        return { value: JSON.parse(parts.join('')), missing }
      } finally {
        await projection.close()
      }
    }
    const notify = await collect('notify'),
      map = await collect('syncMap')
    if (
      JSON.stringify(notify.value) !== JSON.stringify({ memo: '雪'.repeat(24000), transactionIds: [4] }) ||
      notify.missing !== 1
    )
      throw new Error('Independent large duplicate-key notification projection differs')
    if (
      JSON.stringify(map.value.transaction) !==
        JSON.stringify({
          count: 7,
          entityName: syncMap.transaction.entityName,
          idMap: { '1': 4, '-5': 4 },
          maxUpdated_at: '2026-01-01T00:00:00.000Z'
        }) ||
      map.missing !== 0 ||
      Object.keys(map.value).length !== 12
    )
      throw new Error('Independent large sync-map normalized enumeration projection differs')
    if ((await raw(stage, 'notify')).text !== largeNotify || fixture.working.used !== 0)
      throw new Error('Large history changed original provenance or retained a released allocation')
    await stage.sealedMetadata()
    const after = await openDB(fixture.storage.dbName, 7)
    try {
      if (JSON.stringify(await after.get('_wallet_packed_clock', 'clock')) !== JSON.stringify(before))
        throw new Error('Readonly history preparation changed the actual destination clock')
    } finally {
      after.close()
    }
    let staleRefused = false
    try {
      await prepareBrc38IdbStructuredHistory(
        stage,
        fixture.journal,
        fixture.header,
        'provenTxReqs',
        0,
        'notify',
        sourcePolicy,
        policy
      )
    } catch {
      staleRefused = true
    }
    if (!staleRefused || fixture.working.used !== 0)
      throw new Error('Stale structured preparation or failed-allocation cleanup differs')
  } finally {
    await stage.discard(new Error('actual browser history fixture cleanup'))
    if (fixture !== undefined) {
      await fixture.journal.close()
      await fixture.storage.destroy()
      await deleteDB(fixture.storage.dbName)
    }
  }
}

export async function verifyBrowserStructuredReaderRevocationAndOriginalLimit(): Promise<void> {
  const f = setup()
  f.limits.maximumRowAllocationBytes = 4194304
  const stage = await Brc38PrivateIdbStage.create(f.limits, f.binding, 4000),
    working = new Brc38WorkingAllocation(f.limits.maximumRowAllocationBytes),
    policy = {
      databaseName: stage.databaseName,
      maximumTemporaryIndexBytes: 1048576,
      maximumIndexMembers: 1000,
      maximumStructuredBytes: 262144,
      maximumCanonicalBytes: 262144
    }
  try {
    await parse(stage, f)
    let refused = false
    try {
      await stage.openStructuredField(
        'provenTxReqs',
        0,
        'notify',
        policy,
        new Brc38WorkingAllocation(8192),
        f.limits.expiresAt
      )
    } catch {
      refused = true
    }
    if (!refused) throw new Error('Native metadata read bypassed its original resource ceiling')
    const reader = await stage.openStructuredField('provenTxReqs', 0, 'notify', policy, working, f.limits.expiresAt),
      index = await reader.source.openIndex()
    await index.put(0, { key: 'actual', keyOffset: 1, start: 2, end: 3 })
    await index.seal()
    const entries = index.entries(0)[Symbol.asyncIterator]()
    if ((await entries.next()).value?.key !== 'actual' || working.used === 0)
      throw new Error('Native retained index member was not bounded')
    await reader.close()
    await reader.close()
    if (working.used !== 0) throw new Error('Reader close did not drain its actual iterator/index allocation')
    refused = false
    try {
      await reader.source.read(0, 2)
    } catch {
      refused = true
    }
    if (!refused || !(await entries.next()).done) throw new Error('Closed reader resumed source or retained output')
    await stage.sealedMetadata()
  } finally {
    await stage.discard(new Error('actual structured reader cleanup'))
  }
}

export async function verifyBrowserLargeOriginalAndMappedUtf16Staging(): Promise<void> {
  const f = setup()
  f.limits.maximumRowAllocationBytes = 8388608
  // Keep the whitespace within the structured value. Whitespace outside its
  // braces belongs to the containing archive grammar, not the field span.
  const rawNotify =
      '{ "transactionIds":[null],"transactionIds":[14,999,14],"memo":' + JSON.stringify('😀雪'.repeat(16000)) + ' }',
    stage = await Brc38PrivateIdbStage.create(f.limits, f.binding, 4000)
  let fixture: Awaited<ReturnType<typeof historyJournal>> | undefined
  try {
    await parse(stage, f, f.body.replace(f.rawNotify, rawNotify))
    fixture = await historyJournal(f, 8388608)
    const sourcePolicy = {
        databaseName: stage.databaseName,
        maximumTemporaryIndexBytes: 4194304,
        maximumIndexMembers: 1000,
        maximumStructuredBytes: 262144,
        maximumCanonicalBytes: 262144
      },
      policy = {
        maximumTemporaryIndexBytes: 2097152,
        maximumMembers: 1000,
        maximumOutputBytes: 262144,
        maximumScalarBytes: 4096,
        maximumIndexAllocationBytes: 1048576,
        maximumGrammarAllocationBytes: 1048576,
        workingAllocation: fixture.working,
        maximumReadBytes: 4096,
        expiresAt: f.limits.expiresAt
      },
      inspector = await openDB(fixture.storage.dbName, 7),
      before = await inspector.get('_wallet_packed_clock', 'clock')
    try {
      for (const mode of ['original', 'canonical', 'mapped'] as const) {
        const result = await prepareBrc38IdbRestoreText(
            stage,
            fixture.storage,
            fixture.journal,
            fixture.complete,
            'provenTxReqs',
            0,
            'notify',
            mode,
            sourcePolicy,
            policy,
            524288
          ),
          descriptor = result.staged.descriptor,
          decoder = new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }),
          strings: string[] = [],
          chunks: Uint8Array[] = []
        try {
          if (result.bytes > 524288 || descriptor.kind !== 'utf16')
            throw new Error('Original fixture extent bound or kind differs')
          for (let index = 0; index < Math.ceil(result.bytes / 65536); index++) {
            const actual = await inspector.get(packedIdbStores.chunks, [descriptor.content, index])
            if (
              actual?.content !== descriptor.content ||
              actual.index !== index ||
              !(actual.data instanceof Uint8Array) ||
              actual.data.length !== Math.min(65536, result.bytes - index * 65536)
            )
              throw new Error('Actual staged text chunk layout differs')
            strings.push(decoder.decode(actual.data, { stream: true }))
            chunks.push(actual.data)
          }
          strings.push(decoder.decode())
          const text = strings.join(''),
            combined = new Uint8Array(result.bytes)
          let offset = 0
          for (const chunk of chunks) {
            combined.set(chunk, offset)
            offset += chunk.length
          }
          const nativeHash = new Uint8Array(await crypto.subtle.digest('SHA-256', combined)),
            sha256 = Array.from(nativeHash, byte => byte.toString(16).padStart(2, '0')).join('')
          if (sha256 !== result.sha256 || descriptor.sha256 !== sha256 || result.bytes !== 2 * text.length)
            throw new Error('Independent native text decoder/UTF16 extent/WebCrypto digest differs')
          if (
            (mode === 'original' && (text !== rawNotify || result.unmappedIds !== 0)) ||
            (mode === 'canonical' &&
              (JSON.stringify(JSON.parse(text)) !==
                JSON.stringify({ memo: '😀雪'.repeat(16000), transactionIds: [14, 999, 14] }) ||
                result.unmappedIds !== 0)) ||
            (mode === 'mapped' &&
              (JSON.stringify(JSON.parse(text)) !==
                JSON.stringify({ memo: '😀雪'.repeat(16000), transactionIds: [4] }) ||
                result.unmappedIds !== 1))
          )
            throw new Error('Original provenance or inactive mapped text differs')
          if (fixture.working.used === 0)
            throw new Error('Genuine staged content lost its original retained reservation')
        } finally {
          await result.close()
        }
        const retired = await inspector.get(packedIdbStores.contents, descriptor.content)
        if (
          retired?.refs !== 0 ||
          retired.retired !== 1 ||
          retired.expiresAt > Date.now() ||
          fixture.working.used !== 0
        )
          throw new Error(
            'Actual staged text close did not revoke/retire its unreferenced content and release its own reservations'
          )
        await fixture.storage.collectPackedStorage(16, 16)
        if ((await inspector.get(packedIdbStores.contents, descriptor.content)) !== undefined)
          throw new Error('Finite actual collection retained this bounded retired fixture content')
      }
      const after = await inspector.get('_wallet_packed_clock', 'clock')
      if (after.revision !== before.revision || after.epoch !== before.epoch)
        throw new Error('Preparation changed actual wallet revision or epoch')
      await stage.sealedMetadata()
    } finally {
      inspector.close()
    }
  } finally {
    await stage.discard(new Error('actual browser UTF16 stage fixture cleanup'))
    if (fixture !== undefined) {
      await fixture.journal.close()
      await fixture.storage.destroy()
      await deleteDB(fixture.storage.dbName)
    }
  }
}
