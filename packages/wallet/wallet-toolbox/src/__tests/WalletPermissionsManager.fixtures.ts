const { Telemetry, Validation, WERR_REVIEW_ACTIONS } = jest.requireActual('@bsv/sdk')

const existingFetch = (globalThis as any).fetch
if (existingFetch?._isMockFunction == null) {
  ;(globalThis as any).fetch = jest.fn(async () => ({
    ok: false,
    status: 404,
    json: async () => ({})
  }))
}

/**
 * A permissions manager testing mock/stub file for:
 *  1) The `@bsv/sdk` library: Transaction, LockingScript, PushDrop, Utils, Random, etc.
 *  2) A BRC-100 `WalletInterface` (the underlying wallet).
 *
 * This file bypasses real validation/logic in `@bsv/sdk`, returning placeholders and
 * stubs to prevent test-time errors such as "Invalid Atomic BEEF prefix."
 */

/* ---------------------------------------------------------------------------
 * 1) Partial Mocks for @bsv/sdk
 * ------------------------------------------------------------------------- */

/**
 * A minimal mock for `Transaction` that won't throw "Invalid Atomic BEEF prefix."
 * We override the static methods so they do not do real parsing/validation.
 */
export class MockTransaction {
  public version: number = 1
  public lockTime: number = 0
  public inputs: any[] = []
  public outputs: any[] = []
  public fee: number = 0
  private readonly txid = 'ab'.repeat(32)

  static fromAtomicBEEF(): void {
    // Mocked below
  }

  static fromBEEF(_beef: number[]): MockTransaction {
    // Same approach as above
    return new MockTransaction()
  }

  getFee(): number {
    return this.fee
  }

  toBEEF(): number[] {
    // Return an empty array for the BEEF representation
    return []
  }

  id(_encoding: 'hex'): string {
    return this.txid
  }
}

const mockTransactionsByAtomicBEEF = new WeakMap<number[], MockTransaction>()

;(MockTransaction as any).fromAtomicBEEF = jest.fn((beef: number[]) => {
  // Atomic BEEF is opaque to the permissions manager. Associate each mock byte
  // array with the transaction it represents so tests exercise the same
  // createAction contract without having to construct valid serialized BEEF.
  return mockTransactionsByAtomicBEEF.get(beef) ?? new MockTransaction()
})

/**
 * Mocks for `LockingScript`. If your code calls e.g. LockingScript.fromHex, we can just
 * store the hex and do nothing else.
 */
export class MockLockingScript {
  hex: string
  constructor(hex: string) {
    this.hex = hex
  }

  public toHex(): string {
    return this.hex
  }

  static fromHex(hex: string): MockLockingScript {
    return new MockLockingScript(hex)
  }
}

/**
 * Returns an opaque mock Atomic BEEF byte array that parses back to `tx`.
 *
 * Specialized tests can use this when they need to control fees or inputs on
 * the transaction returned by the underlying wallet.
 */
export function mockAtomicBEEF(tx: MockTransaction): number[] {
  const beef: number[] = []
  mockTransactionsByAtomicBEEF.set(beef, tx)
  return beef
}

/** Builds the transaction an underlying wallet would return for createAction. */
function mockCreateActionTransaction(args: any): MockTransaction {
  const tx = new MockTransaction()
  tx.inputs = (args.inputs ?? []).map((input: any) => {
    const match = /^([0-9a-f]{64})\.(\d+)$/i.exec(input.outpoint ?? '')
    return {
      sourceTXID: match?.[1]?.toLowerCase(),
      sourceOutputIndex: Number(match?.[2]),
      sourceTransaction:
        match == null
          ? undefined
          : {
              id: () => match[1].toLowerCase(),
              outputs: Array.from({ length: Number(match[2]) + 1 }, () => ({ satoshis: 1 }))
            },
      sequence: input.sequenceNumber ?? 0xffffffff,
      unlockingScript:
        input.unlockingScript == null ? new MockLockingScript('') : new MockLockingScript(input.unlockingScript)
    }
  })
  tx.outputs = (args.outputs ?? []).map((output: any) => ({
    lockingScript: new MockLockingScript(output.lockingScript),
    satoshis: output.satoshis
  }))
  return tx
}

