import { Script, Transaction, UnlockingScript } from '@bsv/sdk'
import { EntityProvenTx } from '../EntityProvenTx'
import { EntityProvenTxReq } from '../EntityProvenTxReq'
import { WERR_INVALID_OPERATION } from '../../../../sdk/WERR_errors'

describe('EntityProvenTx.fromReq proof errors', () => {
  test('records why a proof lookup returned no Merkle path', async () => {
    const tx = new Transaction()
    tx.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    tx.addOutput({ satoshis: 1, lockingScript: Script.fromHex('51') })
    const req = EntityProvenTxReq.fromTxid(tx.id('hex'), tx.toBinary())

    const proven = await EntityProvenTx.fromReq(
      req,
      { name: 'provider', error: new WERR_INVALID_OPERATION('merklePath parameter must be an accessor-free data object') },
      true
    )

    expect(proven).toBeUndefined()
    const note = req.history.notes?.find(n => n.what === 'getMerklePathProvenError')
    expect(note?.description).toContain('accessor-free data object')
  })
})
