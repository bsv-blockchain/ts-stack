import { verifyNativeSnapshotFieldArtifactCache } from '../../../test/utils/snapshotJournalFieldNativeCache'
import { preparePackedNativeSnapshotJournalField } from './preparePackedNativeSnapshotFieldNode'
import { readSnapshotJournalCaptureConfiguration } from './journal/SnapshotJournalLifecycle'
import { snapshotJournalRevision } from './journal/SnapshotJournalRevision'
import { nativeTestExecutable } from '../portable/Brc38NativeTestPath'
import { composedNativeFixture } from '../portable/Brc38ComposedNativeFixture'
import { restoreProofFixture } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import { KnexSnapshotSyncDestination } from './KnexSnapshotSyncDestination'
import { snapshotSyncTables, type SnapshotSyncTable, type SnapshotSyncCheckpoint } from './SnapshotSync'
import type { WalletReadSnapshot } from './WalletReadSnapshot'
import type { BRC38WalletData } from '../portable/index'
import { verifyNativeScalarFieldSession } from './KnexSnapshotSyncNativeScalarNode.case'
import {
  verifyNativeSnapshotSyncProvenTxs,
  verifyNativeSnapshotSyncProofStaleCurrent,
  verifyNativeSnapshotSyncProofRejectedReplacement
} from './NativeSnapshotSyncProvenTxsNode.case'
import {
  verifyNativeSnapshotSyncActions,
  verifyNativeSnapshotSyncOutputStaleParent,
  verifyNativeSnapshotSyncReclaimQuarantine
} from './NativeSnapshotSyncActionsNode.case'
import {
  verifyNativeSimplePayloadSession,
  verifyNativeSimplePayloadStaleCurrent
} from './NativeSnapshotSyncSimplePayloadNode.case'
import {
  verifyNativeSnapshotSyncProvenTxReqs,
  verifyNativeSnapshotSyncRequestStale
} from './NativeSnapshotSyncProvenTxReqsNode.case'
import { verifyPackedNativeSnapshotField } from './preparePackedNativeSnapshotFieldNode.case'

// The complete request case passed in 566s without coverage; the covered case
// expired after 621s before completing. Give these two full-profile fixtures
// an initial twelve-minute lifetime, with the existing minute for cleanup.
// This measured harness allowance changes no production lifetime or resource
// default. Real UTC/monotonic expiry is checked throughout and never renewed.
const pairLifetimeMilliseconds = 720000
const pairCaseMilliseconds = pairLifetimeMilliseconds + 60000

type NativeFixture = Awaited<ReturnType<typeof composedNativeFixture>>
type Pair = Readonly<{
  origin: NativeFixture
  target: NativeFixture
  source: WalletReadSnapshot
  destination: KnexSnapshotSyncDestination
  checkpoint: SnapshotSyncCheckpoint
  proof: ReturnType<typeof restoreProofFixture>
}>

/** Two genuine independently published profiles. Every predecessor page
 * commits through the real session before the selected component runs. Whole
 * expected occupied rows are captured through the separate public DTO reader
 * before preparation; authored payload/proof values independently check them.
 * No copied source, installed flag or fabricated mapping admits this fixture.
 * Scoped case results do not qualify the complete original case union. */
