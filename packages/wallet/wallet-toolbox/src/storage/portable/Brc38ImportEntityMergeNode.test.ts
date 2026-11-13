import { randomUUID } from 'node:crypto'
import { MerklePath, Script, Transaction } from '@bsv/sdk'
import {
  previewDestinationFixture,
  previewPrivateFixture,
  previewReceiptPolicy as policy
} from './Brc38ImportPreviewFixture'
import { previewBrc38PrivateImport } from './Brc38PrivateImportPreviewNode'
import { installBrc38ImportTargetIndexes } from './Brc38ImportTargetIndexes'
import { installBrc38ImportJournalSchema } from './Brc38ImportJournalSchema'
import { brc38ImportTableOrder } from './Brc38ImportPage'
import { prepareBrc38ImportPage } from './Brc38ImportPage'
import { prepareBrc38ImportEntityMerge } from './Brc38ImportEntityMergeNode'
import * as importIds from './Brc38ImportIdMap'
import {
  brc38ImportDestinationDigest,
  prepareBrc38PrivateImportJournal,
  commitBrc38PrivateImportPage,
  commitBrc38PrivateImportEntityPage
} from './Brc38PrivateImportJournalNode'
import { readBrc38ImportJournal, type Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { runInSeries } from '../../utility/runInSeries'
import { toBinaryBaseBlockHeader } from '../../services/Services'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { doubleSha256BE } from '../../utility/utilityHelpers'
import type { WalletServices } from '../../sdk/WalletServices.interfaces'
import type { BRC38WalletData } from './index'
import type { Brc38StageTable } from './Brc38SemanticStage'
import type { Knex } from 'knex'
import type { Brc38PreparedImportData } from './Brc38ImportPage'
import fc from 'fast-check'
import knex from 'knex'
import { decodePortableRow } from './Brc38PortableRows'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})

