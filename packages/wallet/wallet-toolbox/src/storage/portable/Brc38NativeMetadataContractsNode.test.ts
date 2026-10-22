import {
  withBrc38NativePrivateContractFixture,
  type Brc38NativePrivateContractFixture
} from './Brc38NativePrivateContractFixture'
import { verifyPackedRestoreMetadata, type PackedRestoreMetadataCaseRow } from './Brc38PackedRestoreMetadataNode.case'
import { verifyNativePackedPayloadText, type NativePayloadTextFixture } from './Brc38NativePackedPayloadTextNode.case'
import { verifyBrc38NativeLocalPackedForeground } from './Brc38NativeLocalPackedWalletNode.case'
import { installBrc38NativeLocalPackedLayout } from './Brc38NativeLocalPackedLayoutNode'
import { createHash } from 'node:crypto'

const when = new Date('2026-10-08T00:00:00.000Z'),
  times = { created_at: when, updated_at: when }
async function parents(fixture: Brc38NativePrivateContractFixture) {
  return await fixture.withWriter(async trx => {
    const userId = await fixture.storage.insertUser(
        { userId: 0, ...times, identityKey: 'independent metadata user', activeStorage: 'synthetic target' },
        trx
      ),
      transactionId = await fixture.storage.insertTransaction(
        {
          transactionId: 0,
          userId,
          ...times,
          status: 'nosend',
          reference: 'aW5kZXBlbmRlbnQgcGFyZW50',
          isOutgoing: false,
          satoshis: 0,
          description: 'independent parent transaction'
        },
        trx
      ),
      certificateId = await fixture.storage.insertCertificate(
        {
          certificateId: 0,
          userId,
          ...times,
          type: 'independent-parent-type',
          serialNumber: 'independent-parent-serial',
          certifier: 'parent certifier',
          subject: 'parent subject',
          revocationOutpoint: 'parent outpoint',
          signature: 'parent signature',
          isDeleted: false
        },
        trx
      )
    return { userId, transactionId, certificateId }
  })
}

test('all five actual native binary metadata families retain pointers and roll back occupied updates', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    const { userId, transactionId } = await parents(fixture),
      raw = Uint8Array.from([1, 2, 3, 251]),
      path = Uint8Array.from([4, 5, 6]),
      script = Uint8Array.from([81, 117, 81]),
      cases: readonly PackedRestoreMetadataCaseRow[] = [
        {
          table: 'provenTxs',
          row: {
            provenTxId: 0,
            ...times,
            txid: 'a'.repeat(64),
            height: 1,
            index: 0,
            blockHash: 'b'.repeat(64),
            merkleRoot: 'c'.repeat(64),
            rawTx: [...raw],
            merklePath: [...path]
          },
          binaries: [
            { field: 'rawTx', bytes: raw },
            { field: 'merklePath', bytes: path }
          ]
        },
        {
          table: 'provenTxReqs',
          row: {
            provenTxReqId: 0,
            ...times,
            txid: 'd'.repeat(64),
            status: 'unprocessed',
            attempts: 0,
            notified: false,
            history: '{"notes":[]}',
            notify: '{"transactionIds":[]}',
            rawTx: [...raw]
          },
          binaries: [{ field: 'rawTx', bytes: raw }]
        },
        {
          table: 'transactions',
          row: {
            transactionId: 0,
            userId,
            ...times,
            txid: 'e'.repeat(64),
            status: 'nosend',
            reference: 'aW5kZXBlbmRlbnQgbWV0YWRhdGE=',
            isOutgoing: false,
            satoshis: 1,
            description: 'independent 雪 metadata',
            rawTx: [...raw]
          },
          binaries: [{ field: 'rawTx', bytes: raw }]
        },
        {
          table: 'outputs',
          row: {
            outputId: 0,
            userId,
            transactionId,
            ...times,
            vout: 0,
            satoshis: 1,
            spendable: false,
            change: false,
            providedBy: 'you',
            purpose: 'independent metadata',
            type: 'custom',
            outputDescription: 'independent output 雪',
            lockingScript: [...script]
          },
          binaries: [{ field: 'lockingScript', bytes: script }]
        },
        {
          table: 'commissions',
          row: {
            commissionId: 0,
            userId,
            transactionId,
            ...times,
            satoshis: 1,
            keyOffset: 'independent offset 雪',
            isRedeemed: false,
            lockingScript: [...script]
          },
          binaries: [{ field: 'lockingScript', bytes: script }]
        }
      ]
    try {
      await verifyPackedRestoreMetadata(fixture.store, fixture.storage, cases)
    } finally {
      raw.fill(0)
      path.fill(0)
      script.fill(0)
    }
  })
}, 30000)

