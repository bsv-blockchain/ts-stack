import { LockingScript, OP, P2PKH, PrivateKey, Spend, Transaction } from '@bsv/sdk'
import type { ScriptChunk, WalletInterface } from '@bsv/sdk'
import {
  Bsv21Binary,
  type Bsv21BinaryDecoded,
  Bsv21BinaryError,
  decodeAmountChunk,
  encodeAmountChunk,
  isTokenShaped,
  tokenIdFromString,
  tokenIdToString,
  BSV21_MAX_AMOUNT
} from '../Bsv21Binary.js'

const PKH = Array.from({ length: 20 }, (_, i) => i + 1)
const PKH_HEX = Buffer.from(PKH).toString('hex')
const TXID = 'ab'.repeat(31) + 'cd' // display hex
const ID = `${TXID}_0`
const ID_WIRE_HEX = 'cd' + 'ab'.repeat(31) // natural (internal) order
const P2PKH_HEX = `76a914${PKH_HEX}88ac`
const P2PKH_ASM = `OP_DUP OP_HASH160 ${PKH_HEX} OP_EQUALVERIFY OP_CHECKSIG`
const filled = (n: number, fill = 0x11): number[] => Array.from({ length: n }, () => fill)
const reparse = (s: LockingScript): LockingScript => LockingScript.fromHex(s.toHex())
const decodeHex = (hex: string): Bsv21BinaryDecoded =>
  Bsv21Binary.decode(LockingScript.fromHex(hex))

describe('amount chunks (spec §3.1)', () => {
  it.each<[bigint, number]>([
    [0n, OP.OP_0],
    [1n, OP.OP_1],
    [5n, OP.OP_5],
    [16n, OP.OP_16]
  ])('%s -> opcode', (v, op) => {
    expect(encodeAmountChunk(v)).toEqual({ op })
    expect(decodeAmountChunk({ op })).toBe(v)
  })

  it.each<[bigint, number[]]>([
    [17n, [0x11]],
    [127n, [0x7f]],
    [128n, [0x80, 0x00]],
    [255n, [0xff, 0x00]],
    [256n, [0x00, 0x01]],
    [5000n, [0x88, 0x13]],
    [(1n << 64n) - 1n, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]]
  ])('%s -> minimal direct push', (v, data) => {
    expect(encodeAmountChunk(v)).toEqual({ op: data.length, data })
    expect(decodeAmountChunk({ op: data.length, data })).toBe(v)
  })

  it('round-trips every byte-width boundary with the minimal length', () => {
    for (let bits = 5n; bits <= 64n; bits++) {
      for (const v of [(1n << bits) - 1n, 1n << bits]) {
        if (v > BSV21_MAX_AMOUNT) continue
        const chunk = encodeAmountChunk(v)
        const bitLength = v.toString(2).length
        expect(chunk.op).toBe(Math.floor(bitLength / 8) + 1)
        expect(chunk.data).toHaveLength(chunk.op)
        expect(decodeAmountChunk(chunk)).toBe(v)
      }
    }
  })

  it.each<[string, ScriptChunk, string]>([
    ['data push of 5', { op: 1, data: [0x05] }, 'amounts 0..16 must use OP_0/OP_1..OP_16'],
    ['data push of 16', { op: 1, data: [0x10] }, 'amounts 0..16 must use OP_0/OP_1..OP_16'],
    ['data push of 0', { op: 1, data: [0x00] }, 'amount is not minimally encoded'],
    [
      'empty data push via PUSHDATA1',
      { op: OP.OP_PUSHDATA1, data: [] },
      'direct push of 1-9 bytes'
    ],
    ['negative', { op: 1, data: [0x81] }, 'amount must not be negative'],
    ['negative zero', { op: 1, data: [0x80] }, 'amount must not be negative'],
    ['negative multi-byte', { op: 2, data: [0x11, 0x80] }, 'amount must not be negative'],
    ['OP_1NEGATE', { op: OP.OP_1NEGATE }, 'direct push of 1-9 bytes'],
    ['non-minimal padding', { op: 2, data: [0x11, 0x00] }, 'amount is not minimally encoded'],
    ['double padding', { op: 3, data: [0xff, 0x00, 0x00] }, 'amount is not minimally encoded'],
    ['PUSHDATA1 for 17', { op: OP.OP_PUSHDATA1, data: [0x11] }, 'direct push of 1-9 bytes'],
    ['above 2^64-1', { op: 9, data: [0, 0, 0, 0, 0, 0, 0, 0, 0x01] }, 'amount exceeds 2^64-1'],
    ['10 bytes', { op: 10, data: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] }, 'direct push of 1-9 bytes'],
    ['length mismatch', { op: 2, data: [0x11] }, 'direct push of 1-9 bytes'],
    ['push without data', { op: 1 }, 'direct push of 1-9 bytes'],
    ['opcode, not a push', { op: OP.OP_DUP }, 'direct push of 1-9 bytes']
  ])('rejects %s', (_l, chunk, message) => {
    expect(() => decodeAmountChunk(chunk)).toThrow(Bsv21BinaryError)
    expect(() => decodeAmountChunk(chunk)).toThrow(message)
  })

  it('refuses to encode out-of-range amounts', () => {
    expect(() => encodeAmountChunk(-1n)).toThrow(Bsv21BinaryError)
    expect(() => encodeAmountChunk(-1n)).toThrow('amount outside 0..2^64-1')
    expect(() => encodeAmountChunk(BSV21_MAX_AMOUNT + 1n)).toThrow('amount outside 0..2^64-1')
  })

  it('refuses a non-bigint amount from untyped callers', () => {
    expect(() => encodeAmountChunk(0 as never)).toThrow('amount must be a bigint')
    expect(() => encodeAmountChunk(5 as never)).toThrow('amount must be a bigint')
  })

  it('exposes the 2^64-1 domain maximum and a named error', () => {
    expect(BSV21_MAX_AMOUNT).toBe(18446744073709551615n)
    const err = new Bsv21BinaryError('x')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('Bsv21BinaryError')
    expect(err.message).toBe('x')
  })
})

