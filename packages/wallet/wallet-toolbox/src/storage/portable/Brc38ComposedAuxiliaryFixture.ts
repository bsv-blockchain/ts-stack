import { expect } from '@jest/globals'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { WalletStorageManager } from '../WalletStorageManager'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'

type Row = Readonly<Record<string, string | number | Buffer | null>>
export type ComposedAuxiliaryFixture = Readonly<Record<string, Row>>
const allTables = [
  'users',
  'settings',
  'proven_txs',
  'proven_tx_reqs',
  'output_baskets',
  'output_tags',
  'tx_labels',
  'transactions',
  'outputs',
  'commissions',
  'tx_labels_map',
  'output_tags_map',
  'certificates',
  'certificate_fields',
  'sync_states',
  'monitor_events',
  'prepared_beef_metadata',
  'prepared_beefs',
  'action_batches',
  'action_batch_outputs',
  'action_batch_blobs',
  'sync_transfers',
  'sync_transfer_parts',
  'auth_sessions',
  'auth_message_nonces',
  'payment_replays',
  'snapshot_sync_sessions',
  'snapshot_sync_ids',
  'snapshot_sync_primary_epochs',
  'snapshot_reconciliation_windows',
  'snapshot_reconciliation_stage_budgets',
  'snapshot_reconciliation_stage_pages',
  'snapshot_reconciliation_stage_chains',
  'snapshot_reconciliation_promotion_cursors',
  'snapshot_reconciliation_captured_identity_budgets',
  'snapshot_reconciliation_captured_identities',
  'snapshot_reconciliation_identity_frames',
  'snapshot_reconciliation_identity_budgets',
  'snapshot_reconciliation_identity_maps',
  'snapshot_reconciliation_identity_retirement_budgets',
  'snapshot_reconciliation_identity_retirements',
  'snapshot_reconciliation_membership_budgets',
  'snapshot_reconciliation_memberships',
  'snapshot_reconciliation_membership_retirements',
  'snapshot_reconciliation_provenance_budgets',
  'snapshot_reconciliation_provenance',
  'snapshot_reconciliation_window_progress',
  'internalize_receipts'
] as const
const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
// Independently authored auxiliary coordinates; do not import the production
// local field whitelist or inventory reader into this fixture oracle.
const payloads: Readonly<Record<string, Readonly<{ id: number; kind: 'binary' | 'text'; fields: readonly string[] }>>> =
  {
    prepared_beefs: { id: 8, kind: 'binary', fields: ['beef'] },
    action_batch_blobs: { id: 9, kind: 'binary', fields: ['bytes'] },
    sync_transfer_parts: { id: 10, kind: 'binary', fields: ['bytes'] },
    action_batches: { id: 11, kind: 'text', fields: ['uploadDigests', 'result', 'manifest'] },
    sync_transfers: { id: 12, kind: 'text', fields: ['result'] },
    monitor_events: { id: 13, kind: 'text', fields: ['details'] },
    snapshot_reconciliation_stage_pages: { id: 14, kind: 'binary', fields: ['payload'] },
    snapshot_reconciliation_provenance: { id: 15, kind: 'binary', fields: ['payload'] }
  }

/** Synthetic inactive runtime/recovery records for byte-preserving local
 * composition, authored before import. They are not authenticated sessions,
 * spendable funds, active reconciliation windows or semantic protocol proof.
 * Real source manager/native writer ownership and quota/capture triggers remain
 * in force; no schema or persisted ownership flags are modified. UNRUN. */
