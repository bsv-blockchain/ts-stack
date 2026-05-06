import WindowCWISubstrate from '../window.CWI'

const originator = 'example.com'

const methodCases = [
  {
    methodName: 'createAction',
    args: { description: 'Test description', inputs: [], outputs: [] },
    result: { txid: 'abc123' }
  },
  {
    methodName: 'signAction',
    args: { spends: {}, reference: 'someReference' },
    result: { txid: 'abc123' }
  },
  {
    methodName: 'abortAction',
    args: { reference: 'someReference' },
    result: { aborted: true }
  },
  {
    methodName: 'listActions',
    args: { labels: [] },
    result: { totalActions: 0, actions: [] }
  },
  {
    methodName: 'internalizeAction',
    args: { tx: 'someTx', outputs: [], description: 'Test description' },
    result: { accepted: true }
  },
  {
    methodName: 'listOutputs',
    args: { basket: 'someBasket' },
    result: { totalOutputs: 0, outputs: [] }
  },
  {
    methodName: 'relinquishOutput',
    args: { basket: 'someBasket', output: 'someOutput' },
    result: { relinquished: true }
  },
  {
    methodName: 'getPublicKey',
    args: { identityKey: true },
    result: { publicKey: 'somePubKey' }
  },
  {
    methodName: 'revealCounterpartyKeyLinkage',
    args: { counterparty: 'someCounterparty', verifier: 'someVerifier' },
    result: {
      prover: 'someProver',
      verifier: 'someVerifier',
      counterparty: 'someCounterparty',
      revelationTime: 'someTime',
      encryptedLinkage: [],
      encryptedLinkageProof: []
    }
  },
  {
    methodName: 'revealSpecificKeyLinkage',
    args: {
      counterparty: 'someCounterparty',
      verifier: 'someVerifier',
      protocolID: [0, 'someProtocol'],
      keyID: 'someKeyID'
    },
    result: {
      prover: 'someProver',
      verifier: 'someVerifier',
      counterparty: 'someCounterparty',
      protocolID: [0, 'someProtocol'],
      keyID: 'someKeyID',
      encryptedLinkage: [],
      encryptedLinkageProof: [],
      proofType: 1
    }
  },
  {
    methodName: 'encrypt',
    args: { plaintext: [], protocolID: [0, 'someProtocol'], keyID: 'someKeyID' },
    result: { ciphertext: [] }
  },
  {
    methodName: 'decrypt',
    args: { ciphertext: [], protocolID: [0, 'someProtocol'], keyID: 'someKeyID' },
    result: { plaintext: [] }
  },
  {
    methodName: 'createHmac',
    args: { data: [], protocolID: [0, 'someProtocol'], keyID: 'someKeyID' },
    result: { hmac: [] }
  },
  {
    methodName: 'verifyHmac',
    args: { data: [], hmac: [], protocolID: [0, 'someProtocol'], keyID: 'someKeyID' },
    result: { valid: true }
  },
  {
    methodName: 'createSignature',
    args: { data: [], protocolID: [0, 'someProtocol'], keyID: 'someKeyID' },
    result: { signature: [] }
  },
  {
    methodName: 'verifySignature',
    args: { data: [], signature: [], protocolID: [0, 'someProtocol'], keyID: 'someKeyID' },
    result: { valid: true }
  },
  {
    methodName: 'acquireCertificate',
    args: {
      type: 'someType',
      subject: 'someSubject',
      serialNumber: 'someSerialNumber',
      revocationOutpoint: 'someOutpoint',
      signature: 'someSignature',
      fields: {},
      certifier: 'someCertifier',
      keyringRevealer: 'certifier',
      keyringForSubject: {},
      acquisitionProtocol: 'direct'
    },
    result: {
      type: 'someType',
      subject: 'someSubject',
      serialNumber: 'someSerialNumber',
      certifier: 'someCertifier',
      revocationOutpoint: 'someOutpoint',
      signature: 'someSignature',
      fields: {}
    }
  },
  {
    methodName: 'listCertificates',
    args: { certifiers: [], types: [] },
    result: { totalCertificates: 0, certificates: [] }
  },
  {
    methodName: 'proveCertificate',
    args: {
      certificate: {
        type: 'someType',
        subject: 'someSubject',
        serialNumber: 'someSerialNumber',
        certifier: 'someCertifier',
        revocationOutpoint: 'someOutpoint',
        signature: 'someSignature',
        fields: {}
      },
      fieldsToReveal: [],
      verifier: 'someVerifier'
    },
    result: { keyringForVerifier: {} }
  },
  {
    methodName: 'relinquishCertificate',
    args: { type: 'someType', serialNumber: 'someSerialNumber', certifier: 'someCertifier' },
    result: { relinquished: true }
  },
  {
    methodName: 'discoverByIdentityKey',
    args: { identityKey: 'someIdentityKey' },
    result: { totalCertificates: 0, certificates: [] }
  },
  {
    methodName: 'discoverByAttributes',
    args: { attributes: {} },
    result: { totalCertificates: 0, certificates: [] }
  },
  {
    methodName: 'isAuthenticated',
    args: {},
    result: { authenticated: true }
  },
  {
    methodName: 'waitForAuthentication',
    args: {},
    result: { authenticated: true }
  },
  {
    methodName: 'getHeight',
    args: {},
    result: { height: 1000 }
  },
  {
    methodName: 'getHeaderForHeight',
    args: { height: 1000 },
    result: { header: 'someHeader' }
  },
  {
    methodName: 'getNetwork',
    args: {},
    result: { network: 'mainnet' }
  },
  {
    methodName: 'getVersion',
    args: {},
    result: { version: '1.0.0' }
  }
]

describe('WindowCWISubstrate', () => {
  let originalWindow: typeof global.window
  let mockCWI: Record<string, jest.Mock>

  beforeEach(() => {
    originalWindow = global.window
    mockCWI = Object.fromEntries(
      methodCases.map(({ methodName, result }) => [
        methodName,
        jest.fn().mockResolvedValue(result)
      ])
    )
    global.window = {
      CWI: mockCWI
    } as unknown as Window & typeof globalThis
  })

  afterEach(() => {
    global.window = originalWindow
    jest.restoreAllMocks()
  })

  it('throws if window is not available', () => {
    ;(global as any).window = undefined

    expect(() => new WindowCWISubstrate()).toThrow(
      'The window.CWI substrate requires a global window object.'
    )
  })

  it('throws if window.CWI is not bound', () => {
    delete (global.window as any).CWI

    expect(() => new WindowCWISubstrate()).toThrow(
      'The window.CWI interface does not appear to be bound to the window object.'
    )
  })

  it('binds the CWI object that exists at construction time', async () => {
    const substrate = new WindowCWISubstrate()
    const replacement = {
      getVersion: jest.fn().mockResolvedValue({ version: '2.0.0' })
    }
    ;(global.window as any).CWI = replacement

    await expect(substrate.getVersion({})).resolves.toEqual({ version: '1.0.0' })
    expect(mockCWI.getVersion).toHaveBeenCalledWith({}, undefined)
    expect(replacement.getVersion).not.toHaveBeenCalled()
  })

  test.each(methodCases)('delegates $methodName to window.CWI', async ({ methodName, args, result }) => {
    const substrate = new WindowCWISubstrate()

    await expect((substrate as any)[methodName](args, originator)).resolves.toEqual(result)
    expect(mockCWI[methodName]).toHaveBeenCalledWith(args, originator)
  })
})
