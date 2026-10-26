import { WalletAdvertiser } from '../WalletAdvertiser.js'
import { isTokenSignatureCorrectlyLinked } from '../utils/isTokenSignatureCorrectlyLinked.js'
import {
  Beef,
  type CreateActionArgs,
  LockingScript,
  LookupResolver,
  PrivateKey,
  ProtoWallet,
  PushDrop,
  type SignActionArgs,
  Transaction,
  UnlockingScript,
  Utils,
  type WalletInterface
} from '@bsv/sdk'
import type { Advertisement, AdvertisementData } from '@bsv/overlay'
import { jest } from '@jest/globals'

const testPrivateKey = new PrivateKey(42)
const testPrivateKeyHex = testPrivateKey.toHex()
const testIdentityKey = '02fe8d1eb1bcb3432b1db5833ff5f2226d9cb5e65cee430558c18ed3a3c86ce1af'
const advertiserURI = 'https://advertise-me.com'

let pendingTransaction: Transaction | undefined
let mutatePartial: ((transaction: Transaction) => void) | undefined
let mutateSigned: ((transaction: Transaction) => void) | undefined
let prependFundingInput = true
let reverseRequestedInputs = false
let actionCounter = 0

const mockWallet = new ProtoWallet(testPrivateKey) as unknown as WalletInterface
const createAction = jest.fn(async (args: CreateActionArgs) => {
  const transaction = new Transaction(args.version ?? 1, [], [], args.lockTime ?? 0)
  if (prependFundingInput) {
    const funding = new Transaction(
      1,
      [],
      [
        {
          satoshis: 1000,
          lockingScript: LockingScript.fromASM('OP_TRUE')
        }
      ],
      0
    )
    transaction.addInput({
      sourceTransaction: funding,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript([])
    })
  }

  const requestedInputs = [...(args.inputs ?? [])]
  if (reverseRequestedInputs) requestedInputs.reverse()
  const sourceBeef =
    args.inputBEEF === undefined ? undefined : Beef.fromBinaryStrict(args.inputBEEF)
  for (const input of requestedInputs) {
    const match = /^([0-9a-f]{64})\.(\d+)$/i.exec(input.outpoint)
    if (match === null) throw new Error('Mock received invalid outpoint')
    const sourceTransaction = sourceBeef?.findAtomicTransaction(match[1].toLowerCase())
    if (sourceTransaction === undefined) throw new Error('Mock could not find requested source')
    transaction.addInput({
      sourceTransaction,
      sourceOutputIndex: Number(match[2]),
      unlockingScript: new UnlockingScript([]),
      sequence: input.sequenceNumber
    })
  }
  for (const output of args.outputs ?? []) {
    transaction.addOutput({
      satoshis: output.satoshis,
      lockingScript: LockingScript.fromHex(output.lockingScript)
    })
  }
  mutatePartial?.(transaction)
  pendingTransaction = transaction
  actionCounter += 1
  return {
    signableTransaction: {
      tx: transaction.toAtomicBEEF(true),
      reference: Buffer.from(`mock-reference-${actionCounter}`, 'utf8').toString('base64')
    }
  }
})

const signAction = jest.fn(async (args: SignActionArgs) => {
  if (pendingTransaction === undefined) throw new Error('Mock has no pending transaction')
  const signed = Transaction.fromAtomicBEEF(pendingTransaction.toAtomicBEEF(true))
  for (const [index, spend] of Object.entries(args.spends)) {
    signed.inputs[Number(index)].unlockingScript = UnlockingScript.fromHex(spend.unlockingScript)
  }
  mutateSigned?.(signed)
  return { tx: signed.toAtomicBEEF(true), txid: signed.id('hex') }
})

mockWallet.createAction = createAction as WalletInterface['createAction']
mockWallet.signAction = signAction as WalletInterface['signAction']
mockWallet.abortAction = jest.fn(async () => ({ aborted: true })) as WalletInterface['abortAction']
mockWallet.getNetwork = jest.fn(async () => ({
  network: 'mainnet'
})) as WalletInterface['getNetwork']

