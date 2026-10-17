import { nativeTestExecutable } from '../portable/Brc38NativeTestPath'
import { Brc38CleanupScope } from '../portable/Brc38StagingCleanupError'
import { composedNativeFixture, withComposedNativeFixture } from '../portable/Brc38ComposedNativeFixture'
import { snapshotMeasurementCases } from '../../../benchmarks/snapshot-measurement-cases'
import { verifyNativeSnapshotFieldMetadataAndExactWindows } from './NativeSnapshotFieldSource.case'
import {
  verifyPublishedNativeSnapshotLifecycle,
  verifyNativeConcurrentSnapshotSource
} from './NativeConcurrentSnapshotSourceNode.case'
import { verifyNativePackedHashWindowOracle } from '../portable/Brc38NativePackedHashWindowNode.case'
import { createOwnedNativeReadDatabase, ownedNativeRootIdentity } from '../schema/ownedNativeSqliteConnectionsNode'
import { openBrc38KnexSource } from '../portable/Brc38KnexSource'
import { verifyNativePayloadTextSource, type NativePayloadTextSourceCase } from './NativeSnapshotPayloadTextSource.case'
import { withComposedFixtureRead } from '../portable/Brc38ComposedSemanticFixture'
import type { WalletSnapshotTable } from './WalletReadSnapshot'

// Admit the existing 180-second fixture owner plus 30 seconds of cleanup.
const nativeFixtureCaseTimeoutMs = 180000 + 30000
// Original large-record setup exceeded 180 seconds before its read phase.
// Keep 130 labels,131073 raw bytes,700000 history characters and the original
// 120-second window phase, with separate finite setup admission.
const nativeLargeRecordFixtureLifetimeMs = 360000 + 120000

// Authored UNRUN. These cases use the actual authenticated native fixture and
// its original physical owner. No copied actor, historical pin, stock SQLite
// connection or successful receipt can stand in for the required native host.
test(
  'actual native WAL source retains original large history while foreground writing and archive provenance remain live',
  async () => {
    await withComposedNativeFixture(async fixture => {
      const { storage, manager } = fixture,
        users = await storage.findUsers({ partial: { identityKey: manager.getActiveUser().identityKey } }),
        user = users[0],
        requests = await storage.findProvenTxReqs({ partial: { txid: fixture.proof.txid.toUpperCase() } }),
        states = await storage.findSyncStates({ partial: { userId: user.userId } }),
        originalHistory = JSON.stringify({ notes: [], independent: 'original 雪😀'.repeat(7000) }),
        changedHistory = '{"notes":[],"independent":"foreground replacement"}'
      expect(users).toHaveLength(1)
      expect(user.userId).toBe(manager.getActiveUser().userId)
      expect(requests).toHaveLength(1)
      expect(states).toHaveLength(1)
      expect(await storage.updateProvenTxReq(requests[0].provenTxReqId, { history: originalHistory })).toBe(1)
      // Counts and headers are independent preimages, captured before the
      // under-test retained source. No descriptor, archive producer or sync
      // output supplies the expected original logical bytes.
      const counts = await withComposedFixtureRead(manager, async trx => {
        const names = {
            provenTxs: 'proven_txs',
            outputBaskets: 'output_baskets',
            outputTags: 'output_tags',
            txLabels: 'tx_labels',
            transactions: 'transactions',
            outputs: 'outputs',
            certificates: 'certificates',
            certificateFields: 'certificate_fields',
            commissions: 'commissions',
            provenTxReqs: 'proven_tx_reqs',
            txLabelMaps: 'tx_labels_map',
            outputTagMaps: 'output_tags_map',
            syncStates: 'sync_states'
          } as const,
          result = {} as Record<WalletSnapshotTable, number>
        for (const [table, sql] of Object.entries(names)) {
          const row = (await trx(sql).count({ count: '*' }).first()) as { count: number } | undefined
          if (row === undefined || !Number.isSafeInteger(row.count) || row.count < 1 || row.count > 2)
            throw new Error('Independent complete native archive table preimage differs')
          result[table as WalletSnapshotTable] = row.count
        }
        return result
      })
      await verifyNativeConcurrentSnapshotSource(storage, {
        sourceStorage: storage.getSettings(),
        user,
        counts,
        requestId: requests[0].provenTxReqId,
        originalHistory,
        changedHistory,
        syncStateId: states[0].syncStateId,
        originalSyncMap: states[0].syncMap,
        expiresAt: Math.min(fixture.expiresAt, Date.now() + 120000)
      })
      const current = await storage.findProvenTxReqs({ partial: { provenTxReqId: requests[0].provenTxReqId } })
      expect(current).toHaveLength(1)
      expect(current[0].history).toBe(changedHistory)
    }, nativeTestExecutable())
  },
  nativeFixtureCaseTimeoutMs
)

