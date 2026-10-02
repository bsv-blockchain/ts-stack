// The BRC-162 encoding contract, replayed from the package-local conformance vectors
// (test/vectors/brc162.json, which the Go port reads) through the public codec API, plus
// the guards the vectors cannot express: wallet-derived locks, the unlocker and number[]
// inputs. The file generator checks the vectors against the code; this suite checks the
// code against the vectors, so a change on either side fails here.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LockingScript, PrivateKey, ProtoWallet, Spend, Transaction } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import { hash160 } from '@bsv/sdk/primitives/Hash'
import {
  BSV21_MAX_AMOUNT,
  Bsv21Binary,
  Bsv21BinaryError,
  decodeAmountChunk,
  encodeAmountChunk,
  isTokenShaped,
  tokenIdToString
} from '../Bsv21Binary.js'
import type { Bsv21Role } from '../Bsv21Binary.js'
import {
  StrictCborError,
  decodeStrictCbor,
  encodeStrictCbor,
  tryDecodeStrictCbor
} from '../strictCbor.js'

interface Vectors {
  scripts: Array<{
    id: string
    tokenId: string | null
    amount: string
    pubKeyHash: string
    payload: string | null
    scriptHex: string
    role: Bsv21Role
  }>
  payloadPushes: Array<{
    id: string
    scriptHex: string
    payload: string
    payloadCanonical: boolean
  }>
  amountChunks: Array<{ id: string; amount: string; chunkHex: string }>
  rejectScripts: Array<{ id: string; scriptHex: string; tokenShaped: boolean; error: string }>
  strictCbor: Array<{ id: string; hex: string; valid: boolean; error?: string }>
  commitments: Array<{ id: string; detailsHex: string; commitment: string }>
}

const vectors = JSON.parse(
  readFileSync(join(__dirname, '../../test/vectors/brc162.json'), 'utf8')
) as Vectors

const bytesOf = (hex: string): number[] => Array.from(Buffer.from(hex, 'hex'))
const hexOf = (bytes: ArrayLike<number>): string => Buffer.from(Array.from(bytes)).toString('hex')

/** The error a call throws, checked to be of `type`. */
const errorOf = (call: () => unknown, type: new (message: string) => Error): Error => {
  try {
    call()
  } catch (e) {
    expect(e).toBeInstanceOf(type)
    return e as Error
  }
  throw new Error('expected the call to throw')
}

describe('brc162.json scripts', () => {
  it.each(vectors.scripts.map(v => [v.id, v] as const))('%s locks and decodes', (_id, v) => {
    const payload = v.payload === null ? undefined : bytesOf(v.payload)
    const locked = new Bsv21Binary().lock(
      v.tokenId,
      BigInt(v.amount),
      bytesOf(v.pubKeyHash),
      payload
    )
    expect(locked.toHex()).toBe(v.scriptHex)
    const script = LockingScript.fromHex(v.scriptHex)
    expect(isTokenShaped(script)).toBe(true)
    const decoded = Bsv21Binary.decode(script)
    expect(decoded.role).toBe(v.role)
    expect(decoded.tokenId === undefined ? null : tokenIdToString(decoded.tokenId)).toBe(v.tokenId)
    expect(decoded.amount).toBe(BigInt(v.amount))
    expect(decoded.payload === undefined ? null : hexOf(decoded.payload)).toBe(v.payload)
    expect(decoded.payloadCanonical).toBe(true)
    expect(hexOf(decoded.restPubKeyHash ?? [])).toBe(v.pubKeyHash)
  })

  it.each(vectors.payloadPushes.map(v => [v.id, v] as const))(
    '%s reads its payload push',
    (_id, v) => {
      const decoded = Bsv21Binary.decode(LockingScript.fromHex(v.scriptHex))
      expect(hexOf(decoded.payload ?? [])).toBe(v.payload)
      expect(decoded.payloadCanonical).toBe(v.payloadCanonical)
    }
  )

  it.each(vectors.amountChunks.map(v => [v.id, v] as const))('%s', (_id, v) => {
    const amount = BigInt(v.amount)
    expect(new LockingScript([encodeAmountChunk(amount)]).toHex()).toBe(v.chunkHex)
    expect(decodeAmountChunk(LockingScript.fromHex(v.chunkHex).chunks[0])).toBe(amount)
  })

  it.each(vectors.rejectScripts.map(v => [v.id, v] as const))('%s is refused', (_id, v) => {
    const script = LockingScript.fromHex(v.scriptHex)
    expect(isTokenShaped(script)).toBe(v.tokenShaped)
    expect(errorOf(() => Bsv21Binary.decode(script), Bsv21BinaryError).message).toBe(v.error)
  })
})