async function mockCompleteBoundAction(
  wallet: any,
  args: any,
  options: { inputSigners?: Record<string, (tx: MockTransaction, index: number) => Promise<MockLockingScript>> } = {},
  originator?: string
): Promise<MockTransaction> {
  const created = await wallet.createAction(
    {
      ...args,
      options: { ...args.options, signAndProcess: false, returnTXIDOnly: false }
    },
    originator
  )
  const signable = created.signableTransaction
  const partial = (MockTransaction as any).fromAtomicBEEF(signable.tx) as MockTransaction
  const spends: Record<number, { unlockingScript: string }> = {}
  for (const [outpoint, signer] of Object.entries(options.inputSigners ?? {})) {
    const [txid, indexText] = outpoint.split('.')
    const inputIndex = partial.inputs.findIndex(
      input => input.sourceTXID === txid.toLowerCase() && input.sourceOutputIndex === Number(indexText)
    )
    if (inputIndex === -1) throw new Error('Mock wallet omitted requested input')
    const script = await signer(partial, inputIndex)
    spends[inputIndex] = { unlockingScript: script.toHex() }
  }
  const signed = await wallet.signAction({ reference: signable.reference, spends }, originator)
  return (MockTransaction as any).fromAtomicBEEF(signed.tx) as MockTransaction
}

/**
 * We stub out all methods: `decode()`, `lock()`, `unlock()`.
 */
export class MockPushDrop {
  // Typically we might store the wallet reference, but we can skip for now.

  // Decodes a LockingScript into some {fields: number[][], protocol...} or undefined
  static decode(script: MockLockingScript): { fields: number[][] } | undefined {
    // If you rely on a real format, parse or store a pattern.
    // For now, returning a minimal stub: empty fields
    if (script?.hex == null || script.hex === '') return undefined
    if (script.hex.includes('some script')) {
      // When needed, return some fields
      return {
        fields: [
          [],
          [],
          [],
          [],
          [],
          [],
          [] // 7 fields should always be enough...
        ]
      }
    }
    // Just pretend we always decode to a single empty field array
    return { fields: [] }
  }

  lock(
    _fields: number[][],
    _protocolID: [number, string],
    _keyID: string,
    _counterparty: string,
    _singleSignature: boolean,
    _anyoneCanPay: boolean
  ): MockLockingScript {
    return new MockLockingScript('deadbeef')
  }

  unlock(
    _protocolID: [number, string],
    _keyID: string,
    _counterparty: string,
    _sighashType: string,
    _enforceReplayProtection: boolean,
    _sigSize: number,
    _lockingScript: MockLockingScript
  ): {
    sign: (tx: MockTransaction, vin: number) => Promise<MockLockingScript>
  } {
    // In real usage, it would handle signature logic. We'll return a minimal stub.
    return {
      sign: async (_tx: MockTransaction, _vin: number) => {
        // produce a minimal unlocking script
        return new MockLockingScript('00')
      }
    }
  }
}

/**
 * Mocks for Utils, e.g. toHex, toUTF8, fromUTF8, etc.
 * We can provide minimal stubs that won't break your code.
 */
