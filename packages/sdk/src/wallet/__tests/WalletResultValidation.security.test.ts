import {
  assertSafeWalletJSONValue,
  assertSafeWalletValue,
  snapshotWalletResultRequest,
  validateWalletResult
} from '../WalletResultValidation.js'
import ExactByteCache from '../ExactByteCache.js'
import { jest } from '@jest/globals'
import { normalizeBRC100WalletByteFields } from '../BRC100ByteEncoding.js'
import Transaction from '../../transaction/Transaction.js'
import Beef from '../../transaction/Beef.js'
import Script from '../../script/Script.js'

const PUBLIC_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const OTHER_PUBLIC_KEY = '0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const TYPE = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
const OTHER_TYPE = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI='
const CERTIFICATE = {
  type: TYPE,
  serialNumber: OTHER_TYPE,
  subject: PUBLIC_KEY,
  certifier: PUBLIC_KEY,
  revocationOutpoint: `${'ab'.repeat(32)}.0`,
  fields: {},
  signature: '3006020101020101'
}
const TRANSACTION = new Transaction()
const ATOMIC_BEEF = TRANSACTION.toAtomicBEEF()
const TRANSACTION_ID = TRANSACTION.id('hex')
const LISTED_TRANSACTION = new Transaction(
  1,
  [],
  [{ satoshis: 42, lockingScript: Script.fromASM('OP_TRUE') }],
  0
)
const LISTED_TRANSACTION_ID = LISTED_TRANSACTION.id('hex')
const LISTED_TRANSACTION_BEEF = LISTED_TRANSACTION.toBEEF()

function actionTransaction(
  satoshis = 42,
  lockingScript = Script.fromASM('OP_TRUE'),
  version = 1,
  lockTime = 0
): Transaction {
  return new Transaction(version, [], [{ satoshis, lockingScript }], lockTime)
}

function fundedActionTransaction(
  satoshis = 42,
  lockingScript = Script.fromASM('OP_TRUE'),
  version = 1,
  lockTime = 0
): Transaction {
  const source = actionTransaction(satoshis)
  const transaction = actionTransaction(satoshis, lockingScript, version, lockTime)
  transaction.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  return transaction
}

