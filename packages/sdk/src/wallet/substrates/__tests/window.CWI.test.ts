import WindowCWISubstrate from '../window.CWI'
import { Utils } from '../../../primitives/index'
import Transaction from '../../../transaction/Transaction'

const originator = 'example.com'
const VALID_PUBLIC_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const VALID_TXID = 'ab'.repeat(32)
const VALID_DER_SIGNATURE = [0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]
const VALID_TYPE = Utils.toBase64(Array(32).fill(1))
const VALID_SERIAL = Utils.toBase64(Array(32).fill(2))
const VALID_SIGNATURE_HEX = Utils.toHex(VALID_DER_SIGNATURE)
const MINIMAL_TRANSACTION = new Transaction()
const MINIMAL_BEEF = MINIMAL_TRANSACTION.toAtomicBEEF()
const MINIMAL_TXID = MINIMAL_TRANSACTION.id('hex')

const methodCases = [
  {
    methodName: 'createAction',
    args: { description: 'Test description', inputs: [], outputs: [] },
    result: { txid: MINIMAL_TXID, tx: MINIMAL_BEEF }
  },
  {
    methodName: 'signAction',
    args: { spends: {}, reference: 'cmVm' },
    result: { txid: MINIMAL_TXID, tx: MINIMAL_BEEF }
  },
  {
    methodName: 'abortAction',
    args: { reference: 'cmVm' },
    result: { aborted: true }
  },
  {
    methodName: 'listActions',
    args: { labels: [] },
    result: { totalActions: 0, actions: [] }
  },
  {
    methodName: 'internalizeAction',
    args: {
      tx: MINIMAL_BEEF,
      outputs: [
        {
          outputIndex: 0,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: 'AQ==',
            derivationSuffix: 'Ag==',
            senderIdentityKey: VALID_PUBLIC_KEY
          }
        }
      ],
      description: 'Test description'
    },
    result: { accepted: true }
  },
  {
    methodName: 'listOutputs',
    args: { basket: 'someBasket' },
    result: { totalOutputs: 0, outputs: [] }
  },
  {
    methodName: 'relinquishOutput',
    args: { basket: 'someBasket', output: `${VALID_TXID}.0` },
    result: { relinquished: true }
  },
  {
    methodName: 'getPublicKey',
    args: { identityKey: true },
    result: { publicKey: VALID_PUBLIC_KEY }
  },
  {
    methodName: 'revealCounterpartyKeyLinkage',
    args: { counterparty: VALID_PUBLIC_KEY, verifier: VALID_PUBLIC_KEY },
    result: {
      prover: VALID_PUBLIC_KEY,
      verifier: VALID_PUBLIC_KEY,
      counterparty: VALID_PUBLIC_KEY,
      revelationTime: '2026-09-16T00:00:00.000Z',
      encryptedLinkage: [],
      encryptedLinkageProof: []
    }
  },
  {
    methodName: 'revealSpecificKeyLinkage',
    args: {
      counterparty: VALID_PUBLIC_KEY,
      verifier: VALID_PUBLIC_KEY,
      protocolID: [0, 'someProtocol'],
      keyID: 'someKeyID'
    },
    result: {
      prover: VALID_PUBLIC_KEY,
      verifier: VALID_PUBLIC_KEY,
      counterparty: VALID_PUBLIC_KEY,
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
    result: { hmac: Array(32).fill(0) }
  },
  {
    methodName: 'verifyHmac',
    args: {
      data: [],
      hmac: Array(32).fill(0),
      protocolID: [0, 'someProtocol'],
      keyID: 'someKeyID'
    },
    result: { valid: true }
  },
  {
    methodName: 'createSignature',
    args: { data: [], protocolID: [0, 'someProtocol'], keyID: 'someKeyID' },
    result: { signature: VALID_DER_SIGNATURE }
  },
  {
    methodName: 'verifySignature',
    args: {
      data: [],
      signature: VALID_DER_SIGNATURE,
      protocolID: [0, 'someProtocol'],
      keyID: 'someKeyID'
    },
    result: { valid: true }
  },
  {
    methodName: 'acquireCertificate',
    args: {
      type: VALID_TYPE,
      subject: VALID_PUBLIC_KEY,
      serialNumber: VALID_SERIAL,
      revocationOutpoint: `${VALID_TXID}.0`,
      signature: VALID_SIGNATURE_HEX,
      fields: {},
      certifier: VALID_PUBLIC_KEY,
      keyringRevealer: 'certifier',
      keyringForSubject: {},
      acquisitionProtocol: 'direct'
    },
    result: {
      type: VALID_TYPE,
      subject: VALID_PUBLIC_KEY,
      serialNumber: VALID_SERIAL,
      certifier: VALID_PUBLIC_KEY,
      revocationOutpoint: `${VALID_TXID}.0`,
      signature: VALID_SIGNATURE_HEX,
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
        type: VALID_TYPE,
        subject: VALID_PUBLIC_KEY,
        serialNumber: VALID_SERIAL,
        certifier: VALID_PUBLIC_KEY,
        revocationOutpoint: `${VALID_TXID}.0`,
        signature: VALID_SIGNATURE_HEX,
        fields: {}
      },
      fieldsToReveal: [],
      verifier: VALID_PUBLIC_KEY
    },
    result: { keyringForVerifier: {} }
  },
  {
    methodName: 'relinquishCertificate',
    args: { type: VALID_TYPE, serialNumber: VALID_SERIAL, certifier: VALID_PUBLIC_KEY },
    result: { relinquished: true }
  },
  {
    methodName: 'discoverByIdentityKey',
    args: { identityKey: VALID_PUBLIC_KEY },
    result: { totalCertificates: 0, certificates: [] }
  },
  {
    methodName: 'discoverByAttributes',
    args: { attributes: { name: 'Alice' } },
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
    result: { header: '00'.repeat(80) }
  },
  {
    methodName: 'getNetwork',
    args: {},
    result: { network: 'mainnet' }
  },
  {
    methodName: 'getVersion',
    args: {},
    result: { version: '1.0.0.0' }
  }
]

