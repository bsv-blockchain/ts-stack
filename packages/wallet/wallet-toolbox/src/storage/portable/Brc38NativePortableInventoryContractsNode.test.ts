import { nativeTestExecutable } from './Brc38NativeTestPath'
import { withComposedNativeFixture } from './Brc38ComposedNativeFixture'
import { withComposedFixtureRead } from './Brc38ComposedSemanticFixture'
import {
  readIndependentNativeInventory,
  wipeIndependentNativeInventory
} from './Brc38IndependentNativeInventoryFixture'
import { independentNativePortableFixture } from './Brc38IndependentNativePortableFixture'
import { verifyBrc38NativeSourcePayloadText } from './Brc38NativeSourcePayloadTextNode.case'

test('actual native export preserves all13 tables, all22 TEXT cells and legacy request booleans in all three modes', async () => {
  await withComposedNativeFixture(
    async fixture => {
      const preimage = await withComposedFixtureRead(fixture.manager, readIndependentNativeInventory)
      try {
        const expected = independentNativePortableFixture(preimage, '2026-10-08T00:00:00.000Z')
        expect(expected.tables.provenTxReqs[0].wasBroadcast).toBe(1)
        expect(Object.keys(expected.tables)).toHaveLength(13)
        await verifyBrc38NativeSourcePayloadText(fixture.storage, {
          expected,
          privateIndexParent: fixture.directory,
          expiresAt: Math.min(fixture.expiresAt, Date.now() + 360000),
          onMode(mode, phase) {
            console.log(JSON.stringify({ stage: 'native-portable-mode', mode, phase, at: new Date().toISOString() }))
          }
        })
        const after = await withComposedFixtureRead(fixture.manager, readIndependentNativeInventory)
        try {
          expect(after).toEqual(preimage)
        } finally {
          wipeIndependentNativeInventory(after)
        }
      } finally {
        wipeIndependentNativeInventory(preimage)
      }
    },
    nativeTestExecutable(),
    (source, incoming) => {
      for (const data of [source, incoming]) {
        Object.assign(data.tables.transactions[0], {
          description: 'independent transaction 雪',
          noSendExpiryReclaimDerivationPrefix: 'AQID',
          noSendExpiryReclaimDerivationSuffix: 'BAUG'
        })
        Object.assign(data.tables.outputs[0], {
          outputDescription: 'independent output 雪',
          spendingDescription: 'independent spending',
          customInstructions: 'independent\u0000instructions😀',
          derivationPrefix: 'AQID',
          derivationSuffix: 'BAUG',
          type: 'P2PKH',
          purpose: 'change'
        })
        Object.assign(data.tables.certificates[0], {
          subject: 'subject',
          revocationOutpoint: 'outpoint',
          signature: 'signature',
          verifier: 'verifier'
        })
        Object.assign(data.tables.certificateFields[0], {
          fieldValue: 'independent field 雪',
          masterKey: 'independent master key'
        })
        data.tables.commissions[0].keyOffset = 'independent offset'
        Object.assign(data.tables.provenTxReqs[0], {
          wasBroadcast: true,
          history: { notes: [{ what: 'independent native history', detail: '雪😀' }] },
          notify: { transactionIds: [14] }
        })
        Object.assign(data.tables.syncStates[0], {
          errorLocal: { code: 'independent local', description: '雪😀' },
          errorOther: { code: 'independent remote', description: '\u0000' }
        })
      }
    },
    720000
  )
}, 750000)
