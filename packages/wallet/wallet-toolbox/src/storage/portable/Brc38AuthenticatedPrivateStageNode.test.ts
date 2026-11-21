import {
  verifyBrc38AuthenticatedSourceSeal,
  verifyBrc38SourceSealFieldDefinitions
} from './Brc38AuthenticatedSourceSealNode'
import { fork, type ChildProcess } from 'node:child_process'
import {
  authenticatedStagePassword,
  encrypted,
  authenticatedStageOptions as options
} from './Brc38AuthenticatedPrivateStageFixture'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Brc38StagingAdmissionNode, type Brc38StagingReservation } from './Brc38StagingAdmissionNode'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import { stageAuthenticatedBrc39PrivateImport } from './Brc38AuthenticatedPrivateStageNode'
import { previewDestinationFixture, previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { previewBrc38PrivateImport } from './Brc38PrivateImportPreviewNode'
import type { Brc38AuthenticatedStreamedImportReader } from './KnexBrc38StagingStore'
import { createHash } from 'node:crypto'
import { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Script, Transaction } from '@bsv/sdk'
import { Brc38PrivateChunkPipe } from './Brc38PrivateChunkPipe'
import { inspectBrc38AuthenticatedRawTransaction } from './Brc38AuthenticatedRawTransactionNode'

/** Controlled corruption fixture: ordinary callers cannot change sealed data.
 * Restore the exact guard in the same transaction before testing read integrity. */
async function corruptSealedBinaryChunk(store: KnexBrc38StagingStore, payload: Buffer): Promise<void> {
  const coordinate = { tableName: 'transactions', position: 0, field: 'rawTx', offset: 0 },
    guardNames = ['brc38_source_seal_private_binary_chunks_update', 'private_binary_chunks_prefix_update'],
    extent = await store.knex('private_binary_chunks').where(coordinate).first('bytes')
  expect(Number.isSafeInteger(extent?.bytes)).toBe(true)
  expect(extent.bytes).toBeGreaterThan(0)
  expect(extent.bytes).toBeLessThanOrEqual(payload.byteLength)
  // Preserve the real chunk length so the later refusal proves its digest,
  // rather than stopping at an unrelated table length constraint.
  payload = payload.subarray(0, extent.bytes)
  await expect(store.knex('private_binary_chunks').where(coordinate).update({ payload })).rejects.toThrow('immutable')
  await store.knex.transaction(async trx => {
    const guards: Array<{ name: string; sql: string }> = []
    for (const name of guardNames) {
      const guard = await trx('sqlite_schema').where({ name, type: 'trigger' }).first('name', 'sql')
      expect(typeof guard?.sql).toBe('string')
      guards.push(guard)
      await trx.raw('DROP TRIGGER ??', [name])
    }
    await trx('private_binary_chunks').where(coordinate).update({ payload })
    for (const guard of guards) await trx.raw(guard.sql)
  })
  await verifyBrc38AuthenticatedSourceSeal(store.knex)
}

const password = authenticatedStagePassword
let directory = '',
  root: Brc38StagingAdmissionNode,
  held: Brc38StagingReservation[] = [],
  children: ChildProcess[] = []
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'brc38-authenticated-stage-'))
  root = await Brc38StagingAdmissionNode.create(directory, {
    maximumImports: 1,
    maximumPhysicalBytes: 7340032,
    maximumLogicalBytes: 1048576
  })
  held = []
  children = []
  const original = root.admit.bind(root)
  jest.spyOn(root, 'admit').mockImplementation(async (...args) => {
    const value = await original(...args)
    held.push(value)
    return value
  })
})
afterEach(async () => {
  jest.restoreAllMocks()
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited(child)
  }
  for (const value of held) await value.store.close()
  await root.close()
  await fs.rm(directory, { recursive: true, force: true })
})
async function* chunks(bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.length; offset += 137) yield bytes.slice(offset, offset + 137)
}
async function empty() {
  expect((await root.usage()).imports).toBe(0)
  expect(await fs.readdir(directory)).toEqual(['brc38-admission.sqlite'])
}
test('actual GCM and complete ciphertext digest precede private seal for all thirteen tables', async () => {
  const bytes = await encrypted(),
    selected = options(bytes)
  let checkedBeforeAuthentication = false
  async function* source() {
    yield* chunks(bytes)
    expect(await held[0].store.knex('metadata').where({ slot: 1 }).first('state')).toEqual({
      state: 'staging'
    })
    expect((await root.usage()).imports).toBe(1)
    checkedBeforeAuthentication = true
  }
  const value = await stageAuthenticatedBrc39PrivateImport(source(), password.normalize('NFC'), root, selected)
  expect(checkedBeforeAuthentication).toBe(true)
  expect(value.archiveSha256).toBe(selected.binding.archiveSha256)
  expect(value.fileBytes).toBe(bytes.length)
  expect(value.plaintextBytes).toBe(Buffer.byteLength(JSON.stringify(semanticStageFixture())))
  expect(Object.values(value.document.counts)).toEqual(Array(13).fill(1))
  expect(await value.reservation.store.knex('metadata').where({ slot: 1 }).first('state')).toEqual({
    state: 'sealed'
  })
  expect((await root.usage()).imports).toBe(1)
  await root.discard(value.reservation, new Error('synthetic finish'))
  await empty()
})
test('the owned source stages an authenticated structured envelope before its separate native receiver handoff', async () => {
  const bytes = await encrypted(),
    selected = options(bytes)
  selected.streamedStructuredFields = {
    fields: { maximumStructuredBytes: 1000000, maximumChunkBytes: 1024 },
    staging: {
      privateIndexParent: directory,
      maximumTemporaryIndexBytes: 1048576,
      maximumIndexMembers: 10000,
      maximumStructuredBytes: 1000000,
      maximumCanonicalBytes: 1000000
    }
  }
  const value = await stageAuthenticatedBrc39PrivateImport(chunks(bytes), password.normalize('NFC'), root, selected),
    store = value.reservation.store,
    row = await store.streamedRow('provenTxReqs', 0),
    raw = Buffer.from(JSON.stringify(semanticStageFixture().tables.provenTxReqs[0].history))
  expect(Object.values(value.document.counts)).toEqual(Array(13).fill(1))
  expect(row?.structured?.history).toEqual({
    field: 'history',
    encoding: 'utf8-json',
    bytes: raw.byteLength,
    sha256: createHash('sha256').update(raw).digest('hex')
  })
  expect(await store.knex('private_import').where({ slot: 1 }).first('archiveSha256')).toEqual({
    archiveSha256: selected.binding.archiveSha256
  })
  expect(await store.knex('metadata').where({ slot: 1 }).first('state')).toEqual({ state: 'sealed' })
  await expect(store.withAuthenticatedPrivateStructuredDestination(async () => undefined)).rejects.toThrow()
  expect(await store.knex.schema.hasTable('users')).toBe(false)
  expect(await store.knex.schema.hasTable('private_native_restore')).toBe(false)
  await root.discard(value.reservation, new Error('source-only structured fixture closeout'))
  await empty()
})
test('all seventeen scalar strings retain original UTF-8 bytes behind actual authenticated private sealing', async () => {
  const data = semanticStageFixture(),
    coordinates = {
      transactions: ['description', 'noSendExpiryReclaimDerivationPrefix', 'noSendExpiryReclaimDerivationSuffix'],
      outputs: [
        'outputDescription',
        'spendingDescription',
        'customInstructions',
        'derivationPrefix',
        'derivationSuffix',
        'type',
        'purpose'
      ],
      commissions: ['keyOffset'],
      certificates: ['subject', 'revocationOutpoint', 'signature', 'verifier'],
      certificateFields: ['fieldValue', 'masterKey']
    }
  for (const [table, fields] of Object.entries(coordinates))
    for (const field of fields)
      data.tables[table as keyof typeof data.tables][0][field] = '\ufefforiginal 😄é\n' + table + ':' + field
  data.tables.transactions[0].description = '😄é\n'.repeat(16384)
  data.tables.certificateFields[0].masterKey = ''
  const bytes = await encrypted(data),
    selected = options(bytes)
  selected.streamedTextFields = { maximumTextBytes: 262144, maximumChunkBytes: 1024 }
  const result = await stageAuthenticatedBrc39PrivateImport(chunks(bytes), password, root, selected),
    store = result.reservation.store
  expect(Object.values(result.document.counts)).toEqual(Array(13).fill(1))
  expect(await store.knex('metadata').where({ slot: 1 }).first('state')).toEqual({ state: 'sealed' })
  expect(await store.knex('private_text_fields').count({ count: '*' }).first()).toEqual({ count: 17 })
  for (const [table, fields] of Object.entries(coordinates)) {
    const actual = await store.streamedRow(table as keyof typeof data.tables, 0)
    for (const field of fields) {
      const expected = Buffer.from(data.tables[table as keyof typeof data.tables][0][field] as string, 'utf8'),
        descriptor = {
          field,
          encoding: 'utf8',
          bytes: expected.byteLength,
          sha256: createHash('sha256').update(expected).digest('hex')
        }
      expect(actual?.texts?.[field]).toEqual(descriptor)
      expect(Object.hasOwn(actual!.fields, field)).toBe(false)
      await store.validateTextFields(table as keyof typeof data.tables, 0, actual!.texts!)
      const persisted = (await store
        .knex('private_text_chunks')
        .where({ tableName: table, position: 0, field })
        .select('offset', 'bytes', 'payload')
        .orderBy('offset')) as Array<{ offset: number; bytes: number; payload: Buffer }>
      let offset = 0
      for (const value of persisted) {
        expect(value.offset).toBe(offset)
        expect(value.bytes).toBeLessThanOrEqual(1024)
        expect(value.payload).toEqual(expected.subarray(offset, offset + value.bytes))
        offset += value.bytes
      }
      expect(offset).toBe(expected.byteLength)
    }
  }
  // Field descriptors cannot enroll a legacy receiver or an active wallet.
  await expect(store.withAuthenticatedImportRead(async () => undefined)).rejects.toThrow('scalar TEXT')
  await expect(store.withAuthenticatedStreamedImportRead(async () => undefined)).rejects.toThrow('scalar TEXT')
  expect(await store.knex.schema.hasTable('users')).toBe(false)
  await root.discard(result.reservation, new Error('independent scalar TEXT source closeout'))
  await empty()
})
test('failed whole authentication discards already written scalar strings without sealing or activation', async () => {
  const data = semanticStageFixture()
  data.tables.transactions[0].description = 'x'.repeat(131072)
  const bytes = await encrypted(data),
    selected = options(bytes)
  selected.streamedTextFields = { maximumTextBytes: 262144, maximumChunkBytes: 1024 }
  bytes[bytes.length - 1] ^= 1
  await expect(stageAuthenticatedBrc39PrivateImport(chunks(bytes), password, root, selected)).rejects.toThrow()
  await empty()
})
test.each(['tag', 'password', 'digest'] as const)(
  'complete %s failure never seals and returns capacity only after deletion',
  async kind => {
    const bytes = await encrypted(),
      selected = options(bytes)
    if (kind === 'tag') bytes[bytes.length - 1] ^= 1
    if (kind === 'digest') selected.binding = { ...selected.binding, archiveSha256: 'a'.repeat(64) }
    await expect(
      stageAuthenticatedBrc39PrivateImport(
        chunks(bytes),
        kind === 'password' ? 'wrong password' : password,
        root,
        selected
      )
    ).rejects.toThrow()
    await empty()
  }
)
test('authenticated orphaned relations still refuse and physically discard every private row', async () => {
  const data = semanticStageFixture()
  data.tables.outputs[0].transactionId = 999
  const bytes = await encrypted(data)
  await expect(stageAuthenticatedBrc39PrivateImport(chunks(bytes), password, root, options(bytes))).rejects.toThrow(
    'does not reference'
  )
  await empty()
})
test('authenticated invalid UTF8 refuses without replacement decoding or activation', async () => {
  const bytes = await encrypted(new Uint8Array([0xff]))
  await expect(stageAuthenticatedBrc39PrivateImport(chunks(bytes), password, root, options(bytes))).rejects.toThrow()
  await empty()
})
test('source failure retains exact identity, awaits parser/reader cleanup and never loses the charge early', async () => {
  const bytes = await encrypted(),
    reason = new Error('synthetic encrypted source failure')
  let closed = false
  async function* source() {
    try {
      yield bytes.slice(0, 1024)
      throw reason
    } finally {
      closed = true
    }
  }
  await expect(stageAuthenticatedBrc39PrivateImport(source(), password, root, options(bytes))).rejects.toBe(reason)
  expect(closed).toBe(true)
  await empty()
})
test.each([true, false])('fragmented ciphertext keeps its original input cap (admitted: %s)', async admitted => {
  const bytes = await encrypted(),
    inputChunks = Math.ceil(bytes.length / 137),
    selected = { ...options(bytes), maximumCiphertextChunks: inputChunks - (admitted ? 0 : 1) },
    originalAppend = Brc38PrivateChunkPipe.prototype.append
  let plaintextChunks = 0,
    ciphertextChunks = 0
  jest.spyOn(Brc38PrivateChunkPipe.prototype, 'append').mockImplementation(async function (input) {
    plaintextChunks++
    await originalAppend.call(this, input)
  })
  async function* source() {
    for await (const input of chunks(bytes)) {
      ciphertextChunks++
      yield input
    }
  }
  if (admitted) {
    const value = await stageAuthenticatedBrc39PrivateImport(source(), password, root, selected)
    expect(ciphertextChunks).toBe(inputChunks)
    expect(plaintextChunks).toBeGreaterThan(inputChunks)
    expect(plaintextChunks).toBeLessThanOrEqual(2 * inputChunks)
    expect(value.archiveSha256).toBe(selected.binding.archiveSha256)
    expect(value.fileBytes).toBe(bytes.length)
    expect(value.plaintextBytes).toBe(Buffer.byteLength(JSON.stringify(semanticStageFixture())))
    expect(Object.values(value.document.counts)).toEqual(Array(13).fill(1))
    expect(await value.reservation.store.knex('metadata').where({ slot: 1 }).first('state')).toEqual({
      state: 'sealed'
    })
    await root.discard(value.reservation, new Error('fragmented input boundary closeout'))
  } else {
    await expect(stageAuthenticatedBrc39PrivateImport(source(), password, root, selected)).rejects.toThrow(
      'Authenticated archive chunk policy reached'
    )
    expect(ciphertextChunks).toBe(inputChunks)
  }
  await empty()
})
test('empty encrypted chunks are bounded independently of the archive byte quota', async () => {
  const bytes = await encrypted(),
    selected = { ...options(bytes), maximumCiphertextChunks: 3 }
  async function* source() {
    for (let index = 0; index < 4; index++) yield new Uint8Array()
  }
  await expect(stageAuthenticatedBrc39PrivateImport(source(), password, root, selected)).rejects.toThrow('chunk policy')
  await empty()
})
test('pre-admission invalid metadata policy creates no stage and consumes no capacity', async () => {
  const bytes = await encrypted(),
    selected = { ...options(bytes), maximumMetadataAllocationBytes: 65537 }
  await expect(stageAuthenticatedBrc39PrivateImport(chunks(bytes), password, root, selected)).rejects.toThrow('policy')
  expect(root.admit).not.toHaveBeenCalled()
  await empty()
})
test('abort reason remains exact and physical cleanup completes before rejection', async () => {
  const bytes = await encrypted(),
    controller = new AbortController(),
    reason = new Error('synthetic import cancellation'),
    selected = options(bytes)
  selected.crypto.signal = controller.signal
  async function* source() {
    controller.abort(reason)
    yield bytes.slice(0, 1024)
  }
  await expect(stageAuthenticatedBrc39PrivateImport(source(), password, root, selected)).rejects.toBe(reason)
  await empty()
})
test('physical cleanup failure retains a concrete retry and reserved capacity with original crypto failure', async () => {
  const bytes = await encrypted(),
    selected = options(bytes),
    reason = new Error('synthetic private removal failure'),
    original = fs.rm
  bytes[bytes.length - 1] ^= 1
  const removal = jest.spyOn(fs, 'rm').mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('.retired')) throw reason
    await original(...args)
  })
  const error = await stageAuthenticatedBrc39PrivateImport(chunks(bytes), password, root, selected).then(
    () => undefined,
    cause => cause as unknown
  )
  expect(error).toBeInstanceOf(Brc38StagingCleanupError)
  expect((await root.usage()).imports).toBe(1)
  removal.mockRestore()
  if (!(error instanceof Brc38StagingCleanupError)) throw new Error('Concrete private cleanup owner missing')
  await error.retryCleanup()
  await empty()
})

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned authenticated fixture did not drain')), 3000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
test('identical authenticated envelope resumes a sealed private import without double counting or renewing its deadline', async () => {
  const bytes = await encrypted(),
    selected = options(bytes)
  const first = await stageAuthenticatedBrc39PrivateImport(chunks(bytes), password, root, selected)
  const before = await first.reservation.store.knex('metadata').where({ slot: 1 }).first()
  await first.reservation.store.close()
  const second = await stageAuthenticatedBrc39PrivateImport(chunks(bytes), password, root, {
    ...selected,
    reservationId: first.reservation.id
  })
  held.push(second.reservation)
  expect(second.reservation.id).toBe(first.reservation.id)
  expect(second.document).toEqual(first.document)
  expect(second.reservation.store.limits.expiresAt).toBe(selected.limits.expiresAt)
  expect(await second.reservation.store.knex('metadata').where({ slot: 1 }).first()).toEqual(before)
  expect(root.admit).toHaveBeenCalledTimes(1)
  expect((await root.usage()).imports).toBe(1)
  await root.discard(second.reservation, new Error('synthetic finish'))
  await empty()
})
test('owned process loss before GCM completion resumes only the exact originally charged import and authenticates its complete replay', async () => {
  const bytes = await encrypted(),
    selected = options(bytes)
  const child = fork(
    join(__dirname, '../../../out/test/storage/portableAuthenticatedChild.js'),
    [directory, JSON.stringify(selected)],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
  )
  children.push(child)
  const message = await new Promise<{ status: string; id: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned authentication child did not report')), 3000)
    child.once('message', value => {
      clearTimeout(timer)
      resolve(value as { status: string; id: string })
    })
  })
  expect(message.status).toBe('held-before-gcm')
  expect((await root.usage()).imports).toBe(1)
  await expect(root.resume(message.id, selected.limits, selected.binding)).rejects.toMatchObject({
    code: 'SQLITE_BUSY'
  })
  child.kill('SIGKILL')
  await exited(child)
  const value = await stageAuthenticatedBrc39PrivateImport(chunks(bytes), password, root, {
    ...selected,
    reservationId: message.id
  })
  held.push(value.reservation)
  expect(Object.values(value.document.counts)).toEqual(Array(13).fill(1))
  expect(value.archiveSha256).toBe(selected.binding.archiveSha256)
  expect(value.reservation.store.limits.expiresAt).toBe(selected.limits.expiresAt)
  expect((await root.usage()).imports).toBe(1)
  await root.discard(value.reservation, new Error('synthetic finish'))
  await empty()
})