async function withPair(
  table: SnapshotSyncTable | 'packed-field',
  work: (pair: Pair) => Promise<void>,
  beforeSourceView?: (origin: NativeFixture) => Promise<void>,
  beforeTargetView?: (target: NativeFixture) => Promise<void>
): Promise<void> {
  const proof = restoreProofFixture(131073),
    rawTx = Buffer.from(proof.tx.toBinary()).toString('base64'),
    script = Buffer.from(proof.tx.outputs[0].lockingScript.toBinary()).toString('base64'),
    large = 'independent\u0000雪😀'.repeat(5000),
    customize =
      (destination: boolean) =>
      (source: BRC38WalletData, incoming: BRC38WalletData): void => {
        for (const data of [source, incoming]) {
          data.tables.transactions[0].rawTx = data.tables.provenTxReqs[0].rawTx = rawTx
          // Exact same occupied values exercise no-change retention, including
          // unknown structured members. Large cell selection stays bounded.
          if (table === 'transactions') data.tables.transactions[0].description = large
          if (table === 'outputs' || table === 'packed-field') {
            if (destination && table === 'packed-field') delete data.tables.outputs[0].lockingScript
            else data.tables.outputs[0].lockingScript = script
          }
          if (table === 'certificates') data.tables.certificates[0].subject = large
          if (table === 'certificateFields') data.tables.certificateFields[0].fieldValue = large
          if (table === 'commissions') data.tables.commissions[0].keyOffset = large
          if (table === 'provenTxReqs') data.tables.provenTxReqs[0].history = { notes: [], independent: large }
        }
      },
    closes: Array<() => Promise<void>> = []
  let failed = false,
    failure: unknown
  try {
    const origin = await composedNativeFixture(
      nativeTestExecutable(),
      customize(false),
      pairLifetimeMilliseconds,
      undefined,
      undefined,
      undefined,
      { targetStorageIdentityKey: 'independent-native-source', proofBytes: 131073 }
    )
    closes.push(async () => await origin.close())
    const target = await composedNativeFixture(
      nativeTestExecutable(),
      customize(true),
      pairLifetimeMilliseconds,
      undefined,
      undefined,
      undefined,
      { targetStorageIdentityKey: 'independent-native-destination', proofBytes: 131073 }
    )
    closes.push(async () => await target.close())
    await beforeTargetView?.(target)
    await beforeSourceView?.(origin)
    origin.check()
    target.check()
    const capability = origin.storage.getSnapshotSync()
    if (capability === undefined) throw new Error('Actual source profile has no current native snapshot capability')
    // Use only the remaining original profile lifetime; never renew either
    // profile or impose an unrelated two-minute view window on late tables.
    const source = await capability.openSource(origin.manager.getActiveUser().identityKey, {
      lifetimeMs: Math.min(pairLifetimeMilliseconds, origin.expiresAt - Date.now(), target.expiresAt - Date.now())
    })
    if (source === undefined || source.fieldReader === undefined)
      throw new Error('Actual source profile did not retain its native field view')
    closes.push(async () => await source.close())
    const destination = new KnexSnapshotSyncDestination(target.storage, async () => {
      throw new Error('Native field session unexpectedly entered legacy whole-proof preparation')
    })
    let checkpoint = await destination.begin(source, target.manager.getActiveStore()),
      operations = 0
    const selected = snapshotSyncTables.indexOf(table === 'packed-field' ? 'outputs' : table)
    while (checkpoint.tableIndex < selected && operations++ < 128) {
      origin.check()
      target.check()
      const page = await source.fieldReader.readMetadataPage(
          snapshotSyncTables[checkpoint.tableIndex],
          checkpoint.cursor,
          { maxRows: 2, maxBytes: 32768 }
        ),
        prepared = await destination.prepareNativeFields(checkpoint, page, source)
      try {
        checkpoint = (await prepared.apply()).checkpoint
      } finally {
        await prepared.close()
      }
    }
    if (checkpoint.tableIndex !== selected)
      throw new Error('Native pair did not reach its actual selected session table')
    await work({ origin, target, source, destination, checkpoint, proof })
    expect(origin.merge.workingAllocation.used).toBe(0)
    expect(target.merge.workingAllocation.used).toBe(0)
    origin.check()
    target.check()
  } catch (cause) {
    failed = true
    failure = cause
  }
  try {
    while (closes.length !== 0) {
      await closes[closes.length - 1]()
      closes.pop()
    }
  } catch (cause) {
    throw new AggregateError(
      failed ? [failure, cause] : [cause],
      'Native pair retains its source and original profile cleanup'
    )
  }
  if (failed) throw failure
}