jest.mock('@bsv/wallet-toolbox-client', () => ({
  Services: jest.fn().mockImplementation(() => ({})),
  WalletSigner: jest.fn().mockImplementation(() => ({})),
  Wallet: jest.fn().mockImplementation(() => mockWallet),
  StorageClient: jest.fn().mockImplementation(() => ({
    makeAvailable: jest.fn().mockResolvedValue(undefined as never)
  })),
  WalletStorageManager: jest.fn().mockImplementation((identityKey: unknown) => ({
    addWalletStorageProvider: jest.fn().mockResolvedValue(undefined as never),
    identityKey
  }))
}))

async function initializedAdvertiser(): Promise<WalletAdvertiser> {
  const advertiser = new WalletAdvertiser(
    'test',
    testPrivateKeyHex,
    'https://fake-storage-url.com',
    advertiserURI
  )
  await advertiser.init()
  return advertiser
}

async function makeAdvertisement(
  key: PrivateKey,
  protocol: 'SHIP' | 'SLAP',
  topicOrService: string,
  options: { domain?: string; satoshis?: number; extraField?: boolean } = {}
): Promise<{
  advertisement: Advertisement
  lockingScript: LockingScript
  transaction: Transaction
}> {
  const wallet = new ProtoWallet(key)
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true })
  const fields = [
    Utils.toArray(protocol, 'utf8'),
    Utils.toArray(identityKey, 'hex'),
    Utils.toArray(options.domain ?? advertiserURI, 'utf8'),
    Utils.toArray(topicOrService, 'utf8')
  ]
  if (options.extraField === true) fields.push(Utils.toArray('extra', 'utf8'))
  const lockingScript = await new PushDrop(wallet as unknown as WalletInterface).lock(
    fields,
    [2, protocol === 'SHIP' ? 'service host interconnect' : 'service lookup availability'],
    '1',
    'anyone',
    true
  )
  const transaction = new Transaction(
    1,
    [],
    [
      {
        lockingScript,
        satoshis: options.satoshis ?? 1
      }
    ],
    0
  )
  return {
    advertisement: {
      protocol,
      identityKey,
      domain: options.domain ?? advertiserURI,
      topicOrService,
      beef: transaction.toBEEF(),
      outputIndex: 0
    },
    lockingScript,
    transaction
  }
}