test('all twenty-two actual native TEXT destinations preserve independent values and exact predicates', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    const { userId, transactionId, certificateId } = await parents(fixture),
      value = '\uFEFFindependent\u0000雪😀',
      cases: readonly NativePayloadTextFixture[] = [
        {
          table: 'transactions',
          row: {
            transactionId: 0,
            userId,
            ...times,
            status: 'nosend',
            reference: 'aW5kZXBlbmRlbnQgVEVYVA==',
            isOutgoing: false,
            satoshis: 1,
            description: value,
            noSendExpiryReclaimDerivationPrefix: value + ' prefix',
            noSendExpiryReclaimDerivationSuffix: value + ' suffix'
          }
        },
        {
          table: 'outputs',
          row: {
            outputId: 0,
            userId,
            transactionId,
            ...times,
            vout: 0,
            satoshis: 1,
            spendable: false,
            change: false,
            providedBy: 'you',
            outputDescription: value,
            spendingDescription: value + ' spending',
            customInstructions: value + ' instructions',
            derivationPrefix: value + ' prefix',
            derivationSuffix: value + ' suffix',
            type: value + ' type',
            purpose: value + ' purpose'
          }
        },
        {
          table: 'commissions',
          row: {
            commissionId: 0,
            userId,
            transactionId,
            ...times,
            satoshis: 1,
            keyOffset: value,
            isRedeemed: false,
            lockingScript: []
          }
        },
        {
          table: 'certificates',
          row: {
            certificateId: 0,
            userId,
            ...times,
            type: 'independent text type',
            serialNumber: 'independent text serial',
            certifier: 'independent certifier',
            subject: value,
            revocationOutpoint: value + ' outpoint',
            signature: value + ' signature',
            verifier: value + ' verifier',
            isDeleted: false
          }
        },
        {
          table: 'certificateFields',
          row: {
            certificateId,
            userId,
            ...times,
            fieldName: 'independent text field',
            fieldValue: value,
            masterKey: value + ' key'
          }
        },
        {
          table: 'provenTxReqs',
          row: {
            provenTxReqId: 0,
            ...times,
            txid: 'f'.repeat(64),
            status: 'unprocessed',
            attempts: 0,
            notified: false,
            history: JSON.stringify({ notes: [], unknown: value }),
            notify: JSON.stringify({ transactionIds: [], unknown: value }),
            rawTx: []
          }
        },
        {
          table: 'syncStates',
          row: {
            syncStateId: -1,
            userId,
            ...times,
            storageIdentityKey: 'independent text remote',
            storageName: 'independent remote',
            status: 'unknown',
            init: false,
            refNum: 'independent text checkpoint',
            syncMap: JSON.stringify({ unknown: value }),
            errorLocal: JSON.stringify({ description: value }),
            errorOther: JSON.stringify({ description: value + ' other' })
          }
        }
      ]
    await verifyNativePackedPayloadText(fixture.store, fixture.storage, cases)
  })
}, 30000)

test('actual local packed foreground APIs retain batch, monitor and prepared BEEF bytes', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    await fixture.withWriter(installBrc38NativeLocalPackedLayout)
    const { userId } = await parents(fixture),
      beef = [1, 2, 3, 5, 8],
      blob = Uint8Array.from([13, 21, 34, 55])
    try {
      await verifyBrc38NativeLocalPackedForeground(
        fixture.storage,
        {
          batch: {
            actionBatchId: 0,
            userId,
            ...times,
            batchId: 'independent foreground batch',
            status: 'active',
            expiresAt: new Date(fixture.expiresAt),
            hardExpiresAt: new Date(fixture.expiresAt),
            manifest: '{"independent":"雪😀"}',
            uploadDigests: '[]',
            result: '{"independent":null}'
          },
          blob: {
            actionBatchBlobId: 0,
            actionBatchId: 0,
            ...times,
            digest: createHash('sha256').update(blob).digest('hex'),
            bytes: blob
          },
          monitor: { id: -23, ...times, event: 'independent foreground event', details: 'independent \u0000雪😀' },
          beef: {
            preparedBeefId: 0,
            userId,
            ...times,
            rootTxid: '7'.repeat(64),
            beef,
            checksum: createHash('sha256').update(Uint8Array.from(beef)).digest('hex'),
            formatVersion: 1,
            state: 'ready',
            txCount: 1,
            bumpCount: 0,
            byteLength: beef.length
          }
        },
        fixture.check
      )
    } finally {
      blob.fill(0)
      beef.fill(0)
    }
  })
}, 30000)
