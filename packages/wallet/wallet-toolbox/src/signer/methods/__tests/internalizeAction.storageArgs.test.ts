import { Beef, MerklePath, Script, Transaction, UnlockingScript } from '@bsv/sdk'
import { internalizeAction } from '../internalizeAction'
import type { Wallet } from '../../../Wallet'
import { stringifyJsonRpc } from '../../../storage/remoting/BinaryJson'

describe('signer internalizeAction storage arguments', () => {
  test('passes the AtomicBEEF to storage as bytes so negotiated binary JSON carries it compactly', async () => {
    const tx = new Transaction()
    tx.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    tx.addOutput({ satoshis: 1000, lockingScript: Script.fromHex('51') })
    const txid = tx.id('hex')
    const beef = new Beef()
    beef.mergeBump(new MerklePath(800000, [[{ offset: 0, hash: txid, txid: true }]]))
    beef.mergeTransaction(tx)

    const received: unknown[] = []
    const wallet = {
      getServices: () => ({ getChainTracker: async () => ({ isValidRootForHeight: async () => true }) }),
      storage: {
        internalizeAction: async (args: unknown) => {
          received.push(args)
          return { accepted: true, isMerge: false, txid, satoshis: 0 }
        }
      }
    } as unknown as Wallet

    await internalizeAction(wallet, { identityKey: `02${'11'.repeat(32)}`, userId: 1 }, {
      tx: beef.toBinaryAtomic(txid),
      outputs: [
        {
          outputIndex: 0,
          protocol: 'basket insertion',
          insertionRemittance: { basket: 'tokens', tags: [] }
        }
      ],
      description: 'internalize as bytes'
    })

    const sent = received[0] as { tx: unknown }
    expect(sent.tx).toBeInstanceOf(Uint8Array)
    expect(Array.from(sent.tx as Uint8Array)).toEqual(beef.toBinaryAtomic(txid))
    const wire = JSON.parse(stringifyJsonRpc({ params: [sent] }, true))
    expect(wire.params[0].tx.$bsvBinary).toBe('base64')
  })
})
