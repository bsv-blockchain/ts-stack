import { createHash } from 'node:crypto'
import type { CollectionInfo, Db, Document, IndexDescription } from 'mongodb'
import {
  parseStorageOutputIndex,
  parseStorageUint64,
  type StorageScope
} from '../AdmissionStorage.js'

/** The immutable chain namespace shared by all Overlay nodes. */
export interface MongoChainScope {
  network: string
  genesisHash: string
}

export const MongoCollectionNames = {
  schema: 'overlay_schema',
  payloads: 'overlay_payloads',
  payloadReferences: 'overlay_payload_references',
  submissionOperations: 'overlay_submission_operations',
  readGuards: 'overlay_read_guards',
  transactions: 'overlay_transactions',
  transactionProofs: 'overlay_transaction_proofs',
  outputs: 'overlay_outputs',
  consumptionEdges: 'overlay_consumption_edges',
  appliedTransactions: 'overlay_applied_transactions',
  topicGenerations: 'overlay_topic_generations',
  topicAnchors: 'overlay_topic_anchors',
  topicAnchorTips: 'overlay_topic_anchor_tips',
  basmRecoveryJobs: 'overlay_basm_recovery_jobs',
  basmComparisons: 'overlay_basm_comparisons',
  gaspCursors: 'overlay_gasp_cursors',
  gaspGraphs: 'overlay_gasp_graphs',
  gaspNodes: 'overlay_gasp_nodes',
  manifestComponents: 'overlay_manifest_components',
  lookupOutbox: 'overlay_lookup_outbox',
  propagationOutbox: 'overlay_propagation_outbox',
  shipRecords: 'overlay_ship_records',
  slapRecords: 'overlay_slap_records',
  bannedRecords: 'overlay_banned_records'
} as const

/** GridFS bucket for payload bytes that cannot be stored inline. */
export const MongoGridFsBucketName = 'overlayPayloads'

const schemaVersion = 1
const maxUint64 = '18446744073709551615'
const maxUint32 = 4294967295
const paddedUint64Pattern = String.raw`^\d{20}$`
const hashPattern = '^[0-9a-f]{64}$'
const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
const safeStringPattern = String.raw`^[^\x00]+$`

function validPart(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 1024 ||
    value.includes('\u0000') ||
    !value.isWellFormed()
  ) {
    throw new Error('Invalid Mongo record key component')
  }
  return value
}

/**
 * A length-framed, UTF-8 tuple. It remains unambiguous when values contain
 * dots, colons, or separators and is safe to use only as a BSON value, never
 * as a dynamic BSON field name.
 */
export function mongoRecordKey(...parts: string[]): string {
  if (parts.length === 0 || parts.length > 32) throw new Error('Invalid Mongo record key')
  const encoded = parts.map(part => {
    const valid = validPart(part)
    return `${Buffer.byteLength(valid, 'utf8')}:${valid}`
  })
  const result = `v1|${encoded.join('|')}`
  if (Buffer.byteLength(result, 'utf8') > 4096) throw new Error('Mongo record key is too large')
  return result
}

function validChainScope(scope: MongoChainScope): MongoChainScope {
  if (
    typeof scope !== 'object' ||
    scope === null ||
    typeof scope.network !== 'string' ||
    typeof scope.genesisHash !== 'string' ||
    Buffer.byteLength(validPart(scope.network), 'utf8') > 128 ||
    !new RegExp(hashPattern).test(scope.genesisHash)
  ) {
    throw new Error('Invalid Mongo chain scope')
  }
  return scope
}

export function mongoChainKey(scope: MongoChainScope): string {
  const valid = validChainScope(scope)
  return mongoRecordKey('chain', valid.network, valid.genesisHash)
}

export function mongoNodeKey(scope: StorageScope): string {
  const valid = validChainScope(scope)
  return mongoRecordKey('node', valid.network, valid.genesisHash, validPart(scope.nodeId))
}

/** Stores a canonical S01 uint64 in an exact, lexically sortable BSON string. */
export function encodeMongoUint64(value: string): string {
  const parsed = parseStorageUint64(value)
  return parsed.toString(10).padStart(20, '0')
}

