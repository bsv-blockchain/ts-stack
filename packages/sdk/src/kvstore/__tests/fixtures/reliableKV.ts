import Transaction from '../../../transaction/Transaction'
import MerklePath from '../../../transaction/MerklePath'
import PrivateKey from '../../../primitives/PrivateKey'
import { ProtoWallet } from '../../../wallet/ProtoWallet'
import { UnlockingScript, PushDrop } from '../../../script/index'
import * as Utils from '../../../primitives/utils'

// Synthetic private key and locally trusted roots; never contacts a chain service.
export const author = new ProtoWallet(new PrivateKey(42))
export const protocol: [0 | 1 | 2, string] = [1, 'reliability fixture']
export const roots = new Set<string>()
export const chainTracker = {
  currentHeight: async () => 100,
  isValidRootForHeight: async (root: string, height: number) => height === 100 && roots.has(root)
}
export async function fixture(value = 'synthetic value', previous?: Transaction) {
  const controller = (await author.getPublicKey({ identityKey: true })).publicKey
  const lockingScript = await new PushDrop(author).lock(
    [
      Utils.toArray(JSON.stringify(protocol), 'utf8'),
      Utils.toArray('fixture key', 'utf8'),
      Utils.toArray(value, 'utf8'),
      Utils.toArray(controller, 'hex')
    ],
    protocol,
    'fixture key',
    'anyone',
    true
  )
  const tx = new Transaction(
    1,
    previous === undefined
      ? []
      : [
          {
            sourceTXID: previous.id('hex'),
            sourceOutputIndex: 0,
            unlockingScript: UnlockingScript.fromHex(''),
            sequence: 0xffffffff
          }
        ],
    [{ lockingScript, satoshis: 1 }],
    0
  )
  const id = tx.id('hex')
  tx.merklePath = new MerklePath(100, [
    [
      { offset: 0, hash: '01'.repeat(32) },
      { offset: 1, hash: id, txid: true }
    ]
  ])
  roots.add(tx.merklePath.computeRoot(id))
  return {
    tx,
    query: { key: 'fixture key', controller, protocolID: protocol },
    output: { beef: tx.toBEEF(), outputIndex: 0 }
  }
}