export const MockUtils = {
  toHex: (data: number[]) => {
    // Converts an array of numbers to a hexadecimal string.
    return data.map(num => num.toString(16).padStart(2, '0')).join('')
  },

  toArray: (str: string, encoding = 'utf8') => {
    // Converts a string to an array of numbers based on the encoding.
    if (encoding === 'hex') {
      const arr: number[] = []
      for (let i = 0; i < str.length; i += 2) {
        arr.push(Number.parseInt(str.slice(i, i + 2), 16))
      }
      return arr
    } else if (encoding === 'base64') {
      const binaryStr = atob(str)
      return Array.from(binaryStr, char => char.codePointAt(0))
    } else if (encoding === 'utf8') {
      return Array.from(str, char => char.codePointAt(0))
    } else {
      throw new Error('Unsupported encoding: ' + encoding)
    }
  },

  toUTF8: (arr: number[]) => {
    // Converts an array of numbers to a UTF-8 string.
    return String.fromCodePoint(...arr)
  },

  toUTF8Strict: (arr: number[]) => String.fromCodePoint(...arr),

  toBase64: (arr: number[]) => {
    // Converts an array of numbers to a Base64 string.
    const binaryStr = String.fromCodePoint(...arr)
    return btoa(binaryStr)
  }
}

/**
 * Mocks for Random
 */
export const MockRandom = (size: number): number[] => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return [...require('node:crypto').randomBytes(size)]
}

const MOCK_PERMISSION_LOCKING_KEY = `02${'99'.repeat(32)}`

function mockDecodeCanonicalPushDrop(script: MockLockingScript, limits: { fieldCount: number }): any {
  const decoded = MockPushDrop.decode(script)
  if (decoded == null) throw new Error('Invalid mock PushDrop script')
  const fields = [...decoded.fields]
  if (fields.length === limits.fieldCount - 1) fields.push([0x30, 0x00])
  if (fields.length !== limits.fieldCount) throw new Error('Unexpected mock PushDrop field count')
  return {
    fields,
    lockingPublicKey: { toString: () => MOCK_PERMISSION_LOCKING_KEY }
  }
}

const MockSignature = {
  fromDER: jest.fn(() => ({ verify: () => true }))
}

/**
 * Overriding the real classes with our mocks.
 */
export const MockedBsvSdk = {
  Transaction: MockTransaction,
  LockingScript: MockLockingScript,
  PushDrop: MockPushDrop,
  Utils: MockUtils,
  Random: MockRandom,
  Certificate: null,
  Telemetry,
  Validation,
  WERR_REVIEW_ACTIONS,
  completeBoundAction: mockCompleteBoundAction,
  createPublicHTTPSFetch: jest.fn(() => globalThis.fetch),
  decodeCanonicalPushDrop: mockDecodeCanonicalPushDrop,
  Signature: MockSignature
}

// Backward-compatible alias for consumers that have not yet been renamed
export { MockedBsvSdk as MockedBSV_SDK }

/* ---------------------------------------------------------------------------
 * 2) A full mock for the BRC-100 WalletInterface
 * ------------------------------------------------------------------------- */

/**
 * A helper function returning a Jest-mocked `WalletInterface`.
 * This ensures all required methods exist and return plausible values.
 *
 * - By default, `createAction` returns an opaque Atomic BEEF byte array backed
 *   by a mock transaction containing the caller-requested outputs. This models
 *   the wallet contract closely enough for output-substitution checks while
 *   still bypassing real BEEF serialization and validation.
 * - You can override or chain .mockResolvedValueOnce(...) inside individual tests
 *   if you want more specific behavior in certain test steps.
 */
