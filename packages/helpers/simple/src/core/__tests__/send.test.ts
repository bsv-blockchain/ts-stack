import { LockingScript, PushDrop, WalletInterface } from '@bsv/sdk'
import { WalletCore } from '../WalletCore'

const IDENTITY_KEY = '030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4'
const RECIPIENT_KEY = '02ca066fa6b7557188b0a4013ad44e7b4a32e2f5e32fbd8d460b9f49caa0b275bd'

class TestWallet extends WalletCore {
  constructor(private readonly client: WalletInterface) {
    super(IDENTITY_KEY)
  }

  getClient(): WalletInterface {
    return this.client
  }
}

function createClient(): WalletInterface & {
  createAction: jest.Mock
  getPublicKey: jest.Mock
} {
  return {
    createAction: jest.fn().mockResolvedValue({ txid: 'transaction-id', tx: [1, 2, 3] }),
    getPublicKey: jest.fn().mockResolvedValue({ publicKey: RECIPIENT_KEY })
  } as unknown as WalletInterface & {
    createAction: jest.Mock
    getPublicKey: jest.Mock
  }
}

describe('WalletCore send', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('encodes string, object, and byte-array data in an OP_RETURN output', async () => {
    const client = createClient()
    const wallet = new TestWallet(client)

    await expect(
      wallet.send({
        outputs: [
          {
            data: ['text', { answer: 42 }, [1, 2, 3]],
            basket: 'records',
            description: 'Structured record'
          }
        ]
      })
    ).resolves.toMatchObject({
      txid: 'transaction-id',
      outputDetails: [
        { index: 0, type: 'op_return', satoshis: 0, description: 'Structured record' }
      ]
    })
    expect(client.createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [
          expect.objectContaining({
            basket: 'records',
            satoshis: 0,
            outputDescription: 'Structured record'
          })
        ]
      })
    )
  })

  it('builds PushDrop data outputs with explicit derivation settings', async () => {
    const client = createClient()
    const wallet = new TestWallet(client)
    const lockingScript = LockingScript.fromASM('OP_TRUE')
    const lock = jest.spyOn(PushDrop.prototype, 'lock').mockResolvedValue(lockingScript)

    await expect(
      wallet.send({
        outputs: [
          {
            to: RECIPIENT_KEY,
            data: [{ token: 'value' }],
            satoshis: 2,
            protocolID: [1, 'tokens'],
            keyID: 'token-key',
            basket: 'tokens'
          }
        ]
      })
    ).resolves.toMatchObject({
      outputDetails: [{ index: 0, type: 'pushdrop', satoshis: 2 }]
    })
    expect(lock).toHaveBeenCalledWith(
      [Array.from(new TextEncoder().encode('{"token":"value"}'))],
      [1, 'tokens'],
      'token-key',
      'self',
      true,
      false
    )
  })

  it('uses default PushDrop derivation settings when none are supplied', async () => {
    const client = createClient()
    const wallet = new TestWallet(client)
    const lock = jest
      .spyOn(PushDrop.prototype, 'lock')
      .mockResolvedValue(LockingScript.fromASM('OP_TRUE'))

    await wallet.send({
      outputs: [{ to: RECIPIENT_KEY, data: ['value'] }]
    })

    expect(lock).toHaveBeenCalledWith(
      [Array.from(new TextEncoder().encode('value'))],
      wallet.defaults.tokenProtocolID,
      expect.any(String),
      'self',
      true,
      false
    )
  })

  it('builds a P2PKH payment output', async () => {
    const client = createClient()
    const wallet = new TestWallet(client)

    await expect(
      wallet.send({ outputs: [{ to: RECIPIENT_KEY, satoshis: 25 }] })
    ).resolves.toMatchObject({
      outputDetails: [{ index: 0, type: 'p2pkh', satoshis: 25 }]
    })
    expect(client.createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [expect.objectContaining({ satoshis: 25 })]
      })
    )
  })

  it('rejects an output without a recipient or data', async () => {
    const wallet = new TestWallet(createClient())

    await expect(wallet.send({ outputs: [{}] })).rejects.toThrow(
      "must have 'to' (P2PKH), 'data' (OP_RETURN), or both (PushDrop)"
    )
  })

  it('funds the derived server key and preserves an optional basket', async () => {
    const client = createClient()
    const wallet = new TestWallet(client)

    await expect(
      wallet.fundServerWallet(
        {
          serverIdentityKey: RECIPIENT_KEY,
          derivationPrefix: 'prefix',
          derivationSuffix: 'suffix',
          satoshis: 100
        },
        'server-funds'
      )
    ).resolves.toMatchObject({ txid: 'transaction-id' })
    expect(client.createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [
          expect.objectContaining({
            basket: 'server-funds',
            satoshis: 100
          })
        ]
      })
    )
  })
})
