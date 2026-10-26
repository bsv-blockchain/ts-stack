import Script from '../../script/Script.js'
import Transaction from '../../transaction/Transaction.js'
import { ATOMIC_BEEF, BEEF_V1, BEEF_V2, TX_DATA_FORMAT } from '../../transaction/BeefConstants.js'
import { parseWalletResultAtomicBEEF, parseWalletResultBEEF } from '../WalletResultBEEF.js'

interface TestMerkleLeaf {
  offset: number
  hash?: string
  duplicate?: boolean
}

function uint32LE(value: number): number[] {
  return [value, value >>> 8, value >>> 16, value >>> 24].map(byte => byte & 0xff)
}

function uint64LE(value: number): number[] {
  let remaining = BigInt(value)
  const bytes: number[] = []
  for (let index = 0; index < 8; index++) {
    bytes.push(Number(remaining & 0xffn))
    remaining >>= 8n
  }
  return bytes
}

function varInt(value: number): number[] {
  if (value < 0xfd) return [value]
  if (value <= 0xffff) return [0xfd, value & 0xff, (value >>> 8) & 0xff]
  if (value <= 0xffffffff) return [0xfe, ...uint32LE(value)]
  return [0xff, ...uint64LE(value)]
}

function hexBytes(value: string): number[] {
  const bytes: number[] = []
  for (let index = 0; index < value.length; index += 2) {
    bytes.push(Number.parseInt(value.slice(index, index + 2), 16))
  }
  return bytes
}

function reverseTxid(value: string): number[] {
  return hexBytes(value).reverse()
}

function merklePath(levels: TestMerkleLeaf[][], blockHeight = 0): number[] {
  const bytes = [...varInt(blockHeight), levels.length]
  for (const level of levels) {
    bytes.push(...varInt(level.length))
    for (const leaf of level) {
      bytes.push(...varInt(leaf.offset), leaf.duplicate === true ? 1 : 0)
      if (leaf.duplicate !== true) bytes.push(...reverseTxid(leaf.hash!))
    }
  }
  return bytes
}

function v2RawEntry(transaction: Transaction, bumpIndex?: number): number[] {
  return bumpIndex === undefined
    ? [TX_DATA_FORMAT.RAWTX, ...transaction.toBinary()]
    : [TX_DATA_FORMAT.RAWTX_AND_BUMP_INDEX, ...varInt(bumpIndex), ...transaction.toBinary()]
}

function v2TxidEntry(txid: string): number[] {
  return [TX_DATA_FORMAT.TXID_ONLY, ...reverseTxid(txid)]
}

function v1RawEntry(transaction: Transaction, bumpIndex?: number): number[] {
  return bumpIndex === undefined
    ? [...transaction.toBinary(), 0]
    : [...transaction.toBinary(), 1, ...varInt(bumpIndex)]
}

function beefEnvelope(
  version: typeof BEEF_V1 | typeof BEEF_V2,
  entries: number[][],
  bumps: number[][] = [],
  atomicTxid?: string
): number[] {
  const bytes = [
    ...uint32LE(version),
    ...varInt(bumps.length),
    ...bumps.flat(),
    ...varInt(entries.length),
    ...entries.flat()
  ]
  return atomicTxid === undefined
    ? bytes
    : [...uint32LE(ATOMIC_BEEF), ...reverseTxid(atomicTxid), ...bytes]
}

function transactionWithOutput(satoshis: number): Transaction {
  return new Transaction(1, [], [{ satoshis, lockingScript: Script.fromASM('OP_TRUE') }], 0)
}

function spendingTransaction(source: Transaction): Transaction {
  return new Transaction(
    1,
    [
      {
        sourceTransaction: source,
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE'),
        sequence: 0xfffffffe
      }
    ],
    [{ satoshis: source.outputs[0].satoshis, lockingScript: Script.fromASM('OP_TRUE') }],
    7
  )
}

