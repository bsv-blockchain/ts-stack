import type { Brc38JsonStreamedField, Brc38JsonStreamedRow } from './Brc38JsonBinaryFields'
import type { BRC38Tables, BRC38WalletData } from './index'
import type { Brc38JsonStagingSink } from './Brc38JsonStream'
import {
  type PortableRow,
  requireNumber,
  requireString,
  assertIsoDate,
  validatePortableRows
} from './Brc38PortableRows'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { brc38JsonTextField } from './Brc38JsonTextFields'
import { runInSeries } from '../../utility/runInSeries'

export type Brc38StageTable = keyof BRC38Tables

export interface Brc38AuthenticatedImportReader {
  readonly header: () => Promise<Readonly<BRC38WalletData>>
  readonly count: (table: Brc38StageTable) => Promise<number>
  readonly row: (table: Brc38StageTable, index: number) => Promise<Readonly<PortableRow> | undefined>
}
/** Actual authenticated field-aware source view. Metadata/descriptors are DATA;
 * no complete binary or placeholder row is exposed and this grants no target
 * transaction, current-profile admission or activation authority. */
export interface Brc38AuthenticatedStreamedImportReader {
  readonly header: Brc38AuthenticatedImportReader['header']
  readonly count: Brc38AuthenticatedImportReader['count']
  readonly row: (table: Brc38StageTable, index: number) => Promise<Brc38JsonStreamedRow | undefined>
  readonly chunk: (
    table: Brc38StageTable,
    index: number,
    field: string,
    offset: number
  ) => Promise<Readonly<{ descriptor: Brc38JsonStreamedField; offset: number; bytes: Uint8Array }> | undefined>
}
export interface Brc38StageKey {
  readonly namespace: string
  readonly key: string
}
export interface Brc38StageRecord {
  readonly table: Brc38StageTable
  readonly index: number
  readonly row: Readonly<PortableRow>
  readonly uniqueKeys: readonly Brc38StageKey[]
  readonly memberships: readonly Brc38StageKey[]
}
/** Private host-owned store. Appends must atomically persist the row, all keys
 * and counters under logical AND physical quotas. Queries return one bounded
 * row or scalar, never an archive-size array. A sealed stage is not active data. */