test('actual authenticated private field staging validates all original semantics while legacy native activation remains fenced', async () => {
  const data = semanticStageFixture(),
    raw = Buffer.alloc(131073, 41)
  data.tables.transactions[0].rawTx = raw.toString('base64')
  data.tables.transactions[0].noSendExpiryReclaimRawTx = Array.from(raw.subarray(0, 32769))
  const bytes = await encrypted(data),
    selected = {
      ...options(bytes),
      streamedFields: { maximumBinaryBytes: 262144, maximumChunkBytes: 65536 }
    }
  const value = await stageAuthenticatedBrc39PrivateImport(chunks(bytes), password, root, selected)
  expect(Object.values(value.document.counts)).toEqual(Array(13).fill(1))
  const row = await value.reservation.store.streamedRow('transactions', 0)
  expect(row!.fields.rawTx).toBeUndefined()
  expect(row!.fields.noSendExpiryReclaimRawTx).toBeUndefined()
  expect(row!.fields.description).toBe(data.tables.transactions[0].description)
  expect(row!.binaries.rawTx.bytes).toBe(raw.byteLength)
  const actual: Buffer[] = []
  for (let offset = 0; offset < raw.byteLength;) {
    const extent = await value.reservation.store.readBinaryFieldChunk('transactions', 0, 'rawTx', offset)
    actual.push(Buffer.from(extent!.bytes))
    offset += extent!.bytes.byteLength
  }
  expect(Buffer.concat(actual)).toEqual(raw)
  expect(await value.reservation.store.knex('metadata').first('state')).toEqual({ state: 'sealed' })
  expect((await value.reservation.store.knex('private_import').first('archiveSha256')).archiveSha256).toBe(
    selected.binding.archiveSha256
  )
  const native = jest.fn(async () => undefined)
  await expect(value.reservation.store.withAuthenticatedPrivateDestination(native)).rejects.toThrow(
    'field-aware semantic and native import activation'
  )
  expect(native).not.toHaveBeenCalled()
  await root.discard(value.reservation, new Error('finite streamed stage cleanup'))
  await empty()
})

