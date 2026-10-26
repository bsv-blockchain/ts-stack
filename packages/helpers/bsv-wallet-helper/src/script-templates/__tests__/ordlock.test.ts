import { describe, expect, test } from '@jest/globals'
import { PrivateKey, Transaction, Script, Utils } from '@bsv/sdk'
import OrdLock from '../ordlock'
import { makeMockWallet } from '../../utils/mockWallet'

describe('OrdLock script template', () => {
  const lockParams = {
    ordAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
    payAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
    price: 1000,
    assetId: 'abcd_0'
  }

  test('lock should create a script containing ord envelope and OP_RETURN metadata', async () => {
    const ordLock = new OrdLock()

    const lockingScript = await ordLock.lock({
      ...lockParams,
      itemData: { lootTableId: 'test' },
      metadata: { app: 'test', type: 'ord' }
    })

    const asm = lockingScript.toASM()

    expect(asm).toContain('OP_IF')
    expect(asm).toContain('OP_RETURN')
  })

  test('lock omits OP_RETURN without metadata and rejects invalid metadata containers', async () => {
    const ordLock = new OrdLock()

    expect((await ordLock.lock(lockParams)).toASM()).not.toContain('OP_RETURN')
    await expect(ordLock.lock({ ...lockParams, metadata: null } as any)).rejects.toThrow(
      'metadata must be an object'
    )
    await expect(ordLock.lock({ ...lockParams, metadata: [] } as any)).rejects.toThrow(
      'metadata must be an object'
    )
    await expect(ordLock.lock({ ...lockParams, itemData: null } as any)).rejects.toThrow(
      'itemData must be an object'
    )
    await expect(ordLock.lock({ ...lockParams, itemData: [] } as any)).rejects.toThrow(
      'itemData must be an object'
    )
  })

  test('rejects malformed financial, address, and metadata values', async () => {
    const ordLock = new OrdLock()

    for (const price of [0, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 21e14 + 1]) {
      await expect(ordLock.lock({ ...lockParams, price })).rejects.toThrow(
        'price must be a safe integer'
      )
    }
    const shortAddress = Utils.toBase58Check(Array.from({ length: 19 }, () => 0))
    await expect(ordLock.lock({ ...lockParams, ordAddress: shortAddress })).rejects.toThrow(
      'ordAddress must contain a 20-byte public key hash'
    )
    await expect(ordLock.lock({ ...lockParams, payAddress: shortAddress })).rejects.toThrow(
      'payAddress must contain a 20-byte public key hash'
    )
    await expect(ordLock.lock({ ...lockParams, metadata: { score: Number.NaN } })).rejects.toThrow(
      'metadata.score must be a finite JSON number'
    )

    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => 'value'
    })
    await expect(ordLock.lock({ ...lockParams, metadata: accessor })).rejects.toThrow(
      'metadata.secret must be a data property'
    )

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(ordLock.lock({ ...lockParams, itemData: cyclic })).rejects.toThrow(
      'itemData.self must not contain a cycle'
    )
  })

  test('cancel unlock should produce unlocking script ending with OP_1', async () => {
    const priv = new PrivateKey(42)
    const wallet = await makeMockWallet(priv)

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
    await expect(unlock.estimateLength()).resolves.toBe(109)
  }, 30000)

  test('unlock dispatches cancel and purchase templates', async () => {
    const wallet = await makeMockWallet(43)
    const ordLock = new OrdLock(wallet)

    expect(ordLock.unlock().sign).toEqual(expect.any(Function))
    expect(ordLock.unlock({ kind: 'purchase' }).sign).toEqual(expect.any(Function))
  })
})
