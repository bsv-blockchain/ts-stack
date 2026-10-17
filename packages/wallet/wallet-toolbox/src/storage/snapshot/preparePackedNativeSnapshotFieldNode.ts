import { nativePackedTextSource } from '../portable/Brc38NativePackedTextSources'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import { ownedNativeRootIdentity, createOwnedNativeReadDatabase } from '../schema/ownedNativeSqliteConnectionsNode'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from '../portable/Brc38WorkingAllocation'
import { detachBrc38PrivateChunk } from '../portable/Brc38PrivateChunkPipe'
import { Brc38StagingCleanupError } from '../portable/Brc38StagingCleanupError'
import { brc38Utf8Chunks } from '../portable/Brc38Utf8Chunks'
import { Brc38NativePreparedFieldLifetime } from '../portable/Brc38NativePreparedFieldsNode'
import { hasBrc38NativePreparedFieldsSchema } from '../portable/Brc38NativePreparedFieldSchemaNode'
import {
  hasBrc38NativePackedSchema,
  nativePackedTables,
  requireBrc38PackedWriter
} from '../portable/Brc38NativePackedSchemaNode'
import { hasBrc38NativePackedTextSchema, nativePackedTextTables } from '../portable/Brc38NativePackedTextSchemaNode'
import { hashBrc38NativePackedVersion, readBrc38NativePackedDescriptor } from '../portable/Brc38NativePackedFieldsNode'
import {
  hashBrc38NativePackedTextVersion,
  readBrc38NativePackedTextDescriptor
} from '../portable/Brc38NativePackedTextFieldsNode'
import {
  encodeBrc38NativeBlobRead,
  brc38NativeTextCoordinate,
  type Brc38NativeBlobRead,
  type Brc38NativeTextRead
} from '../portable/Brc38NativeBlobProtocol'
import {
  requireNativeSnapshotSyncStructuredSource,
  type NativeSnapshotSyncStructuredSource
} from './NativeSnapshotSyncStructuredSourceNode'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'
import type {
  WalletReadSnapshot,
  WalletSnapshotCursor,
  WalletSnapshotFieldDescriptor,
  WalletSnapshotTable
} from './WalletReadSnapshot'

export interface PackedNativeSnapshotFieldPolicy {
  readonly workingAllocation: Brc38WorkingAllocation
  readonly maximumFieldBytes: number
  readonly maximumReadBytes: number
  readonly expiresAt: number
  readonly signal?: AbortSignal
}
export interface PreparedPackedNativeSnapshotField {
  readonly descriptor: Readonly<{ kind: 'binary' | 'utf8'; bytes: number; sha256: string }>
  /** Only pointer attachment, on the actual original destination writer. The
   * enclosing component must independently recheck row/parent/session/primary
   * policy and write its metadata plus mapping/checkpoint in this transaction.
   * A failed/rolled-back attachment consumes this one preparation too. */
  attach(trx: Knex.Transaction, destinationRowId: number): Promise<void>
  /** Actual sealed content window, on a fresh drained read-only lease. */
  read(offset: number, length: number): Promise<Uint8Array>
  close(): Promise<void>
}
interface Version {
  sha256: string
  bytes: number
  accepted: number
  chunks: number
  state: string
}
const issued = new WeakMap<
  PreparedPackedNativeSnapshotField,
  Readonly<{ storage: StorageKnex; table: WalletSnapshotTable; field: string }>
>()
const binaryTables: Readonly<Record<string, string>> = {
  transactions: 'transactions',
  provenTxs: 'proven_txs',
  provenTxReqs: 'proven_tx_reqs',
  outputs: 'outputs',
  commissions: 'commissions'
}
function invalid(): never {
  throw new Error('Native snapshot field differs from its original source, producer or prepared content')
}
const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')

/** Concrete issuer membership only. Every attach still freshly checks its
 * original live native producer, source lifetime, schema and actual content.
 * A copied descriptor/object cannot enroll as a prepared field. */