test(
  'actual native proof session retains independently constructed multichunk transaction and Merkle bytes',
  async () => {
    await withPair('provenTxs', async ({ target, source, checkpoint, proof }) => {
      const expected = await target.storage.findProvenTxs({ partial: { txid: proof.txid.toUpperCase() } })
      expect(expected).toHaveLength(1)
      expect(Buffer.from(expected[0].rawTx)).toEqual(Buffer.from(proof.tx.toBinary()))
      expect(Buffer.from(expected[0].merklePath)).toEqual(Buffer.from(proof.path.toBinary()))
      expect(await target.storage.findProvenTxs({ partial: {} })).toHaveLength(expected.length)
      await verifyNativeSnapshotSyncProvenTxs(target.storage, source, checkpoint, expected, false)
      expect(await target.storage.findProvenTxs({ partial: {} })).toHaveLength(expected.length)
    })
  },
  pairCaseMilliseconds
)

test(
  'actual native target-winner merge quarantines separate previously spendable reclaim liquidity',
  async () => {
    const reclaim = restoreProofFixture(32768),
      when = new Date('2026-10-08T00:00:00.000Z')
    await withPair(
      'transactions',
      async ({ target, source, checkpoint }) => {
        const userId = target.manager.getActiveUser().userId,
          current = await target.storage.findTransactions({ partial: { userId }, noRawTx: false }),
          original = current.find(row => row.reference === 'archive-ref'),
          collateral = current.find(row => row.txid === reclaim.txid)
        if (original === undefined || collateral === undefined || current.length !== 2)
          throw new Error('Independent target-winner fixture graph differs')
        expect(original.noSendExpiryState).toBe('reclaimed')
        expect(original.updated_at.getTime()).toBe(when.getTime())
        const before = await target.storage.findOutputs({ partial: { userId, txid: reclaim.txid, vout: 0 } })
        expect(before).toHaveLength(1)
        expect(before[0].spendable).toBe(true)
        const quarantineStarted = Date.now()
        // Independently stated lifecycle postimage: older incoming winner records a
        // target winner, retains newer local payloads/date and preserves collateral
        // transaction metadata. The separately read output must become unspendable.
        await verifyNativeSnapshotSyncActions(target.storage, source, checkpoint, {
          table: 'transactions',
          expected: [{ ...original, noSendExpiryState: 'target-won' }, collateral]
        })
        await verifyNativeSnapshotSyncReclaimQuarantine(target.storage, userId, reclaim.txid)
        const after = await target.storage.findOutputs({ partial: { userId, outputId: before[0].outputId } })
        expect(after).toHaveLength(1)
        expect(after[0].updated_at.getTime()).toBeGreaterThanOrEqual(quarantineStarted)
        expect(after[0].updated_at.getTime()).toBeLessThanOrEqual(Date.now())
        expect({ ...after[0], spendable: true, updated_at: before[0].updated_at }).toEqual(before[0])
      },
      async origin => {
        await origin.manager.runAsStorageProvider(async active => {
          expect(active).toBe(origin.storage)
          const rows = await origin.storage.findTransactions({
            partial: {
              userId: origin.manager.getActiveUser().userId,
              reference: 'archive-ref'
            }
          })
          expect(rows).toHaveLength(1)
          // Keep the original older timestamp: the lifecycle transition, rather
          // than a newer payload, must cause this occupied merge.
          expect(
            await origin.storage.updateTransaction(rows[0].transactionId, {
              noSendExpiryState: 'target-won',
              updated_at: rows[0].updated_at
            })
          ).toBe(1)
        })
      },
      async target => {
        await target.manager.runAsStorageProvider(async active => {
          expect(active).toBe(target.storage)
          const userId = target.manager.getActiveUser().userId,
            rows = await target.storage.findTransactions({ partial: { userId, reference: 'archive-ref' } })
          expect(rows).toHaveLength(1)
          expect(
            await target.storage.updateTransaction(rows[0].transactionId, {
              noSendExpiryState: 'reclaimed',
              noSendExpiryReclaimTxid: reclaim.txid,
              noSendExpiryReclaimRawTx: reclaim.tx.toBinary(),
              updated_at: when
            })
          ).toBe(1)
          const transactionId = await target.storage.insertTransaction({
            transactionId: 0,
            userId,
            created_at: when,
            updated_at: when,
            status: 'completed',
            reference: 'aW5kZXBlbmRlbnQtcmVjbGFpbQ==',
            isOutgoing: false,
            satoshis: 1,
            description: 'independent synthetic reclaim collateral',
            txid: reclaim.txid,
            rawTx: reclaim.tx.toBinary()
          })
          await target.storage.insertOutput({
            outputId: 0,
            userId,
            transactionId,
            created_at: when,
            updated_at: when,
            spendable: true,
            change: false,
            outputDescription: 'independent synthetic reclaim output',
            vout: 0,
            satoshis: 1,
            providedBy: 'you',
            purpose: 'fixture',
            type: 'P2PKH',
            txid: reclaim.txid,
            lockingScript: reclaim.tx.outputs[0].lockingScript.toBinary()
          })
        })
      }
    )
  },
  pairCaseMilliseconds
)