export interface Brc38StageStore {
  append: (record: Brc38StageRecord) => Promise<void>
  count: (table: Brc38StageTable) => Promise<number>
  row: (table: Brc38StageTable, index: number) => Promise<Readonly<PortableRow> | undefined>
  /** Actual bounded string-content validation, called freshly for each stored row.
   * Names describe separately persisted scalar strings; they cannot activate data. */
  textFields?: (table: Brc38StageTable, index: number) => Promise<readonly string[]>
  has: (namespace: string, key: string) => Promise<boolean>
  seal: (header: Readonly<BRC38WalletData>, counts: Readonly<Record<Brc38StageTable, number>>) => Promise<void>
  discard: (cause: unknown) => Promise<void>
}
export interface Brc38SemanticStageOptions {
  readonly expectedIdentityKey: string
  readonly expectedChain: 'main' | 'test'
  readonly expectedSourceStorageIdentityKey: string
  readonly maximumRows: number
  readonly signal?: AbortSignal
}
interface Form {
  readonly kind: string
  readonly id: readonly string[]
  readonly integers: readonly string[]
  readonly strings: readonly string[]
  readonly booleans: readonly string[]
  readonly naturalKey?: readonly string[]
  readonly optionalIntegers?: readonly string[]
  readonly optionalStrings?: readonly string[]
}
const forms: Readonly<Record<Brc38StageTable, Form>> = {
  provenTxs: {
    kind: 'provenTx',
    id: ['provenTxId'],
    integers: ['height', 'index'],
    strings: ['txid', 'merklePath', 'rawTx', 'blockHash', 'merkleRoot'],
    booleans: [],
    naturalKey: ['txid']
  },
  provenTxReqs: {
    kind: 'provenTxReq',
    id: ['provenTxReqId'],
    integers: ['attempts'],
    strings: ['status', 'txid', 'rawTx'],
    booleans: ['notified'],
    naturalKey: ['txid'],
    optionalIntegers: ['provenTxId', 'rebroadcastAttempts'],
    optionalStrings: ['batch', 'inputBEEF']
  },
  outputBaskets: {
    kind: 'outputBasket',
    id: ['basketId'],
    integers: ['userId', 'numberOfDesiredUTXOs', 'minimumDesiredUTXOValue'],
    strings: ['name'],
    booleans: ['isDeleted'],
    naturalKey: ['name', 'userId']
  },
  transactions: {
    kind: 'transaction',
    id: ['transactionId'],
    integers: ['userId', 'satoshis'],
    strings: ['status', 'reference', 'description'],
    booleans: ['isOutgoing'],
    naturalKey: ['reference'],
    optionalIntegers: ['provenTxId', 'version', 'lockTime'],
    optionalStrings: ['txid', 'inputBEEF', 'rawTx']
  },
  commissions: {
    kind: 'commission',
    id: ['commissionId'],
    integers: ['userId', 'transactionId', 'satoshis'],
    strings: ['keyOffset', 'lockingScript'],
    booleans: ['isRedeemed'],
    naturalKey: ['transactionId']
  },
  outputs: {
    kind: 'output',
    id: ['outputId'],
    integers: ['userId', 'transactionId', 'vout', 'satoshis'],
    strings: ['outputDescription', 'providedBy', 'purpose', 'type'],
    booleans: ['spendable', 'change'],
    naturalKey: ['transactionId', 'vout', 'userId'],
    optionalIntegers: ['basketId', 'spentBy', 'sequenceNumber', 'scriptLength', 'scriptOffset'],
    optionalStrings: [
      'txid',
      'senderIdentityKey',
      'derivationPrefix',
      'derivationSuffix',
      'customInstructions',
      'spendingDescription',
      'lockingScript'
    ]
  },
  outputTags: {
    kind: 'outputTag',
    id: ['outputTagId'],
    integers: ['userId'],
    strings: ['tag'],
    booleans: ['isDeleted'],
    naturalKey: ['tag', 'userId']
  },
  outputTagMaps: {
    kind: 'outputTagMap',
    id: ['outputTagId', 'outputId'],
    integers: [],
    strings: [],
    booleans: ['isDeleted']
  },
  txLabels: {
    kind: 'txLabel',
    id: ['txLabelId'],
    integers: ['userId'],
    strings: ['label'],
    booleans: ['isDeleted'],
    naturalKey: ['label', 'userId']
  },
  txLabelMaps: {
    kind: 'txLabelMap',
    id: ['txLabelId', 'transactionId'],
    integers: [],
    strings: [],
    booleans: ['isDeleted']
  },
  certificates: {
    kind: 'certificate',
    id: ['certificateId'],
    integers: ['userId'],
    strings: ['type', 'serialNumber', 'certifier', 'subject', 'revocationOutpoint', 'signature'],
    booleans: ['isDeleted'],
    naturalKey: ['userId', 'type', 'certifier', 'serialNumber'],
    optionalStrings: ['verifier']
  },
  certificateFields: {
    kind: 'certificateField',
    id: ['certificateId', 'fieldName'],
    integers: ['userId'],
    strings: ['fieldName', 'fieldValue', 'masterKey'],
    booleans: []
  },
  syncStates: {
    kind: 'syncState',
    id: ['syncStateId'],
    integers: ['userId'],
    strings: ['storageIdentityKey', 'storageName', 'status', 'refNum'],
    booleans: ['init'],
    naturalKey: ['refNum'],
    optionalIntegers: ['satoshis']
  }
}
export const brc38StageTables: readonly Brc38StageTable[] = Object.freeze(Object.keys(forms) as Brc38StageTable[])
const owned = new Set<Brc38StageTable>([
  'outputBaskets',
  'transactions',
  'commissions',
  'outputs',
  'outputTags',
  'txLabels',
  'certificates',
  'certificateFields',
  'syncStates'
])
interface Reference {
  table: Brc38StageTable
  field: string
  optional?: boolean
}
const references: Partial<Record<Brc38StageTable, readonly Reference[]>> = {
  transactions: [{ table: 'provenTxs', field: 'provenTxId', optional: true }],
  provenTxReqs: [{ table: 'provenTxs', field: 'provenTxId', optional: true }],
  commissions: [{ table: 'transactions', field: 'transactionId' }],
  outputs: [
    { table: 'transactions', field: 'transactionId' },
    { table: 'transactions', field: 'spentBy', optional: true },
    { table: 'outputBaskets', field: 'basketId', optional: true }
  ],
  txLabelMaps: [
    { table: 'transactions', field: 'transactionId' },
    { table: 'txLabels', field: 'txLabelId' }
  ],
  outputTagMaps: [
    { table: 'outputs', field: 'outputId' },
    { table: 'outputTags', field: 'outputTagId' }
  ],
  certificateFields: [{ table: 'certificates', field: 'certificateId' }]
}
function key(namespace: string, values: readonly unknown[]): Brc38StageKey {
  return { namespace, key: JSON.stringify(values) }
}
function validateFields(
  row: Readonly<PortableRow>,
  fields: readonly string[],
  type: 'integer' | 'string' | 'boolean',
  path: string
): void {
  for (const field of fields) {
    const value = row[field],
      label = `${path}.${field}`
    if (type === 'integer') requireNumber(value, label)
    else if (type === 'string') requireString(value, label)
    else if (typeof value !== 'boolean') throw new Error(`BRC-38 ${label} must be a boolean`)
  }
}
function validateOptionalFields(row: Readonly<PortableRow>, form: Form, path: string): void {
  validateFields(
    row,
    (form.optionalIntegers ?? []).filter(field => field in row),
    'integer',
    path
  )
  validateFields(
    row,
    (form.optionalStrings ?? []).filter(field => field in row),
    'string',
    path
  )
  // Historical SQLite archives retain the optional SQL flag as 0/1; typed
  // providers emit booleans. Preserve either spelling until restore admission.
  if (
    'wasBroadcast' in row &&
    typeof row.wasBroadcast !== 'boolean' &&
    row.wasBroadcast !== 0 &&
    row.wasBroadcast !== 1
  )
    throw new Error(`BRC-38 ${path}.wasBroadcast must be a boolean or 0/1`)
}
function validateHistoryNote(note: unknown, path: string): void {
  if (typeof note !== 'object' || note === null || Array.isArray(note))
    throw new Error(`BRC-38 ${path}.history.notes entries must be objects`)
  if ('when' in note) assertIsoDate(note.when, `${path}.history.notes.when`)
  requireString('what' in note ? note.what : undefined, `${path}.history.notes.what`)
}
function validateRequestHistory(row: Readonly<PortableRow>, path: string): void {
  const history = row.history,
    notify = row.notify
  if (typeof history !== 'object' || Array.isArray(history) || typeof notify !== 'object' || Array.isArray(notify))
    throw new Error(`BRC-38 ${path} requires history and notify objects`)
  if ('notes' in history) {
    if (!Array.isArray(history.notes)) throw new Error(`BRC-38 ${path}.history.notes must be an array`)
    for (const note of history.notes) validateHistoryNote(note, path)
  }
  if ('transactionIds' in notify) {
    if (!Array.isArray(notify.transactionIds)) throw new Error(`BRC-38 ${path}.notify.transactionIds must be an array`)
    for (const id of notify.transactionIds) requireNumber(id, `${path}.notify.transactionIds`)
  }
}
function validateRow(
  table: Brc38StageTable,
  index: number,
  row: Readonly<PortableRow>,
  texts: readonly string[] = []
): void {
  if (
    texts.length > 7 ||
    new Set(texts).size !== texts.length ||
    texts.some(field => !brc38JsonTextField(table, field) || Object.hasOwn(row, field))
  )
    throw new Error('Invalid separately staged BRC-38 scalar string coordinates')
  const form = forms[table],
    path = `${table}[${index}]`
  validatePortableRows(form.kind, [row], table)
  assertIsoDate(row.created_at, `${path}.created_at`)
  assertIsoDate(row.updated_at, `${path}.updated_at`)
  validateFields(
    row,
    form.id.filter(field => field !== 'fieldName'),
    'integer',
    path
  )
  validateFields(row, form.integers, 'integer', path)
  validateFields(
    row,
    form.strings.filter(field => !texts.includes(field)),
    'string',
    path
  )
  validateFields(row, form.booleans, 'boolean', path)
  validateOptionalFields(row, form, path)
  if (table === 'provenTxReqs') validateRequestHistory(row, path)
  if (table === 'syncStates') {
    const value = row.syncMap
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`BRC-38 ${path}.syncMap must be an object`)
  }
}
function record(table: Brc38StageTable, index: number, row: Readonly<PortableRow>): Brc38StageRecord {
  const form = forms[table]
  const uniqueKeys = [
    key(
      table,
      form.id.map(field => row[field])
    )
  ]
  if (form.naturalKey !== undefined)
    uniqueKeys.push(
      key(
        `${table}:natural`,
        form.naturalKey.map(field => row[field])
      )
    )
  const memberships: Brc38StageKey[] = []
  if (table === 'transactions' && typeof row.txid === 'string') memberships.push(key('transaction-txid', [row.txid]))
  if ((table === 'transactions' || table === 'provenTxReqs') && 'provenTxId' in row)
    memberships.push(key('referenced-proof', [row.provenTxId]))
  return { table, index, row, uniqueKeys, memberships }
}
function* indices(count: number): Generator<number> {
  for (let index = 0; index < count; index++) yield index
}