describe('wallet-result BEEF parser boundaries', () => {
  it.each([BEEF_V1, BEEF_V2] as const)('accepts an exactly framed empty BEEF v%s', version => {
    const result = parseWalletResultBEEF(Uint8Array.from(beefEnvelope(version, [])))

    expect(result.atomicTxid).toBeUndefined()
    expect(result.transactions.size).toBe(0)
  })

  it.each([
    ['empty input', [], 'Serialized BEEF exceeds available data'],
    ['truncated version', [1, 2, 3], 'Serialized BEEF exceeds available data'],
    ['unknown version', [0, 0, 0, 0], 'Invalid BEEF version'],
    ['trailing suffix', [...beefEnvelope(BEEF_V2, []), 0], 'Serialized BEEF contains trailing data']
  ])('rejects %s', (_name, encoded, message) => {
    expect(() => parseWalletResultBEEF(encoded)).toThrow(message)
  })

  it.each([
    ['16-bit', [0xfd, 0xfd, 0x00]],
    ['32-bit', [0xfe, 0x00, 0x00, 0x01, 0x00]],
    ['64-bit', [0xff, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]]
  ])(
    'reads a canonical %s CompactSize before rejecting the truncated payload',
    (_name, encoded) => {
      expect(() => parseWalletResultBEEF([...uint32LE(BEEF_V2), ...encoded])).toThrow(
        'Serialized BEEF exceeds available data'
      )
    }
  )

  it.each([
    ['16-bit', [0xfd, 0xfc, 0x00], 'non-canonical varInt'],
    ['32-bit', [0xfe, 0xff, 0xff, 0x00, 0x00], 'non-canonical varInt'],
    ['64-bit', [0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00], 'non-canonical varInt'],
    ['unsafe 64-bit', [0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00], 'varInt is too large']
  ])('rejects a %s CompactSize', (_name, encoded, message) => {
    expect(() => parseWalletResultBEEF([...uint32LE(BEEF_V2), ...encoded])).toThrow(message)
  })

  it.each([BEEF_V1, BEEF_V2] as const)(
    'parses a complete raw transaction from BEEF v%s',
    version => {
      const transaction = transactionWithOutput(42)
      const entry = version === BEEF_V1 ? v1RawEntry(transaction) : v2RawEntry(transaction)
      const parsed = parseWalletResultBEEF(beefEnvelope(version, [entry]))

      expect(parsed.transactions.get(transaction.id('hex'))).toMatchObject({
        txid: transaction.id('hex'),
        version: 1,
        lockTime: 0,
        inputs: [],
        outputs: [{ satoshis: 42 }]
      })
    }
  )

  it('distinguishes a BEEF v2 txid-only entry from a complete transaction', () => {
    const txid = 'ab'.repeat(32)
    const parsed = parseWalletResultBEEF(beefEnvelope(BEEF_V2, [v2TxidEntry(txid)]))

    expect(parsed.transactions.has(txid)).toBe(true)
    expect(parsed.transactions.get(txid)).toBeUndefined()
  })

  it('links complete source values without retaining unrelated caller state', () => {
    const source = transactionWithOutput(73)
    const subject = spendingTransaction(source)
    const parsed = parseWalletResultBEEF(
      beefEnvelope(BEEF_V2, [v2RawEntry(source), v2RawEntry(subject)])
    )
    const parsedSubject = parsed.transactions.get(subject.id('hex'))

    expect(parsedSubject?.inputs[0]).toMatchObject({
      sourceTXID: source.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: 73,
      sequence: 0xfffffffe
    })
    expect(Array.from(parsedSubject?.inputs[0].unlockingScript ?? [])).toEqual([0x51])
  })

  it('rejects duplicate ordinary and Atomic BEEF entries', () => {
    const transaction = transactionWithOutput(1)
    const entry = v2RawEntry(transaction)

    expect(() => parseWalletResultBEEF(beefEnvelope(BEEF_V2, [entry, entry]))).toThrow(
      'BEEF contains duplicate transactions'
    )
    expect(() =>
      parseWalletResultAtomicBEEF(beefEnvelope(BEEF_V2, [entry, entry], [], transaction.id('hex')))
    ).toThrow('Atomic BEEF contains duplicate transactions')
  })

  it('requires Atomic framing and the complete subject transaction', () => {
    const transaction = transactionWithOutput(1)

    expect(() =>
      parseWalletResultAtomicBEEF(beefEnvelope(BEEF_V2, [v2RawEntry(transaction)]))
    ).toThrow('Atomic BEEF subject is missing')
    expect(() =>
      parseWalletResultAtomicBEEF(
        beefEnvelope(BEEF_V2, [v2TxidEntry(transaction.id('hex'))], [], transaction.id('hex'))
      )
    ).toThrow('Atomic BEEF subject is missing')
  })

  it('enforces the Atomic dependency closure while retaining the documented partial mode', () => {
    const source = transactionWithOutput(42)
    const subject = spendingTransaction(source)
    const incomplete = beefEnvelope(BEEF_V2, [v2RawEntry(subject)], [], subject.id('hex'))

    expect(() => parseWalletResultAtomicBEEF(incomplete)).toThrow(
      'Atomic BEEF omits a required dependency'
    )
    expect(parseWalletResultAtomicBEEF(incomplete, true).txid).toBe(subject.id('hex'))

    const complete = beefEnvelope(
      BEEF_V2,
      [v2RawEntry(source), v2RawEntry(subject)],
      [],
      subject.id('hex')
    )
    expect(parseWalletResultAtomicBEEF(complete).inputs[0].sourceSatoshis).toBe(42)
  })

  it('rejects unrelated transaction data in an otherwise complete Atomic envelope', () => {
    const subject = transactionWithOutput(1)
    const unrelated = transactionWithOutput(2)

    expect(() =>
      parseWalletResultAtomicBEEF(
        beefEnvelope(BEEF_V2, [v2RawEntry(subject), v2RawEntry(unrelated)], [], subject.id('hex'))
      )
    ).toThrow('Atomic BEEF contains unrelated transaction data')
  })

  it.each([BEEF_V1, BEEF_V2] as const)('accepts a one-transaction proof in BEEF v%s', version => {
    const subject = transactionWithOutput(1)
    const bump = merklePath([[{ offset: 0, hash: subject.id('hex') }]], 100)
    const entry = version === BEEF_V1 ? v1RawEntry(subject, 0) : v2RawEntry(subject, 0)
    const parsed = parseWalletResultAtomicBEEF(
      beefEnvelope(version, [entry], [bump], subject.id('hex'))
    )

    expect(parsed.txid).toBe(subject.id('hex'))
  })

  it('validates a compound four-leaf proof, including synthesized parent nodes', () => {
    const subject = transactionWithOutput(1)
    const levels: TestMerkleLeaf[][] = [
      [
        { offset: 0, hash: subject.id('hex') },
        { offset: 1, hash: '11'.repeat(32) },
        { offset: 2, hash: '22'.repeat(32) },
        { offset: 3, hash: '33'.repeat(32) }
      ],
      []
    ]

    const parsed = parseWalletResultAtomicBEEF(
      beefEnvelope(BEEF_V2, [v2RawEntry(subject, 0)], [merklePath(levels, 101)], subject.id('hex'))
    )
    expect(parsed.txid).toBe(subject.id('hex'))
  })

  it('accepts an explicit duplicate sibling in a Merkle path', () => {
    const subject = transactionWithOutput(1)
    const bump = merklePath([
      [
        { offset: 0, hash: subject.id('hex') },
        { offset: 1, duplicate: true }
      ]
    ])

    expect(
      parseWalletResultAtomicBEEF(
        beefEnvelope(BEEF_V2, [v2RawEntry(subject, 0)], [bump], subject.id('hex'))
      ).txid
    ).toBe(subject.id('hex'))
  })

  it('derives the implicit duplicate for the final odd Merkle leaf', () => {
    const subject = transactionWithOutput(1)
    const bump = merklePath([
      [
        { offset: 0, hash: subject.id('hex') },
        { offset: 1, hash: '11'.repeat(32) },
        { offset: 2, hash: '22'.repeat(32) }
      ]
    ])

    expect(
      parseWalletResultAtomicBEEF(
        beefEnvelope(BEEF_V2, [v2RawEntry(subject, 0)], [bump], subject.id('hex'))
      ).txid
    ).toBe(subject.id('hex'))
  })

  it.each([
    ['zero levels', merklePath([]), 'Invalid Merkle Path height'],
    [
      'too many levels',
      merklePath(Array.from({ length: 33 }, () => [])),
      'Invalid Merkle Path height'
    ],
    ['empty base level', merklePath([[]]), 'Invalid Merkle Path height'],
    [
      'duplicate base offset',
      merklePath([
        [
          { offset: 0, hash: '11'.repeat(32) },
          { offset: 0, hash: '22'.repeat(32) }
        ]
      ]),
      'Duplicate Merkle Path offset'
    ],
    [
      'offset above the 32-bit limit',
      merklePath([[{ offset: 0x100000000, duplicate: true }]]),
      'Invalid Merkle Path offset'
    ],
    [
      'missing sibling hash',
      merklePath([
        [
          { offset: 0, hash: '11'.repeat(32) },
          { offset: 2, hash: '22'.repeat(32) }
        ]
      ]),
      'Missing hash for index 0 at height 0'
    ],
    [
      'missing left child for a derived parent',
      merklePath([
        [
          { offset: 0, hash: '11'.repeat(32) },
          { offset: 1, hash: '22'.repeat(32) },
          { offset: 3, hash: '33'.repeat(32) }
        ],
        []
      ]),
      'Missing hash for index 0 at height 1'
    ],
    [
      'missing right child for a derived parent',
      merklePath([
        [
          { offset: 0, hash: '11'.repeat(32) },
          { offset: 1, hash: '22'.repeat(32) },
          { offset: 2, hash: '33'.repeat(32) }
        ],
        []
      ]),
      'Missing hash for index 0 at height 1'
    ],
    [
      'inconsistent explicit parent',
      merklePath([
        [
          { offset: 0, hash: '11'.repeat(32) },
          { offset: 1, hash: '22'.repeat(32) },
          { offset: 2, hash: '33'.repeat(32) },
          { offset: 3, hash: '44'.repeat(32) }
        ],
        [{ offset: 0, hash: '55'.repeat(32) }]
      ]),
      'Mismatched roots'
    ]
  ])('rejects a Merkle path with %s', (_name, bump, message) => {
    expect(() => parseWalletResultBEEF(beefEnvelope(BEEF_V2, [], [bump]))).toThrow(message)
  })
})