export function assertPreparedPackedNativeSnapshotField(
  storage: StorageKnex,
  table: WalletSnapshotTable,
  field: string,
  value: PreparedPackedNativeSnapshotField
): void {
  const actual = issued.get(value)
  if (actual === undefined || actual.storage !== storage || actual.table !== table || actual.field !== field) invalid()
}

/** Actual retained source -> original native destination, with no source I/O
 * inside a writer. First hash/measure source; replay into short <=64KiB writes;
 * independently hash persisted content through a drained read-only lease;
 * seal in a final short writer. An existing SEALED version is retained and
 * freshly hashed too. Hashes and returned descriptors remain DATA; the closed
 * over lifetime and original producer supply only this one attachment actor.
 * No source authentication, merge/proof policy, profile activation or ACK is
 * inferred. Ordinary stores without the additive schema cannot use this path. */
export async function preparePackedNativeSnapshotField(
  storage: StorageKnex,
  source: WalletReadSnapshot,
  table: WalletSnapshotTable,
  selectedCursor: WalletSnapshotCursor,
  field: string,
  selectedDescriptor: Readonly<WalletSnapshotFieldDescriptor>,
  selectedPolicy: PackedNativeSnapshotFieldPolicy
): Promise<Readonly<PreparedPackedNativeSnapshotField>> {
  const policy = Object.freeze({ ...selectedPolicy }),
    working = brc38WorkingAllocation(policy.workingAllocation),
    root = storage.knex,
    origin = ownedNativeRootIdentity(root),
    reader = source.fieldReader,
    binary = selectedDescriptor.kind === 'binary'
  if (
    working === undefined ||
    root.isTransaction ||
    origin?.slot !== 0 ||
    reader === undefined ||
    typeof field !== 'string' ||
    field.length < 1 ||
    field.length > 128 ||
    selectedCursor.version !== 1 ||
    selectedCursor.snapshotId !== source.snapshotId ||
    selectedCursor.table !== table ||
    selectedCursor.archivePosition !== undefined ||
    !Array.isArray(selectedCursor.after) ||
    selectedCursor.after.length < 1 ||
    selectedCursor.after.length > 3 ||
    selectedCursor.after.some(value =>
      typeof value === 'number'
        ? !Number.isSafeInteger(value) || value < 1
        : typeof value !== 'string' || value.length < 1 || value.length > 4096
    ) ||
    !['binary', 'utf8', 'utf16le'].includes(selectedDescriptor.kind) ||
    !Number.isSafeInteger(selectedDescriptor.bytes) ||
    selectedDescriptor.bytes < 0 ||
    selectedDescriptor.bytes > policy.maximumFieldBytes ||
    (selectedDescriptor.kind === 'utf16le' && selectedDescriptor.bytes % 2 !== 0) ||
    (selectedDescriptor.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(selectedDescriptor.sha256)) ||
    !Number.isSafeInteger(policy.maximumFieldBytes) ||
    policy.maximumFieldBytes < 0 ||
    policy.maximumFieldBytes > 1000000000 ||
    !Number.isSafeInteger(policy.maximumReadBytes) ||
    policy.maximumReadBytes < 64 ||
    policy.maximumReadBytes > 65536 ||
    !Number.isSafeInteger(policy.expiresAt) ||
    policy.expiresAt <= Date.now() ||
    policy.expiresAt > source.expiresAt ||
    policy.expiresAt > Date.now() + 3600000
  )
    invalid()
  const cursor: WalletSnapshotCursor = {
      version: 1,
      snapshotId: selectedCursor.snapshotId,
      table,
      after: [...selectedCursor.after]
    },
    descriptor = Object.freeze({ ...selectedDescriptor }),
    checkSource = (): void => {
      policy.signal?.throwIfAborted()
      if (
        !source.isOpen ||
        storage.knex !== root ||
        ownedNativeRootIdentity(root)?.token !== origin.token ||
        source.fieldReader !== reader ||
        policy.expiresAt > source.expiresAt
      )
        invalid()
    }
  const raw = async function* (hash: ReturnType<typeof createHash>): AsyncGenerator<Uint8Array> {
    const utf8 = descriptor.kind === 'utf8' ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) : undefined
    for (let offset = 0; offset < descriptor.bytes;) {
      checkSource()
      const amount = Math.min(policy.maximumReadBytes, descriptor.bytes - offset),
        bytes = await reader.readFieldExtent(table, cursor, field, offset, amount, descriptor)
      try {
        checkSource()
        if (!(bytes instanceof Uint8Array) || bytes.length !== amount) invalid()
        utf8?.decode(bytes, { stream: true })
        hash.update(bytes)
        offset += amount
        yield bytes
      } finally {
        if (bytes instanceof Uint8Array) bytes.fill(0)
      }
    }
    utf8?.decode()
    if (descriptor.bytes === 0) {
      checkSource()
      const bytes = await reader.readFieldExtent(table, cursor, field, 0, 0, descriptor)
      try {
        checkSource()
        if (!(bytes instanceof Uint8Array) || bytes.length !== 0) invalid()
      } finally {
        if (bytes instanceof Uint8Array) bytes.fill(0)
      }
    }
    checkSource()
  }
  return await prepareNativeSnapshotContent(
    storage,
    source,
    table,
    field,
    binary,
    policy,
    hash =>
      descriptor.kind === 'utf16le'
        ? brc38Utf8Chunks(raw(hash), policy.maximumFieldBytes, working, policy.signal)
        : raw(hash),
    checkSource,
    descriptor.sha256
  )
}

