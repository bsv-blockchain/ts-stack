import { Bsv21Token } from '../Bsv21Token.js'
import { LockingScript, Utils } from '@bsv/sdk'

const OWNER = 'ab'.repeat(20)

function utf8ToHex(s: string): string {
  return Utils.toArray(s, 'utf8')
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
function push(bytesHex: string): string {
  const len = bytesHex.length / 2
  if (len === 0) return '00'
  if (len <= 0x4b) return len.toString(16).padStart(2, '0') + bytesHex
  if (len <= 0xff) return '4c' + len.toString(16).padStart(2, '0') + bytesHex
  const lengthBytes = Array.from({ length: len <= 0xffff ? 2 : 4 }, (_, index) =>
    ((len >>> (index * 8)) & 0xff).toString(16).padStart(2, '0')
  ).join('')
  return (len <= 0xffff ? '4d' : '4e') + lengthBytes + bytesHex
}

const P2PKH = '76a914' + OWNER + '88ac'
const PAYLOAD = { p: 'bsv-20', op: 'transfer', id: `${'cd'.repeat(32)}_0`, amt: '500' }

/** An ord envelope: `fields` are hex tag/value pairs before the body. */
function envelopeHex(
  payload: object,
  fields = '51' + push(utf8ToHex('application/bsv-20'))
): string {
  return (
    '00' +
    '63' + // OP_FALSE OP_IF
    push(utf8ToHex('ord')) +
    fields +
    '00' + // OP_0 body tag
    push(utf8ToHex(JSON.stringify(payload))) +
    '68' // OP_ENDIF
  )
}

// Build a BSV-21 envelope with the given JSON payload + P2PKH owner tail.
function bsv21Script(
  payload: Record<string, string>,
  owner = OWNER,
  contentType = 'application/bsv-20'
): LockingScript {
  const envelope = envelopeHex(payload, '51' + push(utf8ToHex(contentType)))
  const p2pkh = '76a914' + owner + '88ac'
  return LockingScript.fromHex(envelope + p2pkh)
}

describe('Bsv21Token.decode', () => {
  it('decodes a transfer output', () => {
    const id = `${'cd'.repeat(32)}_0`
    const d = Bsv21Token.decode(bsv21Script({ p: 'bsv-20', op: 'transfer', id, amt: '500' }))
    expect(d).toMatchObject({ id, amt: '500', isMint: false, ownerHash160: OWNER })
  })

  it('decodes a deploy+mint output (no id in payload)', () => {
    const d = Bsv21Token.decode(
      bsv21Script({ p: 'bsv-20', op: 'deploy+mint', amt: '21000000', dec: '8', sym: 'TIK' })
    )
    expect(d).toMatchObject({ id: '', amt: '21000000', dec: 8, sym: 'TIK', isMint: true })
  })

  it('isBsv21 is false for plain P2PKH', () => {
    expect(Bsv21Token.isBsv21(LockingScript.fromHex(`76a914${OWNER}88ac`))).toBe(false)
  })

  it('throws on a non-bsv-20 inscription protocol', () => {
    expect(() =>
      Bsv21Token.decode(bsv21Script({ p: 'bsv-21', op: 'transfer', id: 'x', amt: '1' }))
    ).toThrow(/bsv-20/)
  })

  it('throws on a missing/invalid amount', () => {
    expect(() =>
      Bsv21Token.decode(bsv21Script({ p: 'bsv-20', op: 'transfer', id: 'x' } as any))
    ).toThrow(/amount/)
  })

  it.each([300, 70_000])('decodes JSON payloads using extended pushdata at %d bytes', size => {
    const decoded = Bsv21Token.decode(
      bsv21Script({
        p: 'bsv-20',
        op: 'transfer',
        id: 'large',
        amt: '1',
        metadata: 'x'.repeat(size)
      })
    )

    expect(decoded).toMatchObject({ id: 'large', amt: '1' })
  })

  it('rejects the wrong content type', () => {
    expect(() =>
      Bsv21Token.decode(
        bsv21Script({ p: 'bsv-20', op: 'transfer', id: 'x', amt: '1' }, OWNER, 'application/json')
      )
    ).toThrow('wrong content-type')
  })

  it('rejects a long script without the ord envelope prefix', () => {
    expect(() => Bsv21Token.decode(LockingScript.fromHex('01'.repeat(31)))).toThrow(
      'missing OP_FALSE OP_IF'
    )
  })

  it('decodes auth and deploy+auth, which carry no amount', () => {
    const id = `${'cd'.repeat(32)}_0`
    expect(Bsv21Token.decode(bsv21Script({ p: 'bsv-20', op: 'auth', id }))).toMatchObject({
      id,
      amt: '0',
      op: 'auth',
      isMint: false
    })
    expect(Bsv21Token.decode(bsv21Script({ p: 'bsv-20', op: 'deploy+auth' }))).toMatchObject({
      id: '',
      amt: '0',
      op: 'deploy+auth'
    })
    expect(() => Bsv21Token.decode(bsv21Script({ p: 'bsv-20', op: 'auth', id, amt: '1' }))).toThrow(
      'carries no amount'
    )
  })

  it('exposes the op, payload and spend condition', () => {
    const d = Bsv21Token.decode(bsv21Script(PAYLOAD))
    expect(d.op).toBe('transfer')
    expect(d.payload).toEqual(PAYLOAD)
    expect(d.lockingScript.toHex()).toBe(P2PKH)
  })

  it('reads the envelope after the locking script', () => {
    const d = Bsv21Token.decode(LockingScript.fromHex(P2PKH + envelopeHex(PAYLOAD)))
    expect(d).toMatchObject({ id: PAYLOAD.id, amt: '500', ownerHash160: OWNER })
    expect(d.lockingScript.toHex()).toBe(P2PKH)
  })

  it('reads the envelope before OP_CODESEPARATOR and the locking script', () => {
    const d = Bsv21Token.decode(LockingScript.fromHex(envelopeHex(PAYLOAD) + 'ab' + P2PKH))
    expect(d.ownerHash160).toBe(OWNER)
    expect(d.lockingScript.toHex()).toBe(P2PKH)
  })

  it('reads a non-P2PKH spend condition with no owner hash', () => {
    const d = Bsv21Token.decode(LockingScript.fromHex(envelopeHex(PAYLOAD) + '51'))
    expect(d.ownerHash160).toBe('')
    expect(d.lockingScript.toASM()).toBe('OP_1')
    expect(
      Bsv21Token.decode(LockingScript.fromHex(envelopeHex(PAYLOAD))).lockingScript.chunks
    ).toEqual([])
  })

  it('takes the last value of a repeated field', () => {
    const bsv20 = '51' + push(utf8ToHex('application/bsv-20'))
    const text = '51' + push(utf8ToHex('text/plain'))
    expect(
      Bsv21Token.decode(LockingScript.fromHex(envelopeHex(PAYLOAD, text + bsv20) + P2PKH)).amt
    ).toBe('500')
    expect(() =>
      Bsv21Token.decode(LockingScript.fromHex(envelopeHex(PAYLOAD, bsv20 + text) + P2PKH))
    ).toThrow('wrong content-type')
  })

  it('accepts single-byte pushes as tag aliases and ignores unknown fields', () => {
    const fields =
      '0101' + // push 0x01: the content-type tag
      push(utf8ToHex('application/bsv-20')) +
      '55' + // OP_5: an unknown field
      push('beef') +
      push(utf8ToHex('key')) + // a multi-byte tag names a field this decoder does not use
      push('cafe')
    const aliased =
      '00' +
      '63' +
      push(utf8ToHex('ord')) +
      fields +
      '0100' + // push 0x00: the body tag
      push(utf8ToHex(JSON.stringify(PAYLOAD))) +
      '68' +
      P2PKH
    const script = LockingScript.fromHex(aliased)
    expect(Bsv21Token.decode(script)).toMatchObject({ amt: '500', ownerHash160: OWNER })
    const envelope = Bsv21Token.envelope(script)!
    expect(envelope.contentType).toBe('application/bsv-20')
    expect(envelope.fields.get(5)).toEqual([0xbe, 0xef])
  })

  it('rejects a truncated envelope and locates none in plain scripts', () => {
    const truncated =
      '00' + '63' + push(utf8ToHex('ord')) + '51' + push(utf8ToHex('application/bsv-20'))
    expect(() => Bsv21Token.decode(LockingScript.fromHex(truncated))).toThrow(
      'unterminated ord envelope'
    )
    expect(() =>
      Bsv21Token.decode(LockingScript.fromHex(truncated + '00' + push(utf8ToHex('{}')) + '76'))
    ).toThrow('missing OP_ENDIF')
    expect(Bsv21Token.envelope(LockingScript.fromHex(P2PKH))).toBeUndefined()
    const image = LockingScript.fromHex(envelopeHex(PAYLOAD, '51' + push(utf8ToHex('image/png'))))
    expect(Bsv21Token.envelope(image)?.contentType).toBe('image/png')
  })
})