export function mockUnderlyingWallet(): jest.Mocked<any> {
  const pending = new Map<string, MockTransaction>()
  let referenceCounter = 0
  const wallet = {
    getPublicKey: jest.fn().mockResolvedValue({ publicKey: MOCK_PERMISSION_LOCKING_KEY }),
    revealCounterpartyKeyLinkage: jest.fn().mockResolvedValue({
      encryptedLinkage: [1, 2, 3],
      encryptedLinkageProof: [4, 5, 6],
      prover: '02abcdef...',
      verifier: '02cccccc...',
      counterparty: '02bbbbbb...',
      revelationTime: new Date().toISOString()
    }),
    revealSpecificKeyLinkage: jest.fn().mockResolvedValue({
      encryptedLinkage: [1, 2, 3],
      encryptedLinkageProof: [4, 5, 6],
      prover: '02abcdef...',
      verifier: '02cccccc...',
      counterparty: '02bbbbbb...',
      protocolID: [1, 'test-protocol'],
      keyID: 'testKey',
      proofType: 1
    }),
    encrypt: jest.fn().mockResolvedValue({ ciphertext: [42, 42, 42, 42, 42, 42, 42] }),
    decrypt: jest.fn().mockResolvedValue({ plaintext: [42, 42, 42, 42, 42] }),
    createHmac: jest.fn().mockResolvedValue({ hmac: [0xaa] }),
    verifyHmac: jest.fn().mockResolvedValue({ valid: true }),
    createSignature: jest.fn().mockResolvedValue({ signature: [0x30, 0x44] }),
    verifySignature: jest.fn().mockResolvedValue({ valid: true }),

    createAction: jest.fn(async x => {
      const transaction = mockCreateActionTransaction(x)
      const tx = mockAtomicBEEF(transaction)
      if (x.options?.signAndProcess === true) {
        return {
          tx
        }
      }
      referenceCounter++
      const reference = referenceCounter === 1 ? 'mockReference' : `mockReference-${referenceCounter}`
      pending.set(reference, transaction)
      return {
        signableTransaction: {
          tx,
          reference
        }
      }
    }),
    signAction: jest.fn(async args => {
      const transaction = pending.get(args.reference)
      if (transaction == null) throw new Error('Unknown mock action reference')
      for (const [indexText, spend] of Object.entries(args.spends ?? {}) as Array<
        [string, { unlockingScript: string }]
      >) {
        transaction.inputs[Number(indexText)].unlockingScript = new MockLockingScript(spend.unlockingScript)
      }
      pending.delete(args.reference)
      return { txid: transaction.id('hex'), tx: mockAtomicBEEF(transaction) }
    }),
    abortAction: jest.fn(async args => {
      pending.delete(args.reference)
      return { aborted: true }
    }),
    listActions: jest.fn().mockResolvedValue({
      totalActions: 0,
      actions: []
    }),
    internalizeAction: jest.fn().mockResolvedValue({ accepted: true }),
    listOutputs: jest.fn().mockResolvedValue({
      totalOutputs: 0,
      outputs: []
    }),
    relinquishOutput: jest.fn().mockResolvedValue({ relinquished: true }),

    acquireCertificate: jest.fn().mockResolvedValue({
      type: 'some-cert-type',
      subject: '02aaaaaaaaaa...',
      serialNumber: 'serial123',
      certifier: '02ccccccccccc...',
      revocationOutpoint: 'sometxid.1',
      signature: 'deadbeef',
      fields: { name: 'Alice', dob: '1990-01-01' }
    }),
    listCertificates: jest.fn().mockResolvedValue({
      totalCertificates: 0,
      certificates: []
    }),
    proveCertificate: jest.fn().mockResolvedValue({
      keyringForVerifier: {},
      certificate: undefined,
      verifier: undefined
    }),
    relinquishCertificate: jest.fn().mockResolvedValue({ relinquished: true }),
    discoverByIdentityKey: jest.fn().mockResolvedValue({
      totalCertificates: 0,
      certificates: []
    }),
    discoverByAttributes: jest.fn().mockResolvedValue({
      totalCertificates: 0,
      certificates: []
    }),
    isAuthenticated: jest.fn().mockResolvedValue({ authenticated: true }),
    waitForAuthentication: jest.fn().mockResolvedValue({ authenticated: true }),
    getHeight: jest.fn().mockResolvedValue({ height: 777777 }),
    getHeaderForHeight: jest.fn().mockResolvedValue({
      header: '000000000000abc...'
    }),
    getNetwork: jest.fn().mockResolvedValue({ network: 'testnet' }),
    getVersion: jest.fn().mockResolvedValue({ version: 'vendor-1.0.0' })
  }
  return wallet
}
