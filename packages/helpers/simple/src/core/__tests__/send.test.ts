import { LockingScript, PushDrop, Transaction, UnlockingScript, WalletInterface } from '@bsv/sdk'
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
    createAction: jest.fn().mockImplementation(async args => {
      const outputs = args.outputs.map((output: any) => ({
        satoshis: output.satoshis,
        lockingScript: LockingScript.fromHex(output.lockingScript)
      }))
      const totalOutputSatoshis = outputs.reduce(
        (total: number, output: { satoshis: number }) => total + output.satoshis,
        0
      )
      const fundingTransaction = new Transaction(
        1,
        [],
        [{ satoshis: totalOutputSatoshis, lockingScript: LockingScript.fromASM('OP_TRUE') }],
        0
      )
      const tx = new Transaction(
        args.version ?? 1,
        totalOutputSatoshis === 0
          ? []
          : [
              {
                sourceTransaction: fundingTransaction,
                sourceOutputIndex: 0,
                unlockingScript: UnlockingScript.fromASM('OP_TRUE')
              }
            ],
        outputs,
        args.lockTime ?? 0
      )
      return { txid: tx.id('hex'), tx: tx.toAtomicBEEF() }
    }),
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
      txid: expect.stringMatching(/^[0-9a-f]{64}$/),
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
      RECIPIENT_KEY,
      false,
      false
    )
    expect(client.createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [
          expect.objectContaining({
            customInstructions: JSON.stringify({
              protocolID: [1, 'tokens'],
              keyID: 'token-key',
              counterparty: RECIPIENT_KEY
            })
          })
        ]
      })
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
      RECIPIENT_KEY,
      false,
      false
    )
  })

  it('rejects inherited or accessor-backed PushDrop protocol tuples', async () => {
    const client = createClient()
    const wallet = new TestWallet(client)
    const lock = jest.spyOn(PushDrop.prototype, 'lock')
    const sparseProtocol: [number, string] = [] as unknown as [number, string]
    sparseProtocol.length = 2
    Object.setPrototypeOf(
      sparseProtocol,
      Object.assign(Object.create(Array.prototype), { 0: 1, 1: 'tokens' })
    )

    await expect(
      wallet.send({
        outputs: [{ to: RECIPIENT_KEY, data: ['value'], protocolID: sparseProtocol }]
      })
    ).rejects.toThrow('dense own-data tuple')

    const getter = jest.fn(() => 1)
    const accessorProtocol = [0, 'tokens'] as [number, string]
    Object.defineProperty(accessorProtocol, '0', { get: getter, enumerable: true })
    await expect(
      wallet.send({
        outputs: [{ to: RECIPIENT_KEY, data: ['value'], protocolID: accessorProtocol }]
      })
    ).rejects.toThrow('dense own-data tuple')
    expect(getter).not.toHaveBeenCalled()
    expect(lock).not.toHaveBeenCalled()
  })

  it('snapshots byte-array data without invoking or rereading accessors', async () => {
    const client = createClient()
    const wallet = new TestWallet(client)
    const getter = jest.fn(() => 1)
    const hostileBytes = [0]
    Object.defineProperty(hostileBytes, '0', { enumerable: true, get: getter })

    await expect(
      wallet.send({ outputs: [{ to: RECIPIENT_KEY, data: [hostileBytes] }] })
    ).rejects.toThrow('bounded dense byte array')
    expect(getter).not.toHaveBeenCalled()
    expect(client.createAction).not.toHaveBeenCalled()
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

  it('does not accept inherited top-level or nested send options', async () => {
    const client = createClient()
    const wallet = new TestWallet(client)
    Object.defineProperties(Object.prototype, {
      outputs: {
        value: [{ to: RECIPIENT_KEY, satoshis: 25 }],
        configurable: true
      },
      to: { value: RECIPIENT_KEY, configurable: true },
      satoshis: { value: 25, configurable: true }
    })
    try {
      await expect(wallet.send({} as never)).rejects.toThrow('At least one output is required')
      await expect(wallet.send({ outputs: [{}] })).rejects.toThrow(
        "must have 'to' (P2PKH), 'data' (OP_RETURN), or both (PushDrop)"
      )
      expect(client.createAction).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(Object.prototype, 'outputs')
      Reflect.deleteProperty(Object.prototype, 'to')
      Reflect.deleteProperty(Object.prototype, 'satoshis')
    }
  })

  it('funds the derived server key and preserves an optional basket', async () => {
    const client = createClient()
    const wallet = new TestWallet(client)

    await expect(
      wallet.fundServerWallet(
        {
          serverIdentityKey: RECIPIENT_KEY,
          derivationPrefix: 'cHJlZml4',
          derivationSuffix: 'c3VmZml4',
          satoshis: 100
        },
        'server-funds'
      )
    ).resolves.toMatchObject({ txid: expect.stringMatching(/^[0-9a-f]{64}$/) })
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

  it('rejects invalid amounts, malformed bytes, and unbounded data before wallet access', async () => {
    const client = createClient()
    const wallet = new TestWallet(client)

    await expect(
      wallet.send({ outputs: [{ to: RECIPIENT_KEY, satoshis: Number.NaN }] })
    ).rejects.toThrow('valid number of satoshis')
    await expect(wallet.send({ outputs: [{ data: [[0, 256]] }] })).rejects.toThrow(
      'bounded dense byte array'
    )
    await expect(
      wallet.send({ outputs: [{ data: ['x'.repeat(1024 * 1024 + 1)] }] })
    ).rejects.toThrow('maximum permitted size')
    expect(client.createAction).not.toHaveBeenCalled()
  })

  it('rejects malformed wallet completion claims instead of returning an empty txid', async () => {
    const client = createClient()
    client.createAction.mockResolvedValue({})
    const wallet = new TestWallet(client)

    await expect(wallet.send({ outputs: [{ to: RECIPIENT_KEY, satoshis: 1 }] })).rejects.toThrow(
      'Invalid createAction result txid'
    )
  })
})