/** Coordinates serial bounded semantics with durable private storage. Neither
 * construction nor successful sealing activates user.activeStorage/syncStates. */
export class Brc38SemanticStage implements Brc38JsonStagingSink {
  readonly #counts = new Map(brc38StageTables.map(table => [table, 0]))
  #rows = 0
  #busy = false
  #state: 'staging' | 'sealed' | 'discarded' = 'staging'
  readonly options: Brc38SemanticStageOptions
  constructor(
    readonly store: Brc38StageStore,
    options: Brc38SemanticStageOptions
  ) {
    if (!Number.isSafeInteger(options.maximumRows) || options.maximumRows < 1)
      throw new RangeError('maximumRows must be a positive safe integer')
    for (const value of [options.expectedIdentityKey, options.expectedSourceStorageIdentityKey]) {
      if (typeof value !== 'string' || value.length === 0)
        throw new TypeError('Explicit import identity and source storage are required')
    }
    if (options.expectedChain !== 'main' && options.expectedChain !== 'test')
      throw new TypeError('Explicit import chain is required')
    this.options = Object.freeze({ ...options })
  }
  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.#busy || this.#state !== 'staging') throw new Error('Private BRC-38 stage is unavailable')
    this.options.signal?.throwIfAborted()
    this.#busy = true
    try {
      return await work()
    } finally {
      this.#busy = false
    }
  }
  async provisionalRow(
    table: Brc38StageTable,
    index: number,
    row: Readonly<PortableRow>,
    texts: readonly string[] = []
  ): Promise<void> {
    texts = Object.freeze([...texts])
    await this.#exclusive(async () => {
      const expected = this.#counts.get(table)
      if (expected === undefined || index !== expected || !Number.isSafeInteger(index))
        throw new Error('BRC-38 staging row order is invalid')
      if (this.#rows === this.options.maximumRows)
        throw new SnapshotResourceLimitError('BRC-38 staging row policy reached')
      validateRow(table, index, row, texts)
      await this.store.append(record(table, index, row))
      this.#counts.set(table, index + 1)
      this.#rows++
      this.options.signal?.throwIfAborted()
    })
  }
  #validateHeader(header: Readonly<BRC38WalletData>): number {
    if (header.brc !== 38 || header.title !== 'User Wallet Data Format' || header.formatVersion !== 1)
      throw new Error('BRC-38 private stage requires the standard version-one header')
    assertIsoDate(header.exportedAt, 'exportedAt')
    validatePortableRows('settings', [header.sourceStorage], 'sourceStorage')
    validatePortableRows('user', [header.user], 'user')
    const { sourceStorage, user } = header
    if (
      user.identityKey !== this.options.expectedIdentityKey ||
      sourceStorage.chain !== this.options.expectedChain ||
      sourceStorage.storageIdentityKey !== this.options.expectedSourceStorageIdentityKey
    )
      throw new Error('BRC-38 import profile does not match its selected identity, chain and source')
    requireString(user.activeStorage, 'user.activeStorage')
    requireString(sourceStorage.storageName, 'sourceStorage.storageName')
    requireString(sourceStorage.dbtype, 'sourceStorage.dbtype')
    requireNumber(sourceStorage.maxOutputScript, 'sourceStorage.maxOutputScript')
    for (const [name, value] of [
      ['sourceStorage', sourceStorage],
      ['user', user]
    ] as const) {
      assertIsoDate(value.created_at, `${name}.created_at`)
      assertIsoDate(value.updated_at, `${name}.updated_at`)
    }
    return requireNumber(user.userId, 'user.userId')
  }
  async #require(namespace: string, values: readonly unknown[], label: string): Promise<void> {
    if (!(await this.store.has(namespace, JSON.stringify(values))))
      throw new Error(`BRC-38 ${label} does not reference an exported row`)
  }
  async #validateRelations(table: Brc38StageTable, index: number, userId: number): Promise<void> {
    this.options.signal?.throwIfAborted()
    const row = await this.store.row(table, index)
    if (row === undefined) throw new Error('BRC-38 private staged row is missing')
    const texts = this.store.textFields === undefined ? [] : await this.store.textFields(table, index)
    validateRow(table, index, row, texts)
    if (owned.has(table) && row.userId !== userId) throw new Error(`BRC-38 ${table}.userId does not match user.userId`)
    await runInSeries(references[table] ?? [], async ref => {
      if (ref.optional === true && row[ref.field] === undefined) return
      await this.#require(ref.table, [requireNumber(row[ref.field], `${table}.${ref.field}`)], `${table}.${ref.field}`)
    })
    if (table === 'provenTxReqs') await this.#require('transaction-txid', [row.txid], 'provenTxReq.txid')
    if (table === 'provenTxs') await this.#require('referenced-proof', [row.provenTxId], 'provenTx.provenTxId')
    // Resolved DB adapters must also leave a real host turn for cancellation.
    if (index % 128 === 127) await new Promise<void>(done => setTimeout(done, 0))
    this.options.signal?.throwIfAborted()
  }
  async validateCompleted(
    header: Readonly<BRC38WalletData>,
    counts: Readonly<Record<Brc38StageTable, number>>
  ): Promise<void> {
    await this.#exclusive(async () => {
      const userId = this.#validateHeader(header)
      await runInSeries(brc38StageTables, async table => {
        const count = this.#counts.get(table)
        if (count === undefined || counts[table] !== count || (await this.store.count(table)) !== count)
          throw new Error('BRC-38 staged table count is inconsistent')
        await runInSeries(indices(count), index => this.#validateRelations(table, index, userId))
      })
      this.options.signal?.throwIfAborted()
      await this.store.seal(header, counts)
      this.#state = 'sealed'
    })
  }
  async discard(cause: unknown): Promise<void> {
    if (this.#busy) throw new Error('Wait for owned BRC-38 staging I/O before disposal')
    if (this.#state === 'discarded') return
    this.#busy = true
    try {
      await this.store.discard(cause)
      this.#state = 'discarded'
    } finally {
      this.#busy = false
    }
  }
}