describe('brc162.json strict CBOR', () => {
  it.each(vectors.strictCbor.map(v => [v.id, v] as const))('%s', (_id, v) => {
    const bytes = bytesOf(v.hex)
    if (v.valid) {
      expect(encodeStrictCbor(decodeStrictCbor(bytes))).toEqual(bytes)
      expect(encodeStrictCbor(decodeStrictCbor(Uint8Array.from(bytes)))).toEqual(bytes)
      return
    }
    expect(errorOf(() => decodeStrictCbor(bytes), StrictCborError).message).toBe(v.error)
    expect(tryDecodeStrictCbor(bytes)).toBeUndefined()
  })

  it.each(vectors.commitments.map(v => [v.id, v] as const))('%s re-encodes', (_id, v) => {
    expect(hexOf(encodeStrictCbor(decodeStrictCbor(bytesOf(v.detailsHex))))).toBe(v.detailsHex)
  })

  it('encodes the spec map to the spec bytes', () => {
    expect(hexOf(encodeStrictCbor({ sym: 'USD', dec: 2n }))).toBe('a263646563026373796d63555344')
  })
})

describe('strict CBOR guards outside the vectors', () => {
  it('refuses number[] entries outside 0..255 instead of wrapping them', () => {
    for (const input of [
      [0xa1, 0x61, 0x61, 0x101],
      [0xa1, 0x61, 0x61, -0xff],
      [0x1a1, 0x61, 0x61, 0x01]
    ]) {
      expect(errorOf(() => decodeStrictCbor(input), StrictCborError).message).toBe(
        'non-canonical encoding'
      )
    }
  })

  it('refuses inputs and encodings over 4096 bytes', () => {
    const big = [0xa1, 0x61, 0x61, 0x59, 0x0f, 0xfb, ...Array.from({ length: 4091 }, () => 0)]
    expect(errorOf(() => decodeStrictCbor(big), StrictCborError).message).toBe(
      'input exceeds 4096 bytes'
    )
    expect(encodeStrictCbor({ a: new Uint8Array(4090) })).toHaveLength(4096)
    expect(
      errorOf(() => encodeStrictCbor({ a: new Uint8Array(4091) }), StrictCborError).message
    ).toBe('encoding exceeds 4096 bytes')
  })

  it('names its error type and leaves programming errors alone', () => {
    expect(errorOf(() => decodeStrictCbor([0x61, 0x61]), StrictCborError).name).toBe(
      'StrictCborError'
    )
    expect(() => tryDecodeStrictCbor(null as never)).toThrow(TypeError)
    expect(tryDecodeStrictCbor([0xa1, 0x61, 0x61, 0x01])).toEqual({ a: 1n })
  })

  it('decodes to ordinary own entries a caller can change', () => {
    const decoded = decodeStrictCbor([0xa1, 0x61, 0x61, 0x01])
    expect(Object.getOwnPropertyDescriptor(decoded, 'a')).toEqual({
      value: 1n,
      enumerable: true,
      writable: true,
      configurable: true
    })
  })

  it('refuses encoder inputs outside the subset with their own messages', () => {
    const encodeError = (map: unknown): string =>
      errorOf(() => encodeStrictCbor(map as never), StrictCborError).message
    expect(encodeError({ a: -1n })).toBe('integer outside 0..2^64-1')
    expect(encodeError({ a: 1n << 64n })).toBe('integer outside 0..2^64-1')
    expect(encodeError({ a: 1.5 })).toBe('number must be a safe non-negative integer')
    expect(encodeError({ a: -1 })).toBe('number must be a safe non-negative integer')
    expect(encodeError({ a: undefined })).toBe('unsupported value type')
    expect(encodeError({ a: [1] })).toBe('unsupported value type')
    expect(encodeError([])).toBe('top level must be a map')
    expect(encodeError({ a: '\ud800' })).toBe('text contains a lone surrogate')
    expect(encodeError({ a: { b: { c: { d: { e: 1n } } } } })).toBe('map nesting deeper than 4')
    expect(hexOf(encodeStrictCbor({ a: 0 }))).toBe('a1616100')
    expect(hexOf(encodeStrictCbor({ a: 23, b: Number.MAX_SAFE_INTEGER }))).toBe(
      'a2616117 6162 1b001fffffffffffff'.replace(/\s/g, '')
    )
  })
})