/** Strict inverse of encodeMongoUint64; rejects non-canonical padded values. */
export function decodeMongoUint64(value: string): string {
  if (typeof value !== 'string' || !new RegExp(paddedUint64Pattern).test(value))
    throw new Error('Invalid Mongo uint64')
  if (value > maxUint64) throw new Error('Invalid Mongo uint64')
  const decoded = BigInt(value).toString(10)
  if (encodeMongoUint64(decoded) !== value) throw new Error('Invalid Mongo uint64')
  return decoded
}

/** Validates the wire uint32 domain and returns its canonical decimal spelling. */
export function encodeMongoOutputIndex(value: string): string {
  return String(parseStorageOutputIndex(value))
}

const string = (maxLength = 1024): Document => ({
  bsonType: 'string',
  pattern: safeStringPattern,
  minLength: 1,
  maxLength
})
const date: Document = { bsonType: 'date' }
const hash: Document = { bsonType: 'string', pattern: hashPattern }
const uint64: Document = { bsonType: 'string', pattern: paddedUint64Pattern }
const uint32: Document = { bsonType: 'string', pattern: '^(0|[1-9][0-9]{0,9})$' }
const schemaV1: Document = { bsonType: 'int', enum: [schemaVersion] }

const chainFields: Document = { network: string(128), genesisHash: hash }
const nodeFields: Document = { ...chainFields, nodeId: string(256) }
const commonFields: Document = {
  schemaVersion: schemaV1,
  createdAt: date,
  updatedAt: date
}

function scopedValidator(
  fields: Document,
  required: string[],
  options: { node?: boolean; extra?: Document; allowAdditional?: boolean } = {}
): Document {
  const scopeFields = options.node ? nodeFields : chainFields
  const uint64Bounds = Object.entries(fields)
    .filter(([, definition]) => definition === uint64)
    .map(([field]) => ({
      $or: [{ $eq: [{ $type: `$${field}` }, 'missing'] }, { $lte: [`$${field}`, maxUint64] }]
    }))
  // Unpadded canonical uint32 strings are not lexicographically ordered; compare as integers.
  const uint32Bounds = Object.entries(fields)
    .filter(([, definition]) => definition === uint32)
    .map(([field]) => ({
      $or: [
        { $eq: [{ $type: `$${field}` }, 'missing'] },
        { $lte: [{ $toLong: `$${field}` }, maxUint32] }
      ]
    }))
  return {
    $and: [
      {
        $jsonSchema: {
          bsonType: 'object',
          additionalProperties: options.allowAdditional ?? false,
          required: [
            '_id',
            'schemaVersion',
            'createdAt',
            'updatedAt',
            ...Object.keys(scopeFields),
            ...required
          ],
          properties: { _id: string(4096), ...commonFields, ...scopeFields, ...fields }
        }
      },
      ...uint64Bounds.map(bound => ({ $expr: bound })),
      ...uint32Bounds.map(bound => ({ $expr: bound })),
      ...(options.extra === undefined ? [] : [options.extra])
    ]
  }
}

export interface MongoCollectionDefinition {
  readonly name: (typeof MongoCollectionNames)[keyof typeof MongoCollectionNames]
  readonly validator: Document
  readonly indexes: readonly IndexDescription[]
}

interface MongoSchemaDocument extends Document {
  _id: string
}

const index = (
  key: Document,
  name: string,
  options: Omit<IndexDescription, 'key' | 'name'> = {}
): IndexDescription => ({
  key,
  name,
  ...options
})