describe('token ids', () => {
  it('string <-> natural-order bytes', () => {
    const bytes = tokenIdFromString(ID)
    expect(bytes).toHaveLength(32)
    expect(Buffer.from(bytes).toString('hex')).toBe(ID_WIRE_HEX)
    expect(Buffer.from(bytes).reverse().toString('hex')).toBe(TXID)
    expect(tokenIdToString(bytes)).toBe(ID)
  })

  it('does not reverse the caller array in tokenIdToString', () => {
    const bytes = tokenIdFromString(ID)
    const copy = [...bytes]
    tokenIdToString(bytes)
    expect(bytes).toEqual(copy)
  })

  it.each([
    '',
    TXID,
    `${TXID}_1`,
    `${TXID}_00`,
    `${TXID.toUpperCase()}_0`,
    `${TXID}.0`,
    `x${TXID}_0`,
    `${TXID.slice(2)}_0`,
    `zz${TXID.slice(2)}_0`
  ])('rejects %p', bad => {
    expect(() => tokenIdFromString(bad)).toThrow(Bsv21BinaryError)
    expect(() => tokenIdFromString(bad)).toThrow('token id must be <64 lowercase hex>_0')
  })

  it.each([31, 33, 36])('tokenIdToString rejects %i bytes', n => {
    expect(() => tokenIdToString(filled(n))).toThrow('token id must be 32 bytes')
  })
})