test.each(['relation', 'identity', 'duplicate'] as const)(
  'authenticated streamed binary staging preserves the original %s refusal',
  async failure => {
    const data = semanticStageFixture()
    data.tables.transactions[0].rawTx = Buffer.alloc(32769, 23).toString('base64')
    if (failure === 'relation') data.tables.outputs[0].transactionId = 999
    if (failure === 'identity') data.user.identityKey = 'other-identity'
    if (failure === 'duplicate') data.tables.outputTags.push({ ...data.tables.outputTags[0], outputTagId: 999 })
    const bytes = await encrypted(data),
      selected = {
        ...options(bytes),
        streamedFields: { maximumBinaryBytes: 262144, maximumChunkBytes: 65536 }
      }
    await expect(stageAuthenticatedBrc39PrivateImport(chunks(bytes), password, root, selected)).rejects.toThrow()
    await empty()
  }
)

test('authenticated streamed reader retains exact source membership, actual extent integrity and pending-read drain', async () => {
  const target = await previewDestinationFixture(),
    data = semanticStageFixture(),
    raw = Buffer.alloc(131073, 57)
  try {
    data.tables.transactions[0].rawTx = raw.toString('base64')
    const bytes = await encrypted(data),
      selected = {
        ...options(bytes),
        streamedFields: { maximumBinaryBytes: 262144, maximumChunkBytes: 65536 }
      }
    const value = await stageAuthenticatedBrc39PrivateImport(chunks(bytes), password, root, selected),
      store = value.reservation.store
    await previewBrc38PrivateImport(store, target.storage, 'restore', previewReceiptPolicy)
    let escaped!: Readonly<Brc38AuthenticatedStreamedImportReader>,
      pending!: Promise<number>,
      settled = false
    await store.withAuthenticatedStreamedImportRead(async (_json, metadata, reader) => {
      escaped = reader
      expect(metadata.rows).toBe(13)
      expect((await reader.header()).user.identityKey).toBe(selected.binding.identityKey)
      const row = await reader.row('transactions', 0),
        digest = createHash('sha256')
      expect(row!.fields.rawTx).toBeUndefined()
      expect(row!.binaries.rawTx.bytes).toBe(raw.byteLength)
      for (let offset = 0; offset < raw.byteLength;) {
        const actual = await reader.chunk('transactions', 0, 'rawTx', offset)
        expect(actual!.bytes.byteLength).toBeLessThanOrEqual(65536)
        digest.update(actual!.bytes)
        offset += actual!.bytes.byteLength
      }
      expect(digest.digest('hex')).toBe(createHash('sha256').update(raw).digest('hex'))
      expect(await reader.chunk('transactions', 0, 'rawTx', raw.byteLength)).toBeUndefined()
      pending = reader.count('transactions')
      void pending.then(() => {
        settled = true
      })
      await expect(store.close()).rejects.toThrow('Wait for owned')
    })
    expect(settled).toBe(true)
    expect(await pending).toBe(1)
    await expect(escaped.row('transactions', 0)).rejects.toThrow('unavailable')
    await expect(escaped.chunk('transactions', 0, 'rawTx', 0)).rejects.toThrow('unavailable')
    const legacy = jest.fn(async () => undefined)
    await expect(store.withAuthenticatedImportRead(legacy)).rejects.toThrow(
      'field-aware semantic and native import activation'
    )
    expect(legacy).not.toHaveBeenCalled()
    await corruptSealedBinaryChunk(store, Buffer.alloc(65536, 58))
    await expect(
      store.withAuthenticatedStreamedImportRead(
        async (_json, _metadata, reader) => await reader.chunk('transactions', 0, 'rawTx', 0)
      )
    ).rejects.toThrow('content or coordinate differs')
    expect(await target.writer('users')).toEqual([])
    await root.discard(value.reservation, new Error('finite streamed reader disposal'))
    await empty()
  } finally {
    await target.close()
  }
})
test('authenticated stock staging does not grant the private native receiver scope', async () => {
  const bytes = await encrypted(),
    selected = {
      ...options(bytes),
      streamedFields: { maximumBinaryBytes: 262144, maximumChunkBytes: 65536 }
    },
    value = await stageAuthenticatedBrc39PrivateImport(chunks(bytes), password, root, selected),
    receiver = jest.fn(async () => undefined)
  await expect(value.reservation.store.withAuthenticatedPrivateStreamedDestination(receiver)).rejects.toThrow(
    'actual private native backend'
  )
  expect(receiver).not.toHaveBeenCalled()
  await root.discard(value.reservation, new Error('finite stock receiver refusal disposal'))
  await empty()
})
test.each(['expiry', 'archive'] as const)(
  'native reservation handoff refuses changed original %s before any native start',
  async kind => {
    const bytes = await encrypted(),
      selected = options(bytes),
      value = await stageAuthenticatedBrc39PrivateImport(chunks(bytes), password, root, selected),
      native = jest.spyOn(KnexBrc38StagingStore, 'reopenOwnedNative'),
      limits = kind === 'expiry' ? { ...selected.limits, expiresAt: selected.limits.expiresAt + 1 } : selected.limits,
      binding = kind === 'archive' ? { ...selected.binding, archiveSha256: 'e'.repeat(64) } : selected.binding
    await expect(root.resumeNative(value.reservation.id, limits, binding, '/unused-native-engine')).rejects.toThrow(
      'reservation binding does not match'
    )
    expect(native).not.toHaveBeenCalled()
    await root.discard(value.reservation, new Error('finite changed native handoff disposal'))
    await empty()
  }
)