const definitions: MongoCollectionDefinition[] = [
  {
    name: MongoCollectionNames.schema,
    validator: scopedValidator(
      { schemaFingerprint: hash, lastTransactionProbeAt: date },
      ['schemaFingerprint'],
      { node: true }
    ),
    indexes: [index({ network: 1, genesisHash: 1, nodeId: 1 }, 'scope_unique', { unique: true })]
  },
  {
    name: MongoCollectionNames.payloads,
    validator: scopedValidator(
      {
        kind: string(64),
        digest: hash,
        byteLength: uint64,
        state: { bsonType: 'string', enum: ['uploading', 'ready', 'deleting', 'deleted'] },
        guard: string(256),
        ownerNodeId: string(256),
        ownerId: string(1024),
        fencingToken: uint64,
        leaseUntil: date,
        fileId: { bsonType: 'objectId' },
        inlineData: { bsonType: 'binData' },
        retiredFileId: { bsonType: 'objectId' },
        uploadId: string(256)
      },
      [
        'kind',
        'digest',
        'byteLength',
        'state',
        'guard',
        'ownerNodeId',
        'ownerId',
        'fencingToken',
        'leaseUntil'
      ]
    ),
    indexes: [
      index({ network: 1, genesisHash: 1, kind: 1, digest: 1 }, 'chain_kind_digest_unique', {
        unique: true
      }),
      index({ network: 1, genesisHash: 1, state: 1, updatedAt: 1 }, 'chain_state_updated')
    ]
  },
  {
    name: MongoCollectionNames.payloadReferences,
    validator: scopedValidator(
      {
        payloadId: string(4096),
        ownerKind: {
          bsonType: 'string',
          enum: [
            'transaction',
            'applied-history',
            'output',
            'gasp-graph',
            'gasp-node',
            'basm-job',
            'lookup-outbox',
            'propagation-outbox',
            'manifest',
            'pin'
          ]
        },
        ownerId: string(4096),
        slot: string(256),
        expiresAt: date
      },
      ['payloadId', 'ownerKind', 'ownerId', 'slot'],
      {
        node: true,
        extra: {
          $expr: {
            $eq: [{ $eq: ['$ownerKind', 'pin'] }, { $ne: [{ $type: '$expiresAt' }, 'missing'] }]
          }
        }
      }
    ),
    indexes: [
      index(
        { network: 1, genesisHash: 1, nodeId: 1, ownerKind: 1, ownerId: 1, slot: 1 },
        'owner_slot_unique',
        {
          unique: true
        }
      ),
      index({ payloadId: 1 }, 'payload_reference'),
      index({ expiresAt: 1 }, 'pin_expiry', { partialFilterExpression: { ownerKind: 'pin' } })
    ]
  },
  {
    name: MongoCollectionNames.submissionOperations,
    validator: scopedValidator(
      {
        operationId: string(1024),
        semanticDigest: hash,
        txid: hash,
        state: { bsonType: 'string', enum: ['pending', 'committed', 'aborted'] },
        attemptId: { bsonType: 'string', pattern: uuidPattern },
        leaseOwner: { bsonType: 'string', pattern: uuidPattern },
        leaseToken: uint64,
        leaseUntil: date,
        guard: { bsonType: 'string', pattern: uuidPattern },
        receipt: { bsonType: 'binData' }
      },
      [
        'operationId',
        'semanticDigest',
        'txid',
        'state',
        'attemptId',
        'leaseOwner',
        'leaseToken',
        'leaseUntil',
        'guard'
      ],
      {
        node: true,
        extra: {
          $expr: {
            $cond: [
              { $eq: [{ $type: '$receipt' }, 'missing'] },
              true,
              { $lte: [{ $binarySize: '$receipt' }, 1048576] }
            ]
          }
        }
      }
    ),
    indexes: [
      index({ network: 1, genesisHash: 1, nodeId: 1, operationId: 1 }, 'operation_unique', {
        unique: true
      }),
      index({ network: 1, genesisHash: 1, nodeId: 1, txid: 1, state: 1 }, 'scope_tx_state')
    ]
  },
  {
    name: MongoCollectionNames.readGuards,
    validator: scopedValidator(
      {
        key: string(4096),
        version: { bsonType: ['string', 'null'], maxLength: 256 },
        guard: { bsonType: 'string', pattern: uuidPattern }
      },
      ['key', 'version', 'guard'],
      { node: true }
    ),
    indexes: [
      index({ network: 1, genesisHash: 1, nodeId: 1, key: 1, guard: 1 }, 'read_guard_unique', {
        unique: true
      }),
      index({ guard: 1 }, 'guard_lookup')
    ]
  },
  {
    name: MongoCollectionNames.transactions,
    validator: scopedValidator(
      {
        txid: hash,
        rawPayloadId: string(4096),
        manifestPayloadId: string(4096),
        blockHash: hash,
        blockHeight: uint64
      },
      ['txid']
    ),
    indexes: [
      index({ network: 1, genesisHash: 1, txid: 1 }, 'chain_txid_unique', { unique: true }),
      index({ network: 1, genesisHash: 1, blockHash: 1, blockHeight: 1 }, 'chain_block')
    ]
  },
  {
    name: MongoCollectionNames.transactionProofs,
    validator: scopedValidator(
      {
        txid: hash,
        proofPayloadId: string(4096),
        blockHash: hash,
        blockHeight: uint64,
        variantDigest: hash
      },
      ['txid', 'proofPayloadId', 'variantDigest']
    ),
    indexes: [
      index(
        { network: 1, genesisHash: 1, txid: 1, variantDigest: 1 },
        'transaction_variant_unique',
        { unique: true }
      )
    ]
  },
  {
    name: MongoCollectionNames.outputs,
    validator: scopedValidator(
      {
        topic: string(256),
        txid: hash,
        outputIndex: uint32,
        satoshis: uint64,
        score: uint64,
        scriptPayloadId: string(4096),
        scriptOffset: uint64,
        scriptByteLength: uint64,
        state: { bsonType: 'string', enum: ['unspent', 'spent', 'evicted'] },
        spender: string(4096),
        version: string(256)
      },
      [
        'topic',
        'txid',
        'outputIndex',
        'satoshis',
        'score',
        'scriptPayloadId',
        'scriptOffset',
        'scriptByteLength',
        'state',
        'version'
      ],
      { node: true }
    ),
    indexes: [
      index(
        { network: 1, genesisHash: 1, nodeId: 1, topic: 1, txid: 1, outputIndex: 1 },
        'outpoint_unique',
        { unique: true }
      ),
      index(
        { network: 1, genesisHash: 1, nodeId: 1, topic: 1, state: 1, score: 1, _id: 1 },
        'gasp_order'
      )
    ]
  },
  {
    name: MongoCollectionNames.consumptionEdges,
    validator: scopedValidator(
      {
        topic: string(256),
        sourceTxid: hash,
        sourceOutputIndex: uint32,
        consumerTxid: hash,
        consumerOutputIndex: uint32
      },
      ['topic', 'sourceTxid', 'sourceOutputIndex', 'consumerTxid', 'consumerOutputIndex'],
      { node: true }
    ),
    indexes: [
      index(
        {
          network: 1,
          genesisHash: 1,
          nodeId: 1,
          topic: 1,
          sourceTxid: 1,
          sourceOutputIndex: 1,
          consumerTxid: 1,
          consumerOutputIndex: 1
        },
        'edge_unique',
        { unique: true }
      ),
      index(
        { network: 1, genesisHash: 1, nodeId: 1, consumerTxid: 1, consumerOutputIndex: 1 },
        'consumer_lookup'
      )
    ]
  },
  {
    name: MongoCollectionNames.appliedTransactions,
    validator: scopedValidator(
      {
        topic: string(256),
        txid: hash,
        state: { bsonType: 'string', enum: ['active', 'unproven', 'evicted'] },
        firstSeenHeight: uint64,
        proofPayloadId: string(4096),
        admissionId: string(4096)
      },
      ['topic', 'txid', 'state', 'admissionId'],
      { node: true }
    ),
    indexes: [
      index({ network: 1, genesisHash: 1, nodeId: 1, topic: 1, txid: 1 }, 'topic_txid_unique', {
        unique: true
      }),
      index(
        { network: 1, genesisHash: 1, nodeId: 1, topic: 1, state: 1, firstSeenHeight: 1 },
        'topic_state_height'
      )
    ]
  }
]

