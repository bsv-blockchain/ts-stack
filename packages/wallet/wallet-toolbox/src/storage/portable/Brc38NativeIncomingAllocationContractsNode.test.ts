import {
  withBrc38NativeCandidateContractFixture,
  type Brc38NativeCandidateContractFixture
} from './Brc38NativeCandidateContractFixture'
import { verifyBrc38NativeIncomingIdReservations } from './Brc38NativeIncomingIdReservationNode.case'
import { reserveBrc38NativeIncomingIds } from './Brc38NativeIncomingIdReservationNode'
import { verifyReservedPrivatePageIds } from './Brc38PrivatePageIdsNode.case'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import { withComposedFixtureRead } from './Brc38ComposedSemanticFixture'
import { previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { restoreProofFixture } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { doubleSha256BE } from '../../utility/utilityHelpers'

// Original complete copy/allocation reached its 360-second owner under hosted
// coverage. Select two five-minute setup/copy windows once at creation.
// The outer guard adds only 30 seconds for physical cleanup.
const nativeFixtureLifetimeMs = 300000 + 300000
const nativeFixtureCaseTimeoutMs = nativeFixtureLifetimeMs + 30000

// Independent numeric family names and archive counts. Four original merge
// episodes reserve one incoming entity per family; sync additionally reserves
// each episode's operational checkpoint. These numbers never admit a source.
const families = {
    provenTxs: ['proven_txs', 'provenTxId'],
    outputBaskets: ['output_baskets', 'basketId'],
    outputTags: ['output_tags', 'outputTagId'],
    txLabels: ['tx_labels', 'txLabelId'],
    transactions: ['transactions', 'transactionId'],
    outputs: ['outputs', 'outputId'],
    certificates: ['certificates', 'certificateId'],
    commissions: ['commissions', 'commissionId'],
    provenTxReqs: ['proven_tx_reqs', 'provenTxReqId'],
    syncStates: ['sync_states', 'syncStateId']
  } as const,
  counts = {
    provenTxs: 4,
    outputBaskets: 4,
    outputTags: 4,
    txLabels: 4,
    transactions: 4,
    outputs: 4,
    certificates: 4,
    commissions: 4,
    provenTxReqs: 4,
    syncStates: 8
  } as const

async function readCounters(fixture: Brc38NativeCandidateContractFixture): Promise<Readonly<Record<string, number>>> {
  return await withComposedFixtureRead(fixture.source.manager, async trx => {
    const result: Record<string, number> = {}
    for (const [table, [sql, id]] of Object.entries(families)) {
      const sequence = (await trx('sqlite_sequence')
          .where({ name: sql })
          .select(trx.raw('CAST(seq AS TEXT) AS value'), trx.raw('typeof(seq) AS kind'))
          .limit(2)) as Array<{ value: string; kind: string }>,
        rows = (await trx(sql)
          .orderBy(id, 'desc')
          .select(trx.raw('CAST(?? AS TEXT) AS value', [id]))
          .limit(1)) as Array<{ value: string }>
      if (
        sequence.length > 1 ||
        sequence.some(row => row.kind !== 'integer') ||
        [...sequence, ...rows].some(
          row => !/^-?(?:0|[1-9]\d{0,15})$/.test(row.value) || !Number.isSafeInteger(Number(row.value))
        )
      )
        throw new Error('Independent actual source counter differs')
      result[table] = Math.max(0, Number(sequence[0]?.value ?? '0'), Number(rows[0]?.value ?? '0'))
    }
    return result
  })
}

/** Ordinary public StorageKnex insertion APIs on the actual published source
 * writer. Each ID is assigned by AUTOINCREMENT after its durable reservation;
 * no SQL counter, reserved-ID ledger or ownership flags are rewritten. */
async function insertForeground(
  fixture: Brc38NativeCandidateContractFixture
): Promise<Readonly<Record<string, number>>> {
  const source = fixture.source,
    storage = source.storage,
    proof = restoreProofFixture(32768),
    time = new Date('2026-10-08T00:00:00.000Z'),
    times = { created_at: time, updated_at: time },
    userId = source.manager.getActiveUser().userId,
    identityKey = source.manager.getActiveUser().identityKey
  return await source.manager.runAsStorageProvider(async active => {
    if (active !== storage) throw new Error('Independent foreground allocation selected another source')
    return await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(storage, async writer => {
      const provenTxs = await storage.insertProvenTx(
          {
            ...times,
            provenTxId: 0,
            txid: proof.txid,
            height: 100,
            index: 0,
            blockHash: asString(doubleSha256BE(proof.header)),
            merkleRoot: proof.txid,
            rawTx: proof.tx.toBinary(),
            merklePath: proof.path.toBinary()
          },
          writer
        ),
        outputBaskets = await storage.insertOutputBasket(
          {
            ...times,
            basketId: 0,
            userId,
            name: 'independent foreground basket',
            numberOfDesiredUTXOs: 7,
            minimumDesiredUTXOValue: 11,
            isDeleted: false
          },
          writer
        ),
        outputTags = await storage.insertOutputTag(
          { ...times, outputTagId: 0, userId, tag: 'independent foreground tag', isDeleted: false },
          writer
        ),
        txLabels = await storage.insertTxLabel(
          { ...times, txLabelId: 0, userId, label: 'independent foreground label', isDeleted: false },
          writer
        ),
        transactions = await storage.insertTransaction(
          {
            ...times,
            transactionId: 0,
            userId,
            provenTxId: provenTxs,
            status: 'completed',
            reference: 'aW5kZXBlbmRlbnQtZm9yZWdyb3VuZA==',
            isOutgoing: false,
            satoshis: 1,
            description: 'independent foreground transaction',
            txid: proof.txid,
            rawTx: proof.tx.toBinary()
          },
          writer
        ),
        outputs = await storage.insertOutput(
          {
            ...times,
            outputId: 0,
            userId,
            transactionId: transactions,
            basketId: outputBaskets,
            spendable: false,
            change: false,
            outputDescription: 'independent foreground output',
            vout: 0,
            satoshis: 1,
            providedBy: 'you',
            purpose: 'fixture',
            type: 'P2PKH',
            txid: proof.txid,
            lockingScript: proof.tx.outputs[0].lockingScript.toBinary()
          },
          writer
        ),
        certificates = await storage.insertCertificate(
          {
            ...times,
            certificateId: 0,
            userId,
            type: 'aW5kZXBlbmRlbnQ=',
            serialNumber: 'Zm9yZWdyb3VuZA==',
            certifier: identityKey,
            subject: identityKey,
            revocationOutpoint: proof.txid + '.0',
            signature: '00',
            isDeleted: true
          },
          writer
        ),
        commissions = await storage.insertCommission(
          {
            ...times,
            commissionId: 0,
            userId,
            transactionId: transactions,
            satoshis: 0,
            keyOffset: 'independent foreground offset',
            isRedeemed: false,
            lockingScript: [81]
          },
          writer
        ),
        provenTxReqs = await storage.insertProvenTxReq(
          {
            ...times,
            provenTxReqId: 0,
            provenTxId: provenTxs,
            status: 'completed',
            attempts: 0,
            notified: false,
            txid: proof.txid,
            history: '{"notes":[]}',
            notify: '{"transactionIds":[]}',
            rawTx: proof.tx.toBinary()
          },
          writer
        ),
        syncStates = await storage.insertSyncState(
          {
            ...times,
            syncStateId: 0,
            userId,
            storageIdentityKey: 'independent-foreground-peer',
            storageName: 'independent foreground peer',
            status: 'unknown',
            init: false,
            refNum: 'independent-foreground-ref',
            syncMap: '{}'
          },
          writer
        )
      // The inactive certificate is storage data, not signature qualification.
      return {
        provenTxs,
        outputBaskets,
        outputTags,
        txLabels,
        transactions,
        outputs,
        certificates,
        commissions,
        provenTxReqs,
        syncStates
      }
    })
  })
}

test('actual incoming ranges retain deleted-high history, survive retry and exclude ordinary foreground IDs', async () => {
  await withBrc38NativeCandidateContractFixture(
    async fixture => {
      expect((await readCounters(fixture)).outputBaskets).toBe(1600)
      await verifyBrc38NativeIncomingIdReservations(
        {
          storage: fixture.source.storage,
          selection: fixture.selection,
          receiptPolicy: previewReceiptPolicy,
          store: fixture.store,
          working: fixture.options.workingAllocation,
          readCounters: async () => await readCounters(fixture),
          insertForegroundRows: async () => await insertForeground(fixture),
          changePrimaryAwayAndBack: async () => {
            const source = fixture.source,
              userId = source.manager.getActiveUser().userId,
              original = source.manager.getActiveStore()
            await source.manager.runAsStorageProvider(async active => {
              if (active !== source.storage) throw new Error('Primary reservation refusal selected another source')
              await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(source.storage, async writer => {
                expect(
                  await source.storage.updateUser(userId, { activeStorage: 'independent-other-primary' }, writer)
                ).toBe(1)
                expect(await source.storage.updateUser(userId, { activeStorage: original }, writer)).toBe(1)
              })
            })
          },
          check: fixture.check
        },
        counts
      )
    },
    { lifetimeMs: 900000, maximumNativeReadBytes: 16384 }
  )
}, 930000)

test(
  'actual private page allocation consumes genuine source-reserved IDs and rolls back a caught unique violation',
  async () => {
    await withBrc38NativeCandidateContractFixture(
      async fixture => {
        // This expected range follows the authored deleted-high1600 and original
        // four incoming episodes. No reservation result supplies the expectation.
        await reserveBrc38NativeIncomingIds(
          fixture.source.storage,
          fixture.selection,
          previewReceiptPolicy,
          fixture.store,
          { workingAllocation: fixture.options.workingAllocation }
        )
        await fixture.prepareCopied()
        await fixture.withCandidate(async candidate => {
          await candidate.copySequences()
          await candidate.prepareIncomingIds()
        })
        const storage = new StorageKnex({
          ...StorageProvider.createStorageBaseOptions(fixture.source.storage.chain),
          knex: fixture.store.knex,
          snapshotSync: false
        })
        storage.setServices(fixture.options.services)
        const userId = await fixture.withRead(async trx => {
          const rows = await trx('users').select('userId').limit(2)
          if (rows.length !== 1 || !Number.isSafeInteger(Number(rows[0].userId)))
            throw new Error('Actual private allocation user differs')
          return Number(rows[0].userId)
        })
        await verifyReservedPrivatePageIds(
          {
            storage,
            userId,
            expiresAt: fixture.store.limits.expiresAt,
            withRead: fixture.withRead,
            withWriter: fixture.withWriter
          },
          { first: 1601, used: 0, sourceHigh: 1604 }
        )
      },
      { lifetimeMs: nativeFixtureLifetimeMs, maximumNativeReadBytes: 16384 }
    )
  },
  nativeFixtureCaseTimeoutMs
)