test('whole-envelope authentication permanently protects actual source fields, rows and binding while preview remains usable', async () => {
  const bytes = await encrypted(),
    value = await stageAuthenticatedBrc39PrivateImport(chunks(bytes), password, root, {
      ...options(bytes),
      streamedFields: { maximumBinaryBytes: 262144, maximumChunkBytes: 65536 }
    }),
    store = value.reservation.store
  // A successful earlier comparison must never admit an altered or missing
  // physical guard. Restore its exact SQL between each independent refusal.
  const guardName = 'brc38_source_seal_private_binary_chunks_update',
    guard = await store.knex('sqlite_schema').where({ name: guardName, type: 'trigger' }).first('sql')
  expect(typeof guard?.sql).toBe('string')
  await verifyBrc38AuthenticatedSourceSeal(store.knex)
  expect(await verifyBrc38SourceSealFieldDefinitions(store.knex, 'binary')).toBe(6)
  await store.knex.raw('DROP TRIGGER ??', [guardName])
  await expect(verifyBrc38AuthenticatedSourceSeal(store.knex)).rejects.toThrow('write protection')
  await expect(verifyBrc38SourceSealFieldDefinitions(store.knex, 'binary')).rejects.toThrow('write protection')
  await store.knex.raw(`CREATE TRIGGER ${guardName} BEFORE UPDATE ON private_binary_chunks BEGIN SELECT 1; END`)
  await expect(verifyBrc38AuthenticatedSourceSeal(store.knex)).rejects.toThrow('write protection')
  await expect(verifyBrc38SourceSealFieldDefinitions(store.knex, 'binary')).rejects.toThrow('write protection')
  await store.knex.raw('DROP TRIGGER ??', [guardName])
  await store.knex.raw(guard.sql)
  await verifyBrc38AuthenticatedSourceSeal(store.knex)
  expect(await verifyBrc38SourceSealFieldDefinitions(store.knex, 'binary')).toBe(6)
  const protectedCells = [
    ['rows', 'position'],
    ['table_counts', 'rows'],
    ['unique_keys', 'key'],
    ['memberships', 'key'],
    ['private_binding', 'digest'],
    ['private_binary_fields', 'bytes'],
    ['private_binary_chunks', 'bytes']
  ] as const
  for (const [table, column] of protectedCells)
    await expect(store.knex.raw('UPDATE ?? SET ??=??', [table, column, column])).rejects.toThrow('immutable')
  await expect(store.knex('metadata').where({ slot: 1 }).update({ rows: 0 })).rejects.toThrow('seal')
  await expect(
    store
      .knex('private_import')
      .where({ slot: 1 })
      .update({ archiveSha256: 'f'.repeat(64) })
  ).rejects.toThrow('seal')
  const target = await previewDestinationFixture()
  try {
    const first = await previewBrc38PrivateImport(store, target.storage, 'restore', previewReceiptPolicy),
      second = await previewBrc38PrivateImport(store, target.storage, 'restore', previewReceiptPolicy)
    expect(second.previewId).not.toBe(first.previewId)
    expect(second.archiveSha256).toBe(value.archiveSha256)
    expect(second.expiresAt).toBe(store.limits.expiresAt)
    expect((await store.streamedRow('provenTxs', 0))?.binaries.rawTx.bytes).toBeGreaterThan(0)
  } finally {
    await target.close()
  }
  await root.discard(value.reservation, new Error('synthetic source seal finish'))
  await empty()
})