describe('wallet result trust boundary', () => {
  it.each([
    ['internalizeAction', { accepted: false }, 'accepted'],
    ['relinquishOutput', { relinquished: false }, 'relinquished'],
    ['relinquishCertificate', {}, 'relinquished'],
    ['verifyHmac', { valid: false }, 'valid'],
    ['verifySignature', { valid: 'true' }, 'valid'],
    ['isAuthenticated', { authenticated: false }, 'authenticated'],
    ['waitForAuthentication', { authenticated: 1 }, 'authenticated']
  ] as const)('rejects a non-affirmative %s result', (call, result, field) => {
    expect(() => validateWalletResult(call, result)).toThrow(field)
  })

  it('preserves an explicit abort refusal but rejects a coerced flag', () => {
    expect(validateWalletResult('abortAction', { aborted: false })).toEqual({ aborted: false })
    expect(() => validateWalletResult('abortAction', { aborted: 0 })).toThrow('aborted')
  })

  it.each([
    ['createHmac', { hmac: [1, 2] }],
    ['createSignature', { signature: [1, 2] }],
    ['getPublicKey', { publicKey: `04${'00'.repeat(32)}` }],
    ['getHeaderForHeight', { header: '00'.repeat(79) }],
    ['getNetwork', { network: 'regtest' }]
  ] as const)('rejects a malformed %s cryptographic or chain result', (call, result) => {
    expect(() => validateWalletResult(call, result)).toThrow(`Invalid ${call} result`)
  })

  it('does not reuse cached Atomic BEEF validation after the result bytes change', () => {
    const tx = Uint8Array.from(ATOMIC_BEEF)
    const result = { txid: TRANSACTION_ID, tx }

    expect(validateWalletResult('createAction', result)).toEqual(result)
    tx[0] ^= 0xff
    expect(() => validateWalletResult('createAction', result)).toThrow(
      'Invalid createAction result'
    )
  })

  it('does not equate different cached bytes when Buffer.compare is poisoned after an await', async () => {
    if (typeof Buffer === 'undefined') return
    const cache = new ExactByteCache<string>()
    cache.set(new Uint8Array([1, 2, 3]), 'cached value')
    await Promise.resolve()
    const original = Object.getOwnPropertyDescriptor(Buffer, 'compare')!
    let cached: string | undefined
    try {
      Object.defineProperty(Buffer, 'compare', {
        ...original,
        value() {
          return 0
        }
      })
      cached = cache.get(new Uint8Array([1, 2, 4]))
    } finally {
      Object.defineProperty(Buffer, 'compare', original)
    }

    expect(cached).toBeUndefined()
  })

  it('returns an owned result snapshot that the substrate cannot mutate later', () => {
    const tx = Uint8Array.from(ATOMIC_BEEF)
    const result = {
      txid: TRANSACTION_ID,
      tx,
      metadata: { labels: ['original'] }
    }
    const owned = validateWalletResult('createAction', result)

    result.txid = 'ab'.repeat(32)
    tx[0] ^= 0xff
    result.metadata.labels[0] = 'mutated'

    expect(owned).not.toBe(result)
    expect(owned.tx).not.toBe(tx)
    expect(owned.txid).toBe(TRANSACTION_ID)
    expect(Array.from(owned.tx)).toEqual(ATOMIC_BEEF)
    expect(owned.metadata.labels).toEqual(['original'])
  })

  it('preserves repeated byte aliases without copying them repeatedly', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const owned = validateWalletResult('getVersion', {
      version: 'wallet-1.0',
      first: bytes,
      second: bytes
    })

    expect(owned.first).not.toBe(bytes)
    expect(owned.first).toBe(owned.second)
  })

  it('uses captured WeakMap intrinsics when the shared realm poisons its prototype', () => {
    const original = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'get')!
    const result = { version: 'wallet-1.0', metadata: { owner: 'caller' } }
    let owned: typeof result | undefined
    try {
      Object.defineProperty(WeakMap.prototype, 'get', {
        ...original,
        value(_key: object) {
          return _key
        }
      })
      owned = validateWalletResult('getVersion', result)
    } finally {
      Object.defineProperty(WeakMap.prototype, 'get', original)
    }

    expect(owned).not.toBe(result)
    expect(owned?.metadata).not.toBe(result.metadata)
    expect(owned).toEqual(result)
  })

  it('ignores inherited fields during validation while preserving ordinary result objects', () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'tx')
    let owned:
      | { txid: string; tx?: number[]; note?: string; hasOwnProperty(key: PropertyKey): boolean }
      | undefined
    try {
      Object.defineProperty(Object.prototype, 'tx', {
        value: [1, 2, 3],
        configurable: true
      })
      owned = validateWalletResult(
        'createAction',
        { txid: TRANSACTION_ID },
        { options: { returnTXIDOnly: true } }
      ) as typeof owned
    } finally {
      if (previous == null) Reflect.deleteProperty(Object.prototype, 'tx')
      else Object.defineProperty(Object.prototype, 'tx', previous)
    }

    expect(owned).toBeDefined()
    expect(Object.getPrototypeOf(owned)).toBe(Object.prototype)
    expect(owned).toBeInstanceOf(Object)
    expect(Object.hasOwn(owned!, 'tx')).toBe(false)
    expect(owned!.hasOwnProperty('tx')).toBe(false)
    expect(owned!.tx).toBeUndefined()
    owned!.note = 'local annotation'
    expect(owned!.note).toBe('local annotation')
    expect(Object.hasOwn(owned!, 'note')).toBe(true)
  })

  it('rejects shared byte storage that could change during validation', () => {
    if (typeof SharedArrayBuffer === 'undefined') return
    const tx = new Uint8Array(new SharedArrayBuffer(ATOMIC_BEEF.length))
    tx.set(ATOMIC_BEEF)

    expect(() => validateWalletResult('createAction', { txid: TRANSACTION_ID, tx })).toThrow(
      'unshared Uint8Array'
    )
  })

  it('accepts an exactly framed ordinary BEEF action result and binds its txid', () => {
    const transaction = fundedActionTransaction()
    const result = { txid: transaction.id('hex'), tx: transaction.toBEEF() }

    expect(validateWalletResult('createAction', result)).toEqual(result)
    expect(() =>
      validateWalletResult('createAction', { ...result, txid: 'ab'.repeat(32) })
    ).toThrow('matching txid')
  })

  it('selects the explicitly identified transaction from a multi-transaction ordinary BEEF', () => {
    const requested = fundedActionTransaction(42)
    const unrelated = fundedActionTransaction(43)
    const beef = new Beef()
    beef.mergeTransaction(requested)
    beef.mergeTransaction(unrelated)
    const result = { txid: requested.id('hex'), tx: beef.toBinary() }

    expect(validateWalletResult('createAction', result)).toEqual(result)
  })

  it('rejects prototype-sensitive keys anywhere in an untrusted result', () => {
    const result = JSON.parse('{"version":"wallet-1.0.0","nested":{"__proto__":{"admin":true}}}')
    expect(() => validateWalletResult('getVersion', result)).toThrow('safe record key')
  })

  it('rejects objects with a caller-controlled prototype', () => {
    const result = Object.create({ admin: true }) as Record<string, unknown>
    result.version = 'wallet-1.0.0'
    expect(() => validateWalletResult('getVersion', result)).toThrow('object prototype')
  })

  it('does not accept an inherited affirmative authentication verdict', () => {
    const attackerPrototype = Object.create(null) as Record<string, unknown>
    attackerPrototype.authenticated = true
    const result = Object.create(attackerPrototype) as Record<string, unknown>

    expect(() => validateWalletResult('isAuthenticated', result)).toThrow('object prototype')
  })

  it.each([
    ['abortAction', 'aborted'],
    ['internalizeAction', 'accepted'],
    ['relinquishOutput', 'relinquished'],
    ['relinquishCertificate', 'relinquished'],
    ['verifyHmac', 'valid'],
    ['verifySignature', 'valid'],
    ['isAuthenticated', 'authenticated'],
    ['waitForAuthentication', 'authenticated'],
    ['getNetwork', 'network']
  ] as const)('rejects ambient prototype pollution for %s result field %s', (call, field) => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, field)
    let thrown: unknown
    try {
      Object.defineProperty(Object.prototype, field, {
        value: field === 'network' ? 'mainnet' : true,
        configurable: true,
        enumerable: false,
        writable: true
      })
      try {
        validateWalletResult(call, {})
      } catch (error) {
        thrown = error
      }
    } finally {
      if (previous == null) Reflect.deleteProperty(Object.prototype, field)
      else Object.defineProperty(Object.prototype, field, previous)
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain(field)
  })

  it('does not let an array override entries to bypass record validation', () => {
    const outputs = [
      {
        outpoint: 'not-an-outpoint',
        satoshis: -1,
        spendable: 'yes'
      }
    ]
    Object.defineProperty(outputs, 'entries', {
      value: function* () {},
      enumerable: false
    })

    expect(() =>
      validateWalletResult('listOutputs', { totalOutputs: 1, outputs }, { limit: 1 })
    ).toThrow('dense standard array')
  })

  it('rejects sparse byte arrays', () => {
    const hmac: number[] = []
    hmac.length = 32
    hmac[31] = 0
    expect(() => validateWalletResult('createHmac', { hmac })).toThrow('dense standard array')
  })

  it('rejects oversized result and nested collection shapes before schema iteration', () => {
    const oversizedArray: unknown[] = []
    oversizedArray.length = 1_000_001
    expect(() => assertSafeWalletValue(oversizedArray, 'test')).toThrow(
      'array length: expected at most 1000000 entries'
    )

    expect(() =>
      validateWalletResult(
        'listOutputs',
        {
          totalOutputs: 1,
          outputs: [
            {
              outpoint: `${LISTED_TRANSACTION_ID}.0`,
              satoshis: 42,
              spendable: true,
              tags: Array.from({ length: 100_001 }, () => 'tag')
            }
          ]
        },
        { basket: 'test', includeTags: true, limit: 1 }
      )
    ).toThrow('at most 100000 entries')
  })

  it('does not let inherited Array methods skip result validation', () => {
    const original = Object.getOwnPropertyDescriptor(Array.prototype, 'entries')
    Object.defineProperty(Array.prototype, 'entries', {
      value: function* () {},
      configurable: true,
      writable: true
    })
    try {
      expect(() =>
        validateWalletResult('listOutputs', { totalOutputs: 1, outputs: [{}] }, { limit: 1 })
      ).toThrow('outpoint')
    } finally {
      if (original == null) Reflect.deleteProperty(Array.prototype, 'entries')
      else Object.defineProperty(Array.prototype, 'entries', original)
    }
  })

  it('accepts legacy number-array byte results above the structural graph cap', () => {
    const ciphertext = Array<number>(1_000_001).fill(1)
    const owned = validateWalletResult('encrypt', { ciphertext })

    expect(owned.ciphertext).toHaveLength(1_000_001)
    expect(owned.ciphertext).not.toBe(ciphertext)
    expect(owned.ciphertext[1_000_000]).toBe(1)
  })

  it('owns historical ciphertext and transaction bytes above the structural graph cap', () => {
    const historical = Object.create(null) as Record<string, number>
    for (let index = 0; index < 1_000_001; index++) historical[String(index)] = index & 0xff

    const owned = assertSafeWalletJSONValue(
      { ciphertext: historical, tx: historical },
      'HTTPWalletJSON encrypt raw response'
    ) as { ciphertext: number[]; tx: number[] }
    expect(Array.isArray(owned.ciphertext)).toBe(true)
    expect(owned.ciphertext).toHaveLength(1_000_001)
    expect(owned.ciphertext[1_000_000]).toBe(64)
    expect(owned.tx).toBe(owned.ciphertext)
  })

  it('keeps generic numeric-key wallet data as records regardless of field names', () => {
    const numericRecord = { 0: 7, 1: 8 }
    const owned = assertSafeWalletValue(
      { metadata: numericRecord, data: numericRecord, payload: numericRecord, tx: numericRecord },
      'wallet metadata'
    ) as Record<string, Record<string, number>>

    for (const field of ['metadata', 'data', 'payload', 'tx']) {
      expect(Array.isArray(owned[field])).toBe(false)
      expect(Object.getPrototypeOf(owned[field])).toBe(Object.prototype)
      expect(owned[field]).toEqual({ 0: 7, 1: 8 })
    }
  })

  it('recovers historical bytes only in the specialized HTTP wallet snapshot', () => {
    const numericRecord = { 0: 7, 1: 8 }
    const owned = assertSafeWalletJSONValue(
      { metadata: numericRecord, ciphertext: numericRecord },
      'HTTPWalletJSON raw response'
    ) as { metadata: Record<string, number>; ciphertext: number[] }

    expect(Array.isArray(owned.metadata)).toBe(false)
    expect(owned.ciphertext).toEqual([7, 8])
  })

  it('captures each byte descriptor once when hostile proxies change later answers', () => {
    let arrayDescriptorReads = 0
    const array = new Proxy([7], {
      getOwnPropertyDescriptor(target, key) {
        if (key === '0') {
          arrayDescriptorReads++
          return {
            value: arrayDescriptorReads === 1 ? 7 : 256,
            enumerable: true,
            configurable: true,
            writable: true
          }
        }
        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    })
    let recordDescriptorReads = 0
    const historical = new Proxy(
      { 0: 9 },
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === '0') {
            recordDescriptorReads++
            return {
              value: recordDescriptorReads === 1 ? 9 : 256,
              enumerable: true,
              configurable: true,
              writable: true
            }
          }
          return Reflect.getOwnPropertyDescriptor(target, key)
        }
      }
    )

    const owned = assertSafeWalletJSONValue(
      { plaintext: array, ciphertext: historical },
      'flipping wallet bytes'
    ) as { plaintext: number[]; ciphertext: number[] }

    expect(owned.plaintext).toEqual([7])
    expect(owned.ciphertext).toEqual([9])
    expect(arrayDescriptorReads).toBe(1)
    expect(recordDescriptorReads).toBe(1)
  })

  it('requires explicitly requested action-history labels, inputs, outputs, and scripts', () => {
    const action = {
      txid: 'ab'.repeat(32),
      satoshis: 1,
      status: 'completed',
      isOutgoing: false,
      description: 'Complete action history',
      labels: ['reviewed'],
      version: 1,
      lockTime: 0,
      inputs: [
        {
          sourceOutpoint: `${'cd'.repeat(32)}.0`,
          sourceSatoshis: 1,
          sourceLockingScript: '51',
          unlockingScript: '51',
          inputDescription: 'Reviewed source input',
          sequenceNumber: 0xffffffff
        }
      ],
      outputs: [
        {
          satoshis: 1,
          lockingScript: '51',
          spendable: true,
          tags: [],
          outputIndex: 0,
          outputDescription: 'Reviewed action output',
          basket: 'default'
        }
      ]
    }
    const request = {
      labels: ['reviewed'],
      includeLabels: true,
      includeInputs: true,
      includeInputSourceLockingScripts: true,
      includeInputUnlockingScripts: true,
      includeOutputs: true,
      includeOutputLockingScripts: true,
      limit: 1
    }
    const result = { totalActions: 1, actions: [action] }

    expect(validateWalletResult('listActions', result, request)).toEqual(result)
    for (const [field, value] of [
      ['labels', undefined],
      ['labels', ['substituted']],
      ['inputs', undefined],
      ['outputs', undefined]
    ] as const) {
      expect(() =>
        validateWalletResult(
          'listActions',
          { totalActions: 1, actions: [{ ...action, [field]: value }] },
          request
        )
      ).toThrow(`actions[0].${field}`)
    }
    expect(() =>
      validateWalletResult(
        'listActions',
        {
          totalActions: 1,
          actions: [
            {
              ...action,
              inputs: [{ ...action.inputs[0], sourceLockingScript: undefined }]
            }
          ]
        },
        request
      )
    ).toThrow('sourceLockingScript')
    expect(() =>
      validateWalletResult(
        'listActions',
        {
          totalActions: 1,
          actions: [
            {
              ...action,
              outputs: [{ ...action.outputs[0], lockingScript: undefined }]
            }
          ]
        },
        request
      )
    ).toThrow('lockingScript')
  })

  it.each([
    ['createAction', { txid: 'ab'.repeat(32), tx: [1, 2, 3] }],
    ['createAction', { signableTransaction: { tx: [1, 2, 3], reference: 'cmVm' } }],
    ['signAction', { txid: 'ab'.repeat(32), tx: [1, 2, 3] }],
    ['listOutputs', { totalOutputs: 0, outputs: [], BEEF: [1, 2, 3] }]
  ] as const)(
    'rejects malformed or ambiguously framed transaction data from %s',
    (call, result) => {
      expect(() => validateWalletResult(call, result)).toThrow(/BEEF/)
    }
  )

  it('binds action outcomes to the returned envelope and submitted batch', () => {
    expect(() =>
      validateWalletResult('createAction', { txid: 'ab'.repeat(32), tx: ATOMIC_BEEF })
    ).toThrow('matching txid')
    expect(() => validateWalletResult('createAction', {})).toThrow('outcome')
    expect(() =>
      validateWalletResult('createAction', {
        txid: TRANSACTION_ID,
        noSendChange: [`${'ab'.repeat(32)}.0`]
      })
    ).toThrow('returned transaction')
    expect(() =>
      validateWalletResult(
        'createAction',
        {
          txid: TRANSACTION_ID,
          sendWithResults: [{ txid: 'ab'.repeat(32), status: 'sending' }]
        },
        { options: { sendWith: ['cd'.repeat(32)] } }
      )
    ).toThrow('submitted or returned transaction')
  })

  it('binds returned create-action transactions to every caller-requested output', () => {
    const transaction = fundedActionTransaction()
    const result = { txid: transaction.id('hex'), tx: transaction.toAtomicBEEF() }
    const request = {
      description: 'Bound payment output',
      outputs: [
        {
          satoshis: 42,
          lockingScript: '51',
          outputDescription: 'Required payment output'
        }
      ]
    }

    expect(validateWalletResult('createAction', result, request)).toEqual(result)
    expect(() =>
      validateWalletResult('createAction', result, {
        ...request,
        outputs: [{ ...request.outputs[0], satoshis: 43 }]
      })
    ).toThrow('every requested output')
    expect(() => validateWalletResult('createAction', result, { ...request, version: 2 })).toThrow(
      'requested transaction version'
    )
    expect(() => validateWalletResult('createAction', result, { ...request, lockTime: 1 })).toThrow(
      'requested transaction lock time'
    )
  })

  it('preserves requested output positions when output randomization is disabled', () => {
    const source = actionTransaction(3)
    const transaction = new Transaction(
      1,
      [
        {
          sourceTransaction: source,
          sourceOutputIndex: 0,
          unlockingScript: Script.fromASM('OP_TRUE')
        }
      ],
      [
        { satoshis: 2, lockingScript: Script.fromASM('OP_2') },
        { satoshis: 1, lockingScript: Script.fromASM('OP_1') }
      ],
      0
    )
    const result = { txid: transaction.id('hex'), tx: transaction.toAtomicBEEF() }
    const outputs = [
      { satoshis: 1, lockingScript: '51', outputDescription: 'first' },
      { satoshis: 2, lockingScript: '52', outputDescription: 'second' }
    ]

    expect(
      validateWalletResult('createAction', result, {
        description: 'Randomized compatible action',
        outputs
      })
    ).toEqual(result)
    expect(() =>
      validateWalletResult('createAction', result, {
        description: 'Position-bound action',
        outputs,
        options: { randomizeOutputs: false }
      })
    ).toThrow('requested output at the requested position')
  })

  it('rejects action results whose outputs exceed their evidenced inputs', () => {
    const source = actionTransaction(1)
    const inflationary = actionTransaction(2)
    inflationary.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_1')
    })
    const result = { txid: inflationary.id('hex'), tx: inflationary.toAtomicBEEF() }

    expect(() =>
      validateWalletResult('createAction', result, {
        description: 'Inflationary wallet result',
        outputs: [{ satoshis: 2, lockingScript: '51', outputDescription: 'invalid' }]
      })
    ).toThrow('total value no greater than the transaction inputs')
    expect(() =>
      validateWalletResult('signAction', result, { reference: 'cmVm', spends: {} })
    ).toThrow('total value no greater than the transaction inputs')
  })

  it.each([
    ['createAction', undefined],
    ['signAction', { reference: 'cmVm', spends: {} }]
  ] as const)(
    'rejects duplicate direct input outpoints in completed %s results',
    (call, request) => {
      const source = actionTransaction(1)
      const transaction = actionTransaction(2)
      transaction.addInput({
        sourceTransaction: source,
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_1')
      })
      transaction.addInput({
        sourceTransaction: source,
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_1')
      })
      const result = { txid: transaction.id('hex'), tx: transaction.toAtomicBEEF() }

      expect(() => validateWalletResult(call, result, request)).toThrow(
        'a unique transaction input outpoint'
      )
    }
  )

  it('uses request input BEEF to reject value creation hidden by a partial result', () => {
    const source = actionTransaction(1)
    const transaction = actionTransaction(2)
    transaction.addInput({
      sourceTXID: source.id('hex'),
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_1')
    })
    const result = { txid: transaction.id('hex'), tx: transaction.toAtomicBEEF(true) }
    const request = {
      description: 'Request-evidenced input value',
      inputBEEF: source.toBEEF(),
      inputs: [
        {
          outpoint: `${source.id('hex')}.0`,
          inputDescription: 'One satoshi source',
          unlockingScript: '51'
        }
      ],
      outputs: [{ satoshis: 2, lockingScript: '51', outputDescription: 'Invalid output' }]
    }

    expect(() => validateWalletResult('createAction', result, request)).toThrow(
      'total value no greater than the transaction inputs'
    )
  })

  it.each(['partial Atomic BEEF', 'TXID-only Atomic BEEF', 'ordinary BEEF'] as const)(
    'preserves %s completed results when the request supplies source-value evidence',
    encoding => {
      const source = actionTransaction(1)
      const transaction = actionTransaction(1)
      transaction.addInput({
        sourceTXID: source.id('hex'),
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_1')
      })
      const tx = (() => {
        if (encoding === 'partial Atomic BEEF') return transaction.toAtomicBEEF(true)
        if (encoding === 'ordinary BEEF') return transaction.toBEEF(true)
        const beef = new Beef()
        beef.mergeTxidOnly(source.id('hex'))
        beef.mergeRawTx(transaction.toUint8Array())
        return beef.toBinaryAtomic(transaction.id('hex'))
      })()
      const result = { txid: transaction.id('hex'), tx }
      const request = {
        description: 'Request-evidenced partial result',
        inputBEEF: source.toBEEF(),
        inputs: [
          {
            outpoint: `${source.id('hex')}.0`,
            inputDescription: 'One satoshi source',
            unlockingScript: '51'
          }
        ],
        outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'Valid output' }]
      }

      expect(validateWalletResult('createAction', result, request)).toEqual(result)
    }
  )

  it('preserves captured create-action source evidence across repeated request snapshots', () => {
    const source = actionTransaction(1)
    const transaction = actionTransaction(1)
    transaction.addInput({
      sourceTXID: source.id('hex'),
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_1')
    })
    const request = {
      description: 'Request-evidenced partial result',
      inputBEEF: source.toBEEF(),
      inputs: [
        {
          outpoint: `${source.id('hex')}.0`,
          inputDescription: 'One satoshi source',
          unlockingScript: '51'
        }
      ],
      outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'Valid output' }]
    }
    const firstSnapshot = snapshotWalletResultRequest('createAction', request)
    const secondSnapshot = snapshotWalletResultRequest('createAction', firstSnapshot)
    const result = {
      txid: transaction.id('hex'),
      tx: transaction.toAtomicBEEF(true)
    }

    expect(validateWalletResult('createAction', result, secondSnapshot)).toEqual(result)
  })

  it.each(['partial Atomic BEEF', 'TXID-only Atomic BEEF', 'ordinary BEEF'] as const)(
    'rejects an unresolved completed %s result',
    encoding => {
      const source = actionTransaction(1)
      const transaction = actionTransaction(1)
      transaction.addInput({
        sourceTXID: source.id('hex'),
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_1')
      })
      const tx = (() => {
        if (encoding === 'partial Atomic BEEF') return transaction.toAtomicBEEF(true)
        if (encoding === 'ordinary BEEF') return transaction.toBEEF(true)
        const beef = new Beef()
        beef.mergeTxidOnly(source.id('hex'))
        beef.mergeRawTx(transaction.toUint8Array())
        return beef.toBinaryAtomic(transaction.id('hex'))
      })()

      expect(() =>
        validateWalletResult(
          'createAction',
          { txid: transaction.id('hex'), tx },
          {
            description: 'Unresolved completed result',
            inputs: [
              {
                outpoint: `${source.id('hex')}.0`,
                inputDescription: 'Unresolved source input',
                unlockingScript: '51'
              }
            ],
            outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'Output' }]
          }
        )
      ).toThrow('source transaction evidence for every completed transaction input')
    }
  )

  it('allows unresolved source values only while createAction remains deferred', () => {
    const sourceTXID = 'ab'.repeat(32)
    const transaction = actionTransaction(1)
    transaction.addInput({
      sourceTXID,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_1')
    })
    const tx = transaction.toAtomicBEEF(true)
    const input = {
      outpoint: `${sourceTXID}.0`,
      inputDescription: 'Deferred legacy source',
      unlockingScriptLength: 1
    }
    const outputs = [{ satoshis: 1, lockingScript: '51', outputDescription: 'Deferred output' }]
    const signable = { signableTransaction: { tx, reference: 'cmVm' } }

    expect(
      validateWalletResult('createAction', signable, {
        description: 'Deferred partial result',
        inputs: [input],
        outputs,
        options: { signAndProcess: false }
      })
    ).toEqual(signable)
    expect(() =>
      validateWalletResult(
        'createAction',
        { txid: transaction.id('hex'), tx },
        {
          description: 'Completed partial result',
          inputs: [{ ...input, unlockingScript: '51' }],
          outputs
        }
      )
    ).toThrow('source transaction evidence for every completed transaction input')
    expect(() =>
      validateWalletResult(
        'signAction',
        { txid: transaction.id('hex'), tx },
        { reference: 'cmVm', spends: { 0: { unlockingScript: '51' } } }
      )
    ).toThrow('source transaction evidence for every completed transaction input')
  })

  it('rejects completed zero-input transactions that create value', () => {
    const transaction = actionTransaction(1)
    const result = { txid: transaction.id('hex'), tx: transaction.toAtomicBEEF() }

    expect(() =>
      validateWalletResult('createAction', result, {
        description: 'Zero-input value creation',
        outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'Invalid output' }]
      })
    ).toThrow('total value no greater than the transaction inputs')
    expect(() =>
      validateWalletResult('signAction', result, { reference: 'cmVm', spends: {} })
    ).toThrow('total value no greater than the transaction inputs')
  })

  it('requires transaction evidence for completed actions unless explicitly waived', () => {
    const request = {
      description: 'Evidence-required payment',
      outputs: [
        {
          satoshis: 42,
          lockingScript: '51',
          outputDescription: 'Required payment output'
        }
      ]
    }
    const result = { txid: TRANSACTION_ID }

    expect(() => validateWalletResult('createAction', result, request)).toThrow(
      'transaction evidence unless returnTXIDOnly was explicitly requested'
    )
    expect(
      validateWalletResult('createAction', result, {
        ...request,
        options: { returnTXIDOnly: true }
      })
    ).toEqual(result)
  })

  it('binds action result variants to requested completion state', () => {
    const transaction = fundedActionTransaction()
    const completed = { txid: transaction.id('hex'), tx: transaction.toAtomicBEEF() }
    const signable = {
      signableTransaction: { tx: transaction.toAtomicBEEF(), reference: 'cmVm' }
    }

    expect(() =>
      validateWalletResult('createAction', completed, {
        description: 'Deferred action result',
        options: { signAndProcess: false }
      })
    ).toThrow('requested deferred-signing transaction')
    expect(() =>
      validateWalletResult('createAction', signable, {
        description: 'Completed action result'
      })
    ).toThrow('requested completed transaction')
    expect(() =>
      validateWalletResult(
        'signAction',
        { sendWithResults: [{ txid: TRANSACTION_ID, status: 'sending' }] },
        {
          reference: 'cmVm',
          spends: {},
          options: { sendWith: [TRANSACTION_ID] }
        }
      )
    ).toThrow('completed signed transaction')
    expect(
      validateWalletResult(
        'createAction',
        { sendWithResults: [{ txid: TRANSACTION_ID, status: 'sending' }] },
        {
          description: 'Batch-only action result',
          options: { sendWith: [TRANSACTION_ID] }
        }
      )
    ).toBeDefined()
  })

  it('binds returned create-action transactions to requested input outpoints and policy', () => {
    const source = actionTransaction(50)
    const transaction = actionTransaction()
    transaction.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_1'),
      sequence: 7
    })
    const result = { txid: transaction.id('hex'), tx: transaction.toAtomicBEEF(true) }
    const input = {
      outpoint: `${source.id('hex')}.0`,
      inputDescription: 'Bound external input',
      unlockingScript: '51',
      sequenceNumber: 7
    }

    expect(
      validateWalletResult('createAction', result, {
        description: 'Bound external input action',
        inputs: [input]
      })
    ).toEqual(result)
    expect(() =>
      validateWalletResult('createAction', result, {
        description: 'Substituted external input action',
        inputs: [{ ...input, outpoint: `${'ab'.repeat(32)}.0` }]
      })
    ).toThrow('every requested input exactly once')
    expect(() =>
      validateWalletResult('createAction', result, {
        description: 'Substituted input sequence action',
        inputs: [{ ...input, sequenceNumber: 8 }]
      })
    ).toThrow('requested input sequence')
  })

  it('binds a returned signed transaction to the requested spend scripts', () => {
    const source = actionTransaction(50)
    const signed = actionTransaction()
    signed.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_1'),
      sequence: 7
    })
    const result = { txid: signed.id('hex'), tx: signed.toAtomicBEEF(true) }

    expect(
      validateWalletResult('signAction', result, {
        reference: 'cmVm',
        spends: { 0: { unlockingScript: '51', sequenceNumber: 7 } }
      })
    ).toEqual(result)
    expect(() =>
      validateWalletResult('signAction', result, {
        reference: 'cmVm',
        spends: { 0: { unlockingScript: '00', sequenceNumber: 7 } }
      })
    ).toThrow('requested unlocking script')
  })

  it('binds listed output metadata to the requested transaction evidence', () => {
    const args = { basket: 'test', include: 'entire transactions' as const, limit: 2 }
    const validOutput = {
      outpoint: `${LISTED_TRANSACTION_ID}.0`,
      satoshis: 42,
      spendable: true,
      lockingScript: '51'
    }
    expect(
      validateWalletResult(
        'listOutputs',
        { totalOutputs: 1, BEEF: LISTED_TRANSACTION_BEEF, outputs: [validOutput] },
        args
      )
    ).toBeDefined()
    expect(() =>
      validateWalletResult('listOutputs', { totalOutputs: 1, outputs: [validOutput] }, args)
    ).toThrow('requested complete output transactions')
    expect(() =>
      validateWalletResult(
        'listOutputs',
        {
          totalOutputs: 1,
          BEEF: LISTED_TRANSACTION_BEEF,
          outputs: [{ ...validOutput, satoshis: 41 }]
        },
        args
      )
    ).toThrow('amount committed by BEEF')
    expect(() =>
      validateWalletResult(
        'listOutputs',
        {
          totalOutputs: 1,
          BEEF: LISTED_TRANSACTION_BEEF,
          outputs: [{ ...validOutput, lockingScript: '00' }]
        },
        args
      )
    ).toThrow('script committed by BEEF')
    expect(() =>
      validateWalletResult(
        'listOutputs',
        {
          totalOutputs: 1,
          BEEF: LISTED_TRANSACTION_BEEF,
          outputs: [{ ...validOutput, outpoint: `${TRANSACTION_ID}.0` }]
        },
        args
      )
    ).toThrow('contained in BEEF')
    expect(() =>
      validateWalletResult(
        'listOutputs',
        {
          totalOutputs: 2,
          BEEF: LISTED_TRANSACTION_BEEF,
          outputs: [validOutput, { ...validOutput }]
        },
        args
      )
    ).toThrow('unique output')
  })

  it('requires requested list-output locking scripts', () => {
    expect(() =>
      validateWalletResult(
        'listOutputs',
        {
          totalOutputs: 1,
          outputs: [{ outpoint: `${LISTED_TRANSACTION_ID}.0`, satoshis: 42, spendable: true }]
        },
        { basket: 'test', include: 'locking scripts' }
      )
    ).toThrow('requested locking script')
  })

  it('requires requested list-output tags and labels and binds the tag query', () => {
    const output = {
      outpoint: `${LISTED_TRANSACTION_ID}.0`,
      satoshis: 42,
      spendable: true,
      tags: ['owned', 'reviewed'],
      labels: ['payment']
    }
    const request = {
      basket: 'test',
      tags: ['owned', 'reviewed'],
      tagQueryMode: 'all' as const,
      includeTags: true,
      includeLabels: true,
      limit: 1
    }
    const result = { totalOutputs: 1, outputs: [output] }

    expect(validateWalletResult('listOutputs', result, request)).toEqual(result)
    expect(() =>
      validateWalletResult(
        'listOutputs',
        { totalOutputs: 1, outputs: [{ ...output, tags: undefined }] },
        request
      )
    ).toThrow('explicitly requested output tags')
    expect(() =>
      validateWalletResult(
        'listOutputs',
        { totalOutputs: 1, outputs: [{ ...output, labels: undefined }] },
        request
      )
    ).toThrow('explicitly requested transaction labels')
    expect(() =>
      validateWalletResult(
        'listOutputs',
        { totalOutputs: 1, outputs: [{ ...output, tags: ['owned'] }] },
        request
      )
    ).toThrow('requested tag query')
  })

  it('bounds action batch results before iterating them', () => {
    const sendWithResults = Array.from({ length: 1002 }, () => ({
      txid: TRANSACTION_ID,
      status: 'sending'
    }))

    expect(() =>
      validateWalletResult('createAction', { txid: TRANSACTION_ID, sendWithResults })
    ).toThrow('at most 1001 transaction results')
  })

  it('binds key-linkage results to the requested parties and derivation tuple', () => {
    const counterpartyResult = {
      prover: PUBLIC_KEY,
      verifier: PUBLIC_KEY,
      counterparty: PUBLIC_KEY,
      revelationTime: '2026-09-16T12:00:00Z',
      encryptedLinkage: [],
      encryptedLinkageProof: []
    }
    expect(() =>
      validateWalletResult('revealCounterpartyKeyLinkage', counterpartyResult, {
        verifier: OTHER_PUBLIC_KEY,
        counterparty: PUBLIC_KEY
      })
    ).toThrow('requested verifier')

    const specificResult = {
      ...counterpartyResult,
      protocolID: [2, 'test protocol'],
      keyID: 'requested-key',
      proofType: 1
    }
    expect(() =>
      validateWalletResult('revealSpecificKeyLinkage', specificResult, {
        verifier: PUBLIC_KEY,
        counterparty: PUBLIC_KEY,
        protocolID: [2, 'other protocol'],
        keyID: 'requested-key'
      })
    ).toThrow('requested protocol')
    expect(
      validateWalletResult('revealSpecificKeyLinkage', specificResult, {
        verifier: PUBLIC_KEY,
        counterparty: 'self',
        protocolID: [2, 'test protocol'],
        keyID: 'requested-key'
      })
    ).toEqual(specificResult)
    expect(() =>
      validateWalletResult(
        'revealSpecificKeyLinkage',
        { ...specificResult, counterparty: OTHER_PUBLIC_KEY },
        {
          verifier: PUBLIC_KEY,
          counterparty: 'self',
          protocolID: [2, 'test protocol'],
          keyID: 'requested-key'
        }
      )
    ).toThrow("prover's identity key")
    expect(() =>
      validateWalletResult(
        'revealSpecificKeyLinkage',
        { ...specificResult, counterparty: OTHER_PUBLIC_KEY },
        {
          verifier: PUBLIC_KEY,
          counterparty: 'anyone',
          protocolID: [2, 'test protocol'],
          keyID: 'requested-key'
        }
      )
    ).toThrow('canonical anyone public key')
  })

  it('rejects certificates substituted across list, acquisition, and discovery requests', () => {
    expect(() =>
      validateWalletResult(
        'listCertificates',
        { totalCertificates: 1, certificates: [CERTIFICATE] },
        { certifiers: [PUBLIC_KEY], types: [OTHER_TYPE] }
      )
    ).toThrow('requested types')

    expect(() =>
      validateWalletResult('acquireCertificate', CERTIFICATE, {
        type: OTHER_TYPE,
        certifier: PUBLIC_KEY
      })
    ).toThrow('requested certificate type')

    expect(() =>
      validateWalletResult(
        'discoverByIdentityKey',
        {
          totalCertificates: 1,
          certificates: [
            {
              ...CERTIFICATE,
              certifierInfo: {
                name: 'Certifier',
                iconUrl: 'https://example.com/icon.png',
                description: 'Trusted certifier',
                trust: 1
              },
              publiclyRevealedKeyring: {},
              decryptedFields: {}
            }
          ]
        },
        { identityKey: OTHER_PUBLIC_KEY }
      )
    ).toThrow('requested identity key')

    expect(() =>
      validateWalletResult(
        'discoverByAttributes',
        {
          totalCertificates: 1,
          certificates: [
            {
              ...CERTIFICATE,
              certifierInfo: {
                name: 'Certifier',
                iconUrl: 'https://example.com/icon.png',
                description: 'Trusted certifier',
                trust: 1
              },
              publiclyRevealedKeyring: {},
              decryptedFields: { name: 'Mallory' }
            }
          ]
        },
        { attributes: { name: 'Alice' } }
      )
    ).toThrow('requested public attribute')
  })

  it('binds discoverByAttributes results with the identity overlay matching contract', () => {
    const discovered = (decryptedFields: Record<string, string>): unknown => ({
      totalCertificates: 1,
      certificates: [
        {
          ...CERTIFICATE,
          certifierInfo: {
            name: 'Certifier',
            iconUrl: 'https://example.com/icon.png',
            description: 'Trusted certifier',
            trust: 1
          },
          publiclyRevealedKeyring: {},
          decryptedFields
        }
      ]
    })
    const accepts = (fields: Record<string, string>, attributes: Record<string, unknown>): void => {
      expect(() =>
        validateWalletResult('discoverByAttributes', discovered(fields), { attributes })
      ).not.toThrow()
    }
    const rejects = (
      fields: Record<string, string>,
      attributes: Record<string, unknown>,
      message: string
    ): void => {
      expect(() =>
        validateWalletResult('discoverByAttributes', discovered(fields), { attributes })
      ).toThrow(message)
    }
    const person = { name: 'José Alice Smith', userName: 'deggen', profilePhoto: 'uhrp://bob' }

    accepts(person, { any: 'deggen' })
    accepts(person, { any: 'jose' })
    accepts(person, { any: 'al' })
    accepts(person, { any: '"Alice Smith"' })
    accepts(person, { any: '"" nobody alice' })
    accepts(person, { any: 'alice - nobody' })
    rejects(person, { any: '"Smith Alice"' }, 'requested any attribute')
    rejects(person, { any: 'alice -smith' }, 'requested any attribute')
    rejects(person, { any: 'bob' }, 'requested any attribute')
    rejects(person, { any: 'zz' }, 'requested any attribute')
    rejects(person, { any: 'd' }, 'requested any attribute')
    rejects(person, { any: 7 }, 'requested any attribute')

    accepts(person, { name: 'ali smi' })
    accepts(person, { name: 'ali', company: ' ' })
    accepts(person, { userName: ' deggen ' })
    rejects(person, { userName: 'deg' }, 'requested public attribute')
    rejects(person, { city: 'London' }, 'requested public attribute')
    rejects(person, { name: '   ' }, 'usable requested attribute')
    rejects(person, { name: 7 }, 'request.attributes.name')
  })

  it('binds direct acquisition and returned proof certificates to the exact request', () => {
    const directRequest = {
      acquisitionProtocol: 'direct',
      type: TYPE,
      serialNumber: OTHER_TYPE,
      certifier: PUBLIC_KEY,
      revocationOutpoint: `${'ab'.repeat(32)}.0`,
      fields: {},
      signature: CERTIFICATE.signature
    }
    expect(validateWalletResult('acquireCertificate', CERTIFICATE, directRequest)).toEqual(
      CERTIFICATE
    )
    expect(() =>
      validateWalletResult(
        'acquireCertificate',
        { ...CERTIFICATE, serialNumber: TYPE },
        directRequest
      )
    ).toThrow('requested certificate serialNumber')
    expect(() =>
      validateWalletResult(
        'acquireCertificate',
        { ...CERTIFICATE, revocationOutpoint: `${'cd'.repeat(32)}.0` },
        directRequest
      )
    ).toThrow('requested certificate revocation outpoint')

    expect(() =>
      validateWalletResult(
        'proveCertificate',
        { keyringForVerifier: {}, certificate: CERTIFICATE, verifier: PUBLIC_KEY },
        {
          certificate: { serialNumber: TYPE },
          fieldsToReveal: [],
          verifier: PUBLIC_KEY
        }
      )
    ).toThrow('requested certificate serialNumber')
  })

  it('binds issuance results to the caller-supplied certificate fields', () => {
    const issuanceRequest = {
      acquisitionProtocol: 'issuance',
      type: TYPE,
      certifier: PUBLIC_KEY,
      fields: { name: 'Alice' },
      certifierUrl: 'https://certifier.example'
    }
    expect(
      validateWalletResult(
        'acquireCertificate',
        { ...CERTIFICATE, fields: { name: 'Alice' } },
        issuanceRequest
      )
    ).toMatchObject({ fields: { name: 'Alice' } })
    expect(() =>
      validateWalletResult(
        'acquireCertificate',
        { ...CERTIFICATE, fields: { name: 'Mallory' } },
        issuanceRequest
      )
    ).toThrow('requested certificate fields')
  })

  it('binds a proof keyring to exactly the fields authorized by the caller', () => {
    expect(() =>
      validateWalletResult(
        'proveCertificate',
        { keyringForVerifier: { name: TYPE, email: OTHER_TYPE } },
        { fieldsToReveal: ['name'] }
      )
    ).toThrow('exactly the requested certificate fields')
    expect(() =>
      validateWalletResult(
        'proveCertificate',
        { keyringForVerifier: {} },
        { fieldsToReveal: ['name'] }
      )
    ).toThrow('exactly the requested certificate fields')
    expect(
      validateWalletResult(
        'proveCertificate',
        { keyringForVerifier: { name: TYPE } },
        { fieldsToReveal: ['name'] }
      )
    ).toEqual({ keyringForVerifier: { name: TYPE } })
  })

  it('rejects hostile graph descriptors without invoking accessors', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => assertSafeWalletValue(cyclic, 'test')).not.toThrow()

    const nonstandardArray: unknown[] = []
    Object.setPrototypeOf(nonstandardArray, Object.create(Array.prototype))
    expect(() => assertSafeWalletValue(nonstandardArray, 'test')).toThrow('array prototype')

    const arrayGetter = jest.fn(() => 'secret')
    const accessorArray = ['safe']
    Object.defineProperty(accessorArray, '0', { get: arrayGetter, enumerable: true })
    expect(() => assertSafeWalletValue(accessorArray, 'test')).toThrow('array property 0')
    expect(arrayGetter).not.toHaveBeenCalled()

    const objectGetter = jest.fn(() => 'secret')
    const accessorObject: Record<string, unknown> = {}
    Object.defineProperty(accessorObject, 'secret', { get: objectGetter, enumerable: true })
    expect(() => assertSafeWalletValue(accessorObject, 'test')).toThrow('object property secret')
    expect(objectGetter).not.toHaveBeenCalled()

    const symbolRecord = { [Symbol('hidden')]: true }
    expect(() => assertSafeWalletValue(symbolRecord, 'test')).toThrow('object key')
  })

  it('does not bind result policy from inherited or accessor-backed request fields', () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'options')
    Object.defineProperty(Object.prototype, 'options', {
      value: { returnTXIDOnly: true },
      configurable: true
    })
    try {
      const request = snapshotWalletResultRequest('createAction', {})
      expect(() => validateWalletResult('createAction', { txid: TRANSACTION_ID }, request)).toThrow(
        'transaction evidence'
      )
    } finally {
      if (previous == null) Reflect.deleteProperty(Object.prototype, 'options')
      else Object.defineProperty(Object.prototype, 'options', previous)
    }

    const getter = jest.fn(() => ({ returnTXIDOnly: true }))
    const request: Record<string, unknown> = {}
    Object.defineProperty(request, 'options', { enumerable: true, get: getter })
    expect(() => snapshotWalletResultRequest('createAction', request)).toThrow('data properties')
    expect(getter).not.toHaveBeenCalled()
  })

  it.each([
    [
      'negative ciphertext byte',
      () => validateWalletResult('encrypt', { ciphertext: [-1] }),
      'ciphertext'
    ],
    [
      'fractional plaintext byte',
      () => validateWalletResult('decrypt', { plaintext: [1.5] }),
      'plaintext'
    ],
    [
      'oversized HMAC byte',
      () => validateWalletResult('createHmac', { hmac: Array(31).fill(0).concat(256) }),
      'hmac'
    ],
    [
      'oversized DER container',
      () => validateWalletResult('createSignature', { signature: Array(73).fill(0) }),
      'at most 72 bytes'
    ],
    [
      'short version',
      () => validateWalletResult('getVersion', { version: '1.0.0' }),
      '7–30 UTF-8 bytes'
    ],
    [
      'multibyte oversized version',
      () => validateWalletResult('getVersion', { version: 'é'.repeat(16) }),
      '7–30 UTF-8 bytes'
    ],
    ['zero height', () => validateWalletResult('getHeight', { height: 0 }), 'integer from 1'],
    [
      'height above uint32',
      () => validateWalletResult('getHeight', { height: 0x100000000 }),
      'integer from 1'
    ],
    [
      'unsupported send status',
      () =>
        validateWalletResult('createAction', {
          sendWithResults: [{ txid: TRANSACTION_ID, status: 'completed' }]
        }),
      'supported status'
    ],
    [
      'noncanonical no-send outpoint',
      () =>
        validateWalletResult('createAction', {
          txid: TRANSACTION_ID,
          noSendChange: [`${TRANSACTION_ID}.01`]
        }),
      'canonical transaction outpoint'
    ],
    [
      'noncanonical signable reference',
      () =>
        validateWalletResult('createAction', {
          signableTransaction: { tx: ATOMIC_BEEF, reference: 'not base64!' }
        }),
      'canonical base64 string'
    ],
    [
      'result page larger than total',
      () =>
        validateWalletResult('listOutputs', {
          totalOutputs: 0,
          outputs: [{ outpoint: `${TRANSACTION_ID}.0`, satoshis: 0, spendable: true }]
        }),
      'at least 1'
    ],
    [
      'missing result page',
      () => validateWalletResult('listOutputs', { totalOutputs: 0 }),
      'outputs'
    ]
  ])('rejects a %s boundary value', (_name, run, message) => {
    expect(run).toThrow(message)
  })

  it('rejects invalid source evidence while snapshotting an asynchronous request', () => {
    expect(() =>
      snapshotWalletResultRequest('createAction', {
        inputs: [{ outpoint: `${TRANSACTION_ID}.0` }],
        inputBEEF: [1, 2, 3]
      })
    ).toThrow('request.inputBEEF')
  })

  it('snapshots mutable result-binding fields before an asynchronous call', () => {
    const request = {
      inputs: [{ outpoint: `${TRANSACTION_ID}.0`, unlockingScript: '51', sequenceNumber: 1 }],
      outputs: [{ satoshis: 1, lockingScript: '51' }],
      options: {
        signAndProcess: true,
        returnTXIDOnly: false,
        sendWith: [TRANSACTION_ID],
        randomizeOutputs: false,
        knownTxids: [OTHER_TYPE]
      }
    }
    const snapshot = snapshotWalletResultRequest('createAction', request) as typeof request

    request.inputs[0].outpoint = `${'ff'.repeat(32)}.1`
    request.outputs[0].satoshis = 2
    request.options.sendWith[0] = 'ff'.repeat(32)
    request.options.knownTxids[0] = TYPE

    expect(snapshot.inputs[0].outpoint).toBe(`${TRANSACTION_ID}.0`)
    expect(snapshot.outputs[0].satoshis).toBe(1)
    expect(snapshot.options.sendWith).toEqual([TRANSACTION_ID])
    expect(snapshot.options.knownTxids).toEqual([OTHER_TYPE])
  })

  it('snapshots malformed optional request fields without invoking them', () => {
    expect(snapshotWalletResultRequest('getVersion', null)).toBeNull()
    expect(
      snapshotWalletResultRequest('createAction', {
        inputs: [null],
        outputs: [null]
      })
    ).toMatchObject({ inputs: [null], outputs: [null] })
    expect(
      snapshotWalletResultRequest('signAction', {
        spends: { 0: null, 1: { unlockingScript: '51', sequenceNumber: 1 } }
      })
    ).toMatchObject({
      spends: { 0: null, 1: { unlockingScript: '51', sequenceNumber: 1 } }
    })
    expect(
      snapshotWalletResultRequest('discoverByAttributes', {
        limit: 1,
        attributes: null
      })
    ).toEqual({ limit: 1, attributes: null })
    expect(
      snapshotWalletResultRequest('proveCertificate', {
        fieldsToReveal: [],
        certificate: null
      })
    ).toMatchObject({ certificate: null })
  })

  it('rejects contradictory action result envelopes and duplicate batch outcomes', () => {
    expect(() =>
      validateWalletResult('signAction', {
        signableTransaction: { tx: ATOMIC_BEEF, reference: 'cmVm' }
      })
    ).toThrow('signableTransaction')
    expect(() => validateWalletResult('createAction', { tx: ATOMIC_BEEF })).toThrow(
      'txid: expected present with tx'
    )
    expect(() =>
      validateWalletResult('createAction', {
        noSendChange: [`${TRANSACTION_ID}.0`],
        sendWithResults: [{ txid: TRANSACTION_ID, status: 'unproven' }]
      })
    ).toThrow('associated with a transaction')
    expect(() =>
      validateWalletResult('createAction', {
        sendWithResults: [
          { txid: TRANSACTION_ID, status: 'unproven' },
          { txid: TRANSACTION_ID, status: 'sending' }
        ]
      })
    ).toThrow('unique transaction')
    expect(() =>
      validateWalletResult(
        'signAction',
        { txid: TRANSACTION_ID, noSendChange: [`${TRANSACTION_ID}.0`] },
        { options: { returnTXIDOnly: true } }
      )
    ).toThrow('noSendChange: expected an absent field')
  })

  it('rejects malformed action-history and output booleans at their trust boundaries', () => {
    const baseAction = {
      txid: TRANSACTION_ID,
      satoshis: 0,
      status: 'completed',
      isOutgoing: false,
      description: 'Valid action description',
      version: 1,
      lockTime: 0
    }
    expect(() =>
      validateWalletResult(
        'listActions',
        { totalActions: 1, actions: [{ ...baseAction, status: 'pending' }] },
        { limit: 1 }
      )
    ).toThrow('supported action status')
    expect(() =>
      validateWalletResult(
        'listActions',
        { totalActions: 1, actions: [{ ...baseAction, isOutgoing: 0 }] },
        { limit: 1 }
      )
    ).toThrow('isOutgoing: expected a boolean')
    expect(() =>
      validateWalletResult(
        'listActions',
        {
          totalActions: 1,
          actions: [
            {
              ...baseAction,
              inputs: [
                {
                  sourceOutpoint: `${TRANSACTION_ID}.0`,
                  sourceSatoshis: 1,
                  inputDescription: 'Valid input description',
                  sequenceNumber: 0xffffffff
                }
              ]
            }
          ]
        },
        { includeInputs: true, includeInputUnlockingScripts: true, limit: 1 }
      )
    ).toThrow('explicitly requested unlocking script')
    expect(() =>
      validateWalletResult(
        'listOutputs',
        {
          totalOutputs: 1,
          outputs: [
            {
              outpoint: `${TRANSACTION_ID}.0`,
              satoshis: 0,
              spendable: 1
            }
          ]
        },
        { limit: 1 }
      )
    ).toThrow('spendable: expected a boolean')
  })

  it('rejects duplicate inputs and aggregate values above the money bound', () => {
    const source = actionTransaction(42)
    const duplicateInput = {
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    }
    const duplicate = new Transaction(
      1,
      [duplicateInput, { ...duplicateInput }],
      [{ satoshis: 42, lockingScript: Script.fromASM('OP_TRUE') }],
      0
    )
    expect(() =>
      validateWalletResult('createAction', {
        txid: duplicate.id('hex'),
        tx: duplicate.toAtomicBEEF()
      })
    ).toThrow('unique transaction input outpoint')

    const sourceA = actionTransaction(21e14)
    const sourceB = actionTransaction(21e14, Script.fromASM('OP_2'))
    const excessiveInputs = new Transaction(
      1,
      [
        {
          sourceTransaction: sourceA,
          sourceOutputIndex: 0,
          unlockingScript: Script.fromASM('OP_TRUE')
        },
        {
          sourceTransaction: sourceB,
          sourceOutputIndex: 0,
          unlockingScript: Script.fromASM('OP_TRUE')
        }
      ],
      [{ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }],
      0
    )
    expect(() =>
      validateWalletResult('createAction', {
        txid: excessiveInputs.id('hex'),
        tx: excessiveInputs.toAtomicBEEF()
      })
    ).toThrow('valid total input value')

    const excessiveOutputs = new Transaction(
      1,
      [],
      [
        { satoshis: 21e14, lockingScript: Script.fromASM('OP_TRUE') },
        { satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }
      ],
      0
    )
    expect(() =>
      validateWalletResult('createAction', {
        txid: excessiveOutputs.id('hex'),
        tx: excessiveOutputs.toAtomicBEEF()
      })
    ).toThrow('valid total output value')
  })

  it('rejects malformed and request-substituted linkage metadata', () => {
    const counterpartyResult = {
      prover: PUBLIC_KEY,
      verifier: PUBLIC_KEY,
      counterparty: PUBLIC_KEY,
      revelationTime: '2026-09-16T12:00:00Z',
      encryptedLinkage: [],
      encryptedLinkageProof: []
    }
    expect(() =>
      validateWalletResult(
        'revealCounterpartyKeyLinkage',
        { ...counterpartyResult, revelationTime: '2026-09-16' },
        {}
      )
    ).toThrow('ISO timestamp with a timezone')
    expect(() =>
      validateWalletResult(
        'revealCounterpartyKeyLinkage',
        { ...counterpartyResult, revelationTime: '2026-99-99T12:00:00Z' },
        {}
      )
    ).toThrow('valid ISO timestamp')
    expect(() =>
      validateWalletResult('revealCounterpartyKeyLinkage', counterpartyResult, {
        counterparty: OTHER_PUBLIC_KEY
      })
    ).toThrow('requested counterparty')

    const specificResult = {
      ...counterpartyResult,
      protocolID: [2, 'test protocol'],
      keyID: 'requested-key',
      proofType: 1
    }
    for (const [request, message] of [
      [{ verifier: OTHER_PUBLIC_KEY }, 'requested verifier'],
      [{ counterparty: OTHER_PUBLIC_KEY }, 'requested counterparty'],
      [{ keyID: 'other-key' }, 'requested key ID']
    ] as const) {
      expect(() =>
        validateWalletResult('revealSpecificKeyLinkage', specificResult, request)
      ).toThrow(message)
    }
    expect(() =>
      validateWalletResult('revealSpecificKeyLinkage', { ...specificResult, protocolID: [2] })
    ).toThrow('[securityLevel, protocolName] tuple')
  })

  it('rejects malformed and request-substituted certificate metadata', () => {
    expect(() =>
      validateWalletResult(
        'listCertificates',
        { totalCertificates: 1, certificates: [CERTIFICATE] },
        {
          certifiers: [OTHER_PUBLIC_KEY]
        }
      )
    ).toThrow('requested certifiers')
    expect(() =>
      validateWalletResult('acquireCertificate', CERTIFICATE, { certifier: OTHER_PUBLIC_KEY })
    ).toThrow('requested certifier')
    expect(() =>
      validateWalletResult(
        'proveCertificate',
        { keyringForVerifier: {}, verifier: PUBLIC_KEY },
        { fieldsToReveal: [], verifier: OTHER_PUBLIC_KEY }
      )
    ).toThrow('requested verifier')
    expect(() =>
      validateWalletResult('acquireCertificate', {
        ...CERTIFICATE,
        revocationOutpoint: `${'ab'.repeat(32)}.0.extra`
      })
    ).toThrow('canonical signed wallet certificate')
    expect(() =>
      validateWalletResult('acquireCertificate', { ...CERTIFICATE, signature: '3000' })
    ).toThrow('canonical signed wallet certificate')
    expect(() =>
      validateWalletResult(
        'discoverByIdentityKey',
        {
          totalCertificates: 1,
          certificates: [
            {
              ...CERTIFICATE,
              certifierInfo: {
                name: 'Certifier',
                iconUrl: 'file:///private/icon.png',
                description: 'Trusted certifier',
                trust: 1
              },
              publiclyRevealedKeyring: {},
              decryptedFields: {}
            }
          ]
        },
        { identityKey: PUBLIC_KEY }
      )
    ).toThrow('absolute HTTP(S) URL')
  })

  it('normalizes deeply nested JSON byte fields without recursive stack exhaustion', () => {
    const root: Record<string, unknown> = {}
    let cursor = root
    for (let i = 0; i < 20_000; i++) {
      const child: Record<string, unknown> = {}
      cursor.child = child
      cursor = child
    }
    cursor.hmac = { 0: 1, 1: 2 }

    expect(() => normalizeBRC100WalletByteFields(root)).not.toThrow()
    expect(cursor.hmac).toEqual([1, 2])
    expect(() => assertSafeWalletValue(root, 'test')).not.toThrow()
  })
})