export async function seedComposedAuxiliaryFixture(
  storage: StorageKnex,
  manager: WalletStorageManager
): Promise<ComposedAuxiliaryFixture> {
  const userId = manager.getActiveUser().userId,
    time = '2026-10-03T00:00:00.000Z',
    times = { created_at: time, updated_at: time },
    expiresAt = 0,
    lineage = 'd'.repeat(64),
    binding = 'e'.repeat(64),
    generation = 'f'.repeat(64),
    scope = {
      userId,
      sourceStorageIdentity: 'inactive-fixture-source',
      sessionId: 'inactive-fixture-session',
      binding
    },
    bytes = Buffer.from([0, 255, 128, 1, 0]),
    text = 'auxiliary \u0000雪😀"\\\n',
    membership = {
      userId,
      lineage,
      tableId: 10,
      incomingId1: 16,
      incomingId2: 17,
      incomingText: Buffer.alloc(0),
      revision: '1',
      id1: 1,
      id2: 1,
      exactText: Buffer.alloc(0),
      fingerprint: digest('fixture membership'),
      generation,
      parentsJson: '[]',
      created: 0,
      seenSession: scope.sessionId,
      sourceGeneration: generation
    },
    rows: Record<string, Row> = {
      internalize_receipts: {
        userId,
        txid: 'e'.repeat(64),
        ownerToken: 'original-completed-receipt-owner',
        state: 'complete',
        leaseUntil: 0,
        needsNewReceipt: 0
      },
      monitor_events: { ...times, id: 400, event: 'inactive-fixture', details: text },
      prepared_beefs: {
        ...times,
        preparedBeefId: 401,
        userId,
        rootTxid: '1'.repeat(64),
        beef: bytes,
        checksum: digest(bytes),
        formatVersion: 0,
        state: 'stale',
        txCount: 0,
        bumpCount: 0,
        byteLength: bytes.length
      },
      action_batches: {
        ...times,
        actionBatchId: 402,
        userId,
        batchId: 'inactive-fixture-batch',
        status: 'expired',
        expiresAt: time,
        hardExpiresAt: time,
        manifestDigest: null,
        uploadDigests: '[]',
        result: null,
        manifest: ''
      },
      action_batch_outputs: { ...times, actionBatchId: 402, outputId: 1 },
      action_batch_blobs: { ...times, actionBatchBlobId: 403, actionBatchId: 402, digest: digest(bytes), bytes },
      sync_transfer_parts: { slot: 1, offset: 0, bytes },
      auth_sessions: {
        sessionNonce: 'n'.repeat(64),
        peerNonce: null,
        peerIdentityKey: null,
        isAuthenticated: 0,
        lastUpdate: 0,
        certificatesRequired: null,
        certificatesValidated: null,
        expiresAt
      },
      auth_message_nonces: { sessionNonce: 'n'.repeat(64), messageNonce: 'm'.repeat(64), expiresAt },
      payment_replays: { transactionId: '2'.repeat(64), createdAt: time, expiresAt: time },
      snapshot_sync_sessions: {
        userId,
        sourceStorageIdentityKey: scope.sourceStorageIdentity,
        sessionId: scope.sessionId,
        snapshotId: 'inactive-fixture-snapshot',
        version: 1,
        sourceUserId: userId,
        identityKey: manager.getActiveUser().identityKey,
        destinationStorageIdentityKey: manager.getActiveStore(),
        chain: 'test',
        activeStorage: manager.getActiveStore(),
        sourceActiveStorage: null,
        sourceUserCreatedAt: time,
        sourceUserUpdatedAt: time,
        primaryEpoch: 0,
        expiresAt,
        tableIndex: 13,
        sequence: 0,
        cursor: null
      },
      snapshot_sync_ids: {
        userId,
        sourceStorageIdentityKey: scope.sourceStorageIdentity,
        entity: 'output',
        incomingId: 16,
        localId: 1
      },
      snapshot_reconciliation_windows: { ...scope, bindingJson: '{}', stateJson: '{}', sequence: 0, retired: 1 },
      snapshot_reconciliation_stage_budgets: {
        ...scope,
        maximumBytes: 4096,
        maximumPages: 4,
        bytes: bytes.length,
        pages: 1
      },
      snapshot_reconciliation_stage_pages: {
        ...scope,
        sequence: 0,
        ordinal: 0,
        nextSequence: 1,
        streamIndex: 0,
        tableId: 0,
        examined: 0,
        bytes: bytes.length,
        digest: digest(bytes),
        payload: bytes
      },
      snapshot_reconciliation_stage_chains: {
        ...scope,
        tableId: 0,
        headSequence: 0,
        tailSequence: 0,
        pages: 1,
        bytes: bytes.length
      },
      snapshot_reconciliation_promotion_cursors: {
        ...scope,
        windowSequence: 0,
        frameSequence: 0,
        frameDigest: digest(bytes),
        nextChange: 0
      },
      snapshot_reconciliation_captured_identity_budgets: { ...scope, maximumIdentities: 4, identities: 1 },
      snapshot_reconciliation_captured_identities: {
        ...scope,
        frameDigest: digest(bytes),
        changeIndex: 0,
        tableId: 0,
        incomingId: 14,
        generation: '1',
        naturalIdentity: digest('fixture identity'),
        naturalKeyJson: '[]',
        required: 0
      },
      snapshot_reconciliation_identity_frames: {
        ...scope,
        frameDigest: digest(bytes),
        windowSequence: 0,
        identities: 1,
        sealed: 1,
        changes: 1
      },
      snapshot_reconciliation_identity_budgets: { userId, lineage, maximumMappings: 4, mappings: 1 },
      snapshot_reconciliation_identity_maps: {
        userId,
        lineage,
        tableId: 0,
        incomingId: 14,
        generation: '1',
        naturalIdentity: digest('fixture identity'),
        localId: 1,
        sourceGeneration: generation,
        seenSession: scope.sessionId
      },
      snapshot_reconciliation_identity_retirement_budgets: {
        userId,
        lineage,
        maximumPendingAssociations: 4,
        pendingAssociations: 1
      },
      snapshot_reconciliation_identity_retirements: {
        userId,
        lineage,
        tableId: 0,
        incomingId: 15,
        generation: '1',
        naturalIdentity: digest('fixture retired identity'),
        localId: 1,
        retiredBySession: scope.sessionId,
        retiredAtSequence: 0
      },
      snapshot_reconciliation_membership_budgets: {
        userId,
        lineage,
        maximumMemberships: 4,
        maximumRetirements: 4,
        memberships: 1,
        retirements: 1
      },
      snapshot_reconciliation_memberships: membership,
      snapshot_reconciliation_membership_retirements: { ...membership, retiredAtRevision: '2' },
      snapshot_reconciliation_provenance_budgets: {
        userId,
        lineage,
        maximumRows: 4,
        maximumBytes: 4096,
        rows: 1,
        bytes: bytes.length
      },
      snapshot_reconciliation_provenance: {
        userId,
        lineage,
        incomingId: 20,
        revision: '1',
        bytes: bytes.length,
        digest: digest(bytes),
        seenSession: scope.sessionId,
        sourceGeneration: generation,
        payload: bytes
      },
      snapshot_reconciliation_window_progress: {
        ...scope,
        sequence: 0,
        commits: 1,
        pages: 1,
        examined: 0,
        payloadBytes: bytes.length,
        inserts: 0,
        updates: 0
      }
    }
  await manager.runAsStorageProvider(async active => {
    if (active !== storage) throw new Error('Auxiliary fixture source manager selected another provider')
    await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(storage, async writer => {
      // The source restore remaps IDs. Bind the test's original output edge to
      // its actual already-restored row before authoring the auxiliary graph.
      const outputs = await writer('outputs').select('outputId').limit(2)
      if (outputs.length !== 1) throw new Error('Auxiliary fixture requires one original occupied output')
      rows.action_batch_outputs = { ...rows.action_batch_outputs, outputId: Number(outputs[0].outputId) }
      rows.snapshot_sync_ids = { ...rows.snapshot_sync_ids, localId: Number(outputs[0].outputId) }
      for (const [table, row] of Object.entries(rows)) await writer(table).insert(row)
      await writer('sync_transfers')
        .where({ slot: 1 })
        .update({
          transferId: 'inactive-fixture-transfer',
          identityKey: manager.getActiveUser().identityKey,
          context: 'inactive-fixture',
          direction: 'upload',
          digest: digest(bytes),
          totalBytes: bytes.length,
          receivedBytes: bytes.length,
          partBytes: bytes.length,
          expiresAt: 0,
          state: 'expired',
          result: text
        })
    })
  })
  rows.sync_transfers = {
    slot: 1,
    transferId: 'inactive-fixture-transfer',
    identityKey: manager.getActiveUser().identityKey,
    context: 'inactive-fixture',
    direction: 'upload',
    digest: digest(bytes),
    totalBytes: bytes.length,
    receivedBytes: bytes.length,
    partBytes: bytes.length,
    expiresAt: 0,
    state: 'expired',
    result: text
  }
  return Object.freeze(
    Object.fromEntries(Object.entries(rows).map(([table, row]) => [table, Object.freeze({ ...row })]))
  )
}