function stateDefinition(
  name: MongoCollectionDefinition['name'],
  fields: Document,
  required: string[],
  node: boolean,
  indexes: readonly IndexDescription[],
  extra?: Document
): void {
  definitions.push({ name, validator: scopedValidator(fields, required, { node, extra }), indexes })
}

stateDefinition(
  MongoCollectionNames.topicGenerations,
  { topic: string(256), chainEpoch: uint64, topicHistoryGeneration: uint64, policyId: string(256) },
  ['topic', 'chainEpoch', 'topicHistoryGeneration', 'policyId'],
  true,
  [index({ network: 1, genesisHash: 1, nodeId: 1, topic: 1 }, 'topic_unique', { unique: true })]
)
stateDefinition(
  MongoCollectionNames.topicAnchors,
  {
    topic: string(256),
    chainEpoch: uint64,
    topicHistoryGeneration: uint64,
    height: uint64,
    blockHash: hash,
    blockIndex: uint64,
    basmRoot: hash,
    tac: hash,
    previousTac: hash,
    state: { bsonType: 'string', enum: ['canonical', 'noncanonical'] }
  },
  [
    'topic',
    'chainEpoch',
    'topicHistoryGeneration',
    'height',
    'blockHash',
    'blockIndex',
    'basmRoot',
    'tac',
    'previousTac',
    'state'
  ],
  true,
  [
    index(
      {
        network: 1,
        genesisHash: 1,
        nodeId: 1,
        topic: 1,
        chainEpoch: 1,
        topicHistoryGeneration: 1,
        height: 1,
        blockHash: 1
      },
      'anchor_unique',
      { unique: true }
    )
  ]
)
stateDefinition(
  MongoCollectionNames.topicAnchorTips,
  {
    topic: string(256),
    chainEpoch: uint64,
    topicHistoryGeneration: uint64,
    height: uint64,
    blockHash: hash,
    anchorId: string(4096)
  },
  ['topic', 'chainEpoch', 'topicHistoryGeneration', 'height', 'blockHash', 'anchorId'],
  true,
  [index({ network: 1, genesisHash: 1, nodeId: 1, topic: 1 }, 'tip_unique', { unique: true })]
)
stateDefinition(
  MongoCollectionNames.basmRecoveryJobs,
  {
    topic: string(256),
    peerId: string(1024),
    jobId: string(1024),
    chainEpoch: uint64,
    topicHistoryGeneration: uint64,
    leaseToken: uint64,
    leaseUntil: date,
    state: string(64),
    checkpoint: string(4096)
  },
  [
    'topic',
    'peerId',
    'jobId',
    'chainEpoch',
    'topicHistoryGeneration',
    'leaseToken',
    'leaseUntil',
    'state',
    'checkpoint'
  ],
  true,
  [
    index({ network: 1, genesisHash: 1, nodeId: 1, topic: 1, peerId: 1, jobId: 1 }, 'job_unique', {
      unique: true
    }),
    index({ state: 1, leaseUntil: 1 }, 'lease_state')
  ]
)
stateDefinition(
  MongoCollectionNames.basmComparisons,
  {
    topic: string(256),
    peerId: string(1024),
    chainEpoch: uint64,
    topicHistoryGeneration: uint64,
    commonHeight: uint64,
    commonHash: hash,
    state: string(64)
  },
  [
    'topic',
    'peerId',
    'chainEpoch',
    'topicHistoryGeneration',
    'commonHeight',
    'commonHash',
    'state'
  ],
  true,
  [
    index(
      {
        network: 1,
        genesisHash: 1,
        nodeId: 1,
        topic: 1,
        chainEpoch: 1,
        topicHistoryGeneration: 1,
        updatedAt: 1
      },
      'comparison_lookup'
    )
  ]
)
stateDefinition(
  MongoCollectionNames.gaspCursors,
  {
    remoteHost: string(2048),
    topic: string(256),
    state: string(64),
    score: uint64,
    cursorId: string(4096)
  },
  ['remoteHost', 'topic', 'state'],
  true,
  [
    index({ network: 1, genesisHash: 1, nodeId: 1, remoteHost: 1, topic: 1 }, 'cursor_unique', {
      unique: true
    })
  ]
)
stateDefinition(
  MongoCollectionNames.gaspGraphs,
  {
    graphId: string(4096),
    state: { bsonType: 'string', enum: ['receiving', 'validated', 'finalized', 'discarded'] },
    reason: string(1024)
  },
  ['graphId', 'state'],
  true,
  [
    index({ network: 1, genesisHash: 1, nodeId: 1, graphId: 1 }, 'graph_unique', { unique: true }),
    index({ state: 1, updatedAt: 1 }, 'graph_state')
  ]
)
stateDefinition(
  MongoCollectionNames.gaspNodes,
  {
    graphId: string(4096),
    txid: hash,
    outputIndex: uint32,
    payloadId: string(4096),
    state: string(64)
  },
  ['graphId', 'txid', 'outputIndex', 'state'],
  true,
  [
    index(
      { network: 1, genesisHash: 1, nodeId: 1, graphId: 1, txid: 1, outputIndex: 1 },
      'graph_node_unique',
      { unique: true }
    ),
    index({ graphId: 1 }, 'graph_lookup')
  ]
)
stateDefinition(
  MongoCollectionNames.manifestComponents,
  { manifestId: string(4096), ordinal: uint64, payloadId: string(4096), kind: string(64) },
  ['manifestId', 'ordinal', 'payloadId', 'kind'],
  true,
  [
    index(
      { network: 1, genesisHash: 1, nodeId: 1, manifestId: 1, ordinal: 1 },
      'manifest_component_unique',
      { unique: true }
    )
  ]
)
for (const name of [
  MongoCollectionNames.lookupOutbox,
  MongoCollectionNames.propagationOutbox
] as const) {
  stateDefinition(
    name,
    {
      eventId: string(1024),
      target: string(2048),
      state: string(64),
      nextAttemptAt: date,
      leaseUntil: date
    },
    ['eventId', 'target', 'state'],
    true,
    [
      index({ network: 1, genesisHash: 1, nodeId: 1, eventId: 1 }, 'event_unique', {
        unique: true
      }),
      index({ state: 1, nextAttemptAt: 1 }, 'outbox_ready')
    ]
  )
}
for (const name of [MongoCollectionNames.shipRecords, MongoCollectionNames.slapRecords] as const) {
  stateDefinition(
    name,
    {
      txid: hash,
      outputIndex: uint32,
      domain: string(255),
      topic: string(256),
      service: string(256),
      state: string(64)
    },
    ['txid', 'outputIndex', 'domain', 'state'],
    true,
    [
      index(
        { network: 1, genesisHash: 1, nodeId: 1, txid: 1, outputIndex: 1 },
        'discovery_unique',
        { unique: true }
      ),
      index({ domain: 1, topic: 1, createdAt: 1 }, 'discovery_lookup')
    ]
  )
}
stateDefinition(
  MongoCollectionNames.bannedRecords,
  { type: string(64), value: string(2048), bannedAt: date, state: string(64) },
  ['type', 'value', 'bannedAt', 'state'],
  true,
  [
    index({ network: 1, genesisHash: 1, nodeId: 1, type: 1, value: 1 }, 'ban_unique', {
      unique: true
    }),
    index({ bannedAt: 1 }, 'ban_time')
  ]
)

