import { Beef, LockingScript, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { WalletPermissionsManager, type PermissionToken } from '../WalletPermissionsManager'

const TXID = 'ab'.repeat(32)

function managerWith(underlying: Record<string, unknown> = {}): WalletPermissionsManager {
  return new WalletPermissionsManager(underlying as never, 'admin.example', {
    encryptWalletMetadata: false,
    seekSpendingPermissions: false
  })
}

function utf8(value: string): number[] {
  return Utils.toArray(value, 'utf8')
}

function tokenTransaction(): {
  id: () => string
  outputs: Array<{ satoshis: number; lockingScript: { toHex(): string } }>
  toBEEF(): number[]
} {
  return {
    id: () => TXID,
    outputs: [{ satoshis: 1, lockingScript: { toHex: () => '51' } }],
    toBEEF: () => [1, 2, 3]
  }
}

function permissionToken(satoshis = 1): PermissionToken {
  const transaction = new Transaction()
  transaction.addOutput({ satoshis, lockingScript: LockingScript.fromASM('OP_TRUE') })
  const beef = new Beef()
  beef.mergeTransaction(transaction)
  return {
    tx: beef.toBinary(),
    txid: transaction.id('hex'),
    outputIndex: 0,
    outputScript: '51',
    satoshis,
    originator: 'example.com'
  }
}

describe('WalletPermissionsManager hostile boundary coverage', () => {
  afterEach(() => jest.restoreAllMocks())

  test('strictly decodes every protocol-token scalar', async () => {
    const decrypt = jest.fn(async ({ ciphertext }: { ciphertext: number[] }) => ({ plaintext: ciphertext }))
    const manager = managerWith({ decrypt }) as any
    const valid = ['example.com', '123', 'true', '2', 'protocol', 'counterparty'].map(utf8)

    await expect(manager.decryptProtocolTokenFields(valid)).resolves.toEqual({
      domainDecoded: 'example.com',
      expiryDecoded: 123,
      privDecoded: true,
      secLevelDecoded: 2,
      protoNameDecoded: 'protocol',
      cptyDecoded: 'counterparty'
    })

    for (const [index, value, message] of [
      [1, '01', 'canonical non-negative integer'],
      [1, '9007199254740992', 'outside the supported range'],
      [2, 'yes', 'must be true or false'],
      [3, '3', 'outside the supported range']
    ] as const) {
      const malformed = valid.map(field => [...field])
      malformed[index] = utf8(value)
      await expect(manager.decryptProtocolTokenFields(malformed)).rejects.toThrow(message)
    }
  })

  test('rejects malformed certificate field sets after authenticating the token source', async () => {
    const decrypt = jest.fn(async ({ ciphertext }: { ciphertext: number[] }) => ({ plaintext: ciphertext }))
    const manager = managerWith({ decrypt }) as any
    const source = {
      tx: tokenTransaction(),
      txid: TXID,
      outputIndex: 0,
      fields: [utf8('example.com'), utf8('123'), utf8('true'), utf8('type'), utf8('[]'), utf8('verifier')]
    }
    jest.spyOn(manager, 'authenticatedPermissionTokenSource').mockResolvedValue(source)
    const expected = {
      originator: 'example.com',
      privileged: true,
      verifier: 'verifier',
      certType: 'type',
      fields: []
    }

    for (const encoded of [
      JSON.stringify({ field: true }),
      JSON.stringify(Array.from({ length: 257 }, (_, index) => `field-${index}`)),
      JSON.stringify(['']),
      JSON.stringify(['duplicate', 'duplicate']),
      JSON.stringify(['é'.repeat(25)])
    ]) {
      source.fields[4] = utf8(encoded)
      await expect(manager.parseCertificateTokenOutput({ outputs: [] }, { satoshis: 1 }, expected)).rejects.toThrow(
        'Permission certificate fields'
      )
    }
  })

  test('bounds declared, parsed, and streamed manifest bodies', async () => {
    const manager = managerWith() as any
    const tooLarge = 256 * 1024 + 1
    await expect(
      manager.readBoundedManifest({
        headers: { get: () => String(tooLarge) },
        body: {}
      })
    ).rejects.toThrow('size limit')

    await expect(
      manager.readBoundedManifest({
        headers: { get: () => 'not-a-length' },
        body: null,
        json: async () => ({})
      })
    ).rejects.toThrow('size limit')

    await expect(
      manager.readBoundedManifest({
        headers: { get: () => null },
        body: null,
        json: async () => ({ payload: 'x'.repeat(tooLarge) })
      })
    ).rejects.toThrow('size limit')

    const reader = {
      read: jest
        .fn()
        .mockResolvedValueOnce({ done: false, value: Uint8Array.from(utf8('{"metanet":')) })
        .mockResolvedValueOnce({ done: false, value: undefined })
        .mockResolvedValueOnce({
          done: false,
          value: Uint8Array.from(utf8('{"groupPermissions":null}}'))
        })
        .mockResolvedValueOnce({ done: true }),
      cancel: jest.fn()
    }
    await expect(
      manager.readBoundedManifest({
        headers: { get: () => null },
        body: { getReader: () => reader }
      })
    ).resolves.toEqual({ metanet: { groupPermissions: null } })

    const oversizedReader = {
      read: jest.fn().mockResolvedValueOnce({ done: false, value: { byteLength: tooLarge } }),
      cancel: jest.fn(async () => undefined)
    }
    await expect(
      manager.readBoundedManifest({
        headers: { get: () => null },
        body: { getReader: () => oversizedReader }
      })
    ).rejects.toThrow('size limit')
    expect(oversizedReader.cancel).toHaveBeenCalledTimes(1)
  })

  test('uses the localhost manifest compatibility path and coalesces concurrent fetches', async () => {
    const manager = managerWith() as any
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ metanet: { groupPermissions: null, counterpartyPermissions: null } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )

    const [first, second] = await Promise.all([
      manager.fetchManifestPermissions('localhost:8080'),
      manager.fetchManifestPermissions('localhost:8080')
    ])

    expect(first).toEqual({ groupPermissions: null, counterpartyPermissions: null })
    expect(second).toEqual(first)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:8080/manifest.json',
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) })
    )
    await expect(manager.fetchManifestPermissions('localhost:8080')).resolves.toEqual(first)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('does not cache an invalid permission locking key and retries cleanly', async () => {
    const getPublicKey = jest
      .fn()
      .mockResolvedValueOnce({ publicKey: 'invalid' })
      .mockResolvedValueOnce({ publicKey: `02${'AB'.repeat(32)}` })
    const manager = managerWith({ getPublicKey }) as any

    await expect(manager.permissionTokenLockingKey()).rejects.toThrow('invalid permission-token locking key')
    await expect(manager.permissionTokenLockingKey()).resolves.toBe(`02${'ab'.repeat(32)}`)
    expect(getPublicKey).toHaveBeenCalledTimes(2)
  })

  test('shares a failed locking-key request without retaining the rejected promise', async () => {
    const getPublicKey = jest.fn().mockRejectedValue(new Error('key lookup failed'))
    const manager = managerWith({ getPublicKey }) as any

    const results = await Promise.allSettled([manager.permissionTokenLockingKey(), manager.permissionTokenLockingKey()])

    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect(getPublicKey).toHaveBeenCalledTimes(1)
    expect(manager.permissionTokenLockingKeyPromise).toBeUndefined()
  })

  test('accepts byte arrays for permission-token encryption without text coercion', async () => {
    const encrypt = jest.fn(async ({ plaintext }: { plaintext: number[] }) => ({ ciphertext: plaintext }))
    const manager = managerWith({ encrypt }) as any

    await expect(manager.encryptPermissionTokenField([0, 255])).resolves.toEqual([0, 255])
    expect(encrypt).toHaveBeenCalledWith(expect.objectContaining({ plaintext: [0, 255] }), 'admin.example')
  })

  test('fails closed before decoding a token whose transaction or output binding is invalid', async () => {
    const manager = managerWith() as any
    const output = { outpoint: `${TXID}.0`, satoshis: 1 }
    jest.spyOn(manager, 'transactionFromResultBeef').mockReturnValueOnce({
      id: () => 'cd'.repeat(32),
      outputs: []
    })
    await expect(manager.authenticatedPermissionTokenSource({}, output, 2)).resolves.toBeUndefined()

    manager.transactionFromResultBeef.mockReturnValueOnce({ id: () => TXID, outputs: [] })
    await expect(manager.authenticatedPermissionTokenSource({}, output, 2)).resolves.toBeUndefined()

    jest.spyOn(manager, 'authenticatedPermissionTokenSource').mockResolvedValue(undefined)
    await expect(
      manager.parseProtocolTokenOutput({}, output, {
        originator: 'example.com',
        privileged: false,
        securityLevel: 1,
        protocolName: 'protocol',
        counterparty: 'self'
      })
    ).resolves.toBeUndefined()
    await expect(
      manager.parseCertificateTokenOutput({}, output, {
        originator: 'example.com',
        privileged: false,
        verifier: 'verifier',
        certType: 'type',
        fields: []
      })
    ).resolves.toBeUndefined()
  })

  test('decodes spending grants and applies the requested origin filter', async () => {
    const outputs = [
      { outpoint: `${TXID}.0`, satoshis: 1 },
      { outpoint: `${TXID}.1`, satoshis: 1 }
    ]
    const listOutputs = jest.fn(async () => ({ outputs }))
    const decrypt = jest.fn(async ({ ciphertext }: { ciphertext: number[] }) => ({ plaintext: ciphertext }))
    const manager = managerWith({ listOutputs, decrypt }) as any
    jest
      .spyOn(manager, 'authenticatedPermissionTokenSource')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({
        tx: tokenTransaction(),
        txid: TXID,
        outputIndex: 0,
        fields: [utf8('Example.COM:443'), utf8('500')]
      })

    await expect(manager.listSpendingAuthorizations({ originator: 'example.com' })).resolves.toEqual([
      expect.objectContaining({ originator: 'Example.COM:443', authorizedAmount: 500 })
    ])
    expect(listOutputs).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['originator example.com'] }),
      'admin.example'
    )

    manager.authenticatedPermissionTokenSource.mockResolvedValue({
      tx: tokenTransaction(),
      txid: TXID,
      outputIndex: 0,
      fields: [utf8('other.example'), utf8('500')]
    })
    await expect(manager.listSpendingAuthorizations({ originator: 'example.com' })).resolves.toEqual([])
  })

  test('finds only an authenticated spending token for the normalized origin', async () => {
    const outputs = [
      { outpoint: `${'01'.repeat(32)}.0`, satoshis: 1 },
      { outpoint: `${'02'.repeat(32)}.0`, satoshis: 1 },
      { outpoint: `${'03'.repeat(32)}.0`, satoshis: 1 }
    ]
    const listOutputs = jest
      .fn()
      .mockResolvedValueOnce({ outputs: [outputs[0]] })
      .mockResolvedValueOnce({ outputs: outputs.slice(1) })
    const decrypt = jest.fn(async ({ ciphertext }: { ciphertext: number[] }) => ({ plaintext: ciphertext }))
    const manager = managerWith({ listOutputs, decrypt }) as any
    jest
      .spyOn(manager, 'authenticatedPermissionTokenSource')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        tx: tokenTransaction(),
        txid: TXID,
        outputIndex: 0,
        fields: [utf8('other.example'), utf8('99')]
      })
      .mockResolvedValueOnce({
        tx: tokenTransaction(),
        txid: TXID,
        outputIndex: 0,
        fields: [utf8('Example.COM:443'), utf8('500')]
      })

    await expect(manager.findSpendingToken('example.com', ['legacy.example', 'example.com'])).resolves.toEqual(
      expect.objectContaining({
        originator: 'example.com',
        rawOriginator: 'Example.COM:443',
        authorizedAmount: 500
      })
    )
    expect(listOutputs.mock.calls.map(call => call[0].tags)).toEqual([
      ['originator legacy.example'],
      ['originator example.com']
    ])
  })

  test('collects only authenticated protocol and certificate tokens for the requested origin', async () => {
    const decrypt = jest.fn(async ({ ciphertext }: { ciphertext: number[] }) => ({ plaintext: ciphertext }))
    const manager = managerWith({ decrypt }) as any
    const origin = manager.prepareOriginator('example.com')
    const outputs = [
      { outpoint: `${'11'.repeat(32)}.0`, satoshis: 1 },
      { outpoint: `${'12'.repeat(32)}.0`, satoshis: 1 },
      { outpoint: `${'13'.repeat(32)}.0`, satoshis: 1 },
      { outpoint: `${'14'.repeat(32)}.0`, satoshis: 1 }
    ]
    const protocolFields = (domain: string): number[][] => [domain, '123', 'true', '2', 'protocol', 'self'].map(utf8)
    const authenticate = jest
      .spyOn(manager, 'authenticatedPermissionTokenSource')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        tx: tokenTransaction(),
        txid: TXID,
        outputIndex: 0,
        fields: protocolFields('other.example')
      })
      .mockResolvedValueOnce({
        tx: tokenTransaction(),
        txid: TXID,
        outputIndex: 0,
        fields: protocolFields('Example.COM:443')
      })
    const seen = new Set([outputs[0].outpoint])
    const protocolTokens: PermissionToken[] = []

    await manager.collectProtocolTokens({ outputs }, origin, seen, protocolTokens)

    expect(protocolTokens).toEqual([
      expect.objectContaining({
        originator: 'example.com',
        rawOriginator: 'Example.COM:443',
        expiry: 123,
        privileged: true,
        securityLevel: 2,
        protocol: 'protocol',
        counterparty: 'self'
      })
    ])
    expect(authenticate).toHaveBeenCalledTimes(3)

    authenticate.mockReset()
    authenticate
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        tx: tokenTransaction(),
        txid: TXID,
        outputIndex: 0,
        fields: [utf8('other.example'), utf8('456'), utf8('false'), utf8('type'), utf8('["name"]'), utf8('verifier')]
      })
      .mockResolvedValueOnce({
        tx: tokenTransaction(),
        txid: TXID,
        outputIndex: 0,
        fields: [utf8('Example.COM:443'), utf8('456'), utf8('false'), utf8('type'), utf8('["name"]'), utf8('verifier')]
      })
    const certificateTokens: PermissionToken[] = []

    await manager.collectCertificateTokens({ outputs }, origin, new Set([outputs[0].outpoint]), certificateTokens)

    expect(certificateTokens).toEqual([
      expect.objectContaining({
        originator: 'example.com',
        rawOriginator: 'Example.COM:443',
        expiry: 456,
        privileged: false,
        certType: 'type',
        certFields: ['name'],
        verifier: 'verifier'
      })
    ])
    expect(authenticate).toHaveBeenCalledTimes(3)
  })

  test('binds renewal, coalescing, and revocation batches to their old token inputs', async () => {
    const manager = managerWith() as any
    const first = permissionToken(1)
    const second = permissionToken(2)
    const request = {
      type: 'spending',
      originator: 'example.com',
      spending: { satoshis: 100 }
    }
    jest.spyOn(manager, 'buildPermissionOutput').mockResolvedValue({
      request,
      output: { lockingScript: '51', satoshis: 1, basket: 'admin spending-authorization' }
    })
    const completed = new Transaction()
    completed.addOutput({ satoshis: 1, lockingScript: LockingScript.fromASM('OP_TRUE') })
    const complete = jest.spyOn(manager, 'completePermissionTokenAction').mockResolvedValue(completed)

    await expect(
      manager.renewPermissionTokensBestEffort([{ oldToken: first, request, expiry: 123, amount: 100 }], true)
    ).resolves.toEqual([request])
    expect(complete).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        description: 'Renew 1 permissions',
        inputs: [expect.objectContaining({ outpoint: `${first.txid}.0` })],
        outputs: [expect.objectContaining({ lockingScript: '51' })]
      }),
      [first]
    )

    await expect(
      manager.coalescePermissionTokens([first, second], LockingScript.fromASM('OP_TRUE'), {
        basket: 'admin protocol-permission',
        tags: ['originator example.com'],
        description: 'Coalesce grants'
      })
    ).resolves.toBe(completed.id('hex'))
    expect(complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        description: 'Coalesce grants',
        inputs: [
          expect.objectContaining({ outpoint: `${first.txid}.0` }),
          expect.objectContaining({ outpoint: `${second.txid}.0` })
        ],
        outputs: [
          expect.objectContaining({
            lockingScript: '51',
            basket: 'admin protocol-permission',
            tags: ['originator example.com']
          })
        ]
      }),
      [first, second]
    )

    await expect(manager.revokePermissionTokensChunk([])).resolves.toBeUndefined()
    await expect(manager.revokePermissionTokensChunk([first])).resolves.toBeUndefined()
    expect(complete).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        description: 'Revoke 1 permissions',
        inputs: [expect.objectContaining({ outpoint: `${first.txid}.0` })]
      }),
      [first]
    )
  })

  test('applies all public protocol and certificate list filters to decoded tokens', async () => {
    const manager = managerWith({ listOutputs: jest.fn(async () => ({ outputs: [] })) }) as any
    const protocolTokens: PermissionToken[] = [
      {
        tx: [],
        txid: TXID,
        outputIndex: 0,
        outputScript: '51',
        satoshis: 1,
        originator: 'example.com',
        privileged: true,
        protocol: 'alpha',
        securityLevel: 2,
        counterparty: 'self'
      },
      {
        tx: [],
        txid: 'cd'.repeat(32),
        outputIndex: 0,
        outputScript: '51',
        satoshis: 1,
        originator: 'example.com',
        privileged: false,
        protocol: 'beta',
        securityLevel: 1,
        counterparty: 'anyone'
      }
    ]
    jest.spyOn(manager, 'collectProtocolTokens').mockImplementation(async (_result, _origin, _seen, tokens) => {
      tokens.push(...protocolTokens)
    })
    await expect(
      manager.listProtocolPermissions({
        privileged: true,
        protocolName: 'alpha',
        protocolSecurityLevel: 2,
        counterparty: 'self'
      })
    ).resolves.toEqual([protocolTokens[0]])
    await expect(manager.listProtocolPermissions()).resolves.toHaveLength(2)

    const certificateTokens: PermissionToken[] = [
      { ...protocolTokens[0], certType: 'type-a', verifier: 'verifier-a' },
      { ...protocolTokens[1], certType: 'type-b', verifier: 'verifier-b' }
    ]
    jest.spyOn(manager, 'collectCertificateTokens').mockImplementation(async (_result, _origin, _seen, tokens) => {
      tokens.push(...certificateTokens)
    })
    await expect(
      manager.listCertificateAccess({ privileged: true, certType: 'type-a', verifier: 'verifier-a' })
    ).resolves.toEqual([certificateTokens[0]])
    await expect(manager.listCertificateAccess()).resolves.toHaveLength(2)

    jest.spyOn(manager, 'collectBasketTokens').mockImplementation(async (_result, _origin, _seen, tokens) => {
      tokens.push({ ...protocolTokens[0], basketName: 'basket-a' })
    })
    await expect(manager.listBasketAccess()).resolves.toEqual([expect.objectContaining({ basketName: 'basket-a' })])

    jest.spyOn(manager, 'authenticatedPermissionTokenSource').mockResolvedValue({
      tx: tokenTransaction(),
      txid: TXID,
      outputIndex: 0,
      fields: [utf8('example.com'), utf8('500')]
    })
    manager.underlying.listOutputs.mockResolvedValue({
      outputs: [{ outpoint: `${TXID}.0`, satoshis: 1 }]
    })
    await expect(manager.listSpendingAuthorizations({})).resolves.toEqual([
      expect.objectContaining({ originator: 'example.com', authorizedAmount: 500 })
    ])
  })

  test('rejects unsafe monetary totals and unbound transaction inputs', () => {
    const manager = managerWith() as any
    expect(() => manager.checkedSatoshiTotal(21e14, 1, 'total')).toThrow('monetary range')
    expect(() => manager.checkedSatoshiTotal(-1, 0, 'total')).toThrow('monetary range')

    const source = new Transaction(1, [], [{ satoshis: 1, lockingScript: LockingScript.fromASM('OP_TRUE') }], 0)
    expect(() =>
      manager.inputOutpointForBinding({
        sourceTransaction: source,
        sourceTXID: 'cd'.repeat(32),
        sourceOutputIndex: 0
      })
    ).toThrow('inconsistent')
    expect(() => manager.inputOutpointForBinding({ sourceOutputIndex: 0 })).toThrow('transaction ID is invalid')
    expect(() => manager.inputOutpointForBinding({ sourceTXID: TXID, sourceOutputIndex: 0x100000000 })).toThrow(
      'output index is invalid'
    )
    expect(manager.inputOutpointForBinding({ sourceTXID: TXID.toUpperCase(), sourceOutputIndex: 1 })).toBe(`${TXID}.1`)
    expect(() => manager.parseOutpoint(`${TXID}.4294967296`)).toThrow('outpoint is invalid')

    const missingSource = new Transaction(1, [{ sourceTXID: TXID, sourceOutputIndex: 0 }], [], 0)
    expect(() =>
      manager.computeNetSpend(
        missingSource,
        {
          description: 'Missing source',
          inputs: [{ outpoint: `${TXID}.0`, unlockingScriptLength: 1, inputDescription: 'caller input' }]
        },
        {},
        {}
      )
    ).toThrow('missing its authenticated source transaction')

    const emptySource = new Transaction()
    const missingOutput = new Transaction(1, [{ sourceTransaction: emptySource, sourceOutputIndex: 0 }], [], 0)
    expect(() =>
      manager.computeNetSpend(
        missingOutput,
        {
          description: 'Missing output',
          inputs: [
            {
              outpoint: `${emptySource.id('hex')}.0`,
              unlockingScriptLength: 1,
              inputDescription: 'caller input'
            }
          ]
        },
        {},
        {}
      )
    ).toThrow('source output is missing')
  })

  test('binds final transactions to the authorized template and signed indices', () => {
    const manager = managerWith() as any
    const authorized = new Transaction(1, [], [{ satoshis: 1, lockingScript: LockingScript.fromASM('OP_TRUE') }], 0)
    expect(() => manager.assertAuthorizedSignResult('missing', {}, {})).toThrow('template is unavailable')

    manager.pendingActionTemplates.set('reference', authorized)
    expect(() => manager.assertAuthorizedSignResult('reference', {}, {})).toThrow('omitted transaction data')

    const substituted = new Transaction(2, [], [{ satoshis: 1, lockingScript: LockingScript.fromASM('OP_TRUE') }], 0)
    expect(() => manager.assertAuthorizedSignResult('reference', {}, { tx: substituted.toAtomicBEEF() })).toThrow(
      'substituted the authorized transaction template'
    )

    expect(() =>
      manager.assertAuthorizedSignResult(
        'reference',
        { '01': { unlockingScript: '' } },
        {
          tx: authorized.toAtomicBEEF()
        }
      )
    ).toThrow('Signed input index is invalid')
    expect(() =>
      manager.assertAuthorizedSignResult(
        'reference',
        { 0: { unlockingScript: '' } },
        {
          tx: authorized.toAtomicBEEF()
        }
      )
    ).toThrow('Signed input index is invalid')
    expect(() =>
      manager.assertAuthorizedSignResult(
        'reference',
        {},
        {
          tx: authorized.toAtomicBEEF(),
          txid: 'cd'.repeat(32)
        }
      )
    ).toThrow('transaction ID does not match')
  })

  test('accepts only an unlocking script bound to the authorized input', () => {
    const manager = managerWith() as any
    const source = new Transaction(1, [], [{ satoshis: 2, lockingScript: LockingScript.fromASM('OP_TRUE') }], 0)
    const authorized = new Transaction(
      1,
      [
        {
          sourceTransaction: source,
          sourceOutputIndex: 0,
          sequence: 1,
          unlockingScript: UnlockingScript.fromASM('OP_TRUE')
        }
      ],
      [{ satoshis: 1, lockingScript: LockingScript.fromASM('OP_TRUE') }],
      0
    )
    manager.pendingActionTemplates.set('input-reference', authorized)
    const result = { tx: authorized.toAtomicBEEF(), txid: authorized.id('hex').toUpperCase() }

    expect(() =>
      manager.assertAuthorizedSignResult('input-reference', { 0: { unlockingScript: '51' } }, result)
    ).not.toThrow()
    expect(() =>
      manager.assertAuthorizedSignResult('input-reference', { 0: { unlockingScript: '00' } }, result)
    ).toThrow('substituted an authorized unlocking script')

    const changedSequence = new Transaction(
      1,
      [
        {
          sourceTransaction: source,
          sourceOutputIndex: 0,
          sequence: 2,
          unlockingScript: UnlockingScript.fromASM('OP_TRUE')
        }
      ],
      [{ satoshis: 1, lockingScript: LockingScript.fromASM('OP_TRUE') }],
      0
    )
    expect(() =>
      manager.assertAuthorizedSignResult('input-reference', {}, { tx: changedSequence.toAtomicBEEF() })
    ).toThrow('substituted an authorized transaction input')

    const changedUnlockingScript = new Transaction(
      1,
      [
        {
          sourceTransaction: source,
          sourceOutputIndex: 0,
          sequence: 1,
          unlockingScript: UnlockingScript.fromASM('OP_FALSE')
        }
      ],
      [{ satoshis: 1, lockingScript: LockingScript.fromASM('OP_TRUE') }],
      0
    )
    expect(() =>
      manager.assertAuthorizedSignResult('input-reference', {}, { tx: changedUnlockingScript.toAtomicBEEF() })
    ).toThrow('substituted an existing unlocking script')

    const changedOutput = new Transaction(
      1,
      [
        {
          sourceTransaction: source,
          sourceOutputIndex: 0,
          sequence: 1,
          unlockingScript: UnlockingScript.fromASM('OP_TRUE')
        }
      ],
      [{ satoshis: 2, lockingScript: LockingScript.fromASM('OP_TRUE') }],
      0
    )
    expect(() =>
      manager.assertAuthorizedSignResult('input-reference', {}, { tx: changedOutput.toAtomicBEEF() })
    ).toThrow('substituted an authorized transaction output')

    for (const spends of [{ 0: { unlockingScript: undefined } }, { 0: { unlockingScript: 'not-hex' } }]) {
      expect(() => manager.assertAuthorizedSignResult('input-reference', spends, result)).toThrow(
        'substituted an authorized unlocking script'
      )
    }
    expect(() =>
      manager.assertAuthorizedSignResult('input-reference', { '9007199254740992': { unlockingScript: '51' } }, result)
    ).toThrow('Signed input index is invalid')
  })

  test('aborts and clears pending action state after signing fails or the caller aborts', async () => {
    const signFailure = new Error('storage refused to sign')
    const signAction = jest.fn().mockRejectedValue(signFailure)
    const abortAction = jest.fn().mockResolvedValue({ aborted: true })
    const manager = managerWith({ signAction, abortAction }) as any
    manager.pendingActionOriginators.set('failed-sign', 'example.com')
    manager.pendingActionTemplates.set('failed-sign', new Transaction())

    await expect(manager.signAction({ reference: 'failed-sign', spends: {} }, 'example.com')).rejects.toBe(signFailure)
    expect(abortAction).toHaveBeenCalledWith({ reference: 'failed-sign' })
    expect(manager.pendingActionOriginators.has('failed-sign')).toBe(false)
    expect(manager.pendingActionTemplates.has('failed-sign')).toBe(false)
    expect(manager.blockedActionReferences.has('failed-sign')).toBe(false)

    manager.pendingActionOriginators.set('caller-abort', 'example.com')
    manager.pendingActionTemplates.set('caller-abort', new Transaction())
    await expect(manager.abortAction({ reference: 'caller-abort' }, 'example.com')).resolves.toEqual({ aborted: true })
    expect(manager.pendingActionOriginators.has('caller-abort')).toBe(false)
    expect(manager.pendingActionTemplates.has('caller-abort')).toBe(false)
  })

  test('lets the admin originator abort actions this manager did not issue', async () => {
    const abortAction = jest.fn().mockResolvedValue({ aborted: true })
    const manager = managerWith({ abortAction }) as any

    await expect(manager.abortAction({ reference: 'earlier-session' }, 'admin.example')).resolves.toEqual({
      aborted: true
    })
    expect(abortAction).toHaveBeenCalledWith({ reference: 'earlier-session' }, 'admin.example')
  })

  test.each(['example.com', undefined])('refuses %s aborting an action it was not issued', async originator => {
    const abortAction = jest.fn().mockResolvedValue({ aborted: true })
    const manager = managerWith({ abortAction }) as any

    await expect(manager.abortAction({ reference: 'earlier-session' }, originator)).rejects.toThrow('not issued')
    manager.pendingActionOriginators.set('other-app', 'other.example')
    await expect(manager.abortAction({ reference: 'other-app' }, originator)).rejects.toThrow()
    expect(abortAction).not.toHaveBeenCalled()
  })

  test.each(['[broken', 'bad_host.example'])('rejects the malformed originator %s', originator => {
    const manager = managerWith() as any
    expect(() => manager.prepareOriginator(originator)).toThrow('valid')
  })
})