/** Independent small-fixture byte oracle. Expected metadata/payloads predate
 * composition. Direct SQL and explicitly authored packed coordinates read
 * complete content; no production source/candidate/image/receipt hash is used
 * to infer equality. Whole payloads here are bounded synthetic test data. */
export async function assertComposedAuxiliaryFixture(
  manager: WalletStorageManager,
  expected: ComposedAuxiliaryFixture
): Promise<void> {
  await manager.runAsStorageProvider(async active => {
    if (!(active instanceof StorageKnex)) throw new Error('Auxiliary oracle needs the actual current native provider')
    const driver = require('./NativeProfileSqlite.cjs') as { createOwnedNativeReadDatabase(root: Knex): Knex },
      reader = driver.createOwnedNativeReadDatabase(active.knex)
    try {
      await reader.transaction(async read => {
        expect(allTables).toHaveLength(48)
        for (const table of allTables) {
          const present = await read(table).select(read.raw('1 AS present')).limit(1)
          expect(present).toHaveLength(1)
        }
        for (const [table, row] of Object.entries(expected)) {
          const fieldSet = payloads[table],
            columns = Object.keys(row).filter(key => !fieldSet?.fields.includes(key)),
            where = table === 'sync_transfers' ? { slot: 1 } : {},
            actual = await read(table)
              .where(where)
              .select(...columns)
              .limit(2)
          expect(actual).toHaveLength(1)
          for (const column of columns) expect(normalize(actual[0][column])).toEqual(normalize(row[column]))
          if (fieldSet === undefined) continue
          for (const [fieldId, field] of fieldSet.fields.entries()) {
            if (!(field in row)) continue
            const cell = await read(table).where(where).first(field),
              value = cell[field],
              pointers = await read(`brc38_native_${fieldSet.kind}_fields`)
                .where({ tableId: fieldSet.id, fieldId })
                .select('sha256')
                .limit(2)
            if (value === null) {
              expect(row[field]).toBeNull()
              expect(pointers).toHaveLength(0)
              continue
            }
            if (pointers.length === 0) {
              expect(normalize(value)).toEqual(normalize(row[field]))
              continue
            }
            expect(pointers).toHaveLength(1)
            const hash = pointers[0].sha256,
              version = await read(`brc38_native_${fieldSet.kind}_versions`).where({ sha256: hash }).first(),
              chunks = await read(`brc38_native_${fieldSet.kind}_chunks`)
                .where({ sha256: hash })
                .orderBy('offset')
                .limit(129)
            expect(version.state).toBe('SEALED')
            expect(Number(version.bytes)).toBeLessThanOrEqual(4096)
            expect(Number(version.accepted)).toBe(Number(version.bytes))
            expect(chunks).toHaveLength(Number(version.chunks))
            let offset = 0
            const content: Buffer[] = []
            for (const chunk of chunks) {
              const payload = Buffer.from(chunk.payload)
              expect(Number(chunk.offset)).toBe(offset)
              expect(Number(chunk.bytes)).toBe(payload.length)
              expect(digest(payload)).toBe(chunk.chunkSha256)
              offset += payload.length
              content.push(payload)
            }
            const bytes = Buffer.concat(content)
            expect(bytes.length).toBe(Number(version.bytes))
            expect(digest(bytes)).toBe(hash)
            expect(typeof value === 'string' ? Buffer.byteLength(value) : Buffer.from(value).length).toBe(0)
            const wanted = row[field]
            expect(bytes).toEqual(typeof wanted === 'string' ? Buffer.from(wanted) : wanted)
          }
        }
      })
    } finally {
      await reader.destroy()
    }
  })
}

function normalize(value: unknown): unknown {
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('hex') }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return value.toString()
  return value
}
