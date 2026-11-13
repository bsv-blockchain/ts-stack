import { NativeSnapshotJournalStructuredSource } from '../../src/storage/snapshot/NativeSnapshotSyncStructuredSourceNode'
import { NativeSnapshotSyncStructuredWorkspace } from '../../src/storage/snapshot/NativeSnapshotSyncStructuredWorkspaceNode'
import type { SnapshotJournalDestinationCheckpoint } from '../../src/storage/snapshot/journal/SnapshotJournalTypes'
import type { Knex } from 'knex'
import { readNativeSnapshotJournalMappingRevision } from '../../src/storage/snapshot/NativeSnapshotSyncMappingSchemaNode'
import { readSnapshotJournalPointFields } from '../../src/storage/snapshot/journal/SnapshotJournalFieldSql'
import { PrivateKey } from '@bsv/sdk'
import type { BRC38WalletData } from '../../src/storage/portable/index'
import type { WalletStorageManager } from '../../src/storage/WalletStorageManager'
import { KnexSnapshotJournalFieldDestination } from '../../src/storage/snapshot/journal/KnexSnapshotJournalFieldDestination'
import { journalCopyLimits } from '../../src/storage/snapshot/journal/SnapshotJournalCopyLimits'
import { readSnapshotJournalNativeOwnedRow } from '../../src/storage/snapshot/journal/SnapshotJournalNativeRows'
import { createHash } from 'node:crypto'
import { Brc38WorkingAllocation } from '../../src/storage/portable/Brc38WorkingAllocation'
import { snapshotHttpFixture } from './snapshotArchiveHttpFixtures'
import { StorageClient } from '../../src/storage/remoting/StorageClient'
import type { StorageKnex } from '../../src/storage/StorageKnex'
import type { KnexSnapshotArchiveRpc } from '../../src/storage/snapshot/archive/KnexSnapshotArchiveRpc'
import type {
  RemoteSnapshotJournalFieldArchive,
  RemoteSnapshotJournalFieldFrame
} from '../../src/storage/snapshot/journal/openRemoteSnapshotJournalFieldArchive'
import { preparePackedNativeSnapshotArchiveField } from '../../src/storage/snapshot/preparePackedNativeSnapshotFieldNode'
import { verifyPackedNativeSnapshotField } from '../../src/storage/snapshot/preparePackedNativeSnapshotFieldNode.case'

/** Genuine actual native target plus AuthFetch artifact. Reused by the full
 * functional pair and the original selected native-catalog component suite.
 * No copied SQL/native actor, full-snapshot substitute or financial ACK. */
