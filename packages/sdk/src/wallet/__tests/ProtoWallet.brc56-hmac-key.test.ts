import ProtoWallet from '../../wallet/ProtoWallet'
import KeyDeriver from '../../wallet/KeyDeriver'
import { PrivateKey, Utils } from '../../primitives/index'
import { WalletProtocol } from '../../wallet/Wallet.interfaces'

// Public BRC-56 derivation fixtures, aligned with established SDK2/3 HMACs.
// Only minimal-length unsigned big-endian X-coordinate bytes are HMAC keys.
// The rejected fixtures pin refusal of tags made with prepended zero bytes.
const ROOT_KEY = 'f0efba88c117ca2614554bb676d743f413822a31e3c8d70cfcc5fff119d20a07'
const ROOT_PUBLIC_KEY = '035818cd7cc614fea816c8b39eebe6e43cafc635451ec5a873f8757b418aaae91a'
const COUNTERPARTY = '03458d551018414b8fe1adbcef2d0afc17e1074bfab3fdde3e1b0750bdde58a9a7'
const PROTOCOL_ID: WalletProtocol = [2, 'hmac key vectors']
const DATA = Utils.toArray('4252432d353620484d41432074657374', 'hex')

interface Vector {
  counterparty: string
  keyID: string
  leadingZeroBytes: number
  hmacKey: string
  hmac: string
  rejectedTag?: string
}

const VECTORS: Vector[] = [
  {
    counterparty: 'self',
    keyID: 'k0',
    leadingZeroBytes: 0,
    hmacKey: 'b1273850ff41cee365a4d590e3c323822129f66c5a9b2eacb8b9e790e000e396',
    hmac: '99455edf49ea2156f6109466fb344c3027d4c14485581a50bf5ff0850328a269'
  },
  {
    counterparty: 'self',
    keyID: 'k95',
    leadingZeroBytes: 1,
    hmacKey: '0c82ac78dc853158f24883ccfda332be6ba34f821765357cc4ef2a190a28fd',
    hmac: '3a968ebaa25eaa4b1cfad138f96105bb1eb738defc066d01e37b32595900d48b',
    rejectedTag: '054a0fc6a3b0e21b31dc627fb1d645f2eea4127dff71eac95b1f71b7cb13c787'
  },
  {
    counterparty: 'self',
    keyID: 'k91538',
    leadingZeroBytes: 2,
    hmacKey: '9dc11102cc72eca3c6e4e232460eac581e9b2cee1bb35c395b635d3f6393',
    hmac: '5a8b84fb2a7d9ce7b12feb8319f14dc6169e0be005a1a8e58d9b9b2d1ac29d47',
    rejectedTag: 'ff43127cb1ddfbd19776d01ce34b8c3e83916b51fa55ac045a355b731e6999f5'
  },
  {
    counterparty: COUNTERPARTY,
    keyID: 'k0',
    leadingZeroBytes: 0,
    hmacKey: '1896e0210afac8dbb4ca3bd4ea25c8377d0352ab83e62fe6ffabeca78c1a6113',
    hmac: '986af579272261acf3e890bb1650124b0dfbc0b1edacda202f8ed0c3b876c072'
  },
  {
    counterparty: COUNTERPARTY,
    keyID: 'k497',
    leadingZeroBytes: 1,
    hmacKey: '1829e1dd58fc2c45b6edcbb277eecdecbab1c884b42fd779e131fea5881b45',
    hmac: '3a5ea2bf5bcc9bc1461041737384bf258b0a3e5a475fb281a19c2972cdb1cff6',
    rejectedTag: 'aa39467c48a116ffb00fd7b56ff158bd9af37d1298df2f031c0125458c30f574'
  },
  {
    counterparty: COUNTERPARTY,
    keyID: 'k29510',
    leadingZeroBytes: 2,
    hmacKey: 'a52a35523175d6c181e90f463a27cdbf70f4ecf055e912d6fc24ac7d0e3c',
    hmac: 'ecca769bb17b1775ce8ae4326fe721ba0f7ba272300741bf4a5b068cf0cebd60',
    rejectedTag: '2677674035f1aaac3219b3405cf8569ec07922a3ceffbd4f7c8a7948b2d3c553'
  }
]

const label = (v: Vector): string =>
  `${v.counterparty === 'self' ? 'self' : 'counterparty'} ${v.keyID} (${v.leadingZeroBytes} leading zero bytes)`

describe('BRC-56 HMAC key vectors', () => {
  const rootKey = PrivateKey.fromHex(ROOT_KEY)
  const wallet = new ProtoWallet(rootKey)

  const verify = async (v: Vector, tag: string): Promise<boolean> => {
    const { valid } = await wallet.verifyHmac({
      data: DATA,
      hmac: Utils.toArray(tag, 'hex'),
      protocolID: PROTOCOL_ID,
      keyID: v.keyID,
      counterparty: v.counterparty
    })
    return valid
  }

  it('uses the BRC root key', () => {
    expect(rootKey.toPublicKey().toString()).toBe(ROOT_PUBLIC_KEY)
  })

  describe.each(VECTORS.map(v => [label(v), v] as const))('%s', (_name, v) => {
    it('derives the vector HMAC key', () => {
      const key = new KeyDeriver(rootKey).deriveSymmetricKey(PROTOCOL_ID, v.keyID, v.counterparty)
      expect(Utils.toHex(key.toArray())).toBe(v.hmacKey)
    })

    it('createHmac returns the tag published SDK 2/3 issue', async () => {
      const { hmac } = await wallet.createHmac({
        data: DATA,
        protocolID: PROTOCOL_ID,
        keyID: v.keyID,
        counterparty: v.counterparty
      })
      expect(Utils.toHex(hmac)).toBe(v.hmac)
    })

    it('verifyHmac accepts the established HMAC tag', async () => {
      await expect(verify(v, v.hmac)).resolves.toBe(true)
    })

    if (v.rejectedTag !== undefined) {
      const rejectedTag = v.rejectedTag
      it('verifyHmac rejects a tag made with prepended zero bytes', async () => {
        await expect(verify(v, rejectedTag)).rejects.toThrow('HMAC is not valid')
      })
    }

    it('verifyHmac refuses a tampered tag', async () => {
      const tampered = Utils.toArray(v.hmac, 'hex')
      tampered[31] ^= 1
      await expect(verify(v, Utils.toHex(tampered))).rejects.toThrow('HMAC is not valid')
    })
  })
})