export const MongoCollectionDefinitions: readonly MongoCollectionDefinition[] = definitions

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map(key => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const schemaFingerprint = (): string => {
  const source = stable(
    MongoCollectionDefinitions.map(({ name, validator, indexes }) => ({ name, validator, indexes }))
  )
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

export interface MongoOverlayCapability {
  readonly topology: 'replica-set'
  readonly schemaVersion: 1
  readonly scope: Readonly<StorageScope>
  readonly collections: readonly string[]
}

/**
 * Creates only empty Overlay-owned collections and refuses all incompatible
 * pre-existing schema. It never drops, migrates, or relaxes validation.
 */
export async function bootstrapMongoOverlay(
  db: Db,
  scope: StorageScope
): Promise<MongoOverlayCapability> {
  validChainScope(scope)
  validPart(scope.nodeId)
  const hello = await db.command({ hello: 1 })
  if (hello.msg === 'isdbgrid' || typeof hello.setName !== 'string' || hello.setName.length === 0)
    throw new Error('Mongo Overlay storage requires an unsharded replica set')
  if (hello.isWritablePrimary !== true)
    throw new Error('Mongo Overlay storage requires the writable primary')

  const fingerprint = schemaFingerprint()
  for (const definition of MongoCollectionDefinitions) await ensureCollection(db, definition)
  await ensureGridFs(db)
  await ensureLedger(db, scope, fingerprint)
  await transactionalProbe(db, scope)
  return {
    topology: 'replica-set',
    schemaVersion,
    scope: { ...scope },
    collections: Object.values(MongoCollectionNames)
  }
}

async function ensureCollection(db: Db, definition: MongoCollectionDefinition): Promise<void> {
  await createCollectionIfMissing(db, definition)
  const actual = await db.listCollections<CollectionInfo>({ name: definition.name }).next()
  if (!collectionMatchesDefinition(actual, definition))
    throw new Error(`Incompatible Mongo Overlay validator for ${definition.name}`)
  await ensureCollectionIndexes(db, definition)
}

async function createCollectionIfMissing(
  db: Db,
  definition: MongoCollectionDefinition
): Promise<void> {
  const existing = await db.listCollections<CollectionInfo>({ name: definition.name }).next()
  if (existing !== null) return
  try {
    await db.createCollection(definition.name, {
      validator: definition.validator,
      validationLevel: 'strict',
      validationAction: 'error',
      collation: { locale: 'simple' }
    })
  } catch (error) {
    if ((error as { code?: number }).code !== 48) throw error
  }
}

function collectionMatchesDefinition(
  actual: CollectionInfo | null,
  definition: MongoCollectionDefinition
): boolean {
  return (
    actual !== null &&
    stable(actual.options?.validator) === stable(definition.validator) &&
    (actual.options?.collation === undefined ||
      stable(actual.options.collation) === stable({ locale: 'simple' }))
  )
}

async function ensureCollectionIndexes(
  db: Db,
  definition: MongoCollectionDefinition
): Promise<void> {
  const collection = db.collection<Document>(definition.name)
  for (const expected of definition.indexes) {
    const { key, ...options } = expected
    try {
      await collection.createIndex(key, options)
    } catch (error) {
      if (![68, 85, 86].includes((error as { code?: number }).code ?? -1)) throw error
    }
  }
  const actualIndexes = await collection.listIndexes().toArray()
  for (const expected of definition.indexes) {
    if (
      !indexMatchesDefinition(
        actualIndexes.find(candidate => candidate.name === expected.name),
        expected
      )
    )
      throw new Error(`Incompatible Mongo Overlay index for ${definition.name}:${expected.name}`)
  }
}

function indexMatchesDefinition(
  actualIndex: Document | undefined,
  expected: IndexDescription
): boolean {
  return (
    actualIndex !== undefined &&
    stable(actualIndex.key) === stable(expected.key) &&
    Boolean(actualIndex.unique) === Boolean(expected.unique) &&
    stable(actualIndex.partialFilterExpression) === stable(expected.partialFilterExpression) &&
    Boolean(actualIndex.sparse) === Boolean(expected.sparse) &&
    actualIndex.expireAfterSeconds === expected.expireAfterSeconds
  )
}

async function ensureGridFs(db: Db): Promise<void> {
  const filesName = `${MongoGridFsBucketName}.files`
  const chunksName = `${MongoGridFsBucketName}.chunks`
  for (const name of [filesName, chunksName]) {
    const existing = await db.listCollections({ name }).next()
    if (existing === null) {
      try {
        await db.createCollection(name)
      } catch (error) {
        if ((error as { code?: number }).code !== 48) throw error
      }
    }
  }
  await db
    .collection(filesName)
    .createIndex({ filename: 1, uploadDate: 1 }, { name: 'filename_1_uploadDate_1' })
  await db
    .collection(chunksName)
    .createIndex({ files_id: 1, n: 1 }, { unique: true, name: 'files_id_1_n_1' })
}

async function ensureLedger(db: Db, scope: StorageScope, fingerprint: string): Promise<void> {
  const collection = db.collection<MongoSchemaDocument>(MongoCollectionNames.schema)
  const id = mongoNodeKey(scope)
  const now = new Date()
  try {
    await collection.insertOne({
      _id: id,
      schemaVersion,
      network: scope.network,
      genesisHash: scope.genesisHash,
      nodeId: scope.nodeId,
      schemaFingerprint: fingerprint,
      createdAt: now,
      updatedAt: now
    })
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error
  }
  const ledger = await collection.findOne({ _id: id })
  if (
    ledger === null ||
    ledger.schemaVersion !== schemaVersion ||
    ledger.network !== scope.network ||
    ledger.genesisHash !== scope.genesisHash ||
    ledger.nodeId !== scope.nodeId ||
    ledger.schemaFingerprint !== fingerprint
  )
    throw new Error('Incompatible Mongo Overlay schema ledger')
}

async function transactionalProbe(db: Db, scope: StorageScope): Promise<void> {
  const session = db.client.startSession()
  try {
    await session.withTransaction(
      async () => {
        const result = await db
          .collection<MongoSchemaDocument>(MongoCollectionNames.schema)
          .updateOne(
            { _id: mongoNodeKey(scope), schemaVersion, schemaFingerprint: schemaFingerprint() },
            { $set: { lastTransactionProbeAt: new Date(), updatedAt: new Date() } },
            { session }
          )
        if (result.matchedCount !== 1)
          throw new Error('Mongo Overlay schema ledger changed during bootstrap')
      },
      { readConcern: { level: 'majority' }, writeConcern: { w: 'majority', j: true } }
    )
  } finally {
    await session.endSession()
  }
}