export async function verifyNativeSnapshotFieldArtifactCache(
  input: Readonly<{
    storage: StorageKnex
    manager: WalletStorageManager
    sourceData: Readonly<BRC38WalletData>
    targetRowId: number
    expected: Uint8Array
    expiresAt: number
  }>
): Promise<void> {
  const expected = new Uint8Array(input.expected),
    expectedText = Buffer.from('\ufeffnative\u0000雪😀'.repeat(5001), 'utf8'),
    http = await snapshotHttpFixture()
  let archive: RemoteSnapshotJournalFieldArchive | undefined
  const failures: unknown[] = []
  try {
    await http.storage
      .knex('outputs')
      .where('outputId', 1)
      .update({ lockingScript: Buffer.from(expected), outputDescription: expectedText.toString('utf8') })
    const { server, url } = await http.serve(),
      client = new StorageClient(http.wallet, url, { serverIdentityKey: http.serverIdentityKey }),
      rpc = Reflect.get(server, 'snapshotArchives') as KnexSnapshotArchiveRpc,
      original = rpc.dispatch.bind(rpc),
      downloads: number[] = []
    jest.spyOn(rpc, 'dispatch').mockImplementation(async (method, params, identity) => {
      if (method === 'readSnapshotJournalFieldArchivePage') downloads.push(Reflect.get(params[0] as object, 'sequence'))
      return await original(method, params, identity)
    })
    archive = await client.openSnapshotJournalFieldArchive(http.identityKey)
    if (archive === undefined) throw new Error('Actual authenticated field archive unavailable')
    const owned = archive,
      content = new Set<number>(
        (
          await http.storage
            .knex('snapshot_archive_pages')
            .where('tableName', 'like', 'journal-fields-content/%')
            .select('sequence')
        ).map(row => Number(row.sequence))
      )
    let identityCount = 0
    let selected: { frame: RemoteSnapshotJournalFieldFrame; changeIndex: number } | undefined
    for (let ordinal = 0; ordinal < owned.frameCount; ordinal++) {
      const frame = await owned.readFrame(ordinal, (_digest, _index, values) => {
        identityCount += values.size
      })
      if (frame.stream === 'scope' && frame.tableId === 1) {
        const changeIndex = frame.page.changes.findIndex(change => change.present && change.metadata.id1 === 1)
        if (changeIndex >= 0) selected = { frame, changeIndex }
      }
    }
    expect(identityCount).toBeGreaterThan(0)
    if (selected === undefined) throw new Error('Actual HTTP output metadata unavailable')
    const { frame, changeIndex } = selected
    const selectedChange = frame.page.changes[changeIndex]
    if (!selectedChange.present || selectedChange.fields.lockingScript?.kind !== 'binary')
      throw new Error('Actual authenticated binary descriptor unavailable')
    expect(selectedChange.fields.lockingScript.bytes).toBe(expected.length)
    let preparations = 0
    await verifyPackedNativeSnapshotField({
      storage: input.storage,
      descriptor: selectedChange.fields.lockingScript,
      targetRowId: input.targetRowId,
      expected,
      expiresAt: Math.min(owned.expiresAt, input.expiresAt),
      prepare: async policy => {
        await expect(
          preparePackedNativeSnapshotArchiveField(
            input.storage,
            owned,
            structuredClone(frame),
            changeIndex,
            'lockingScript',
            policy
          )
        ).rejects.toThrow('actual opened artifact')
        const before = downloads.filter(sequence => content.has(sequence)).length,
          prepared = await preparePackedNativeSnapshotArchiveField(
            input.storage,
            owned,
            frame,
            changeIndex,
            'lockingScript',
            policy
          ),
          count = downloads.filter(sequence => content.has(sequence)).length - before
        try {
          if (preparations++ === 0) expect(count).toBeGreaterThan(0)
          else expect(count).toBe(0)
          return prepared
        } catch (cause) {
          await prepared.close()
          throw cause
        }
      }
    })
    const textWorking = new Brc38WorkingAllocation(1048576),
      textPolicy = {
        workingAllocation: textWorking,
        maximumFieldBytes: 262144,
        maximumReadBytes: 4096,
        expiresAt: Math.min(owned.expiresAt, input.expiresAt)
      }
    for (let pass = 0; pass < 2; pass++) {
      const before = downloads.filter(sequence => content.has(sequence)).length,
        prepared = await preparePackedNativeSnapshotArchiveField(
          input.storage,
          owned,
          frame,
          changeIndex,
          'outputDescription',
          textPolicy
        )
      try {
        const count = downloads.filter(sequence => content.has(sequence)).length - before
        if (pass === 0) expect(count).toBeGreaterThan(0)
        else expect(count).toBe(0)
        expect(prepared.descriptor).toEqual({
          kind: 'utf8',
          bytes: expectedText.length,
          sha256: createHash('sha256').update(expectedText).digest('hex')
        })
        for (const offset of [0, 65530, expectedText.length - 17]) {
          const length = Math.min(17, expectedText.length - offset),
            bytes = await prepared.read(offset, length)
          try {
            expect(Buffer.from(bytes)).toEqual(expectedText.subarray(offset, offset + length))
          } finally {
            bytes.fill(0)
          }
        }
        if (pass === 0)
          await input.storage.knex.transaction(
            async trx =>
              await input.storage.writePreparedNativeSnapshotFields(
                'outputs',
                input.targetRowId,
                { outputDescription: prepared },
                trx
              )
          )
        const custody = await input.storage.runSnapshotJournalWriter(async trx => {
          const target = await trx('outputs').where('outputId', input.targetRowId).first('userId')
          if (target === undefined) throw new Error('Actual native custody output missing')
          return await readSnapshotJournalNativeOwnedRow(
            trx,
            1,
            Number(target.userId),
            { id1: input.targetRowId, id2: 0, exactText: '' },
            { remaining: 16777216 }
          )
        })
        expect(custody?.row).not.toHaveProperty('lockingScript')
        expect(custody?.row).not.toHaveProperty('outputDescription')
        expect(custody?.fields?.lockingScript).toEqual({
          kind: 'binary',
          bytes: expected.length,
          sha256: createHash('sha256').update(expected).digest('hex')
        })
        expect(custody?.fields?.outputDescription).toEqual({
          kind: 'utf8',
          bytes: expectedText.length,
          sha256: createHash('sha256').update(expectedText).digest('hex')
        })
      } finally {
        await prepared.close()
      }
    }
    expect(textWorking.used).toBe(0)
    expect(preparations).toBe(2)
    await owned.close()
    await owned.closed
    expect(await http.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
      archives: 0,
      reservedBytes: 0
    })
    await verifyNativeJournalFinancialFieldPromotion(input)
  } catch (cause) {
    failures.push(cause)
  } finally {
    expected.fill(0)
    expectedText.fill(0)
    for (const close of [async () => await archive?.close(), async () => await http.close()]) {
      try {
        await close()
      } catch (cause) {
        failures.push(cause)
      }
    }
    jest.restoreAllMocks()
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1)
    throw new AggregateError(failures, 'Native archive field case and cleanup failed', { cause: failures[0] })
}