test(
  'actual occupied native proof refuses an invalid current header before destination or ACK mutation',
  async () => {
    await withPair(
      'provenTxs',
      async ({ target, source, checkpoint, proof }) => {
        const expected = await target.storage.findProvenTxs({ partial: { txid: proof.txid.toUpperCase() } })
        expect(expected).toHaveLength(1)
        expect(Buffer.from(expected[0].rawTx)).toEqual(Buffer.from(proof.tx.toBinary()))
        expect(Buffer.from(expected[0].merklePath)).toEqual(Buffer.from(proof.path.toBinary()))
        await verifyNativeSnapshotSyncProofRejectedReplacement(target.storage, source, checkpoint, expected[0])
      },
      async origin => {
        // Change only this genuine synthetic profile after successful restoration.
        // Its current view is issued normally; no source/descriptor/service mock
        // grants admission to these deliberately invalid replacement proof bytes.
        await origin.manager.runAsStorageProvider(async active => {
          expect(active).toBe(origin.storage)
          const rows = await origin.storage.findProvenTxs({ partial: { txid: origin.proof.txid.toUpperCase() } })
          expect(rows).toHaveLength(1)
          expect(
            await origin.storage.updateProvenTx(rows[0].provenTxId, {
              blockHash: '0'.repeat(64),
              updated_at: new Date('2026-10-08T00:00:01.000Z')
            })
          ).toBe(1)
        })
      }
    )
  },
  pairCaseMilliseconds
)

test(
  'actual native scalar session preserves original occupied basket policy and one-use durable ACK',
  async () => {
    await withPair('outputBaskets', async ({ target, source, destination, checkpoint }) => {
      const expectedBaskets = await target.storage.findOutputBaskets({
        partial: { userId: target.manager.getActiveUser().userId }
      })
      expect(expectedBaskets).toHaveLength(1)
      expect(expectedBaskets[0].numberOfDesiredUTXOs).toBe(32)
      expect(expectedBaskets[0].minimumDesiredUTXOValue).toBe(1000)
      if (source.fieldReader === undefined) throw new Error('Actual source field reader is unavailable')
      const page = await source.fieldReader.readMetadataPage('outputBaskets', checkpoint.cursor, {
          maxRows: 2,
          maxBytes: 32768
        }),
        now = Date.now.bind(Date),
        marker = 'independent-native-expired-page'
      let expired = false
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => (expired ? source.expiresAt : now())),
        expireAfterCheckpoint = (_response: unknown, query: { sql: string }): void => {
          if (query.sql.startsWith('update `snapshot_sync_sessions` set ')) expired = true
        }
      target.storage.knex.on('query-response', expireAfterCheckpoint)
      try {
        await expect(
          destination.commitNativeFieldPage(checkpoint, page, undefined, async writer => {
            expect(
              await target.storage.insertOutputBasket(
                {
                  userId: writer.user.userId,
                  name: marker,
                  created_at: new Date(0),
                  updated_at: new Date(0),
                  numberOfDesiredUTXOs: 0,
                  minimumDesiredUTXOValue: 0,
                  isDeleted: false
                },
                writer.transaction
              )
            ).toBeGreaterThan(0)
            return { inserts: 1, updates: 0 }
          })
        ).rejects.toThrow('Snapshot source expired before destination commit completion')
      } finally {
        target.storage.knex.removeListener('query-response', expireAfterCheckpoint)
        clock.mockRestore()
      }
      expect(expired).toBe(true)
      expect(await destination.checkpoint(checkpoint.identityKey, checkpoint.sourceStorageIdentityKey)).toEqual(
        checkpoint
      )
      expect(await target.storage.findOutputBaskets({ partial: { name: marker } })).toHaveLength(0)
      expect(
        await target.storage.findOutputBaskets({ partial: { userId: target.manager.getActiveUser().userId } })
      ).toEqual(expectedBaskets)
      await verifyNativeScalarFieldSession({ storage: target.storage, source, checkpoint, expectedBaskets })
    })
  },
  pairCaseMilliseconds
)