function proofFixture() {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromHex('51') })
  const txid = tx.id('hex'),
    path = new MerklePath(100, [[{ offset: 0, hash: txid, txid: true }]]),
    header = toBinaryBaseBlockHeader({
      version: 1,
      previousHash: '0'.repeat(64),
      merkleRoot: txid,
      time: 1,
      bits: 0,
      nonce: 0
    }),
    isValidRootForHeight = jest.fn(async (root: string, height: number) => root === txid && height === 100),
    getHeaderForHeight = jest.fn(async () => [...header])
  const services = {
    getChainTracker: async () => ({ isValidRootForHeight }),
    getHeaderForHeight
  } as unknown as WalletServices
  return { txid, tx, path, header, services, isValidRootForHeight, getHeaderForHeight }
}
function portableProof(data: BRC38WalletData, proof: ReturnType<typeof proofFixture>) {
  Object.assign(data.tables.provenTxs[0], {
    txid: proof.txid.toUpperCase(),
    height: 100,
    index: 0,
    rawTx: Buffer.from(proof.tx.toBinary()).toString('base64'),
    merklePath: Buffer.from(proof.path.toBinary()).toString('base64'),
    blockHash: asString(doubleSha256BE(proof.header)).toUpperCase(),
    merkleRoot: proof.txid.toUpperCase()
  })
  data.tables.provenTxReqs[0].txid = proof.txid.toUpperCase()
  data.tables.transactions[0].txid = proof.txid.toUpperCase()
  data.tables.outputs[0].txid = proof.txid.toUpperCase()
}
const nativeTables: Readonly<Record<Brc38StageTable, string>> = {
  provenTxs: 'proven_txs',
  outputBaskets: 'output_baskets',
  outputTags: 'output_tags',
  txLabels: 'tx_labels',
  transactions: 'transactions',
  outputs: 'outputs',
  txLabelMaps: 'tx_labels_map',
  outputTagMaps: 'output_tags_map',
  certificates: 'certificates',
  certificateFields: 'certificate_fields',
  commissions: 'commissions',
  provenTxReqs: 'proven_tx_reqs',
  syncStates: 'sync_states'
}
describe('actual authenticated thirteen-table merge application', () => {
  let target: Awaited<ReturnType<typeof previewDestinationFixture>>,
    staged: Awaited<ReturnType<typeof previewPrivateFixture>>,
    admission: Brc38ImportJournalAdmission,
    proof: ReturnType<typeof proofFixture>,
    original: string,
    cleanup: Array<() => Promise<void>>
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    const results = await Promise.allSettled(cleanup.map(close => close())),
      failed = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (failed.length !== 0) throw new AggregateError(failed, 'Merge fixture retains physical cleanup')
  })
  async function open(transform?: (data: BRC38WalletData) => void, beforePreview?: () => Promise<void>) {
    proof = proofFixture()
    target = await previewDestinationFixture(async trx => {
      await installBrc38ImportTargetIndexes(trx)
      await installBrc38ImportJournalSchema(trx)
    })
    cleanup.push(async () => await target.close())
    jest.spyOn(target.storage, 'getServices').mockReturnValue(proof.services)
    staged = await previewPrivateFixture(
      undefined,
      data => {
        portableProof(data, proof)
        transform?.(data)
        original = JSON.stringify(data)
      },
      2097152
    )
    cleanup.push(async () => await staged.close())
    await target.storage.insertUser({
      userId: 7,
      identityKey: 'original-identity',
      activeStorage: '',
      created_at: new Date(0),
      updated_at: new Date(0)
    })
    await beforePreview?.()
    const store = staged.value.reservation.store,
      preview = await previewBrc38PrivateImport(store, target.storage, 'merge', policy),
      metadata = await store.withAuthenticatedImportView(async (_json, value) => value),
      binding = store.binding
    if (binding === undefined) throw new Error('Actual private binding missing')
    admission = {
      scope: {
        importId: randomUUID(),
        bindingSha256: binding.digest,
        archiveSha256: binding.binding.archiveSha256,
        userId: 7
      },
      previewId: preview.previewId,
      originalLimitsJson: binding.limitsJson,
      expiresAt: preview.expiresAt,
      initialDestinationSha256: brc38ImportDestinationDigest(preview.target),
      totalRows: metadata.rows + 1,
      maximumStepRows: 128,
      maximumStepBytes: 2097152,
      maximumMappedIds: 1000,
      maximumJournalLogicalBytes: 516096
    }
    await prepareBrc38PrivateImportJournal(store, target.storage, {
      admission,
      receiptPolicy: policy
    })
    await commitBrc38PrivateImportPage(store, target.storage, {
      admission,
      receiptPolicy: policy,
      fromRow: 0,
      apply: async () => {}
    })
  }
  async function commit(fromRow: number) {
    return await commitBrc38PrivateImportEntityPage(staged.value.reservation.store, target.storage, {
      admission,
      receiptPolicy: policy,
      fromRow
    })
  }
  async function readReceipt() {
    return await target.k.transaction(async trx => await readBrc38ImportJournal(trx, admission))
  }
  test.each([
    [144, 32],
    [144, 96],
    [200, 32]
  ])(
    'staged merge preserves archived managed-change policy %i/%i without an operational upgrade',
    async (desired, minimum) => {
      await open(data => {
        data.tables.outputBaskets[0].name = 'default'
        data.tables.outputBaskets[0].numberOfDesiredUTXOs = desired
        data.tables.outputBaskets[0].minimumDesiredUTXOValue = minimum
      })
      const source = original
      await runInSeries(brc38ImportTableOrder.entries(), async ([index]) => {
        await commit(index + 1)
      })
      expect(await target.k('output_baskets').first()).toMatchObject({
        name: 'default',
        numberOfDesiredUTXOs: desired,
        minimumDesiredUTXOValue: minimum
      })
      expect(original).toBe(source)
      expect((await readReceipt()).state).toBe('COMPLETE')
      expect((await target.k('users').first()).activeStorage).toBe('')
    }
  )
  test('all13 actual rows, composite links, tombstones, mapped history and source identities commit atomically without activating the original primary', async () => {
    await open()
    await runInSeries(brc38ImportTableOrder.entries(), async ([index, table]) => {
      const receipt = await commit(index + 1)
      expect(receipt.nextRow).toBe(index + 2)
      expect(await target.k(nativeTables[table])).toHaveLength(1)
    })
    const transaction = await target.k('transactions').first(),
      output = await target.k('outputs').first(),
      basket = await target.k('output_baskets').first(),
      tag = await target.k('output_tags').first(),
      label = await target.k('tx_labels').first(),
      certificate = await target.k('certificates').first(),
      proven = await target.k('proven_txs').first(),
      request = await target.k('proven_tx_reqs').first()
    expect(transaction).toMatchObject({
      userId: 7,
      provenTxId: proven.provenTxId,
      reference: 'archive-ref'
    })
    expect(proven).toMatchObject({ txid: proof.txid, merkleRoot: proof.txid })
    expect(output).toMatchObject({
      userId: 7,
      transactionId: transaction.transactionId,
      basketId: basket.basketId
    })
    expect(await target.k('tx_labels_map').first()).toMatchObject({
      transactionId: transaction.transactionId,
      txLabelId: label.txLabelId
    })
    expect(await target.k('output_tags_map').first()).toMatchObject({
      outputId: output.outputId,
      outputTagId: tag.outputTagId,
      isDeleted: 1
    })
    expect(await target.k('certificate_fields').first()).toMatchObject({
      userId: 7,
      certificateId: certificate.certificateId
    })
    expect(JSON.parse(request.notify).transactionIds).toEqual([transaction.transactionId])
    expect(JSON.parse((await target.k('sync_states').first()).syncMap).output.idMap['160']).toBe(output.outputId)
    expect((await target.k('users').first()).activeStorage).toBe('')
    expect((await readReceipt()).state).toBe('COMPLETE')
    expect(await target.k('brc38_import_ids')).toHaveLength(9)
    expect(proof.isValidRootForHeight).toHaveBeenCalledTimes(1)
    const source = await staged.value.reservation.store.withAuthenticatedImportRead(
      async (_json, _metadata, reader) => await reader.row('provenTxs', 0)
    )
    expect(source?.txid).toBe(proof.txid.toUpperCase())
    expect(original).toContain(proof.txid.toUpperCase())
  })
  test('lost acknowledgement replays the exact page without another proof write, epoch increment or map charge', async () => {
    await open()
    const first = await commit(1),
      epoch = await target.storage.readPreparedBeefProofEpoch(),
      rows = JSON.stringify(await target.k('proven_txs')),
      ids = JSON.stringify(await target.k('brc38_import_ids'))
    expect(await commit(1)).toEqual(first)
    expect(await target.storage.readPreparedBeefProofEpoch()).toBe(epoch)
    expect(JSON.stringify(await target.k('proven_txs'))).toBe(rows)
    expect(JSON.stringify(await target.k('brc38_import_ids'))).toBe(ids)
    expect(proof.isValidRootForHeight).toHaveBeenCalledTimes(1)
  })
  test('accepted transaction aliases split before the writer, keep every source row and map both incoming IDs to the same native entity', async () => {
    await open(data => {
      data.tables.transactions.push({
        ...data.tables.transactions[0],
        transactionId: 114,
        reference: 'archive-second',
        description: 'same transaction alias'
      })
      data.tables.provenTxReqs[0].notify = { transactionIds: [14, 114] }
    })
    let receipt = await readReceipt()
    await runInSeries(Array.from({ length: 20 }), async () => {
      if (receipt.state !== 'COMPLETE') receipt = await commit(receipt.nextRow)
    })
    expect(receipt).toMatchObject({ state: 'COMPLETE', nextRow: 15 })
    expect(await target.k('transactions')).toHaveLength(1)
    const mappings = await target.k('brc38_import_ids').where({ entity: 'transaction' }).orderBy('incomingId')
    expect(mappings.map(row => row.incomingId)).toEqual(['114', '14'])
    expect(new Set(mappings.map(row => row.localId)).size).toBe(1)
    expect(JSON.parse((await target.k('proven_tx_reqs').first()).notify).transactionIds).toEqual([mappings[0].localId])
    expect(proof.isValidRootForHeight).toHaveBeenCalledTimes(1)
  })
  test('two fully chain-validated proofs atomically coalesce the original cache invalidation and worker epoch', async () => {
    await open(
      data => {
        const other = new Transaction()
        other.addOutput({ satoshis: 2, lockingScript: Script.fromHex('51') })
        const txid = other.id('hex'),
          path = new MerklePath(100, [
            [
              { offset: 0, hash: proof.txid, txid: true },
              { offset: 1, hash: txid, txid: true }
            ]
          ]),
          root = path.computeRoot(proof.txid),
          header = toBinaryBaseBlockHeader({
            version: 1,
            previousHash: '0'.repeat(64),
            merkleRoot: root,
            time: 1,
            bits: 0,
            nonce: 0
          })
        proof.isValidRootForHeight.mockImplementation(async (value, height) => value === root && height === 100)
        proof.getHeaderForHeight.mockImplementation(async () => [...header])
        Object.assign(data.tables.provenTxs[0], {
          merklePath: Buffer.from(path.toBinary()).toString('base64'),
          merkleRoot: root,
          blockHash: asString(doubleSha256BE(header))
        })
        data.tables.provenTxs.push({
          ...data.tables.provenTxs[0],
          provenTxId: 21,
          index: 1,
          txid: txid.toUpperCase(),
          rawTx: Buffer.from(other.toBinary()).toString('base64')
        })
        data.tables.transactions.push({
          ...data.tables.transactions[0],
          transactionId: 114,
          reference: 'second-proof',
          txid: txid.toUpperCase(),
          provenTxId: 21
        })
      },
      async () => {
        await runInSeries(['e'.repeat(64), 'f'.repeat(64)], async rootTxid => {
          expect(
            await target.storage.upsertPreparedBeef(
              {
                preparedBeefId: 0,
                userId: 7,
                rootTxid,
                created_at: new Date(0),
                updated_at: new Date(0),
                formatVersion: 1,
                state: 'ready',
                txCount: 1,
                bumpCount: 1,
                byteLength: 1,
                checksum: '0'.repeat(64),
                beef: [0]
              },
              0
            )
          ).toBe(true)
        })
      }
    )
    const invalidation = jest.spyOn(target.storage, 'invalidatePreparedBeefs')
    const receipt = await commit(1)
    expect(receipt.nextRow).toBe(3)
    expect(await target.k('proven_txs')).toHaveLength(2)
    expect(await target.k('brc38_import_ids')).toHaveLength(2)
    expect(await target.storage.readPreparedBeefProofEpoch()).toBe(1)
    expect(invalidation).toHaveBeenCalledTimes(1)
    expect(await target.k('prepared_beefs').select('state', 'formatVersion')).toEqual([
      { state: 'stale', formatVersion: 0 },
      { state: 'stale', formatVersion: 0 }
    ])
    expect(proof.isValidRootForHeight).toHaveBeenCalledTimes(2)
  })
  test('all13 existing native entities preserve local IDs, apply tombstones, capture false-return history writes and retain the source operational checkpoint', async () => {
    const kinds = [
        'provenTx',
        'outputBasket',
        'outputTag',
        'txLabel',
        'transaction',
        'output',
        'txLabelMap',
        'outputTagMap',
        'certificate',
        'certificateField',
        'commission',
        'provenTxReq',
        'syncState'
      ],
      methods = [
        'insertProvenTx',
        'insertOutputBasket',
        'insertOutputTag',
        'insertTxLabel',
        'insertTransaction',
        'insertOutput',
        'insertTxLabelMap',
        'insertOutputTagMap',
        'insertCertificate',
        'insertCertificateField',
        'insertCommission',
        'insertProvenTxReq',
        'insertSyncState'
      ]
    await open(undefined, async () => {
      const data = JSON.parse(original) as BRC38WalletData
      await runInSeries(brc38ImportTableOrder.entries(), async ([index, table]) => {
        const row = decodePortableRow<Record<string, unknown>>(kinds[index], data.tables[table][0])
        row.updated_at = new Date(0)
        if (table === 'provenTxs') row.txid = proof.txid
        if (Object.hasOwn(row, 'isDeleted')) row.isDeleted = false
        if (table === 'syncStates') row.syncMap = '{"retainedOperationalCheckpoint":true}'
        const method: unknown = Reflect.get(target.storage, methods[index])
        if (typeof method !== 'function') throw new Error('Native fixture method missing')
        await Reflect.apply(method, target.storage, [row])
      })
    })
    const epoch = await target.storage.readPreparedBeefProofEpoch()
    await runInSeries(brc38ImportTableOrder.entries(), async ([index, table]) => {
      await commit(index + 1)
      expect(await target.k(nativeTables[table])).toHaveLength(1)
    })
    expect((await target.k('proven_txs').first()).provenTxId).toBe(11)
    expect((await target.k('transactions').first()).transactionId).toBe(14)
    expect((await target.k('output_tags').first()).isDeleted).toBe(1)
    expect((await target.k('output_tags_map').first()).isDeleted).toBe(1)
    expect((await target.k('certificates').first()).isDeleted).toBe(1)
    expect(target.storage.validateDate((await target.k('proven_tx_reqs').first()).updated_at).getTime()).toBe(
      Date.parse('2026-10-03T00:00:00.000Z')
    )
    expect((await target.k('sync_states').first()).syncMap).toBe('{"retainedOperationalCheckpoint":true}')
    expect(await target.storage.readPreparedBeefProofEpoch()).toBe(epoch)
    expect(proof.isValidRootForHeight).not.toHaveBeenCalled()
    expect((await readReceipt()).state).toBe('COMPLETE')
  })
  test('BRC177 target-winner merge and later output merge both quarantine reclaim liquidity through bounded owned secondary indexes', async () => {
    const reclaim = 'd'.repeat(64)
    await open(
      data => {
        for (const table of brc38ImportTableOrder)
          if (table !== 'transactions' && table !== 'outputs') data.tables[table] = []
        Object.assign(data.tables.transactions[0], {
          status: 'nosend',
          noSendExpiryState: 'target-won',
          noSendExpiryReclaimTxid: reclaim,
          updated_at: '2000-01-01T00:00:00.000Z'
        })
        delete data.tables.transactions[0].provenTxId
        Object.assign(data.tables.outputs[0], {
          txid: reclaim,
          spendable: true,
          updated_at: '2002-01-01T00:00:00.000Z'
        })
        delete data.tables.outputs[0].basketId
      },
      async () => {
        await target.storage.insertTransaction({
          transactionId: 40,
          userId: 7,
          created_at: new Date(0),
          updated_at: new Date('2001-01-01'),
          reference: 'archive-ref',
          txid: proof.txid,
          isOutgoing: true,
          satoshis: 5,
          description: 'current local',
          status: 'nosend',
          noSendExpiryState: 'reclaimed',
          noSendExpiryReclaimTxid: reclaim
        })
        await target.storage.insertOutput({
          outputId: 41,
          userId: 7,
          transactionId: 40,
          created_at: new Date(0),
          updated_at: new Date('2001-01-01'),
          txid: reclaim,
          vout: 0,
          spendable: true,
          change: true,
          satoshis: 5,
          outputDescription: 'reclaimed',
          type: 'P2PKH',
          providedBy: 'storage',
          purpose: 'change',
          lockingScript: [81]
        })
      }
    )
    await commit(1)
    expect((await target.k('transactions').first()).noSendExpiryState).toBe('target-won')
    expect((await target.k('outputs').first()).spendable).toBe(0)
    await commit(2)
    expect((await target.k('outputs').first()).spendable).toBe(0)
    expect(await target.k('brc38_import_ids').select('entity', 'incomingId', 'localId')).toEqual([
      { entity: 'transaction', incomingId: '14', localId: 40 },
      { entity: 'output', incomingId: '16', localId: 41 }
    ])
    expect((await readReceipt()).state).toBe('COMPLETE')
  })
  test('the actual entity row, map, proof-cache epoch and journal all roll back when map persistence fails', async () => {
    await open()
    const before = await readReceipt(),
      epoch = await target.storage.readPreparedBeefProofEpoch()
    const originalLoad = importIds.loadBrc38ImportIdMap
    jest.spyOn(importIds, 'loadBrc38ImportIdMap').mockImplementation(async (...args) => {
      const loaded = await originalLoad(...args)
      return {
        ...loaded,
        persist: async () => {
          await loaded.persist()
          throw new Error('synthetic after actual mapping persistence')
        }
      }
    })
    await expect(commit(1)).rejects.toThrow('synthetic after actual mapping persistence')
    expect(await target.k('proven_txs')).toEqual([])
    expect(await target.storage.readPreparedBeefProofEpoch()).toBe(epoch)
    expect(await readReceipt()).toEqual(before)
    expect(await target.k('brc38_import_ids')).toEqual([])
  })
  test('a large existing ready artifact is charged in SQL and refuses the proof page before any writer or payload transfer', async () => {
    await open(undefined, async () => {
      await target.storage.upsertPreparedBeef(
        {
          preparedBeefId: 0,
          userId: 7,
          rootTxid: 'e'.repeat(64),
          created_at: new Date(0),
          updated_at: new Date(0),
          formatVersion: 1,
          state: 'ready',
          txCount: 1,
          bumpCount: 1,
          byteLength: 262144,
          checksum: '0'.repeat(64),
          beef: Array.from(Buffer.alloc(262144, 0))
        },
        0
      )
    })
    const before = await readReceipt(),
      invalidation = jest.spyOn(target.storage, 'invalidatePreparedBeefs')
    await expect(commit(1)).rejects.toThrow('fixed allocation budget')
    expect(await readReceipt()).toEqual(before)
    expect(await target.k('proven_txs')).toEqual([])
    expect(await target.k('brc38_import_ids')).toEqual([])
    expect(await target.storage.readPreparedBeefProofEpoch()).toBe(0)
    expect((await target.k('prepared_beefs').first('state')).state).toBe('ready')
    expect(invalidation).not.toHaveBeenCalled()
  })
  test('a source proof outside the configured current chain fails before destination writes and preserves the original admission', async () => {
    await open()
    proof.isValidRootForHeight.mockResolvedValue(false)
    const before = await readReceipt()
    await expect(commit(1)).rejects.toThrow('Merkle root is not active')
    expect(await target.k('proven_txs')).toEqual([])
    expect(await target.k('brc38_import_ids')).toEqual([])
    expect(await readReceipt()).toEqual(before)
  })
  test('the internal merge helper refuses an admitted restore before any header write, preserving the separate original restore contract', async () => {
    proof = proofFixture()
    target = await previewDestinationFixture(async trx => {
      await installBrc38ImportTargetIndexes(trx)
      await installBrc38ImportJournalSchema(trx)
    })
    cleanup.push(async () => await target.close())
    staged = await previewPrivateFixture(undefined, data => portableProof(data, proof), 2097152)
    cleanup.push(async () => await staged.close())
    const store = staged.value.reservation.store,
      preview = await previewBrc38PrivateImport(store, target.storage, 'restore', policy),
      metadata = await store.withAuthenticatedImportView(async (_json, value) => value),
      binding = store.binding
    if (binding === undefined) throw new Error('Private restore binding missing')
    admission = {
      scope: {
        importId: randomUUID(),
        bindingSha256: binding.digest,
        archiveSha256: binding.binding.archiveSha256,
        userId: 7
      },
      previewId: preview.previewId,
      originalLimitsJson: binding.limitsJson,
      expiresAt: preview.expiresAt,
      initialDestinationSha256: brc38ImportDestinationDigest(preview.target),
      totalRows: metadata.rows + 1,
      maximumStepRows: 128,
      maximumStepBytes: 2097152,
      maximumMappedIds: 1000,
      maximumJournalLogicalBytes: 516096
    }
    await prepareBrc38PrivateImportJournal(store, target.storage, {
      admission,
      receiptPolicy: policy
    })
    const before = await readReceipt()
    await expect(
      commitBrc38PrivateImportPage(store, target.storage, {
        admission,
        receiptPolicy: policy,
        fromRow: 0,
        prepareEntityMerge: true,
        apply: async () => {
          throw new Error('Restore writer must not run')
        }
      })
    ).rejects.toThrow('admitted merge mode')
    expect(await target.k('users')).toEqual([])
    expect(await target.k('brc38_import_ids')).toEqual([])
    expect(await readReceipt()).toEqual(before)
    const mutable = {
      admission,
      receiptPolicy: policy,
      fromRow: 0,
      prepareEntityMerge: false,
      maximumPreparedRows: undefined as number | undefined,
      apply: async (trx: Knex.Transaction, data: Brc38PreparedImportData) => {
        if (data.kind !== 'header') throw new Error('Original restore header missing')
        await target.storage.insertUser({ ...data.user, userId: 7, activeStorage: '' }, trx)
      }
    }
    const committing = commitBrc38PrivateImportPage(store, target.storage, mutable)
    mutable.prepareEntityMerge = true
    mutable.maximumPreparedRows = 0
    expect((await committing).nextRow).toBe(1)
    expect(await target.k('users').select('userId', 'activeStorage')).toEqual([{ userId: 7, activeStorage: '' }])
  })
  test('bounded original300 status/clock scenarios retain the legacy monotonic BRC177 winner independently of row clock', async () => {
    await open(data => {
      for (const table of brc38ImportTableOrder) if (table !== 'transactions') data.tables[table] = []
      delete data.tables.transactions[0].provenTxId
      data.tables.transactions[0].status = 'nosend'
      data.tables.transactions[0].noSendExpiryState = 'target-won'
      data.tables.transactions[0].updated_at = '2000-01-01T00:00:00.000Z'
    })
    const source = staged.value.reservation.store,
      component = await source.withAuthenticatedImportRead(async (_json, metadata, reader) => {
        const page = await prepareBrc38ImportPage(reader, metadata, admission, 1),
          header = await prepareBrc38ImportPage(reader, metadata, admission, 0)
        return {
          data: await page.consume(async data => data),
          references: page.references,
          source: await header.consume(async data => {
            if (data.kind !== 'header') throw new Error('Source header missing')
            return data.source
          })
        }
      }),
      pool = knex({ ...target.k.client.config, pool: { min: 0, max: 1 } })
    cleanup.push(async () => await pool.destroy())
    await pool.raw('PRAGMA query_only = ON')
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 100000 }), async skew => {
        const id = await target.storage.insertTransaction({
          transactionId: 0,
          userId: 7,
          created_at: new Date(0),
          updated_at: new Date(Date.UTC(2000, 0, 1) + skew),
          status: 'nosend',
          reference: 'archive-ref',
          txid: proof.txid,
          isOutgoing: true,
          satoshis: 5,
          description: 'newer local description',
          noSendExpiryState: 'reclaimed'
        })
        try {
          let operations = 0
          // Component policy oracle on real query-only storage. The full owner
          // is separately exercised above; this loop never edits receipt fences.
          const merge = await pool.transaction(
            async trx =>
              await prepareBrc38ImportEntityMerge(
                trx,
                target.storage,
                admission.scope,
                component.data,
                component.references,
                component.source,
                2097152
              )
          )
          await target.k
            .transaction(async trx => {
              operations = merge.operationCount
              await merge.apply(trx)
              const result = await trx('transactions').where({ transactionId: id }).first()
              expect(result.noSendExpiryState).toBe('target-won')
              expect(result.description).toBe('newer local description')
              expect(target.storage.validateDate(result.updated_at).getTime()).toBe(Date.UTC(2000, 0, 1) + skew)
              throw new Error('synthetic property rollback')
            })
            .catch(error => {
              if (!(error instanceof Error) || error.message !== 'synthetic property rollback') throw error
            })
          expect(operations).toBe(1)
        } finally {
          await target.k('transactions').where({ transactionId: id }).delete()
        }
      }),
      {
        numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
        seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
        path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? '',
        interruptAfterTimeLimit: 150000,
        markInterruptAsFailure: true
      }
    )
    expect((await readReceipt()).nextRow).toBe(1)
  }, 180000)
})