test('authenticated raw framing uses the actual sealed binary field and independent transaction oracle', async () => {
  const target = await previewDestinationFixture(),
    data = semanticStageFixture(),
    transaction = new Transaction()
  transaction.addOutput({ satoshis: 0, lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${'31'.repeat(131073)}`) })
  const raw = Buffer.from(transaction.toBinary())
  data.tables.transactions[0].rawTx = raw.toString('base64')
  const bytes = await encrypted(data),
    selected = {
      ...options(bytes),
      streamedFields: { maximumBinaryBytes: 262144, maximumChunkBytes: 65536 }
    }
  try {
    const value = await stageAuthenticatedBrc39PrivateImport(chunks(bytes), password, root, selected),
      store = value.reservation.store
    await previewBrc38PrivateImport(store, target.storage, 'restore', previewReceiptPolicy)
    const result = await inspectBrc38AuthenticatedRawTransaction(store, 'transactions', 0, {
      maximumBytes: 262144,
      maximumChunks: 8
    })
    expect(result.txid).toBe(transaction.id('hex'))
    expect(result.bytes).toBe(raw.length)
    await expect(
      inspectBrc38AuthenticatedRawTransaction(store, 'transactions', 0, {
        maximumBytes: raw.length - 1,
        maximumChunks: 8
      })
    ).rejects.toThrow()
    await expect(
      inspectBrc38AuthenticatedRawTransaction(store, 'transactions', 0, { maximumBytes: 262144, maximumChunks: 1 })
    ).rejects.toThrow()
    const controller = new AbortController(),
      cancellation = new Error('original raw field cancellation')
    controller.abort(cancellation)
    await expect(
      inspectBrc38AuthenticatedRawTransaction(store, 'transactions', 0, {
        maximumBytes: 262144,
        maximumChunks: 8,
        signal: controller.signal
      })
    ).rejects.toBe(cancellation)
    expect(await target.writer('users')).toEqual([])
    await corruptSealedBinaryChunk(store, Buffer.alloc(65536, 59))
    await expect(
      inspectBrc38AuthenticatedRawTransaction(store, 'transactions', 0, { maximumBytes: 262144, maximumChunks: 8 })
    ).rejects.toThrow()
    await root.discard(value.reservation, new Error('authenticated raw fixture cleanup'))
    await empty()
  } finally {
    raw.fill(0)
    await target.close()
  }
})
