import {
  Hash,
  LockingScript,
  PrivateKey,
  PushDrop,
  Transaction,
  UnlockingScript,
  Utils,
  type CreateActionArgs,
  type CreateActionOutput,
  type CreateActionResult,
  type WalletInterface
} from '@bsv/sdk'
import { BasicTokenModule, createBtmsModule } from '../index.js'
import type { BTMS } from '@bsv/btms'
import type { AuthorizedTransaction, ParsedTokenInfo, TokenSpendInfo } from '../types.js'

const ORIGINATOR = 'https://app.example'

type AuthorizationState = {
  authorizedTransactions: Map<string, AuthorizedTransaction>
  sessionAuthorizations: Map<string, number>
}

type InternalModule = AuthorizationState & {
  classifyTokenAction(spendInfo: TokenSpendInfo): {
    burnAmount: number
    isBurn: boolean
    isInvalidBurn: boolean
  }
  computeAuthorizedDigests(transaction: Transaction): Set<string>
  dispose(): void
  extractTokenSpendInfo(args: CreateActionArgs): TokenSpendInfo
  getAssetMetadata(assetId: string): Promise<{ name?: string; iconURL?: string } | null>
  handleCreateAction(args: CreateActionArgs, originator: string): Promise<void>
  isIssuanceFromPreimage(preimage: number[]): boolean
  onRequest: BasicTokenModule['onRequest']
  outputIndicatesIssuance(output: { tags?: unknown; lockingScript?: unknown }): boolean
  parseTokenLockingScript(lockingScriptHex: string): ParsedTokenInfo | null
  parseInputAmounts(args: CreateActionArgs): {
    assetId: string
    assetIdMismatch: boolean
    iconURL: string | undefined
    inputAmountSource: TokenSpendInfo['inputAmountSource']
    tokenName: string
    totalInputAmount: number
  }
  promptForTokenBurn(originator: string, spendInfo: TokenSpendInfo): Promise<void>
  promptForTokenSpend(originator: string, spendInfo: TokenSpendInfo): Promise<void>
  readVarint(
    data: number[],
    offset: number,
    throwOnTruncated?: boolean
  ): { value: number; nextOffset: number } | null
  resolveTokenForOutput(output: CreateActionOutput): ParsedTokenInfo | null
  verifyAuthorizedTransaction(args: { data?: number[] }, originator: string): void
}

function state(module: BasicTokenModule): InternalModule {
  return module as unknown as InternalModule
}

function request(
  module: Pick<BasicTokenModule, 'onRequest'>,
  method: string,
  args: object,
  originator = ORIGINATOR
): Promise<{ args: object }> {
  return module.onRequest({ method, args, originator })
}

function decoded(fields: number[][]): ReturnType<typeof PushDrop.decode> {
  return {
    fields,
    lockingPublicKey: new PrivateKey(1).toPublicKey()
  }
}

function createSignableTransaction(): Transaction {
  const sourceTransaction = new Transaction(
    1,
    [],
    [{ lockingScript: new LockingScript(), satoshis: 100 }],
    0
  )
  return new Transaction(
    1,
    [
      {
        sequence: 0xfffffffe,
        sourceOutputIndex: 0,
        sourceTransaction,
        unlockingScript: new UnlockingScript()
      }
    ],
    [{ lockingScript: new LockingScript(), satoshis: 75 }],
    1
  )
}