test(
  'actual DELETE publication reaches WAL snapshot admission only through its original profile',
  async () => {
    let observed = false
    const fixture = await composedNativeFixture(
      nativeTestExecutable(),
      undefined,
      180000,
      undefined,
      async (profile, manager, expiresAt) => {
        await verifyPublishedNativeSnapshotLifecycle(profile, manager, Math.min(expiresAt, Date.now() + 60000))
        observed = true
      }
    )
    let failed = false,
      failure: unknown
    const cleanupScope1 = new Brc38CleanupScope(async () => {
      try {
        await fixture.close()
      } catch (cause) {
        throw new AggregateError(
          failed ? [failure, cause] : [cause],
          'Native lifecycle contract retains original cleanup owners'
        )
      }
    })
    try {
      expect(observed).toBe(true)
      expect(fixture.storage.getSnapshotSync()).toBeDefined()
      expect(fixture.manager.getActive()).toBe(fixture.storage)
    } catch (cause) {
      failed = true
      failure = cause
      {
        await cleanupScope1.close()
        throw cause
      }
    } finally {
      await cleanupScope1.close()
    }
  },
  nativeFixtureCaseTimeoutMs
)

test(
  'actual native field metadata and packed hash windows preserve independent large bytes',
  async () => {
    const history = JSON.stringify({
        notes: [{ when: '2026-10-08T00:00:00.000Z', what: 'independent native window', detail: 'x'.repeat(70000) }]
      }),
      fixture = await composedNativeFixture(
        nativeTestExecutable(),
        (source, incoming) => {
          for (const document of [source, incoming]) document.tables.provenTxReqs[0].history = JSON.parse(history)
        },
        nativeLargeRecordFixtureLifetimeMs,
        snapshotMeasurementCases[2]
      )
    let reader: ReturnType<typeof createOwnedNativeReadDatabase> | undefined
    let failed = false,
      failure: unknown
    const cleanupScope2 = new Brc38CleanupScope(async () => {
      // Keep the original native reader on the dependency stack if close fails.
      if (reader !== undefined) fixture.retainCleanup(async () => await reader!.destroy())
      try {
        await fixture.close()
      } catch (cause) {
        throw new AggregateError(
          failed ? [failure, cause] : [cause],
          'Native window contract retains original cleanup owners'
        )
      }
    })
    try {
      const user = fixture.manager.getActiveUser(),
        identityKey = user.identityKey,
        [transaction] = await fixture.storage.findTransactions({ partial: { userId: user.userId }, noRawTx: true }),
        [request] = await fixture.storage.findProvenTxReqs({ partial: { txid: fixture.proof.txid.toUpperCase() } }),
        rawTx = new Uint8Array(fixture.proof.tx.toBinary()),
        expiresAt = Math.min(fixture.expiresAt, Date.now() + 60000)
      expect(transaction).toBeDefined()
      expect(request).toBeDefined()
      // Re-seed through the genuine current writer with an independently authored
      // complete JSON value. The expected bytes never come from source descriptors.
      await fixture.storage.updateProvenTxReq(request.provenTxReqId, { history })
      await verifyNativeSnapshotFieldMetadataAndExactWindows(fixture.storage, {
        identityKey,
        transactionId: transaction.transactionId,
        provenTxReqId: request.provenTxReqId,
        rawTx,
        history,
        expiresAt
      })
      reader = createOwnedNativeReadDatabase(fixture.storage.knex)
      await reader.transaction(async trx => {
        const check = () => {
          if (Date.now() >= expiresAt) throw new Error('Native hash case exceeded its original lifetime')
        }
        await verifyNativePackedHashWindowOracle(
          trx,
          { family: 'binary', coordinate: { table: 'transactions', field: 'rawTx', rowId: transaction.transactionId } },
          rawTx,
          check
        )
        await verifyNativePackedHashWindowOracle(
          trx,
          { family: 'text', coordinate: { table: 'provenTxReqs', field: 'history', rowId: request.provenTxReqId } },
          new TextEncoder().encode(history),
          check
        )
      })
    } catch (cause) {
      failed = true
      failure = cause
      {
        await cleanupScope2.close()
        throw cause
      }
    } finally {
      await cleanupScope2.close()
    }
  },
  nativeLargeRecordFixtureLifetimeMs + 30000
)