describe('WalletAdvertiser', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    pendingTransaction = undefined
    mutatePartial = undefined
    mutateSigned = undefined
    prependFundingInput = true
    reverseRequestedInputs = false
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('rejects a non-advertisable constructor URI and supports TTN routing', () => {
    expect(
      () =>
        new WalletAdvertiser(
          'test',
          testPrivateKeyHex,
          'https://fake-storage-url.com',
          'xyz://bad-protocol.com'
        )
    ).toThrow('Refusing to initialize with non-advertisable URI')

    const ttnAdvertiser = new WalletAdvertiser(
      'ttn',
      testPrivateKeyHex,
      'https://staging-storage.babbage.systems',
      'https://staging-overlay.babbage.systems'
    )
    expect(ttnAdvertiser.lookupResolverConfig).toEqual({ networkPreset: 'teratestnet' })
  })

  it('requires initialization before use', async () => {
    const advertiser = new WalletAdvertiser(
      'test',
      testPrivateKeyHex,
      'https://fake-storage-url.com',
      advertiserURI
    )
    await expect(advertiser.findAllAdvertisements('SHIP')).rejects.toThrow(
      'Initialize the Advertiser using init() before use.'
    )
  })

  it('creates an authenticated, exactly bound advertisement transaction', async () => {
    const advertiser = await initializedAdvertiser()
    const taggedBeef = await advertiser.createAdvertisements([
      {
        protocol: 'SHIP',
        topicOrServiceName: 'tm_meter'
      }
    ])

    expect(taggedBeef.topics).toEqual(['tm_ship'])
    const action = createAction.mock.calls[0][0]
    expect(action.outputs).toHaveLength(1)
    expect(action.outputs?.[0]).toMatchObject({
      satoshis: 1,
      outputDescription: 'SHIP advertisement of tm_meter'
    })
    const decoded = PushDrop.decode(LockingScript.fromHex(action.outputs![0].lockingScript))
    const fieldsBeforeVerification = decoded.fields.map(field => [...field])
    await expect(
      isTokenSignatureCorrectlyLinked(decoded.lockingPublicKey, decoded.fields)
    ).resolves.toBe(true)
    expect(decoded.fields).toEqual(fieldsBeforeVerification)

    const returned = Transaction.fromBEEF(taggedBeef.beef)
    expect(returned.outputs[0].lockingScript.toHex()).toBe(action.outputs![0].lockingScript)
  })

  it('rejects invalid, cross-protocol, duplicate, sparse, and accessor-backed creation data', async () => {
    const advertiser = await initializedAdvertiser()
    await expect(
      advertiser.createAdvertisements([
        {
          protocol: 'SHIP',
          topicOrServiceName: '!@#$invalid-topic'
        }
      ])
    ).rejects.toThrow('invalid topic or service name')
    await expect(
      advertiser.createAdvertisements([
        {
          protocol: 'SHIP',
          topicOrServiceName: 'ls_wrong'
        }
      ])
    ).rejects.toThrow('invalid topic or service name')
    await expect(
      advertiser.createAdvertisements([
        { protocol: 'SHIP', topicOrServiceName: 'tm_same' },
        { protocol: 'SHIP', topicOrServiceName: 'tm_same' }
      ])
    ).rejects.toThrow('duplicate')
    const sparseAdvertisements: AdvertisementData[] = []
    sparseAdvertisements.length = 1
    await expect(advertiser.createAdvertisements(sparseAdvertisements)).rejects.toThrow('dense')

    const getter = jest.fn(() => 'SHIP')
    const accessor = Object.defineProperty({ topicOrServiceName: 'tm_test' }, 'protocol', {
      enumerable: true,
      get: getter
    })
    await expect(advertiser.createAdvertisements([accessor] as never)).rejects.toThrow(
      'data properties'
    )
    expect(getter).not.toHaveBeenCalled()
  })

  it('bounds creation cardinality and validates owned advertisement records', async () => {
    const advertiser = await initializedAdvertiser()
    await expect(advertiser.createAdvertisements(null as never)).rejects.toThrow('non-empty array')
    await expect(advertiser.createAdvertisements([])).rejects.toThrow('non-empty array')
    await expect(
      advertiser.createAdvertisements(
        Array(10_001).fill({
          protocol: 'SHIP',
          topicOrServiceName: 'tm_meter'
        })
      )
    ).rejects.toThrow('at most 10000')
    await expect(advertiser.createAdvertisements([null] as never)).rejects.toThrow(
      'plain data object'
    )
    await expect(advertiser.createAdvertisements([new Date()] as never)).rejects.toThrow(
      'plain data object'
    )
    await expect(
      advertiser.createAdvertisements([
        { protocol: 'OTHER', topicOrServiceName: 'tm_meter' } as never
      ])
    ).rejects.toThrow('must be SHIP or SLAP')

    advertiser.advertisableURI = 'http://private.invalid'
    await expect(
      advertiser.createAdvertisements([{ protocol: 'SHIP', topicOrServiceName: 'tm_meter' }])
    ).rejects.toThrow('non-advertisable URI')
  })

  it('rejects wallet substitution before or after signing and aborts the poisoned action', async () => {
    const advertiser = await initializedAdvertiser()
    mutatePartial = transaction => {
      transaction.outputs[0].satoshis = 2
    }
    await expect(
      advertiser.createAdvertisements([
        {
          protocol: 'SHIP',
          topicOrServiceName: 'tm_meter'
        }
      ])
    ).rejects.toThrow('omitted or substituted a requested output')
    expect(mockWallet.abortAction).toHaveBeenCalledTimes(1)
    expect(signAction).not.toHaveBeenCalled()

    jest.clearAllMocks()
    mutatePartial = undefined
    mutateSigned = transaction => {
      transaction.outputs[0].lockingScript = LockingScript.fromASM('OP_RETURN')
    }
    await expect(
      advertiser.createAdvertisements([
        {
          protocol: 'SHIP',
          topicOrServiceName: 'tm_meter'
        }
      ])
    ).rejects.toThrow('substituted an authorized output')
    expect(mockWallet.abortAction).toHaveBeenCalledTimes(1)
  })

  it('parses only canonical, structurally valid advertisement envelopes', async () => {
    const advertiser = await initializedAdvertiser()
    const valid = await makeAdvertisement(testPrivateKey, 'SHIP', 'tm_meter')
    expect(advertiser.parseAdvertisement(valid.lockingScript)).toEqual({
      protocol: 'SHIP',
      topicOrService: 'tm_meter',
      domain: advertiserURI,
      identityKey: testIdentityKey
    })

    const wrongPrefix = await makeAdvertisement(testPrivateKey, 'SHIP', 'ls_wrong')
    const extra = await makeAdvertisement(testPrivateKey, 'SHIP', 'tm_meter', { extraField: true })
    expect(() => advertiser.parseAdvertisement(wrongPrefix.lockingScript)).toThrow(
      'Error parsing advertisement'
    )
    expect(() => advertiser.parseAdvertisement(extra.lockingScript)).toThrow(
      'Error parsing advertisement'
    )
  })

  it('returns only authenticated, owned, one-satoshi, transaction-bound lookup results', async () => {
    const advertiser = await initializedAdvertiser()
    const owned = await makeAdvertisement(testPrivateKey, 'SHIP', 'tm_owned')
    const foreign = await makeAdvertisement(new PrivateKey(43), 'SHIP', 'tm_foreign')
    const wrongValue = await makeAdvertisement(testPrivateKey, 'SHIP', 'tm_wrong_value', {
      satoshis: 2
    })
    jest.spyOn(LookupResolver.prototype, 'query').mockResolvedValue({
      type: 'output-list',
      outputs: [
        { beef: owned.advertisement.beef!, outputIndex: 0, txid: owned.transaction.id('hex') },
        { beef: owned.advertisement.beef!, outputIndex: 0 },
        { beef: foreign.advertisement.beef!, outputIndex: 0 },
        { beef: wrongValue.advertisement.beef!, outputIndex: 0 },
        { beef: owned.advertisement.beef!, outputIndex: 0, txid: '00'.repeat(32) }
      ]
    })

    await expect(advertiser.findAllAdvertisements('SHIP')).resolves.toEqual([owned.advertisement])
  })

  it('does not invoke accessors returned by a hostile lookup implementation', async () => {
    const advertiser = await initializedAdvertiser()
    const getter = jest.fn(() => [])
    const answer = Object.defineProperty({ type: 'output-list' }, 'outputs', {
      enumerable: true,
      get: getter
    })
    jest.spyOn(LookupResolver.prototype, 'query').mockResolvedValue(answer as never)

    await expect(advertiser.findAllAdvertisements('SHIP')).resolves.toEqual([])
    expect(getter).not.toHaveBeenCalled()
  })

  it('fails closed on lookup failures and malformed output-list envelopes', async () => {
    const advertiser = await initializedAdvertiser()
    const query = jest.spyOn(LookupResolver.prototype, 'query')

    await expect(advertiser.findAllAdvertisements('OTHER' as never)).rejects.toThrow(
      'must be SHIP or SLAP'
    )

    query.mockRejectedValueOnce(new Error('lookup offline'))
    await expect(advertiser.findAllAdvertisements('SHIP')).resolves.toEqual([])

    const sparseOutputs: unknown[] = Array(1)
    for (const answer of [
      null,
      { type: 'freeform', outputs: [] },
      { type: 'output-list', outputs: null },
      { type: 'output-list', outputs: Array(10_001).fill(null) },
      { type: 'output-list', outputs: sparseOutputs },
      { type: 'output-list', outputs: [null] },
      { type: 'output-list', outputs: [{ beef: null, outputIndex: 0 }] },
      { type: 'output-list', outputs: [{ beef: [256], outputIndex: 0 }] },
      { type: 'output-list', outputs: [{ beef: [1], outputIndex: -1 }] }
    ]) {
      query.mockResolvedValueOnce(answer as never)
      await expect(advertiser.findAllAdvertisements('SHIP')).resolves.toEqual([])
    }
  })

  it('signs only exact owned advertisement outpoints at wallet-selected input indexes', async () => {
    const advertiser = await initializedAdvertiser()
    const first = await makeAdvertisement(testPrivateKey, 'SHIP', 'tm_first')
    const second = await makeAdvertisement(testPrivateKey, 'SLAP', 'ls_second')
    prependFundingInput = true
    reverseRequestedInputs = true

    const result = await advertiser.revokeAdvertisements([
      first.advertisement,
      second.advertisement
    ])

    expect(result.topics).toEqual(['tm_ship', 'tm_slap'])
    const action = createAction.mock.calls[0][0]
    expect(action.inputs?.map(input => input.outpoint)).toEqual([
      `${first.transaction.id('hex')}.0`,
      `${second.transaction.id('hex')}.0`
    ])
    expect(signAction.mock.calls[0][0].spends).toEqual({
      1: { unlockingScript: expect.any(String) },
      2: { unlockingScript: expect.any(String) }
    })
    const revoked = Transaction.fromBEEF(result.beef)
    expect(revoked.inputs).toHaveLength(3)
    expect(revoked.inputs[1].unlockingScript?.toHex()).not.toBe('')
    expect(revoked.inputs[2].unlockingScript?.toHex()).not.toBe('')
  })

  it('rejects foreign, mismatched, wrong-value, and duplicate revocation claims before signing', async () => {
    const advertiser = await initializedAdvertiser()
    const owned = await makeAdvertisement(testPrivateKey, 'SHIP', 'tm_owned')
    const foreign = await makeAdvertisement(new PrivateKey(43), 'SHIP', 'tm_foreign')
    const wrongValue = await makeAdvertisement(testPrivateKey, 'SHIP', 'tm_value', {
      satoshis: 2
    })

    await expect(advertiser.revokeAdvertisements([foreign.advertisement])).rejects.toThrow(
      'owned authenticated token'
    )
    await expect(
      advertiser.revokeAdvertisements([
        {
          ...owned.advertisement,
          domain: 'https://attacker.example'
        }
      ])
    ).rejects.toThrow('metadata does not match')
    await expect(advertiser.revokeAdvertisements([wrongValue.advertisement])).rejects.toThrow(
      'one-satoshi token'
    )
    await expect(
      advertiser.revokeAdvertisements([owned.advertisement, owned.advertisement])
    ).rejects.toThrow('same advertisement outpoint')
    expect(createAction).not.toHaveBeenCalled()
    expect(signAction).not.toHaveBeenCalled()
  })

  it('rejects an empty revocation set', async () => {
    const advertiser = await initializedAdvertiser()
    await expect(advertiser.revokeAdvertisements([])).rejects.toThrow(
      'Must provide advertisements to revoke!'
    )
  })

  it('bounds and snapshots revocation claims before constructing wallet inputs', async () => {
    const advertiser = await initializedAdvertiser()
    const owned = await makeAdvertisement(testPrivateKey, 'SHIP', 'tm_owned')

    await expect(
      advertiser.revokeAdvertisements(Array(10_001).fill(owned.advertisement))
    ).rejects.toThrow('Cannot revoke more than 10000')

    const sparse: Advertisement[] = Array(1)
    await expect(advertiser.revokeAdvertisements(sparse)).rejects.toThrow('dense array')
    await expect(advertiser.revokeAdvertisements([null] as never)).rejects.toThrow(
      'plain data object'
    )
    await expect(
      advertiser.revokeAdvertisements([{ ...owned.advertisement, beef: [256] }])
    ).rejects.toThrow('bounded non-empty byte array')
    await expect(
      advertiser.revokeAdvertisements([{ ...owned.advertisement, outputIndex: -1 }])
    ).rejects.toThrow('unsigned 32-bit integer')
    expect(createAction).not.toHaveBeenCalled()
  })

  it('rejects non-script and unauthenticated advertisement parsing requests', async () => {
    const advertiser = await initializedAdvertiser()
    expect(() => advertiser.parseAdvertisement({} as never)).toThrow('Error parsing advertisement')
    const valid = await makeAdvertisement(testPrivateKey, 'SHIP', 'tm_meter')
    await expect(
      (advertiser as any).authenticateAdvertisement(valid.lockingScript, 'SLAP')
    ).rejects.toThrow('Invalid or unauthenticated SLAP advertisement')
  })
})