describe('Bsv21Binary chunks and guards outside the vectors', () => {
  const ID = `${'ab'.repeat(31)}cd_0`
  const PKH = Array.from({ length: 20 }, () => 1)
  const p2pkhHex = `76a914${hexOf(PKH)}88ac`

  it('names its error type', () => {
    expect(errorOf(() => tokenIdToString([]), Bsv21BinaryError).name).toBe('Bsv21BinaryError')
  })

  it('builds the minimal chunk for the id, the amount and the payload', () => {
    const t = new Bsv21Binary()
    expect(t.lock(null, 0n, PKH).chunks.slice(0, 3)).toEqual([{ op: 0 }, { op: 0 }, { op: 0x6d }])
    for (const [payload, chunk] of [
      [[], { op: 0 }],
      [[1], { op: 0x51 }],
      [[16], { op: 0x60 }],
      [[0x81], { op: 0x4f }],
      [[0], { op: 1, data: [0] }],
      [[17], { op: 1, data: [17] }]
    ] as const) {
      expect(t.lock(ID, 1n, PKH, payload).chunks[3]).toEqual(chunk)
    }
  })

  it('pushes a payload of exactly 0xffff bytes with OP_PUSHDATA2', () => {
    const script = new Bsv21Binary().lock(
      ID,
      1n,
      PKH,
      Array.from({ length: 0xffff }, () => 7)
    )
    expect(script.chunks[3].op).toBe(0x4d)
    expect(Bsv21Binary.decode(LockingScript.fromHex(script.toHex())).payloadCanonical).toBe(true)
  })

  it('reads a lone push after OP_2DROP as part of the remainder, not as a payload', () => {
    const decoded = Bsv21Binary.decode(LockingScript.fromHex('00006d0101'))
    expect(decoded.payload).toBeUndefined()
    expect(decoded.payloadCanonical).toBe(true)
    expect(decoded.restChunks).toMatchObject([{ op: 1, data: [1] }])
    expect(decoded.restPubKeyHash).toBeUndefined()
  })

  it('names a public key hash only for an exact P2PKH remainder', () => {
    const rest = (hex: string) => Bsv21Binary.decode(LockingScript.fromHex(`00006d${hex}`))
    expect(rest(p2pkhHex).restPubKeyHash).toEqual(PKH)
    // OP_EQUAL instead of OP_EQUALVERIFY, five chunks all the same
    expect(rest(`76a914${hexOf(PKH)}87ac`).restPubKeyHash).toBeUndefined()
    expect(rest(`${p2pkhHex}ac`).restPubKeyHash).toBeUndefined()
    // a 20-byte push op whose chunk carries some other length (built, not parsed)
    const short = new LockingScript([
      { op: 0 },
      { op: 0 },
      { op: 0x6d },
      { op: 0x76 },
      { op: 0xa9 },
      { op: 20, data: [1, 2] },
      { op: 0x88 },
      { op: 0xac }
    ])
    expect(Bsv21Binary.decode(short).restPubKeyHash).toBeUndefined()
  })

  it('refuses an id or amount chunk whose data disagrees with its push op', () => {
    const idChunk = new LockingScript([{ op: 32, data: [1] }, { op: 0x51 }, { op: 0x6d }])
    expect(errorOf(() => Bsv21Binary.decode(idChunk), Bsv21BinaryError).message).toBe(
      'token id must be a direct 32-byte push'
    )
    expect(
      errorOf(() => decodeAmountChunk({ op: 2, data: [0x11] }), Bsv21BinaryError).message
    ).toBe('amount must be OP_0, OP_1..OP_16 or a direct push of 1-9 bytes')
    expect(errorOf(() => decodeAmountChunk({ op: 2 }), Bsv21BinaryError).message).toBe(
      'amount must be OP_0, OP_1..OP_16 or a direct push of 1-9 bytes'
    )
  })
})