describe('BasicTokenModule authorization boundary', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it('requires a prompt callback', () => {
    expect(() => new BasicTokenModule(undefined as unknown as () => Promise<boolean>)).toThrow(
      'requestTokenAccess callback is required'
    )
  })

  it('passes unknown wallet methods through without prompting', async () => {
    const prompt = jest.fn<Promise<boolean>, [string, string]>()
    const module = new BasicTokenModule(prompt)
    const args = { value: 1 }

    await expect(request(module, 'getVersion', args)).resolves.toEqual({ args })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('auto-authorizes only explicitly marked issuance actions', async () => {
    const prompt = jest.fn<Promise<boolean>, [string, string]>()
    const module = new BasicTokenModule(prompt)
    const args = {
      description: 'Issue BTMS tokens',
      outputs: [{ tags: ['btms_type_issue'] }]
    }

    await expect(request(module, 'createAction', args)).resolves.toEqual({ args })
    expect(prompt).not.toHaveBeenCalled()
    expect(state(module).sessionAuthorizations.has(ORIGINATOR)).toBe(true)
  })

  it('prompts for an unmarked action even when it has no explicit inputs', async () => {
    const prompt = jest.fn().mockResolvedValue(true)
    const module = new BasicTokenModule(prompt)
    const args = { description: 'Unmarked action', outputs: [] }

    await expect(request(module, 'createAction', args)).resolves.toEqual({ args })
    expect(prompt).toHaveBeenCalledWith(ORIGINATOR, `Spend BTMS tokens\n\nApp: ${ORIGINATOR}`)
  })

  it('fails closed when an unmarked action is denied', async () => {
    const module = new BasicTokenModule(jest.fn().mockResolvedValue(false))

    await expect(
      request(module, 'createAction', { description: 'Unmarked action', outputs: [] })
    ).rejects.toThrow('User denied permission to spend BTMS tokens')
    expect(state(module).sessionAuthorizations.size).toBe(0)
  })

  it('prompts instead of treating a short signature payload as issuance', async () => {
    const prompt = jest.fn().mockResolvedValue(true)
    const module = new BasicTokenModule(prompt)
    const args = { data: [1, 2, 3] }

    await expect(request(module, 'createSignature', args)).resolves.toEqual({ args })
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(state(module).sessionAuthorizations.has(ORIGINATOR)).toBe(false)

    await expect(request(module, 'createSignature', args)).resolves.toEqual({ args })
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it('fails closed on malformed data once a transaction commitment exists', async () => {
    const module = new BasicTokenModule(jest.fn().mockResolvedValue(true))
    await request(module, 'listOutputs', { basket: 'p btms' })
    state(module).authorizedTransactions.set(ORIGINATOR, {
      authorizedDigests: new Set(['11'.repeat(32)]),
      reference: 'approved-reference',
      timestamp: Date.now()
    })

    await expect(request(module, 'createSignature', { data: [1, 2, 3] })).rejects.toThrow(
      'neither a 32-byte digest nor a full BIP-143 preimage'
    )
  })

  it('rejects a digest that was not derived from the approved transaction', async () => {
    const module = new BasicTokenModule(jest.fn().mockResolvedValue(true))
    await request(module, 'listOutputs', { basket: 'p btms' })
    state(module).authorizedTransactions.set(ORIGINATOR, {
      authorizedDigests: new Set(['11'.repeat(32)]),
      reference: 'approved-reference',
      timestamp: Date.now()
    })

    await expect(
      request(module, 'createSignature', { data: Array.from({ length: 32 }, () => 0x22) })
    ).rejects.toThrow('Signature request does not match the approved transaction')
  })

  it('rejects a full preimage that was not derived from the approved transaction', async () => {
    const module = new BasicTokenModule(jest.fn().mockResolvedValue(true))
    await request(module, 'listOutputs', { basket: 'p btms' })
    state(module).authorizedTransactions.set(ORIGINATOR, {
      authorizedDigests: new Set(['11'.repeat(32)]),
      reference: 'approved-reference',
      timestamp: Date.now()
    })
    const preimage = Array.from({ length: 157 }, () => 0)

    await expect(request(module, 'createSignature', { data: preimage })).rejects.toThrow(
      'Signature request does not match the approved transaction'
    )
  })

  it('invalidates session authorization when transaction binding fails', async () => {
    const prompt = jest.fn().mockResolvedValue(true)
    const module = new BasicTokenModule(prompt)
    await request(module, 'createAction', { description: 'Spend', outputs: [] })

    await expect(
      module.onResponse(
        {
          signableTransaction: {
            reference: 'invalid',
            tx: [1]
          }
        } as CreateActionResult,
        { method: 'createAction', originator: ORIGINATOR }
      )
    ).rejects.toThrow('Unable to bind BTMS authorization')
    expect(state(module).sessionAuthorizations.has(ORIGINATOR)).toBe(false)
  })

  it('clears authorization when createAction completes without a signable transaction', async () => {
    const module = new BasicTokenModule(jest.fn().mockResolvedValue(true))
    await request(module, 'createAction', { description: 'Spend', outputs: [] })
    expect(state(module).sessionAuthorizations.has(ORIGINATOR)).toBe(true)

    await expect(
      module.onResponse({ tx: [1, 2, 3] }, { method: 'createAction', originator: ORIGINATOR })
    ).resolves.toEqual({ tx: [1, 2, 3] })
    expect(state(module).sessionAuthorizations.has(ORIGINATOR)).toBe(false)
    expect(state(module).authorizedTransactions.has(ORIGINATOR)).toBe(false)
  })

  it('clears authorization when a signable transaction omits required binding data', async () => {
    const module = new BasicTokenModule(jest.fn().mockResolvedValue(true))
    await request(module, 'createAction', { description: 'Spend', outputs: [] })

    await expect(
      module.onResponse(
        { signableTransaction: { reference: '', tx: [] } } as unknown as CreateActionResult,
        { method: 'createAction', originator: ORIGINATOR }
      )
    ).resolves.toEqual({ signableTransaction: { reference: '', tx: [] } })
    expect(state(module).sessionAuthorizations.has(ORIGINATOR)).toBe(false)
  })

  it('captures a valid transaction commitment from createAction responses', async () => {
    const module = new BasicTokenModule(jest.fn())
    const transaction = createSignableTransaction()
    const expectedDigest = Utils.toHex(Hash.sha256(transaction.preimage(0)))
    const response = {
      signableTransaction: {
        reference: 'approved-reference',
        tx: transaction.toAtomicBEEF()
      }
    }

    await expect(
      module.onResponse(response, {
        method: 'createAction',
        originator: ORIGINATOR
      })
    ).resolves.toBe(response)
    expect(state(module).authorizedTransactions.get(ORIGINATOR)).toMatchObject({
      authorizedDigests: new Set([expectedDigest]),
      reference: 'approved-reference'
    })
    await expect(
      module.onResponse(response, {
        method: 'getVersion',
        originator: ORIGINATOR
      })
    ).resolves.toBe(response)
  })

  it('caches access approval for sixty seconds and re-prompts after expiry', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-07-26T00:00:00.000Z'))
    const prompt = jest.fn().mockResolvedValue(true)
    const module = new BasicTokenModule(prompt)

    await request(module, 'listOutputs', { basket: 'p btms asset.0' })
    await request(module, 'listActions', { labels: ['p btms assetId asset.0'] })
    expect(prompt).toHaveBeenCalledTimes(1)

    jest.setSystemTime(new Date('2026-07-26T00:01:01.000Z'))
    await request(module, 'listOutputs', { basket: 'p btms asset.0' })
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it('ignores unrelated and malformed labels before extracting a BTMS asset label', async () => {
    const prompt = jest.fn().mockResolvedValue(true)
    const module = new BasicTokenModule(prompt)

    await request(module, 'listActions', {
      labels: [42, 'ordinary label', 'p btms assetId asset.0']
    })

    expect(JSON.parse(prompt.mock.calls[0][1])).toMatchObject({ assetId: 'asset.0' })
  })

  it('clears sensitive authorization state when disposed', async () => {
    const prompt = jest.fn().mockResolvedValue(true)
    const module = new BasicTokenModule(prompt)
    await request(module, 'listOutputs', { basket: 'p btms' })

    module.dispose()
    expect(state(module).sessionAuthorizations.size).toBe(0)
    expect(state(module).authorizedTransactions.size).toBe(0)

    await request(module, 'listOutputs', { basket: 'p btms' })
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it('sweeps expired transaction state during subsequent requests', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-07-26T00:02:00.000Z'))
    const module = new BasicTokenModule(jest.fn())
    state(module).sessionAuthorizations.set(
      'expired.example',
      new Date('2026-07-26T00:00:00.000Z').getTime()
    )
    state(module).authorizedTransactions.set('expired.example', {
      authorizedDigests: new Set(),
      reference: 'expired',
      timestamp: new Date('2026-07-26T00:00:00.000Z').getTime()
    })

    await request(module, 'getVersion', {})
    expect(state(module).sessionAuthorizations.size).toBe(0)
    expect(state(module).authorizedTransactions.size).toBe(0)
  })

  it('uses deny-by-default behavior in the convenience factory', async () => {
    const module = createBtmsModule({
      wallet: {} as WalletInterface
    })

    await expect(request(module, 'listOutputs', { basket: 'p btms' })).rejects.toThrow(
      'User denied permission to access BTMS tokens'
    )
    module.dispose()
  })
})

describe('BasicTokenModule security primitives', () => {
  const defaultSpendInfo: TokenSpendInfo = {
    actionDescription: 'Send tokens',
    assetId: `${'ab'.repeat(32)}.0`,
    changeAmount: 25,
    hasTokenOutputs: true,
    inputAmountSource: 'beef',
    outputChangeAmount: 25,
    outputSendAmount: 75,
    sendAmount: 75,
    tokenName: 'Example Token',
    totalInputAmount: 100
  }

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([
    [{ method: '', args: {}, originator: ORIGINATOR }, 'Invalid method'],
    [{ method: 'getVersion', args: {}, originator: '' }, 'Invalid originator'],
    [
      { method: 'getVersion', args: null as unknown as object, originator: ORIGINATOR },
      'Invalid args'
    ]
  ])('rejects malformed permission requests', async (permissionRequest, message) => {
    const module = new BasicTokenModule(jest.fn())
    await expect(module.onRequest(permissionRequest)).rejects.toThrow(message)
  })

  it('parses every bounded Bitcoin varint form and rejects truncation', () => {
    const module = state(new BasicTokenModule(jest.fn()))

    expect(module.readVarint([0xfc], 0)).toEqual({ value: 0xfc, nextOffset: 1 })
    expect(module.readVarint([0xfd, 0x34, 0x12], 0)).toEqual({
      value: 0x1234,
      nextOffset: 3
    })
    expect(module.readVarint([0xfe, 0x78, 0x56, 0x34, 0x12], 0)).toEqual({
      value: 0x12345678,
      nextOffset: 5
    })
    expect(module.readVarint([0xff], 0)).toBeNull()
    expect(module.readVarint([], 0)).toBeNull()
    expect(() => module.readVarint([], 0, true)).toThrow('Preimage too short for varint')
    expect(module.readVarint([0xfd], 0)).toBeNull()
    expect(module.readVarint([0xfe, 1], 0)).toBeNull()
    expect(() => module.readVarint([0xfd], 0, true)).toThrow('Preimage too short for varint')
    expect(() => module.readVarint([0xfe, 1], 0, true)).toThrow('Preimage too short for varint')
  })

  it('handles create actions whose output list is absent', () => {
    const module = state(new BasicTokenModule(jest.fn()))
    expect(module.extractTokenSpendInfo({} as CreateActionArgs)).toMatchObject({
      hasTokenOutputs: false,
      outputChangeAmount: 0,
      outputSendAmount: 0
    })
  })

  it('reports no BEEF amount when inputs are present but none resolve to tokens', () => {
    const module = state(new BasicTokenModule(jest.fn()))
    expect(
      module.parseInputAmounts({ description: 'Inspect inputs', inputBEEF: [], inputs: [] })
    ).toMatchObject({
      inputAmountSource: 'none',
      totalInputAmount: 0
    })
  })

  it('classifies pure burns and rejects mixed burn-and-send actions', () => {
    const module = state(new BasicTokenModule(jest.fn()))

    expect(
      module.classifyTokenAction({
        ...defaultSpendInfo,
        outputChangeAmount: 40,
        outputSendAmount: 0
      })
    ).toEqual({ burnAmount: 60, isBurn: true, isInvalidBurn: false })
    expect(
      module.classifyTokenAction({
        ...defaultSpendInfo,
        outputChangeAmount: 15,
        outputSendAmount: 75
      })
    ).toEqual({ burnAmount: 10, isBurn: false, isInvalidBurn: true })
    expect(
      module.classifyTokenAction({
        ...defaultSpendInfo,
        inputAmountSource: 'derived'
      })
    ).toEqual({ burnAmount: 0, isBurn: false, isInvalidBurn: false })
  })

  it('produces structured spend and burn prompts and honors denial', async () => {
    const approve = jest.fn().mockResolvedValue(true)
    const approvedModule = state(new BasicTokenModule(approve))

    await approvedModule.promptForTokenSpend(ORIGINATOR, defaultSpendInfo)
    expect(JSON.parse(approve.mock.calls[0][1])).toMatchObject({
      assetId: defaultSpendInfo.assetId,
      sendAmount: 75,
      type: 'btms_spend'
    })

    approvedModule.dispose()
    await approvedModule.promptForTokenBurn(ORIGINATOR, {
      ...defaultSpendInfo,
      changeAmount: 0
    })
    expect(JSON.parse(approve.mock.calls[1][1])).toMatchObject({
      burnAll: true,
      burnAmount: 100,
      type: 'btms_burn'
    })

    const deniedModule = state(new BasicTokenModule(jest.fn().mockResolvedValue(false)))
    await expect(deniedModule.promptForTokenSpend(ORIGINATOR, defaultSpendInfo)).rejects.toThrow(
      'User denied permission to spend tokens'
    )
    await expect(deniedModule.promptForTokenBurn(ORIGINATOR, defaultSpendInfo)).rejects.toThrow(
      'User denied permission to burn tokens'
    )
    await expect(deniedModule.promptForTokenSpend('', defaultSpendInfo)).rejects.toThrow(
      'Invalid originator'
    )
    await expect(deniedModule.promptForTokenBurn('', defaultSpendInfo)).rejects.toThrow(
      'Invalid originator'
    )
  })

  it('routes parsed spends and burns to their exact authorization prompts', async () => {
    const prompt = jest.fn().mockResolvedValue(true)
    const module = state(new BasicTokenModule(prompt))
    const extract = jest.spyOn(module, 'extractTokenSpendInfo')

    extract.mockReturnValueOnce(defaultSpendInfo)
    await module.handleCreateAction({ description: 'Send', inputs: [], outputs: [] }, ORIGINATOR)
    expect(JSON.parse(prompt.mock.calls[0][1])).toMatchObject({
      sendAmount: 75,
      type: 'btms_spend'
    })

    module.dispose()
    extract.mockReturnValueOnce({
      ...defaultSpendInfo,
      outputChangeAmount: 25,
      outputSendAmount: 0,
      sendAmount: 0
    })
    await module.handleCreateAction({ description: 'Burn', inputs: [], outputs: [] }, ORIGINATOR)
    expect(JSON.parse(prompt.mock.calls[1][1])).toMatchObject({
      burnAmount: 75,
      type: 'btms_burn'
    })

    extract.mockReturnValueOnce({
      ...defaultSpendInfo,
      outputChangeAmount: 15,
      outputSendAmount: 75
    })
    await expect(
      module.handleCreateAction({ description: 'Mixed burn', inputs: [], outputs: [] }, ORIGINATOR)
    ).rejects.toThrow('Burn transactions must not send tokens')
  })

  it('parses valid token fields and rejects invalid token encodings', () => {
    const module = state(new BasicTokenModule(jest.fn()))
    const decode = jest.spyOn(PushDrop, 'decode')

    decode.mockReturnValueOnce(
      decoded([
        Array.from(Buffer.from('asset.0')),
        Array.from(Buffer.from('25')),
        Array.from(Buffer.from('{"name":"Gold","iconURL":"https://example/icon"}'))
      ])
    )
    expect(module.parseTokenLockingScript('00')).toEqual({
      amount: 25,
      assetId: 'asset.0',
      metadata: { iconURL: 'https://example/icon', name: 'Gold' }
    })

    decode.mockReturnValueOnce(decoded([Array.from(Buffer.from('asset.0'))]))
    expect(module.parseTokenLockingScript('00')).toBeNull()

    decode.mockReturnValueOnce(
      decoded([Array.from(Buffer.from('asset.0')), Array.from(Buffer.from('-1'))])
    )
    expect(module.parseTokenLockingScript('00')).toBeNull()

    decode.mockReturnValueOnce(
      decoded([
        Array.from(Buffer.from('asset.0')),
        Array.from(Buffer.from('25')),
        Array.from(Buffer.from('signature-like metadata'))
      ])
    )
    expect(module.parseTokenLockingScript('00')).toMatchObject({ metadata: undefined })

    decode.mockReturnValueOnce(
      decoded([
        Array.from(Buffer.from('asset.0')),
        Array.from(Buffer.from('25')),
        Array.from(Buffer.from('[1,2,3]'))
      ])
    )
    expect(module.parseTokenLockingScript('00')).toMatchObject({ metadata: undefined })

    decode.mockReturnValueOnce(
      decoded([
        Array.from(Buffer.from('asset.0')),
        Array.from(Buffer.from('25')),
        Array.from(Buffer.from('{malformed'))
      ])
    )
    expect(module.parseTokenLockingScript('00')).toMatchObject({ metadata: undefined })

    expect(module.parseTokenLockingScript('not hex')).toBeNull()
  })

  it('recognizes explicit issuance markers in tags, scripts, and preimages', async () => {
    const module = state(new BasicTokenModule(jest.fn()))
    expect(module.outputIndicatesIssuance({ tags: ['btms_type_issue'] })).toBe(true)
    expect(module.outputIndicatesIssuance({ tags: ['other'] })).toBe(false)

    jest
      .spyOn(PushDrop, 'decode')
      .mockReturnValue(decoded([Array.from(Buffer.from('ISSUE')), Array.from(Buffer.from('10'))]))
    expect(module.outputIndicatesIssuance({ lockingScript: '00' })).toBe(true)

    const preimage = Array.from({ length: 157 }, () => 0)
    preimage[104] = 1
    preimage[105] = 0
    expect(module.isIssuanceFromPreimage(preimage)).toBe(true)
    expect(module.isIssuanceFromPreimage([1, 2, 3])).toBe(false)
    const oversizedScript = Array.from({ length: 157 }, () => 0)
    oversizedScript.splice(104, 3, 0xfd, 0x11, 0x27)
    expect(module.isIssuanceFromPreimage(oversizedScript)).toBe(false)
    const truncatedScript = Array.from({ length: 157 }, () => 0)
    truncatedScript[104] = 0xfc
    expect(module.isIssuanceFromPreimage(truncatedScript)).toBe(false)

    const prompt = jest.fn()
    await expect(
      request(new BasicTokenModule(prompt), 'createSignature', { data: preimage })
    ).resolves.toEqual({ args: { data: preimage } })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('computes exact PushDrop signing digests for every transaction input', () => {
    const module = state(new BasicTokenModule(jest.fn()))
    const transaction = createSignableTransaction()
    expect(module.computeAuthorizedDigests(transaction)).toEqual(
      new Set([Utils.toHex(Hash.sha256(transaction.preimage(0)))])
    )
    expect(() => module.computeAuthorizedDigests(null as unknown as Transaction)).toThrow(
      'Invalid transaction for signing-digest computation'
    )
  })

  it('matches the 32-byte digest emitted by the SDK PushDrop signer', async () => {
    const transaction = createSignableTransaction()
    const signingKey = new PrivateKey(1)
    const createSignature = jest.fn(async ({ data }: { data: number[] }) => ({
      signature: signingKey.sign(data).toDER() as number[]
    }))
    const wallet = { createSignature } as unknown as WalletInterface

    await new PushDrop(wallet).unlock([2, 'btms'], 'test-key', 'self').sign(transaction, 0)

    expect(createSignature).toHaveBeenCalledWith(
      expect.objectContaining({ data: Hash.sha256(transaction.preimage(0)) }),
      undefined
    )
  })

  it('accepts only the exact approved transaction signing digest or preimage', async () => {
    const prompt = jest.fn().mockResolvedValue(true)
    const module = state(new BasicTokenModule(prompt))
    const transaction = createSignableTransaction()
    const preimage = transaction.preimage(0)
    const digest = Hash.sha256(preimage)
    module.authorizedTransactions.set(ORIGINATOR, {
      authorizedDigests: new Set([Utils.toHex(digest)]),
      reference: 'approved-reference',
      timestamp: Date.now()
    })

    await expect(request(module, 'createSignature', { data: digest })).resolves.toEqual({
      args: { data: digest }
    })
    expect(prompt).toHaveBeenCalledTimes(1)
    await expect(request(module, 'createSignature', { data: preimage })).resolves.toEqual({
      args: { data: preimage }
    })

    const substitutedDigest = [...digest]
    substitutedDigest[0] ^= 1
    await expect(request(module, 'createSignature', { data: substitutedDigest })).rejects.toThrow(
      'Signature request does not match the approved transaction'
    )
  })

  it('expires transaction commitments and rejects missing verification data', () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-07-26T00:02:00.000Z'))
    const module = state(new BasicTokenModule(jest.fn()))
    expect(() =>
      module.verifyAuthorizedTransaction({ data: Array(32).fill(0) }, ORIGINATOR)
    ).toThrow('No approved transaction')
    module.sessionAuthorizations.set(ORIGINATOR, Date.now())
    const expired = {
      authorizedDigests: new Set(['11'.repeat(32)]),
      reference: 'expired',
      timestamp: new Date('2026-07-26T00:00:00.000Z').getTime()
    }
    module.authorizedTransactions.set(ORIGINATOR, expired)

    expect(() =>
      module.verifyAuthorizedTransaction({ data: Array(157).fill(0) }, ORIGINATOR)
    ).toThrow('Transaction authorization has expired')

    module.authorizedTransactions.set(ORIGINATOR, {
      ...expired,
      timestamp: Date.now()
    })
    expect(() => module.verifyAuthorizedTransaction({}, ORIGINATOR)).toThrow(
      'Signature request is missing data'
    )
  })

  it('enriches prompts from BTMS metadata and tolerates lookup failure', async () => {
    const getAssetInfo = jest
      .fn()
      .mockResolvedValueOnce({
        metadata: { iconURL: 'https://example/icon' },
        name: 'Gold'
      })
      .mockRejectedValueOnce(new Error('offline'))
    const module = state(
      new BasicTokenModule(jest.fn(), { getAssetInfo } as Pick<BTMS, 'getAssetInfo'>)
    )

    await expect(module.getAssetMetadata('asset.0')).resolves.toEqual({
      iconURL: 'https://example/icon',
      name: 'Gold'
    })
    await expect(module.getAssetMetadata('asset.0')).resolves.toBeNull()
  })

  it('extracts send/change totals and rejects mixed asset outputs', () => {
    const module = state(new BasicTokenModule(jest.fn()))
    const resolve = jest.spyOn(module, 'resolveTokenForOutput')
    resolve
      .mockReturnValueOnce({
        amount: 40,
        assetId: 'asset.0',
        metadata: { name: 'Gold' }
      })
      .mockReturnValueOnce({ amount: 60, assetId: 'asset.0' })

    expect(
      module.extractTokenSpendInfo({
        description: 'Send',
        outputs: [
          {
            basket: 'p btms asset.0',
            lockingScript: '00',
            outputDescription: 'Token change',
            satoshis: 1
          },
          {
            lockingScript: '00',
            outputDescription: 'Token send',
            satoshis: 1
          }
        ]
      })
    ).toMatchObject({
      assetId: 'asset.0',
      changeAmount: 40,
      sendAmount: 60,
      tokenName: 'Gold',
      totalInputAmount: 100
    })

    resolve
      .mockReset()
      .mockReturnValueOnce({ amount: 1, assetId: 'asset-a.0' })
      .mockReturnValueOnce({ amount: 1, assetId: 'asset-b.0' })
    expect(() =>
      module.extractTokenSpendInfo({
        description: 'Mixed assets',
        outputs: [
          {
            lockingScript: '00',
            outputDescription: 'First token',
            satoshis: 1
          },
          {
            lockingScript: '00',
            outputDescription: 'Second token',
            satoshis: 1
          }
        ]
      })
    ).toThrow('Asset swap support coming soon')
  })

  it('aggregates parsed input amounts and detects mixed input assets', () => {
    const module = state(new BasicTokenModule(jest.fn()))
    const resolveInput = jest
      .spyOn(
        module as unknown as {
          resolveTokenForInput(input: { outpoint: string }, beef: number[]): ParsedTokenInfo | null
        },
        'resolveTokenForInput'
      )
      .mockReturnValueOnce({
        amount: 40,
        assetId: 'asset.0',
        metadata: { iconURL: 'https://example/icon', name: 'Gold' }
      })
      .mockReturnValueOnce({ amount: 60, assetId: 'asset.0' })
    const inputs = [
      { inputDescription: 'First token', outpoint: `${'11'.repeat(32)}.0` },
      { inputDescription: 'Second token', outpoint: `${'22'.repeat(32)}.0` }
    ]

    expect(
      module.parseInputAmounts({
        description: 'Spend',
        inputBEEF: [1],
        inputs
      })
    ).toMatchObject({
      assetId: 'asset.0',
      assetIdMismatch: false,
      inputAmountSource: 'beef',
      tokenName: 'Gold',
      totalInputAmount: 100
    })

    resolveInput
      .mockReset()
      .mockReturnValueOnce({ amount: 1, assetId: 'asset-a.0' })
      .mockReturnValueOnce({ amount: 1, assetId: 'asset-b.0' })
    expect(
      module.parseInputAmounts({
        description: 'Mixed spend',
        inputBEEF: [1],
        inputs
      })
    ).toMatchObject({
      assetIdMismatch: true,
      totalInputAmount: 1
    })
  })
})