test.each(['transactions', 'outputs'] as const)(
  'actual native %s session retains complete occupied action fields',
  async table => {
    await withPair(table, async ({ target, source, checkpoint, proof }) => {
      const userId = target.manager.getActiveUser().userId
      if (table === 'transactions') {
        const expected = await target.storage.findTransactions({ partial: { userId }, noRawTx: false })
        expect(expected).toHaveLength(1)
        expect(Buffer.from(expected[0].rawTx!)).toEqual(Buffer.from(proof.tx.toBinary()))
        expect(expected[0].description).toBe('independent\u0000雪😀'.repeat(5000))
        await verifyNativeSnapshotSyncActions(target.storage, source, checkpoint, { table, expected })
      } else {
        const expected = await target.storage.findOutputs({ partial: { userId } })
        expect(expected).toHaveLength(1)
        expect(Buffer.from(expected[0].lockingScript!)).toEqual(
          Buffer.from(proof.tx.outputs[0].lockingScript.toBinary())
        )
        await verifyNativeSnapshotSyncActions(target.storage, source, checkpoint, { table, expected })
      }
    })
  },
  pairCaseMilliseconds
)

test.each(['certificates', 'certificateFields', 'commissions'] as const)(
  'actual native %s session retains full large logical payloads and parent mappings',
  async table => {
    await withPair(table, async ({ target, source, checkpoint }) => {
      const userId = target.manager.getActiveUser().userId,
        large = 'independent\u0000雪😀'.repeat(5000)
      if (table === 'certificates') {
        const expected = await target.storage.findCertificates({ partial: { userId } })
        expect(expected).toHaveLength(1)
        expect(expected[0].subject).toBe(large)
        await verifyNativeSimplePayloadSession(target.storage, source, checkpoint, { table, expected })
      } else if (table === 'certificateFields') {
        const expected = await target.storage.findCertificateFields({ partial: { userId } })
        expect(expected).toHaveLength(1)
        expect(expected[0].fieldValue).toBe(large)
        await verifyNativeSimplePayloadSession(target.storage, source, checkpoint, { table, expected })
      } else {
        const expected = await target.storage.findCommissions({ partial: { userId } })
        expect(expected).toHaveLength(1)
        expect(expected[0].keyOffset).toBe(large)
        await verifyNativeSimplePayloadSession(target.storage, source, checkpoint, { table, expected })
      }
    })
  },
  pairCaseMilliseconds
)

test(
  'actual native request session retains full history, proof, notify and atomic completion',
  async () => {
    await withPair('provenTxReqs', async ({ target, source, checkpoint, proof }) => {
      const expected = await target.storage.findProvenTxReqs({ partial: { txid: proof.txid.toUpperCase() } })
      expect(expected).toHaveLength(1)
      expect(JSON.parse(expected[0].history)).toEqual({ notes: [], independent: 'independent\u0000雪😀'.repeat(5000) })
      expect(Buffer.from(expected[0].rawTx)).toEqual(Buffer.from(proof.tx.toBinary()))
      await verifyNativeSnapshotSyncProvenTxReqs(target.storage, source, checkpoint, expected, 0)
    })
  },
  pairCaseMilliseconds
)

