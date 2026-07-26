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
  const lo = len & 0xff
  const hi = (len >> 8) & 0xff
  return '4d' + lo.toString(16).padStart(2, '0') + hi.toString(16).padStart(2, '0') + bytesHex
}

// Build a BSV-21 envelope with the given JSON payload + P2PKH owner tail.
function bsv21Script(payload: Record<string, string>, owner = OWNER): LockingScript {
  const json = utf8ToHex(JSON.stringify(payload))
  const envelope =
    '00' +
    '63' + // OP_FALSE OP_IF
    push(utf8ToHex('ord')) +
    '51' + // OP_1 content-type tag
    push(utf8ToHex('application/bsv-20')) +
    '00' + // OP_0 separator
    push(json) +
    '68' // OP_ENDIF
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
})