describe('isTokenShaped', () => {
  it.each<[string, string, boolean]>([
    ['deploy', 'OP_0 OP_0 OP_2DROP', true],
    ['id + small amount', `${ID_WIRE_HEX} OP_5 OP_2DROP`, true],
    ['OP_1NEGATE pushes', 'OP_1NEGATE OP_1NEGATE OP_2DROP', true],
    ['OP_16 pushes', 'OP_16 OP_16 OP_2DROP OP_1', true],
    ['empty script', '', false],
    ['two chunks', 'OP_0 OP_0', false],
    ['third chunk not OP_2DROP', 'OP_0 OP_0 OP_DROP', false],
    ['first chunk not a push', 'OP_DUP OP_0 OP_2DROP', false],
    ['second chunk not a push', 'OP_0 OP_DUP OP_2DROP', false],
    ['OP_NOP is not a push', 'OP_0 OP_NOP OP_2DROP', false],
    ['OP_RESERVED is not a push', 'OP_0 OP_RESERVED OP_2DROP', false],
    ['plain P2PKH', P2PKH_ASM, false]
  ])('%s -> %p', (_l, asmText, expected) => {
    const s = asmText === '' ? new LockingScript([]) : LockingScript.fromASM(asmText)
    expect(isTokenShaped(s)).toBe(expected)
  })

  it('PUSHDATA4 counts as a push', () => {
    const s = new LockingScript([
      { op: OP.OP_PUSHDATA4, data: [1] },
      { op: OP.OP_0 },
      { op: OP.OP_2DROP }
    ])
    expect(isTokenShaped(s)).toBe(true)
  })

  it('SDK P2PKH output is not token-shaped and decode refuses it', () => {
    const s = new P2PKH().lock(PKH)
    expect(isTokenShaped(s)).toBe(false)
    expect(() => Bsv21Binary.decode(s)).toThrow('not a BRC-162 token output')
  })
})

