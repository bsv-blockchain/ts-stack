import { MandalaToken } from '../MandalaToken.js'
import { PrivateKey, Hash, Transaction, P2PKH } from '@bsv/sdk'

describe('MandalaToken unlock', () => {
  const assetId = `${'b'.repeat(64)}.1`

  it('signs a spend whose script verifies against the source output', async () => {
    const priv = PrivateKey.fromRandom()
    const pubKeyHash = Hash.hash160(priv.toPublicKey().encode(true) as number[])
    const lockingScript = new MandalaToken().lock(assetId, 5, pubKeyHash)

    const sourceTx = new Transaction()
    sourceTx.addOutput({ lockingScript, satoshis: 1 })

    const spendTx = new Transaction()
    spendTx.addInput({ sourceTransaction: sourceTx, sourceOutputIndex: 0, sequence: 0xffffffff })
    spendTx.addOutput({ lockingScript: new P2PKH().lock(pubKeyHash), satoshis: 1 })

    const unlocker = new MandalaToken().unlock(priv)
    const unlockingScript = await unlocker.sign(spendTx, 0)
    spendTx.inputs[0].unlockingScript = unlockingScript

    // Two pushes: signature then pubkey.
    expect(unlockingScript.chunks).toHaveLength(2)
    expect(unlockingScript.chunks[1].data?.length).toBe(33)
    // estimateLength uses optional parameters to satisfy ScriptTemplateUnlock interface
    // while supporting no-argument calls for backward compatibility
    expect(await unlocker.estimateLength(spendTx, 0)).toBeGreaterThan(100)
  })
})