test(
  'actual retained source stages multichunk bytes into a fresh native pointer with rollback and content reuse',
  async () => {
    await withPair('packed-field', async ({ target, source, checkpoint, proof }) => {
      const rows = await target.storage.findOutputs({ partial: { userId: target.manager.getActiveUser().userId } }),
        page = await source.fieldReader!.readMetadataPage('outputs', checkpoint.cursor, {
          maxRows: 1,
          maxBytes: 32768
        }),
        expected = Uint8Array.from(proof.tx.outputs[0].lockingScript.toBinary())
      expect(rows).toHaveLength(1)
      expect(rows[0].lockingScript == null).toBe(true)
      expect(page.rows).toHaveLength(1)
      try {
        await verifyPackedNativeSnapshotField({
          storage: target.storage,
          source,
          cursor: page.rows[0].cursor,
          descriptor: page.rows[0].extents.lockingScript,
          targetRowId: rows[0].outputId,
          expected,
          expiresAt: Math.min(source.expiresAt, target.expiresAt)
        })
      } finally {
        expected.fill(0)
      }
    })
  },
  pairCaseMilliseconds
)

test(
  'a real occupied proof update invalidates previously prepared native effects',
  async () => {
    await withPair('provenTxs', async ({ target, source, checkpoint, proof }) => {
      const rows = await target.storage.findProvenTxs({ partial: { txid: proof.txid.toUpperCase() } })
      expect(rows).toHaveLength(1)
      await verifyNativeSnapshotSyncProofStaleCurrent(target.storage, source, checkpoint, {
        ...rows[0],
        updated_at: new Date(rows[0].updated_at.getTime() + 1000)
      })
    })
  },
  pairCaseMilliseconds
)

test(
  'a real mapped-parent update invalidates prepared native output effects',
  async () => {
    await withPair('outputs', async ({ target, source, checkpoint }) => {
      const rows = await target.storage.findTransactions({
        partial: { userId: target.manager.getActiveUser().userId },
        noRawTx: true
      })
      expect(rows).toHaveLength(1)
      await verifyNativeSnapshotSyncOutputStaleParent(target.storage, source, checkpoint, rows[0])
    })
  },
  pairCaseMilliseconds
)

test.each(['certificates', 'certificateFields', 'commissions'] as const)(
  'a real occupied %s update refuses the old prepared payload and ACK',
  async table => {
    await withPair(table, async ({ target, source, checkpoint }) => {
      const userId = target.manager.getActiveUser().userId
      if (table === 'certificates') {
        const rows = await target.storage.findCertificates({ partial: { userId } })
        expect(rows).toHaveLength(1)
        await verifyNativeSimplePayloadStaleCurrent(target.storage, source, checkpoint, { table, row: rows[0] })
      } else if (table === 'certificateFields') {
        const rows = await target.storage.findCertificateFields({ partial: { userId } })
        expect(rows).toHaveLength(1)
        await verifyNativeSimplePayloadStaleCurrent(target.storage, source, checkpoint, { table, row: rows[0] })
      } else {
        const rows = await target.storage.findCommissions({ partial: { userId } })
        expect(rows).toHaveLength(1)
        await verifyNativeSimplePayloadStaleCurrent(target.storage, source, checkpoint, { table, row: rows[0] })
      }
    })
  },
  pairCaseMilliseconds
)