/** Derived UTF-8 text from the concrete original structured owner. The issuer
 * does not synthesize a WalletReadSnapshot or accept descriptor membership as
 * authority. Both complete projection passes re-enter their actual owners;
 * this stage supplies only one current native pointer attachment. */
export async function stageNativeSnapshotSyncText(
  owner: NativeSnapshotSyncStructuredSource,
  field: 'history' | 'notify',
  measure: () => AsyncIterable<Uint8Array>,
  replay: () => AsyncIterable<Uint8Array>
): Promise<Readonly<PreparedPackedNativeSnapshotField>> {
  requireNativeSnapshotSyncStructuredSource(owner)
  await owner.fresh()
  if (field !== 'history' && field !== 'notify') invalid()
  let pass = 0
  const encoded = async function* (hash: ReturnType<typeof createHash>): AsyncGenerator<Uint8Array> {
    requireNativeSnapshotSyncStructuredSource(owner)
    const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }),
      selected = pass++ === 0 ? measure : replay
    if (pass > 2) invalid()
    for await (const chunk of selected()) {
      try {
        requireNativeSnapshotSyncStructuredSource(owner)
        if (!(chunk instanceof Uint8Array) || chunk.length < 1 || chunk.length > 65536) invalid()
        utf8.decode(chunk, { stream: true })
        hash.update(chunk)
        yield chunk
      } finally {
        if (chunk instanceof Uint8Array) chunk.fill(0)
      }
    }
    utf8.decode()
    requireNativeSnapshotSyncStructuredSource(owner)
  }
  return await prepareNativeSnapshotContent(
    owner.storage,
    owner.source,
    'provenTxReqs',
    field,
    false,
    {
      workingAllocation: owner.working,
      maximumFieldBytes: 1000000000,
      maximumReadBytes: 16384,
      expiresAt: owner.expiresAt,
      signal: owner.signal
    },
    encoded,
    () => requireNativeSnapshotSyncStructuredSource(owner)
  )
}

/** Detached bounded string DATA, encoded with the native SQLite UTF-8 string
 * contract. Keep surrogate pairs together across windows; no whole-field copy. */