test(
  'all seventeen native scalar TEXT fields use exact bounded source windows',
  async () => {
    const fixtures: readonly NativePayloadTextSourceCase[] = [
      {
        table: 'transactions',
        field: 'description',
        match: { reference: 'archive-ref' },
        value: 'independent transaction 雪'
      },
      {
        table: 'transactions',
        field: 'noSendExpiryReclaimDerivationPrefix',
        match: { reference: 'archive-ref' },
        value: 'AQID'
      },
      {
        table: 'transactions',
        field: 'noSendExpiryReclaimDerivationSuffix',
        match: { reference: 'archive-ref' },
        value: 'BAUG'
      },
      { table: 'outputs', field: 'outputDescription', match: { vout: 0 }, value: 'independent output 雪' },
      { table: 'outputs', field: 'spendingDescription', match: { vout: 0 }, value: 'independent spending' },
      {
        table: 'outputs',
        field: 'customInstructions',
        match: { vout: 0 },
        value: 'independent \u0000 instructions 😀'
      },
      { table: 'outputs', field: 'derivationPrefix', match: { vout: 0 }, value: 'AQID' },
      { table: 'outputs', field: 'derivationSuffix', match: { vout: 0 }, value: 'BAUG' },
      { table: 'outputs', field: 'type', match: { vout: 0 }, value: 'P2PKH' },
      { table: 'outputs', field: 'purpose', match: { vout: 0 }, value: 'change' },
      { table: 'commissions', field: 'keyOffset', match: { satoshis: 1 }, value: 'independent offset' },
      { table: 'certificates', field: 'subject', match: { serialNumber: 'serial' }, value: 'subject' },
      { table: 'certificates', field: 'revocationOutpoint', match: { serialNumber: 'serial' }, value: 'outpoint' },
      { table: 'certificates', field: 'signature', match: { serialNumber: 'serial' }, value: 'signature' },
      { table: 'certificates', field: 'verifier', match: { serialNumber: 'serial' }, value: 'verifier' },
      { table: 'certificateFields', field: 'fieldValue', match: { fieldName: 'name' }, value: 'independent field 雪' },
      { table: 'certificateFields', field: 'masterKey', match: { fieldName: 'name' }, value: 'independent master key' }
    ]
    await withComposedNativeFixture(
      async fixture => {
        await verifyNativePayloadTextSource(
          fixture.storage,
          fixture.manager.getActiveUser().identityKey,
          fixtures,
          Math.min(fixture.expiresAt, Date.now() + 120000)
        )
      },
      nativeTestExecutable(),
      (source, incoming) => {
        for (const document of [source, incoming])
          for (const fixture of fixtures) {
            const rows = document.tables[fixture.table]
            expect(rows).toHaveLength(1)
            Reflect.set(rows[0], fixture.field, fixture.value)
          }
      }
    )
  },
  nativeFixtureCaseTimeoutMs
)

test('native portable measurement keeps foreground capacity while its dedicated export reader is retained', async () => {
  let borrowed: ReturnType<typeof createOwnedNativeReadDatabase> | undefined
  await withComposedNativeFixture(
    async fixture => {
      const storage = fixture.storage,
        user = fixture.manager.getActiveUser(),
        originalMaximum = storage.knex.client.config.pool?.max,
        reader = await fixture.openPortableReader(storage)
      borrowed = reader.knex
      expect(originalMaximum).toBe(1)
      expect(reader.knex).not.toBe(storage.knex)
      expect(ownedNativeRootIdentity(reader.knex)?.slot).toBe(3)
      expect(ownedNativeRootIdentity(reader.knex)?.token).toBe(ownedNativeRootIdentity(storage.knex)?.token)
      await expect(fixture.openPortableReader(Object.create(storage))).rejects.toThrow('current fixture provider')
      const source = await openBrc38KnexSource(reader, user.identityKey, {
        lifetimeMs: Math.min(60000, fixture.expiresAt - Date.now()),
        maximumPageRows: 8,
        maximumPageBytes: 1048576,
        maximumRowAllocationBytes: 1048576,
        maximumCertificateGroupBytes: 1048576
      })
      fixture.retainCleanup(async () => await source.release())
      const labels = await fixture.manager.runAsReader(async active => {
        if (active !== storage) throw new Error('Portable foreground reader changed its current provider')
        return await storage.findTxLabels({ partial: { userId: user.userId }, paged: { limit: 1, offset: 0 } })
      })
      expect(labels.length).toBeGreaterThan(0)
      const name = 'independent retained portable foreground basket',
        basket = await fixture.manager.runAsWriter(async active => {
          if (active !== storage) throw new Error('Portable foreground writer changed its current provider')
          return await storage.findOrInsertOutputBasket(user.userId, name)
        })
      expect(basket.basketId).toBeGreaterThan(0)
      const captured = []
      for await (const row of source.rows('outputBaskets')) captured.push(row)
      expect(captured.length).toBeGreaterThan(0)
      expect(captured.some(row => row.name === name)).toBe(false)
      expect(storage.knex.client.config.pool?.max).toBe(originalMaximum)
      await source.release()
    },
    nativeTestExecutable(),
    undefined,
    360000
  )
  expect(borrowed).toBeDefined()
  expect(ownedNativeRootIdentity(borrowed!)).toBeUndefined()
}, 390000)