test.each(['request', 'transaction'] as const)(
  'a real current %s update invalidates prepared native request effects',
  async kind => {
    await withPair('provenTxReqs', async ({ target, source, checkpoint, proof }) => {
      if (kind === 'request') {
        const rows = await target.storage.findProvenTxReqs({ partial: { txid: proof.txid.toUpperCase() } })
        expect(rows).toHaveLength(1)
        await verifyNativeSnapshotSyncRequestStale(target.storage, source, checkpoint, { kind, row: rows[0] })
      } else {
        const rows = await target.storage.findTransactions({
          partial: { userId: target.manager.getActiveUser().userId },
          noRawTx: true
        })
        expect(rows).toHaveLength(1)
        await verifyNativeSnapshotSyncRequestStale(target.storage, source, checkpoint, { kind, row: rows[0] })
      }
    })
  },
  pairCaseMilliseconds
)

// This case requires the genuine pinned native runtime. Typechecking it is not
// evidence that packed source/pointer/reuse behavior has executed successfully.
test(
  'actual journal fields stage verified native bytes with rollback, consumed actors and content reuse',
  async () => {
    await withPair('packed-field', async ({ origin, target, source, checkpoint, proof }) => {
      const rows = await target.storage.findOutputs({ partial: { userId: target.manager.getActiveUser().userId } }),
        page = await source.fieldReader!.readMetadataPage('outputs', checkpoint.cursor, {
          maxRows: 1,
          maxBytes: 32768
        }),
        expected = Uint8Array.from(proof.tx.outputs[0].lockingScript.toBinary())
      expect(rows).toHaveLength(1)
      expect(page.rows).toHaveLength(1)
      expect(rows[0].lockingScript == null).toBe(true)
      // Drain the original source before reusing this provider's one source slot.
      await source.close()
      const configuration = await readSnapshotJournalCaptureConfiguration(origin.storage.knex),
        journal = await origin.storage.openSnapshotJournalSource(
          origin.manager.getActiveUser().identityKey,
          configuration,
          {
            lifetimeMs: Math.min(origin.expiresAt, target.expiresAt) - Date.now()
          }
        )
      try {
        const request = {
            bootstrap: true as const,
            stream: 'scope' as const,
            tableId: 1,
            low: snapshotJournalRevision('0'),
            maximumRows: 2,
            maximumBytes: 32768
          },
          reader = journal.fieldDeltaReader
        if (reader === undefined) throw new Error('Actual native journal did not issue its field reader')
        const metadata = await reader.readPage(request),
          selected = metadata.changes.find(
            change => change.present && change.metadata.id1 === page.rows[0].fields.outputId
          )
        if (selected === undefined || !selected.present) throw new Error('Actual native journal output is missing')
        expect(selected.row).not.toHaveProperty('lockingScript')
        expect(selected.fields.lockingScript.bytes).toBe(expected.length)
        await verifyPackedNativeSnapshotField({
          storage: target.storage,
          source,
          cursor: page.rows[0].cursor,
          descriptor: page.rows[0].extents.lockingScript,
          targetRowId: rows[0].outputId,
          expected,
          expiresAt: Math.min(journal.expiresAt, target.expiresAt),
          prepare: async policy =>
            await preparePackedNativeSnapshotJournalField(
              target.storage,
              journal,
              request,
              selected.metadata,
              'lockingScript',
              selected.fields.lockingScript,
              policy
            )
        })
      } finally {
        expected.fill(0)
        await journal.close()
        await journal.closed
      }
    })
  },
  pairCaseMilliseconds
)

// Both real profiles retain their original full functional setup and limits.
test(
  'actual authenticated field archive reuses freshly verified native content without downloading it again',
  async () => {
    await withPair('packed-field', async ({ target, source, proof }) => {
      const rows = await target.storage.findOutputs({ partial: { userId: target.manager.getActiveUser().userId } }),
        expected = Uint8Array.from(proof.tx.outputs[0].lockingScript.toBinary())
      try {
        expect(rows).toHaveLength(1)
        await source.close()
        await verifyNativeSnapshotFieldArtifactCache({
          storage: target.storage,
          manager: target.manager,
          sourceData: target.sourceData,
          targetRowId: rows[0].outputId,
          expected,
          expiresAt: target.expiresAt
        })
      } finally {
        expected.fill(0)
      }
    })
  },
  pairCaseMilliseconds
)