export async function stageNativeSnapshotSyncInlineText(
  owner: NativeSnapshotSyncStructuredSource,
  field: 'history' | 'notify',
  value: string
): Promise<Readonly<PreparedPackedNativeSnapshotField>> {
  requireNativeSnapshotSyncStructuredSource(owner)
  if (typeof value !== 'string' || value.length > 131072) invalid()
  const chunks = async function* (): AsyncGenerator<Uint8Array> {
    for (let offset = 0; offset < value.length;) {
      requireNativeSnapshotSyncStructuredSource(owner)
      let count = Math.min(4096, value.length - offset)
      const last = value.charCodeAt(offset + count - 1),
        next = value.charCodeAt(offset + count)
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) count++
      const bytes = new TextEncoder().encode(value.slice(offset, offset + count))
      try {
        yield bytes
        requireNativeSnapshotSyncStructuredSource(owner)
        offset += count
      } finally {
        bytes.fill(0)
      }
    }
  }
  return await stageNativeSnapshotSyncText(owner, field, chunks, chunks)
}

async function prepareNativeSnapshotContent(
  storage: StorageKnex,
  source: WalletReadSnapshot,
  table: WalletSnapshotTable,
  field: string,
  binary: boolean,
  policy: Readonly<PackedNativeSnapshotFieldPolicy>,
  encoded: (hash: ReturnType<typeof createHash>) => AsyncIterable<Uint8Array>,
  checkSource: () => void,
  expectedOriginalSha?: string
): Promise<Readonly<PreparedPackedNativeSnapshotField>> {
  const working = brc38WorkingAllocation(policy.workingAllocation),
    root = storage.knex,
    origin = ownedNativeRootIdentity(root)
  if (working === undefined || root.isTransaction || origin?.slot !== 0) invalid()
  // These whitelist functions describe coordinates only. Every actual SQL
  // operation below still checks the original producer, lease and exact schema.
  const coordinate = binary
      ? encodeBrc38NativeBlobRead({
          table: table as Brc38NativeBlobRead['table'],
          field: field as Brc38NativeBlobRead['field'],
          rowId: 1,
          offset: 0,
          totalBytes: 1,
          length: 1
        }).subarray(0, 2)
      : brc38NativeTextCoordinate(table as Brc38NativeTextRead['table'], field as Brc38NativeTextRead['field']),
    names = binary ? nativePackedTables : nativePackedTextTables,
    allowance = working.claim(16384 + 8 * 65536 + 4 * policy.maximumReadBytes),
    deadline = performance.now() + Math.max(0, policy.expiresAt - Date.now())
  let lifetime: Brc38NativePreparedFieldLifetime | undefined,
    buffer: Uint8Array | undefined,
    readDatabase: Knex | undefined,
    closed = false,
    consumed = false,
    closing: Promise<void> | undefined,
    attaching: Promise<void> | undefined,
    reading: Promise<Uint8Array> | undefined
  const producer = (): void => {
    if (
      storage.knex !== root ||
      ownedNativeRootIdentity(root)?.token !== origin.token ||
      ownedNativeRootIdentity(root)?.slot !== 0
    )
      invalid()
  }
  const check = (): void => {
    policy.signal?.throwIfAborted()
    producer()
    checkSource()
    if (closed || !source.isOpen || Date.now() >= policy.expiresAt || performance.now() >= deadline)
      throw new SnapshotResourceLimitError('Native snapshot field original source/resource admission ended')
  }
  const schema = async (trx: Knex.Transaction): Promise<void> => {
    producer()
    if (
      ownedNativeRootIdentity(trx)?.token !== origin.token ||
      !(await hasBrc38NativePreparedFieldsSchema(trx)) ||
      !(await hasBrc38NativePackedSchema(trx)) ||
      !(await hasBrc38NativePackedTextSchema(trx))
    )
      invalid()
  }
  const version = async (trx: Knex.Transaction, sha256: string): Promise<Version | undefined> =>
    (await trx(names.versions).where({ sha256 }).first('sha256', 'bytes', 'accepted', 'chunks', 'state')) as
      Version | undefined
  const write = async <T>(operation: (trx: Knex.Transaction) => Promise<T>): Promise<T> => {
    producer()
    return await root.transaction(async trx => {
      requireBrc38PackedWriter(trx)
      await schema(trx)
      const result = await operation(trx)
      producer()
      requireBrc38PackedWriter(trx)
      return result
    })
  }
  const hashStored = async (sha256: string, bytes: number): Promise<Version> => {
    check()
    if (readDatabase !== undefined) invalid()
    const database = createOwnedNativeReadDatabase(root)
    readDatabase = database
    let failed = false,
      cause: unknown,
      result!: Version
    try {
      result = await database.transaction(async trx => {
        await schema(trx)
        await lifetime!.check(trx, policy.signal)
        const before = await version(trx, sha256)
        if (
          before === undefined ||
          before.bytes !== bytes ||
          before.accepted !== bytes ||
          !['PENDING', 'SEALED'].includes(before.state)
        )
          invalid()
        const actual = binary
          ? await hashBrc38NativePackedVersion(trx, sha256, bytes, check, policy.maximumReadBytes, working)
          : await hashBrc38NativePackedTextVersion(trx, sha256, bytes, check, policy.maximumReadBytes, working)
        await lifetime!.check(trx, policy.signal)
        check()
        if (actual !== sha256 || JSON.stringify(await version(trx, sha256)) !== JSON.stringify(before)) invalid()
        return before
      })
    } catch (error_) {
      failed = true
      cause = error_
    }
    try {
      await database.destroy()
      readDatabase = undefined
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [...(failed ? [cause] : []), error_],
        'Native field retains its actual read-only pool',
        async () => {
          await database.destroy()
          if (readDatabase === database) readDatabase = undefined
        }
      )
    }
    if (failed) throw cause
    check()
    return result
  }
  const cleanup = (): Promise<void> => {
    if (closing !== undefined) return closing
    closed = true
    closing = (async () => {
      if (attaching !== undefined) await attaching.catch(() => undefined)
      if (reading !== undefined) await reading.catch(() => undefined)
      buffer?.fill(0)
      buffer = undefined
      if (readDatabase !== undefined) {
        await readDatabase.destroy()
        readDatabase = undefined
      }
      if (lifetime !== undefined) await write(async trx => await lifetime!.release(trx))
      allowance.close()
    })()
    void closing.catch(() => {
      closing = undefined
    })
    return closing
  }
  try {
    check()
    const original = createHash('sha256'),
      target = createHash('sha256')
    let bytes = 0
    for await (const chunk of encoded(original)) {
      try {
        check()
        bytes += chunk.length
        if (bytes > policy.maximumFieldBytes)
          throw new SnapshotResourceLimitError('Native staged field exceeds its original byte ceiling')
        target.update(chunk)
      } finally {
        chunk.fill(0)
      }
    }
    const originalSha = original.digest('hex'),
      sha256 = target.digest('hex')
    if (expectedOriginalSha !== undefined && expectedOriginalSha !== originalSha) invalid()
    let reused = false
    lifetime = await write(async trx => {
      check()
      const existing = await version(trx, sha256)
      if (existing !== undefined) {
        if (existing.state !== 'SEALED' || existing.bytes !== bytes || existing.accepted !== bytes) invalid()
        reused = true
      } else await trx(names.versions).insert({ sha256, bytes, accepted: 0, chunks: 0, state: 'PENDING' })
      return await Brc38NativePreparedFieldLifetime.begin(
        trx,
        binary ? 'binary' : 'text',
        sha256,
        policy.expiresAt,
        policy.signal
      )
    })
    check()
    if (!reused) {
      buffer = new Uint8Array(65536)
      const replay = createHash('sha256'),
        postimage = createHash('sha256')
      let filled = 0,
        offset = 0
      const append = async (value: Uint8Array): Promise<void> => {
        const at = offset
        await write(async trx => {
          check()
          await lifetime!.check(trx, policy.signal)
          const actual = await version(trx, sha256)
          if (actual?.state !== 'PENDING' || actual.bytes !== bytes || actual.accepted !== at) invalid()
          const captured = Buffer.from(value)
          try {
            await trx(names.chunks).insert({
              sha256,
              offset: at,
              bytes: value.length,
              payload: captured,
              chunkSha256: digest(value)
            })
          } finally {
            captured.fill(0)
          }
          await lifetime!.check(trx, policy.signal)
          check()
        })
        offset += value.length
      }
      for await (const chunk of encoded(replay)) {
        try {
          check()
          postimage.update(chunk)
          for (let used = 0; used < chunk.length;) {
            const amount = Math.min(buffer.length - filled, chunk.length - used)
            buffer.set(chunk.subarray(used, used + amount), filled)
            used += amount
            filled += amount
            if (filled === buffer.length) {
              await append(buffer)
              filled = 0
              buffer.fill(0)
            }
          }
        } finally {
          chunk.fill(0)
        }
      }
      if (filled !== 0) await append(buffer.subarray(0, filled))
      if (offset !== bytes || replay.digest('hex') !== originalSha || postimage.digest('hex') !== sha256) invalid()
      buffer.fill(0)
      buffer = undefined
    }
    const verified = await hashStored(sha256, bytes)
    await write(async trx => {
      check()
      await lifetime!.check(trx, policy.signal)
      if (JSON.stringify(await version(trx, sha256)) !== JSON.stringify(verified)) invalid()
      if (
        verified.state === 'PENDING' &&
        (await trx(names.versions)
          .where({ sha256, state: 'PENDING', bytes, accepted: bytes, chunks: verified.chunks })
          .update({ state: 'SEALED' })) !== 1
      )
        invalid()
      check()
    })
    allowance.resize(4096)
    const attach = async (trx: Knex.Transaction, rowId: number): Promise<void> => {
      check()
      if (
        consumed ||
        attaching !== undefined ||
        reading !== undefined ||
        readDatabase !== undefined ||
        !Number.isSafeInteger(rowId) ||
        rowId < 1
      )
        invalid()
      consumed = true
      const operation = (async () => {
        requireBrc38PackedWriter(trx)
        await schema(trx)
        await lifetime!.check(trx, policy.signal)
        const actual = await version(trx, sha256)
        if (
          actual?.state !== 'SEALED' ||
          actual.bytes !== bytes ||
          actual.accepted !== bytes ||
          actual.chunks !== verified.chunks
        )
          invalid()
        const textSource = binary ? undefined : nativePackedTextSource(table),
          sqlTable = binary ? binaryTables[table] : textSource!.sql,
          physical = (await (
            binary ? trx(sqlTable).whereRaw('rowid=?', [rowId]) : trx(sqlTable).where({ [textSource!.key]: rowId })
          ).first(trx.raw('typeof(??) AS kind,length(CAST(?? AS BLOB)) AS bytes', [field, field]))) as
            { kind: string; bytes: number } | undefined
        if (physical?.kind !== (binary ? 'blob' : 'text') || physical.bytes !== 0) invalid()
        const key = { tableId: coordinate[0], fieldId: coordinate[1], rowId }
        await trx(names.fields).where(key).delete()
        await trx(names.fields).insert({ ...key, sha256 })
        const after = binary
          ? await readBrc38NativePackedDescriptor(trx, {
              table: table as Brc38NativeBlobRead['table'],
              field: field as Brc38NativeBlobRead['field'],
              rowId
            })
          : await readBrc38NativePackedTextDescriptor(trx, {
              table: table as Brc38NativeTextRead['table'],
              field: field as Brc38NativeTextRead['field'],
              rowId
            })
        check()
        await lifetime!.check(trx, policy.signal)
        if (after?.bytes !== bytes || after.sha256 !== sha256) invalid()
      })()
      attaching = operation
      try {
        await operation
      } finally {
        attaching = undefined
      }
    }
    const read = async (offset: number, length: number): Promise<Uint8Array> => {
      check()
      if (
        consumed ||
        reading !== undefined ||
        readDatabase !== undefined ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > policy.maximumReadBytes ||
        offset + length > bytes
      )
        invalid()
      const reservation = working.claim(16384 + 8 * 65536 + 4 * length)
      const operation = (async (): Promise<Uint8Array> => {
        const database = createOwnedNativeReadDatabase(root)
        readDatabase = database
        let output: Uint8Array | undefined,
          failed = false,
          cause: unknown
        try {
          output = await database.transaction(async trx => {
            check()
            await schema(trx)
            await lifetime!.check(trx, policy.signal)
            const before = await version(trx, sha256)
            if (
              before?.state !== 'SEALED' ||
              before.bytes !== bytes ||
              before.accepted !== bytes ||
              before.chunks !== verified.chunks
            )
              invalid()
            const result = new Uint8Array(length)
            try {
              for (let used = 0; used < length;) {
                check()
                await lifetime!.check(trx, policy.signal)
                const at = offset + used,
                  rows: Array<{
                    offset: unknown
                    bytes: unknown
                    kind: unknown
                    actualBytes: unknown
                    chunkSha256: unknown
                  }> = await trx(names.chunks)
                    .where({ sha256 })
                    .where('offset', '<=', at)
                    .orderBy('offset', 'desc')
                    .limit(1)
                    .select(
                      'offset',
                      'bytes',
                      'chunkSha256',
                      trx.raw('typeof(payload) AS kind,length(payload) AS actualBytes')
                    )
                const row = rows[0]
                if (
                  rows.length !== 1 ||
                  typeof row.offset !== 'number' ||
                  !Number.isSafeInteger(row.offset) ||
                  row.offset < 0 ||
                  row.offset > at ||
                  typeof row.bytes !== 'number' ||
                  !Number.isSafeInteger(row.bytes) ||
                  row.bytes < 1 ||
                  row.bytes > 65536 ||
                  row.actualBytes !== row.bytes ||
                  row.kind !== 'blob' ||
                  typeof row.chunkSha256 !== 'string' ||
                  !/^[0-9a-f]{64}$/.test(row.chunkSha256) ||
                  at - row.offset >= row.bytes ||
                  row.offset + row.bytes > bytes
                )
                  invalid()
                const actual = (await trx(names.chunks).where({ sha256, offset: row.offset }).first('payload')) as
                  { payload: Uint8Array } | undefined
                let chunk: Uint8Array | undefined
                try {
                  if (
                    actual === undefined ||
                    !(actual.payload instanceof Uint8Array) ||
                    actual.payload.byteLength !== row.bytes
                  )
                    invalid()
                  chunk = detachBrc38PrivateChunk(actual.payload, 65536)
                  if (digest(chunk) !== row.chunkSha256) invalid()
                  const within = at - row.offset,
                    amount = Math.min(row.bytes - within, length - used)
                  result.set(chunk.subarray(within, within + amount), used)
                  used += amount
                } finally {
                  chunk?.fill(0)
                  actual?.payload.fill(0)
                }
              }
              check()
              await lifetime!.check(trx, policy.signal)
              if (JSON.stringify(await version(trx, sha256)) !== JSON.stringify(before)) invalid()
              return result
            } catch (error_) {
              result.fill(0)
              throw error_
            }
          })
        } catch (error_) {
          failed = true
          cause = error_
        }
        try {
          await database.destroy()
          readDatabase = undefined
        } catch (error_) {
          output?.fill(0)
          throw new Brc38StagingCleanupError(
            [...(failed ? [cause] : []), error_],
            'Native issued stage retains its actual extent read pool',
            async () => {
              await database.destroy()
              if (readDatabase === database) readDatabase = undefined
            }
          )
        }
        if (failed) {
          output?.fill(0)
          throw cause
        }
        try {
          check()
          if (output === undefined) invalid()
          return output
        } catch (error_) {
          output?.fill(0)
          throw error_
        }
      })()
      reading = operation
      try {
        return await operation
      } finally {
        reading = undefined
        reservation.close()
      }
    }
    const prepared = Object.freeze({
      descriptor: Object.freeze({ kind: binary ? ('binary' as const) : ('utf8' as const), bytes, sha256 }),
      attach,
      read,
      close: cleanup
    })
    issued.set(prepared, Object.freeze({ storage, table, field }))
    return prepared
  } catch (cause) {
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Native source field retains staged content, physical read lease and working allowance',
        cleanup
      )
    }
    throw cause
  }
}