describe('lock / decode', () => {
  const t = new Bsv21Binary()

  it('authority deploy: OP_0 OP_0 OP_2DROP <payload> OP_DROP P2PKH', () => {
    const s = t.lock(null, 0n, PKH, [0xa0])
    expect(s.toHex()).toBe(`00006d01a075${P2PKH_HEX}`)
    const d = Bsv21Binary.decode(reparse(s))
    expect(d).toMatchObject({
      role: 'deploy',
      amount: 0n,
      payload: [0xa0],
      payloadCanonical: true,
      restPubKeyHash: PKH
    })
    expect(d.tokenId).toBeUndefined()
    expect(d.restChunks).toHaveLength(5)
    expect(s.chunks[0].op).toBe(OP.OP_0)
  })

  it('fixed-supply deploy decodes as deploy (policy refuses it later)', () => {
    const d = Bsv21Binary.decode(t.lock(null, 5n, PKH))
    expect(d).toMatchObject({ role: 'deploy', amount: 5n, payloadCanonical: true })
    expect(d.tokenId).toBeUndefined()
    expect(d.payload).toBeUndefined()
  })

  it('authority and value outputs carry the 32-byte id as a direct push', () => {
    const a = Bsv21Binary.decode(t.lock(ID, 0n, PKH))
    const v = Bsv21Binary.decode(t.lock(ID, 5000n, PKH))
    expect(a.role).toBe('authority')
    expect(a.amount).toBe(0n)
    expect(tokenIdToString(a.tokenId!)).toBe(ID)
    expect(v).toMatchObject({ role: 'value', amount: 5000n, payloadCanonical: true })
    expect(v.payload).toBeUndefined()
    expect(tokenIdToString(v.tokenId!)).toBe(ID)
    expect(t.lock(ID, 1n, PKH).chunks[0].op).toBe(0x20)
    expect(t.lock(ID, 5000n, PKH).toHex()).toBe(`20${ID_WIRE_HEX}0288136d${P2PKH_HEX}`)
    expect(t.lock(ID, 1n, PKH).toHex()).toBe(`20${ID_WIRE_HEX}516d${P2PKH_HEX}`)
  })

  it('decodes the maximum amount from a parsed script', () => {
    const d = Bsv21Binary.decode(reparse(t.lock(ID, BSV21_MAX_AMOUNT, PKH)))
    expect(d).toMatchObject({ role: 'value', amount: BSV21_MAX_AMOUNT, restPubKeyHash: PKH })
  })

  it.each<[string, number[], { op: number; data?: number[] }]>([
    ['empty', [], { op: OP.OP_0 }],
    ['0x01', [0x01], { op: OP.OP_1 }],
    ['0x05', [0x05], { op: OP.OP_5 }],
    ['0x10', [0x10], { op: OP.OP_16 }],
    ['0x81', [0x81], { op: OP.OP_1NEGATE }],
    ['0x00', [0x00], { op: 1, data: [0x00] }],
    ['0x11', [0x11], { op: 1, data: [0x11] }],
    ['0x80', [0x80], { op: 1, data: [0x80] }],
    ['75 bytes', filled(75), { op: 75, data: filled(75) }],
    ['76 bytes', filled(76), { op: OP.OP_PUSHDATA1, data: filled(76) }],
    ['255 bytes', filled(255), { op: OP.OP_PUSHDATA1, data: filled(255) }],
    ['256 bytes', filled(256), { op: OP.OP_PUSHDATA2, data: filled(256) }],
    ['65535 bytes', filled(65535), { op: OP.OP_PUSHDATA2, data: filled(65535) }],
    ['65536 bytes', filled(65536), { op: OP.OP_PUSHDATA4, data: filled(65536) }]
  ])(
    'lock emits the canonical payload chunk for %s and decode accepts it',
    (_l, payload, chunk) => {
      const s = t.lock(ID, 7n, PKH, payload)
      expect(s.chunks[3]).toEqual(chunk)
      expect(s.chunks[4]).toEqual({ op: OP.OP_DROP })
      const d = Bsv21Binary.decode(reparse(s))
      expect(d).toMatchObject({
        role: 'value',
        amount: 7n,
        payloadCanonical: true,
        restPubKeyHash: PKH
      })
      expect(d.payload).toEqual(payload)
    }
  )

  it('lock copies the payload instead of aliasing it', () => {
    const payload = [0xa1, 0x61, 0x61, 0x01]
    const s = t.lock(ID, 7n, PKH, payload)
    payload[0] = 0x00
    expect(s.chunks[3].data).toEqual([0xa1, 0x61, 0x61, 0x01])
  })

  it('treats a leading <push> OP_DROP in the remainder as the payload (BRC-162 rule)', () => {
    const s = LockingScript.fromASM(`OP_0 OP_0 OP_2DROP 01 OP_DROP ${P2PKH_ASM}`)
    expect(Bsv21Binary.decode(s)).toMatchObject({
      payload: [0x01],
      payloadCanonical: false,
      restPubKeyHash: PKH
    })
  })

  it.each<[string, string, number[]]>([
    ['0x05 via PUSHDATA1', `00006d4c010575${P2PKH_HEX}`, [0x05]],
    ['empty via PUSHDATA1', `00006d4c0075${P2PKH_HEX}`, []],
    ['0x81 as a data push', `00006d018175${P2PKH_HEX}`, [0x81]],
    ['4 bytes via PUSHDATA1', `00006d4c04a161610175${P2PKH_HEX}`, [0xa1, 0x61, 0x61, 0x01]],
    ['76 bytes via PUSHDATA2', `00006d4d4c00${'11'.repeat(76)}75${P2PKH_HEX}`, filled(76)],
    ['256 bytes via PUSHDATA4', `00006d4e00010000${'11'.repeat(256)}75${P2PKH_HEX}`, filled(256)]
  ])('records a non-minimal payload push (%s) as non-canonical', (_l, hex, payload) => {
    const d = decodeHex(hex)
    expect(d.payload).toEqual(payload)
    expect(d.payloadCanonical).toBe(false)
    expect(d.restPubKeyHash).toEqual(PKH)
  })

  it('OP_1NEGATE payload decodes to 0x81 and is canonical', () => {
    const d = decodeHex(`00006d4f75${P2PKH_HEX}`)
    expect(d).toMatchObject({ payload: [0x81], payloadCanonical: true, restPubKeyHash: PKH })
  })

  it('consumes only the first <push> OP_DROP as the payload', () => {
    const d = Bsv21Binary.decode(
      LockingScript.fromASM('OP_0 OP_0 OP_2DROP OP_1 OP_DROP OP_2 OP_DROP')
    )
    expect(d.payload).toEqual([0x01])
    expect(d.restChunks).toEqual([{ op: OP.OP_2 }, { op: OP.OP_DROP }])
  })

  it.each<[string, string, number]>([
    ['no remainder', 'OP_0 OP_0 OP_2DROP', 0],
    ['single push', 'OP_0 OP_0 OP_2DROP OP_1', 1],
    ['push not followed by OP_DROP', 'OP_0 OP_0 OP_2DROP OP_1 OP_1', 2],
    ['non-push followed by OP_DROP', 'OP_0 OP_0 OP_2DROP OP_DUP OP_DROP', 2]
  ])('no payload: %s', (_l, asmText, restLength) => {
    const d = Bsv21Binary.decode(LockingScript.fromASM(asmText))
    expect(d.payload).toBeUndefined()
    expect(d.payloadCanonical).toBe(true)
    expect(d.restChunks).toHaveLength(restLength)
    expect(d.restPubKeyHash).toBeUndefined()
  })

  it('records a non-P2PKH remainder without restPubKeyHash', () => {
    const s = LockingScript.fromASM('OP_0 OP_0 OP_2DROP OP_1')
    expect(Bsv21Binary.decode(s).restPubKeyHash).toBeUndefined()
  })

  it.each([
    [
      'OP_DUP replaced',
      `OP_0 OP_0 OP_2DROP OP_NOP OP_HASH160 ${PKH_HEX} OP_EQUALVERIFY OP_CHECKSIG`
    ],
    [
      'OP_HASH160 replaced',
      `OP_0 OP_0 OP_2DROP OP_DUP OP_SHA256 ${PKH_HEX} OP_EQUALVERIFY OP_CHECKSIG`
    ],
    [
      '19-byte hash',
      `OP_0 OP_0 OP_2DROP OP_DUP OP_HASH160 ${PKH_HEX.slice(2)} OP_EQUALVERIFY OP_CHECKSIG`
    ],
    [
      'OP_EQUALVERIFY replaced',
      `OP_0 OP_0 OP_2DROP OP_DUP OP_HASH160 ${PKH_HEX} OP_EQUAL OP_CHECKSIG`
    ],
    [
      'OP_CHECKSIG replaced',
      `OP_0 OP_0 OP_2DROP OP_DUP OP_HASH160 ${PKH_HEX} OP_EQUALVERIFY OP_CHECKSIGVERIFY`
    ],
    ['trailing opcode', `OP_0 OP_0 OP_2DROP ${P2PKH_ASM} OP_1`]
  ])('near-P2PKH remainder (%s) has no restPubKeyHash', (_l, asmText) => {
    const d = Bsv21Binary.decode(LockingScript.fromASM(asmText))
    expect(d.restPubKeyHash).toBeUndefined()
  })

  it('a 20-opcode push carrying 19 bytes is not a canonical P2PKH remainder', () => {
    const s = new LockingScript([
      { op: OP.OP_0 },
      { op: OP.OP_0 },
      { op: OP.OP_2DROP },
      { op: OP.OP_DUP },
      { op: OP.OP_HASH160 },
      { op: 20, data: PKH.slice(1) },
      { op: OP.OP_EQUALVERIFY },
      { op: OP.OP_CHECKSIG }
    ])
    expect(Bsv21Binary.decode(s).restPubKeyHash).toBeUndefined()
  })

  it('hash via PUSHDATA1 is not a canonical P2PKH remainder', () => {
    const d = decodeHex(`00006d76a94c14${PKH_HEX}88ac`)
    expect(d.restChunks).toHaveLength(5)
    expect(d.restPubKeyHash).toBeUndefined()
  })

  it.each([
    ['36-byte id', `${'11'.repeat(36)} 05 OP_2DROP`, 'token id must be a direct 32-byte push'],
    ['31-byte id', `${'11'.repeat(31)} 05 OP_2DROP`, 'token id must be a direct 32-byte push'],
    ['OP_1NEGATE id', 'OP_1NEGATE OP_5 OP_2DROP', 'token id must be a direct 32-byte push'],
    ['OP_1 id', 'OP_1 OP_5 OP_2DROP', 'token id must be a direct 32-byte push'],
    ['non-minimal amount', `${'11'.repeat(32)} 0500 OP_2DROP`, 'amount is not minimally encoded'],
    [
      'small amount as data',
      `${'11'.repeat(32)} 05 OP_2DROP`,
      'amounts 0..16 must use OP_0/OP_1..OP_16'
    ],
    ['zero amount as data', `${'11'.repeat(32)} 00 OP_2DROP`, 'amount is not minimally encoded'],
    ['OP_1NEGATE amount', `${'11'.repeat(32)} OP_1NEGATE OP_2DROP`, 'direct push of 1-9 bytes'],
    ['negative amount', `${'11'.repeat(32)} 8813ff OP_2DROP`, 'amount must not be negative']
  ])('token-shaped but invalid: %s', (_l, asmText, message) => {
    const s = LockingScript.fromASM(asmText)
    expect(isTokenShaped(s)).toBe(true)
    expect(() => Bsv21Binary.decode(s)).toThrow(Bsv21BinaryError)
    expect(() => Bsv21Binary.decode(s)).toThrow(message)
  })

  it('id via PUSHDATA1 is token-shaped but invalid', () => {
    const s = new LockingScript([
      { op: OP.OP_PUSHDATA1, data: filled(32) },
      { op: OP.OP_5 },
      { op: OP.OP_2DROP }
    ])
    expect(isTokenShaped(s)).toBe(true)
    expect(() => Bsv21Binary.decode(s)).toThrow(Bsv21BinaryError)
    expect(() => Bsv21Binary.decode(reparse(s))).toThrow('token id must be a direct 32-byte push')
  })

  it('a truncated push after a deploy prefix makes the output token-shaped but invalid', () => {
    const s = LockingScript.fromHex('00006d4c050102')
    expect(s.chunks[3]).toMatchObject({ op: OP.OP_PUSHDATA1, invalidLength: true })
    expect(isTokenShaped(s)).toBe(true)
    expect(() => Bsv21Binary.decode(s)).toThrow(Bsv21BinaryError)
    expect(() => Bsv21Binary.decode(s)).toThrow('truncated push')
  })

  it('a truncated push after a value prefix makes the output token-shaped but invalid', () => {
    const s = LockingScript.fromHex(`20${ID_WIRE_HEX}516d4c050102`)
    expect(isTokenShaped(s)).toBe(true)
    expect(() => Bsv21Binary.decode(s)).toThrow('truncated push')
  })

  it('lock validates its inputs', () => {
    expect(() => t.lock(ID, 1n, PKH.slice(1))).toThrow('pubKeyHash must be 20 bytes')
    expect(() => t.lock(ID, 1n, [...PKH, 0])).toThrow('pubKeyHash must be 20 bytes')
    expect(() => t.lock(`${TXID}_1`, 1n, PKH)).toThrow('token id must be <64 lowercase hex>_0')
    expect(() => t.lock(ID, -1n, PKH)).toThrow('amount outside 0..2^64-1')
    expect(() => t.lock(ID, 1n, PKH)).not.toThrow()
  })

  // Builds a 1-in/1-out spend of a Bsv21Binary output, signs it and runs the
  // input through the SDK script interpreter (scripts-only verification).
  const signedSpend = async (
    lock: LockingScript,
    unlocker: ReturnType<Bsv21Binary['unlock']>
  ): Promise<{ spend: Transaction; valid: boolean }> => {
    const src = new Transaction(1, [], [{ lockingScript: lock, satoshis: 1 }], 0)
    const spend = new Transaction(
      1,
      [
        {
          sourceTransaction: src,
          sourceOutputIndex: 0,
          unlockingScriptTemplate: unlocker,
          sequence: 0xffffffff
        }
      ],
      [{ lockingScript: lock, satoshis: 1 }],
      0
    )
    await spend.sign()
    const interpreter = new Spend({
      sourceTXID: src.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: 1,
      lockingScript: lock,
      transactionVersion: spend.version,
      otherInputs: [],
      inputIndex: 0,
      unlockingScript: spend.inputs[0].unlockingScript!,
      outputs: spend.outputs,
      inputSequence: 0xffffffff,
      lockTime: spend.lockTime
    })
    let valid: boolean
    try {
      valid = interpreter.validate()
    } catch {
      valid = false
    }
    return { spend, valid }
  }

  it('unlock signs over the full locking script (spendable P2PKH remainder)', async () => {
    const key = PrivateKey.fromRandom()
    const pkh = key.toPublicKey().toHash() as number[]
    const lock = t.lock(ID, 7n, pkh)
    expect((await signedSpend(lock, t.unlock(key))).valid).toBe(true)
  })

  it('unlock with a key that does not own the output fails the script', async () => {
    const owner = PrivateKey.fromRandom()
    const lock = t.lock(ID, 7n, owner.toPublicKey().toHash() as number[])
    expect((await signedSpend(lock, t.unlock(PrivateKey.fromRandom()))).valid).toBe(false)
  })

  it.each<['all' | 'none' | 'single', boolean, number]>([
    ['all', false, 0x41],
    ['none', false, 0x42],
    ['single', true, 0xc3]
  ])('unlock passes signOutputs=%s anyoneCanPay=%p through', async (scope, acp, sighash) => {
    const key = PrivateKey.fromRandom()
    const lock = t.lock(ID, 7n, key.toPublicKey().toHash() as number[], [0xa0])
    const unlocker = t.unlock(key, scope, acp)
    const { spend, valid } = await signedSpend(lock, unlocker)
    const sig = spend.inputs[0].unlockingScript!.chunks[0].data!
    expect(sig[sig.length - 1]).toBe(sighash)
    expect(valid).toBe(true)
    expect(await unlocker.estimateLength(spend, 0)).toBe(108)
  })
})

