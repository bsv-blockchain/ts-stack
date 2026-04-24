import { describe, expect, test } from '@jest/globals'
import { PrivateKey, Transaction, Script } from '@bsv/sdk'
import OrdLock from '../ordlock'
import { makeWallet } from '../../utils/mockWallet'

const storageURL = 'https://store-us-1.bsvb.tech'

describe('OrdLock script template', () => {
  test('lock should create a script containing ord envelope and OP_RETURN metadata', async () => {
    const ordLock = new OrdLock()

    const lockingScript = await ordLock.lock({
      ordAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
      payAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
      price: 1000,
      assetId: 'abcd_0',
      itemData: { lootTableId: 'test' },
      metadata: { app: 'test', type: 'ord' }
    })

    const asm = lockingScript.toASM()

    expect(asm).toContain('OP_IF')
    expect(asm).toContain('OP_RETURN')
  })

  test('cancel unlock should produce unlocking script ending with OP_1', async () => {
    const priv = new PrivateKey(42)
    const wallet = await makeWallet('test', storageURL, priv.toHex())

    const ordLock = new OrdLock(wallet)
    const unlock = ordLock.cancelUnlock({
      protocolID: [0, 'ordlock'],
      keyID: '0',
      counterparty: 'self',
      sourceSatoshis: 1,
      lockingScript: Script.fromASM('OP_TRUE')
    })

    const tx = new Transaction()
    tx.addInput({
      sourceTXID: '00'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('')
    })
    tx.addOutput({
      satoshis: 1,
      lockingScript: Script.fromASM('OP_TRUE')
    })

    const unlockingScript = await unlock.sign(tx, 0)
    const asm = unlockingScript.toASM()

    expect(asm.trim().endsWith('OP_1')).toBe(true)
  }, 30000)
})