describe('WindowCWISubstrate', () => {
  let originalWindow: typeof global.window
  let mockCWI: Record<string, jest.Mock>

  beforeEach(() => {
    originalWindow = global.window
    mockCWI = Object.fromEntries(
      methodCases.map(({ methodName, result }) => [methodName, jest.fn().mockResolvedValue(result)])
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
      getVersion: jest.fn().mockResolvedValue({ version: '2.0.0.0' })
    }
    ;(global.window as any).CWI = replacement

    await expect(substrate.getVersion({})).resolves.toEqual({ version: '1.0.0.0' })
    expect(mockCWI.getVersion).toHaveBeenCalledWith({}, undefined)
    expect(replacement.getVersion).not.toHaveBeenCalled()
  })

  test.each(methodCases)(
    'delegates $methodName to window.CWI',
    async ({ methodName, args, result }) => {
      const substrate = new WindowCWISubstrate()

      await expect((substrate as any)[methodName](args, originator)).resolves.toEqual(result)
      expect(mockCWI[methodName]).toHaveBeenCalledWith(args, originator)
    }
  )

  it('rejects a malformed security-critical result from window.CWI', async () => {
    mockCWI.verifySignature.mockResolvedValue({ valid: false })
    const substrate = new WindowCWISubstrate()

    await expect(
      substrate.verifySignature({
        data: [],
        signature: VALID_DER_SIGNATURE,
        protocolID: [1, 'test protocol'],
        keyID: '1'
      })
    ).rejects.toThrow('valid')
  })

  it('rejects a result page larger than the requested default limit', async () => {
    mockCWI.listOutputs.mockResolvedValue({
      totalOutputs: 11,
      outputs: Array(11).fill(null)
    })
    const substrate = new WindowCWISubstrate()

    await expect(substrate.listOutputs({ basket: 'someBasket' })).rejects.toThrow(
      'at most the requested limit of 10'
    )
  })
})