describe('Bsv21Binary wallet locks and the unlocker', () => {
  const ID = `${'ab'.repeat(31)}cd_0`

  it('pushes a payload over 0xffff bytes with OP_PUSHDATA4, which is then canonical', () => {
    const payload = Array.from({ length: 0x10000 }, () => 7)
    const script = new Bsv21Binary().lock(
      ID,
      1n,
      Array.from({ length: 20 }, () => 1),
      payload
    )
    expect(script.chunks[3]).toMatchObject({ op: 0x4e })
    const decoded = Bsv21Binary.decode(LockingScript.fromHex(script.toHex()))
    expect(decoded.payload).toHaveLength(0x10000)
    expect(decoded.payloadCanonical).toBe(true)
  })

  it('lockBRC29 locks to hash160 of the wallet-derived key', async () => {
    const wallet = new ProtoWallet(PrivateKey.fromHex('11'.repeat(32)))
    const args = {
      protocolID: [2, 'mandala token'] as [2, string],
      keyID: '7',
      counterparty: 'self'
    }
    const { publicKey } = await wallet.getPublicKey(args)
    const script = await new Bsv21Binary(
      wallet as unknown as WalletInterface,
      'example.com'
    ).lockBRC29(ID, 9n, args.protocolID, args.keyID, args.counterparty, [0xa0])
    const decoded = Bsv21Binary.decode(script)
    expect(decoded.restPubKeyHash).toEqual(hash160(Array.from(Buffer.from(publicKey, 'hex'))))
    expect(decoded).toMatchObject({ role: 'value', amount: 9n, payload: [0xa0] })
  })

  it('lockBRC29 requires a wallet', async () => {
    // The rejection is always handled, even when building the expectation throws.
    const refused = await new Bsv21Binary()
      .lockBRC29(null, 0n, [2, 'mandala token'], '1', 'self')
      .then(
        () => undefined,
        (e: unknown) => e
      )
    expect(refused).toBeInstanceOf(Bsv21BinaryError)
    expect((refused as Error).message).toBe('lockBRC29 requires a wallet')
  })

  it.each<[string, (t: Bsv21Binary, key: PrivateKey) => ReturnType<Bsv21Binary['unlock']>, number]>(
    [
      ['the default SIGHASH_ALL', (t, key) => t.unlock(key), 0x41],
      ['SIGHASH_SINGLE | ANYONECANPAY', (t, key) => t.unlock(key, 'single', true), 0xc3]
    ]
  )(
    'unlock with %s spends a prefixed output, signing the full script',
    async (_scope, unlocker, sighash) => {
      const key = PrivateKey.fromHex('22'.repeat(32))
      const template = new Bsv21Binary()
      const lock = template.lock(ID, BSV21_MAX_AMOUNT, key.toPublicKey().toHash() as number[], [1])
      const source = new Transaction(1, [], [{ lockingScript: lock, satoshis: 1 }], 0)
      const spend = new Transaction(
        1,
        [
          {
            sourceTransaction: source,
            sourceOutputIndex: 0,
            unlockingScriptTemplate: unlocker(template, key),
            sequence: 0xffffffff
          }
        ],
        [{ lockingScript: lock, satoshis: 1 }],
        0
      )
      await spend.sign()
      const unlocking = spend.inputs[0].unlockingScript
      if (unlocking === undefined) throw new Error('not signed')
      const signature = unlocking.chunks[0].data ?? []
      expect(signature.at(-1)).toBe(sighash)
      const interpreter = new Spend({
        sourceTXID: source.id('hex'),
        sourceOutputIndex: 0,
        sourceSatoshis: 1,
        lockingScript: lock,
        transactionVersion: spend.version,
        otherInputs: [],
        inputIndex: 0,
        unlockingScript: unlocking,
        outputs: spend.outputs,
        inputSequence: 0xffffffff,
        lockTime: spend.lockTime
      })
      expect(interpreter.validate()).toBe(true)
    }
  )
})
