import {
  type AsyncCryptoBackend,
  registerAsyncCryptoBackend,
  unregisterAsyncCryptoBackend
} from '../../../primitives/AsyncCryptoBackend'
import PrivateKey from '../../../primitives/PrivateKey'
import Script from '../../Script'
import Transaction from '../../../transaction/Transaction'
import P2PKH from '../P2PKH'

function backendFor (key: PrivateKey, publicKey: Uint8Array): AsyncCryptoBackend {
  const derSignature = Uint8Array.from(key.sign(Array.from({ length: 32 }, () => 1)).toDER())
  return {
    preload: async () => {},
    isReady: () => true,
    supportsCrypto: operation => operation === 'signDigest' || operation === 'publicKeyFromPrivate',
    signDigest: async () => derSignature,
    verifyDigest: async () => true,
    verifyDigestBatch: async items => items.map(() => true),
    publicKeyFromPrivate: async () => publicKey,
    multiplyPublicKey: async value => value,
    tweakPublicKeyAdd: async value => value,
    tweakPrivateKeyAdd: async value => value
  }
}

function spendFor (key: PrivateKey): { tx: Transaction; template: ReturnType<P2PKH['unlock']> } {
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: Script.fromHex('00'),
    sequence: 0xffffffff
  })
  const p2pkh = new P2PKH()
  source.addOutput({ satoshis: 2, lockingScript: p2pkh.lock(key.toAddress()) })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, sequence: 0xffffffff })
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromHex('51') })
  return { tx, template: p2pkh.unlock(key) }
}

describe('P2PKH async crypto backend', () => {
  test('forwards the validated compressed public key without parsing it again', async () => {
    const key = PrivateKey.fromRandom()
    const publicKey = Uint8Array.from(key.toPublicKey().encode(true) as number[])
    const backend = backendFor(key, publicKey)
    registerAsyncCryptoBackend(backend)
    try {
      const { tx, template } = spendFor(key)
      const script = await template.sign(tx, 0)
      expect(script.chunks.at(-1)?.data).toEqual(Array.from(publicKey))
    } finally {
      unregisterAsyncCryptoBackend(backend)
    }
  })

  test('rejects a malformed compressed public key returned by a backend', async () => {
    const key = PrivateKey.fromRandom()
    const backend = backendFor(key, Uint8Array.from([0x04, ...Array.from({ length: 32 }, () => 0)]))
    registerAsyncCryptoBackend(backend)
    try {
      const { tx, template } = spendFor(key)
      await expect(template.sign(tx, 0)).rejects.toThrow('invalid compressed public key')
    } finally {
      unregisterAsyncCryptoBackend(backend)
    }
  })
})