describe('lockBRC29', () => {
  it('locks to hash160 of the wallet-derived public key', async () => {
    const key = PrivateKey.fromRandom()
    const calls: unknown[] = []
    const wallet = {
      getPublicKey: async (args: unknown, originator?: string) => {
        calls.push([args, originator])
        return { publicKey: key.toPublicKey().toString() }
      }
    } as unknown as WalletInterface
    const t = new Bsv21Binary(wallet, 'example.com')
    const s = await t.lockBRC29(ID, 9n, [2, 'mandala token'], '1', 'self', [0xa0])
    expect(calls).toEqual([
      [{ protocolID: [2, 'mandala token'], keyID: '1', counterparty: 'self' }, 'example.com']
    ])
    const d = Bsv21Binary.decode(s)
    expect(d).toMatchObject({ role: 'value', amount: 9n, payload: [0xa0], payloadCanonical: true })
    expect(d.restPubKeyHash).toEqual(key.toPublicKey().toHash())
    expect(tokenIdToString(d.tokenId!)).toBe(ID)
  })

  it('requires a wallet', async () => {
    await expect(
      new Bsv21Binary().lockBRC29(null, 0n, [2, 'mandala token'], '1', 'self')
    ).rejects.toThrow('lockBRC29 requires a wallet')
  })
})