/** Additional genuine financial receiver assertion inside the existing selected
 * component and mandatory pair. Original cold/hot content, pointer/rollback,
 * UTF8 and custody oracles above remain unchanged. This minimal proof/action/simple-payload
 * fixture does not replace the separate complete-profile qualification. */
async function verifyNativeJournalFinancialFieldPromotion(
  input: Readonly<{
    storage: StorageKnex
    manager: WalletStorageManager
    sourceData: Readonly<BRC38WalletData>
    targetRowId: number
    expected: Uint8Array
    expiresAt: number
  }>
): Promise<void> {
  const key = new PrivateKey(1),
    identityKey = key.toPublicKey().toString(),
    expectedText = '\ufeffjournal financial\u0000雪😀'.repeat(5001)
  if (identityKey !== input.manager.getActiveUser().identityKey || input.sourceData.user.identityKey !== identityKey)
    throw new Error('Independent native fixture identity differs from its genuine authenticated field source')
  const http = await snapshotHttpFixture(true, false, input.storage.chain, 'http-field-financial-source', key),
    closes: Array<() => Promise<void>> = [async () => await http.close()],
    failures: unknown[] = []
  try {
    const user = (await http.storage.findOrInsertUser(identityKey)).user,
      beforeActive = (await input.storage.findUsers({ partial: { identityKey } }))[0].activeStorage,
      incoming = (
        table:
          | 'provenTxs'
          | 'outputBaskets'
          | 'transactions'
          | 'outputs'
          | 'certificates'
          | 'certificateFields'
          | 'commissions'
          | 'provenTxReqs',
        binaries: readonly string[]
      ): Record<string, unknown> => {
        const original = input.sourceData.tables[table][0]
        if (original === undefined) throw new Error('Independent financial fixture is missing ' + table)
        const row: Record<string, unknown> = { ...original }
        for (const [name, value] of Object.entries(row)) {
          if (value === undefined) delete row[name]
          else if (binaries.includes(name)) {
            if (typeof value !== 'string') throw new Error('Independent fixture binary is not canonical base64')
            const bytes = Buffer.from(value, 'base64')
            if (bytes.toString('base64') !== value) throw new Error('Independent fixture binary spelling differs')
            row[name] = bytes
          } else if (
            table === 'provenTxReqs' &&
            ['history', 'notify'].includes(name) &&
            value !== null &&
            typeof value === 'object'
          ) {
            row[name] = JSON.stringify(value)
          } else if (value !== null && !['string', 'number', 'boolean'].includes(typeof value))
            throw new Error('Independent small financial fixture unexpectedly contains structured payload')
        }
        if (table !== 'provenTxs' && table !== 'provenTxReqs') row.userId = user.userId
        return row
      }
    const schemaRollback = new Error('Independent native mapping schema rollback')
    await expect(
      input.storage.runSnapshotJournalWriter(async trx => {
        await readNativeSnapshotJournalMappingRevision(trx as Knex.Transaction)
        await trx.raw('DROP TRIGGER brc38_journal_mapping_captured_update')
        await expect(readNativeSnapshotJournalMappingRevision(trx as Knex.Transaction)).rejects.toThrow(
          'schema or revision differs'
        )
        throw schemaRollback
      })
    ).rejects.toBe(schemaRollback)
    await input.storage.runSnapshotJournalWriter(
      async trx => await readNativeSnapshotJournalMappingRevision(trx as Knex.Transaction)
    )
    const canonicalProofId = await input.manager.runAsWriter(async active => {
      if (active !== input.storage) throw new Error('Actual canonical native fixture manager changed')
      return await input.storage.runSnapshotJournalWriter(async trx => {
        const rows: Array<{ provenTxId: number; txid: string; blockHash: string; merkleRoot: string }> = await trx(
          'proven_txs'
        )
          .select('provenTxId', 'txid', 'blockHash', 'merkleRoot')
          .limit(2)
        expect(rows).toHaveLength(1)
        const row = rows[0],
          source = input.sourceData.tables.provenTxs[0]
        if (typeof source.txid !== 'string' || row.txid.toLowerCase() !== source.txid.toLowerCase())
          throw new Error('Independent canonical native proof fixture identifies a different transaction')
        // Model the existing complete-row validator directly in actual SQL.
        // No under-test lookup or prepared receipt supplies this preimage.
        await trx('proven_txs').where('provenTxId', row.provenTxId).update({
          txid: row.txid.toLowerCase(),
          blockHash: row.blockHash.toLowerCase(),
          merkleRoot: row.merkleRoot.toLowerCase()
        })
        return row.provenTxId
      })
    })
    await http.storage.knex('output_baskets').where('userId', user.userId).delete()
    await http.storage.knex('proven_txs').insert(incoming('provenTxs', ['rawTx', 'merklePath']))
    await http.storage.knex('output_baskets').insert(incoming('outputBaskets', []))
    const transaction = incoming('transactions', ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx']),
      proof = input.sourceData.tables.provenTxs[0]
    if (typeof proof.rawTx !== 'string') throw new Error('Independent proven transaction bytes missing')
    transaction.rawTx = Buffer.from(proof.rawTx, 'base64')
    await http.storage.knex('transactions').insert(transaction)
    const output = incoming('outputs', ['lockingScript'])
    output.lockingScript = Buffer.from(input.expected)
    output.outputDescription = expectedText
    output.updated_at = new Date(Date.now() + 1000).toISOString()
    await http.storage.knex('outputs').insert(output)
    const certificate = incoming('certificates', []),
      certificateField = incoming('certificateFields', []),
      commission = incoming('commissions', ['lockingScript']),
      simpleUpdated = new Date(Date.now() + 1000).toISOString(),
      originalCommission = input.sourceData.tables.commissions[0]
    certificate.subject = expectedText
    certificate.updated_at = simpleUpdated
    certificateField.fieldValue = expectedText
    certificateField.updated_at = simpleUpdated
    commission.keyOffset = 'incoming commission payload must not replace current'.repeat(2000)
    commission.lockingScript = Buffer.from([255, 254, 253])
    commission.satoshis = 991
    commission.isRedeemed = true
    commission.updated_at = simpleUpdated
    await http.storage.knex('certificates').insert(certificate)
    await http.storage.knex('certificate_fields').insert(certificateField)
    await http.storage.knex('commissions').insert(commission)
    const beforeSimple = await input.storage.runSnapshotJournalWriter(async trx => {
      const userId = input.manager.getActiveUser().userId,
        certificates = await trx('certificates')
          .where({ userId, certifier: certificate.certifier, serialNumber: certificate.serialNumber })
          .select('certificateId')
          .limit(2),
        commissions = await trx('commissions').where({ userId }).select('commissionId', 'transactionId').limit(2)
      expect(certificates).toHaveLength(1)
      expect(commissions).toHaveLength(1)
      return {
        certificateId: Number(certificates[0].certificateId),
        commissionId: Number(commissions[0].commissionId),
        transactionId: Number(commissions[0].transactionId)
      }
    })
    const existingRequests = await input.storage.findProvenTxReqs({ partial: {} })
    expect(existingRequests).toHaveLength(1)
    const initialRequest = existingRequests[0],
      initialNotify = JSON.parse(initialRequest.notify) as Record<string, unknown>
    await input.manager.runAsWriter(async active => {
      if (active !== input.storage) throw new Error('Actual request fixture manager changed')
      expect(
        await input.storage.updateProvenTxReq(initialRequest.provenTxReqId, {
          notify: JSON.stringify({ ...initialNotify, transactionIds: [] }),
          notified: true
        })
      ).toBe(1)
    })
    const [beforeRequest] = await input.storage.findProvenTxReqs({
        partial: { provenTxReqId: initialRequest.provenTxReqId }
      }),
      request = incoming('provenTxReqs', ['rawTx', 'inputBEEF']),
      incomingNote = { when: '2026-10-17T21:00:00.000Z', what: expectedText },
      expectedHistory = JSON.parse(beforeRequest.history) as { notes?: unknown[] }
    request.history = JSON.stringify({ notes: [incomingNote] })
    request.notify = JSON.stringify({
      transactionIds: [transaction.transactionId, 999, transaction.transactionId, 1.5]
    })
    request.rawTx = Buffer.from([99, 98, 97])
    request.status = 'unknown'
    request.attempts = beforeRequest.attempts + 99
    request.batch = beforeRequest.batch || 'journal independent batch'
    request.updated_at = simpleUpdated
    await http.storage.knex('proven_tx_reqs').insert(request)
    const { url } = await http.serve(),
      client = new StorageClient(http.wallet, url, { serverIdentityKey: http.serverIdentityKey }),
      archive = await client.openSnapshotJournalFieldArchive(identityKey)
    if (archive === undefined) throw new Error('Genuine financial field archive unavailable')
    closes.unshift(async () => {
      await archive.close()
      await archive.closed
    })
    const admission = async <T>(operation: () => Promise<T>) =>
        await input.manager.runAsWriter(async active => {
          if (active !== input.storage) throw new Error('Genuine native financial target manager changed')
          return await operation()
        }),
      begun = await KnexSnapshotJournalFieldDestination.begin(
        input.storage,
        identityKey,
        archive.manifest.binding,
        journalCopyLimits(),
        admission
      )
    let checkpoint = begun.checkpoint
    for (let ordinal = 0; ordinal < archive.frameCount; ordinal++)
      checkpoint = await begun.destination.stageArchiveFrame(checkpoint, archive)
    expect(checkpoint.phase).toBe('promoting')
    let injectedCheckpoint: SnapshotJournalDestinationCheckpoint | undefined,
      fenceRefusals = 0
    const originalOpen = NativeSnapshotJournalStructuredSource.open.bind(NativeSnapshotJournalStructuredSource),
      ownerSpy = jest.spyOn(NativeSnapshotJournalStructuredSource, 'open').mockImplementationOnce(async (...args) => {
        const owned = await originalOpen(...args)
        await expect(NativeSnapshotSyncStructuredWorkspace.open(Object.create(owned))).rejects.toThrow(
          'actual producer'
        )
        const [storage, binding, expected, receipt, changeIndex] = args
        expect(storage).toBe(input.storage)
        await storage.runSnapshotJournalWriter(async trx => {
          const selected = {
              userId: binding.destinationUserId,
              sourceStorageIdentity: binding.source.storageIdentity,
              sessionId: expected.sessionId,
              frameDigest: receipt.digest,
              changeIndex,
              tableId: 0
            },
            rows: Array<{ incomingId: number; naturalKeyJson: string }> = await trx(
              'snapshot_reconciliation_captured_identities'
            )
              .where(selected)
              .select('incomingId', 'naturalKeyJson')
              .limit(2)
          expect(rows).toHaveLength(1)
          const row = rows[0],
            key = { ...selected, incomingId: row.incomingId },
            before = await readNativeSnapshotJournalMappingRevision(trx as Knex.Transaction)
          // The final DATA is identical. Only the real committed event fence
          // can reveal this away-and-back change after preparation ownership.
          await trx('snapshot_reconciliation_captured_identities')
            .where(key)
            .update({ naturalKeyJson: row.naturalKeyJson + ' ' })
          await trx('snapshot_reconciliation_captured_identities')
            .where(key)
            .update({ naturalKeyJson: row.naturalKeyJson })
          expect(BigInt(await readNativeSnapshotJournalMappingRevision(trx as Knex.Transaction))).toBe(
            BigInt(before) + 2n
          )
        })
        injectedCheckpoint = structuredClone(expected)
        return owned
      })
    try {
      while (checkpoint.phase !== 'acknowledged') {
        if (Date.now() >= Math.min(input.expiresAt, archive.expiresAt))
          throw new Error('Genuine financial field case reached its actual original owner deadline')
        try {
          checkpoint = (await begun.destination.promote(checkpoint, archive)).checkpoint
        } catch (cause) {
          if (
            injectedCheckpoint === undefined ||
            fenceRefusals !== 0 ||
            !(cause instanceof Error) ||
            !cause.message.includes('Native structured source differs')
          )
            throw cause
          const actual = (await begun.destination.status()).checkpoint
          expect(actual).toEqual(injectedCheckpoint)
          const [unchanged] = await input.storage.findProvenTxReqs({
            partial: { provenTxReqId: beforeRequest.provenTxReqId }
          })
          expect(unchanged.history).toBe(beforeRequest.history)
          expect(unchanged.notify).toBe(beforeRequest.notify)
          checkpoint = actual
          fenceRefusals++
        }
      }
      expect(fenceRefusals).toBe(1)
    } finally {
      ownerSpy.mockRestore()
    }
    const [afterRequest] = await input.storage.findProvenTxReqs({
      partial: { provenTxReqId: beforeRequest.provenTxReqId }
    })
    expect(JSON.parse(afterRequest.history)).toEqual({
      ...expectedHistory,
      notes: [...(expectedHistory.notes ?? []), incomingNote]
    })
    expect(JSON.parse(afterRequest.notify)).toEqual({
      ...JSON.parse(beforeRequest.notify),
      transactionIds: [beforeSimple.transactionId]
    })
    expect(afterRequest).toMatchObject({
      provenTxReqId: beforeRequest.provenTxReqId,
      txid: beforeRequest.txid,
      status: beforeRequest.status,
      attempts: beforeRequest.attempts,
      provenTxId: beforeRequest.provenTxId,
      batch: request.batch,
      notified: false
    })
    expect(Buffer.from(afterRequest.rawTx)).toEqual(Buffer.from(beforeRequest.rawTx))
    expect(afterRequest.inputBEEF).toEqual(beforeRequest.inputBEEF)

    const resumed = await KnexSnapshotJournalFieldDestination.resume(
      input.storage,
      identityKey,
      archive.manifest.binding.sourceStorage.storageIdentityKey,
      journalCopyLimits(),
      admission
    )
    if (resumed === undefined) throw new Error('Actual native committed field window missing')
    expect((await resumed.status()).checkpoint).toEqual(checkpoint)
    const measured = await input.storage.runSnapshotJournalWriter(async trx => {
      const userId = input.manager.getActiveUser().userId,
        custody = await readSnapshotJournalNativeOwnedRow(
          trx,
          1,
          userId,
          { id1: input.targetRowId, id2: 0, exactText: '' },
          { remaining: 16777216 }
        ),
        point = await readSnapshotJournalPointFields(trx, 1, { outputId: input.targetRowId, userId }, 16777216)
      if (custody === undefined || point === undefined)
        throw new Error('Actual committed native financial output missing')
      const result: Record<string, { kind: string; bytes: number; sha256: string }> = {}
      for (const name of ['lockingScript', 'outputDescription']) {
        const descriptor = point.fields[name]
        if (descriptor === undefined) throw new Error('Actual native financial field missing')
        const hash = createHash('sha256')
        for (let offset = 0; offset < descriptor.bytes; offset += 16384) {
          const bytes = await point.readExtent(name, offset, Math.min(16384, descriptor.bytes - offset))
          try {
            hash.update(bytes)
          } finally {
            bytes.fill(0)
          }
        }
        const sha256 = hash.digest('hex')
        if (descriptor.sha256 !== undefined) expect(descriptor.sha256).toBe(sha256)
        result[name] = { kind: descriptor.kind, bytes: descriptor.bytes, sha256 }
      }
      return result
    })
    expect(measured.outputDescription).toEqual({
      kind: 'utf8',
      bytes: Buffer.byteLength(expectedText),
      sha256: createHash('sha256').update(expectedText).digest('hex')
    })
    expect(measured.lockingScript).toEqual({
      kind: 'binary',
      bytes: input.expected.length,
      sha256: createHash('sha256').update(input.expected).digest('hex')
    })
    const proofs = await input.storage.knex('proven_txs').select('provenTxId', 'txid').limit(2)
    expect(proofs).toHaveLength(1)
    expect(proofs[0].provenTxId).toBe(canonicalProofId)
    expect(proofs[0].txid).toBe(String(input.sourceData.tables.provenTxs[0].txid).toLowerCase())
    const simpleResult = await input.storage.runSnapshotJournalWriter(async trx => {
      const userId = input.manager.getActiveUser().userId,
        certificates = await trx('certificates')
          .where({ userId, certifier: certificate.certifier, serialNumber: certificate.serialNumber })
          .select('certificateId')
          .limit(2),
        commissions = await trx('commissions')
          .where({ userId })
          .select('commissionId', 'transactionId', 'satoshis', 'isRedeemed')
          .limit(2)
      expect(certificates).toHaveLength(1)
      expect(commissions).toHaveLength(1)
      expect(Number(certificates[0].certificateId)).toBe(beforeSimple.certificateId)
      expect(Number(commissions[0].commissionId)).toBe(beforeSimple.commissionId)
      expect(Number(commissions[0].transactionId)).toBe(beforeSimple.transactionId)
      expect(Number(commissions[0].satoshis)).toBe(originalCommission.satoshis)
      expect(Number(commissions[0].isRedeemed)).toBe(1)
      const result: Record<string, { bytes: number; sha256: string }> = {}
      const points: Array<{ name: string; table: number; key: Record<string, string | number> }> = [
        { name: 'subject', table: 2, key: { userId, certificateId: beforeSimple.certificateId } },
        {
          name: 'fieldValue',
          table: 12,
          key: { userId, certificateId: beforeSimple.certificateId, fieldName: String(certificateField.fieldName) }
        },
        { name: 'keyOffset', table: 6, key: { userId, commissionId: beforeSimple.commissionId } },
        { name: 'lockingScript', table: 6, key: { userId, commissionId: beforeSimple.commissionId } }
      ]
      for (const item of points) {
        const point = await readSnapshotJournalPointFields(trx, item.table, item.key, 16777216),
          descriptor = point?.fields[item.name]
        if (point === undefined || descriptor === undefined)
          throw new Error('Actual committed native simple field missing')
        const hash = createHash('sha256')
        for (let offset = 0; offset < descriptor.bytes; offset += 16384) {
          const bytes = await point.readExtent(item.name, offset, Math.min(16384, descriptor.bytes - offset))
          try {
            hash.update(bytes)
          } finally {
            bytes.fill(0)
          }
        }
        result[item.name] = { bytes: descriptor.bytes, sha256: hash.digest('hex') }
      }
      return result
    })
    const expectedDigest = (bytes: Uint8Array) => ({
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
    expect(simpleResult.subject).toEqual(expectedDigest(Buffer.from(expectedText)))
    expect(simpleResult.fieldValue).toEqual(expectedDigest(Buffer.from(expectedText)))
    expect(simpleResult.keyOffset).toEqual(expectedDigest(Buffer.from(String(originalCommission.keyOffset))))
    if (typeof originalCommission.lockingScript !== 'string')
      throw new Error('Independent original commission script missing')
    expect(simpleResult.lockingScript).toEqual(expectedDigest(Buffer.from(originalCommission.lockingScript, 'base64')))
    expect((await input.storage.findUsers({ partial: { identityKey } }))[0].activeStorage).toBe(beforeActive)
    expect(checkpoint.phase).toBe('acknowledged')
  } catch (cause) {
    failures.push(cause)
  }
  for (const close of closes)
    try {
      await close()
    } catch (cause) {
      failures.push(cause)
    }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1)
    throw new AggregateError(failures, 'Genuine native journal financial case and cleanup failed', {
      cause: failures[0]
    })
}
