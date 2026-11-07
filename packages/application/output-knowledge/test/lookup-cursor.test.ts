import { describe, expect, it } from '@jest/globals'
import { canonicalOutputJSON, Hash, SymmetricKey, Utils } from '@bsv/sdk'
import { LookupCursorCodec, type LookupCursorPosition } from '../src/lookup/LookupCursorCodec.js'
import { lookupIndexKey } from '../src/lookup/LookupIndexKey.js'

const secret = '01'.repeat(32)
const maximum = '18446744073709551615'
const codec = () => new LookupCursorCodec(secret, 'session-one', 'epoch-one')

describe('provider-local encrypted lookup cursors', () => {
  it.each<LookupCursorPosition>([
    { phase: 'snapshot', watermark: '0', after: null },
    { phase: 'snapshot', watermark: maximum, after: 'ff'.repeat(128) },
    { phase: 'live', through: '0' },
    { phase: 'live', through: maximum }
  ])('recovers a bounded, owned $phase position after reopening the codec', input => {
    const cursor = codec().seal(input)
    expect(cursor.length).toBeLessThanOrEqual(1024)
    expect(codec().open(cursor)).toEqual(input)
    const copy = codec().open(cursor)
    copy.phase = 'live'
    expect(codec().open(cursor)).toEqual(input)
    expect(codec().seal(input)).not.toBe(cursor)
  })

  it('does not expose an internal scan key in the cursor plaintext', () => {
    const after = '01020304'.repeat(32)
    const cursor = codec().seal({ phase: 'snapshot', watermark: '7', after })
    expect(Utils.toUTF8(Utils.toArray(cursor, 'base64'))).not.toContain(after)
    expect(codec().open(cursor)).toEqual({ phase: 'snapshot', watermark: '7', after })
  })

  it.each([
    () => new LookupCursorCodec('02'.repeat(32), 'session-one', 'epoch-one'),
    () => new LookupCursorCodec(secret, 'session-two', 'epoch-one'),
    () => new LookupCursorCodec(secret, 'session-one', 'epoch-two')
  ])('requires the exact retained key, session and epoch', other => {
    const cursor = codec().seal({ phase: 'live', through: '42' })
    expect(() => other().open(cursor)).toThrow('Invalid or unavailable lookup cursor')
  })

  it.each([undefined, null, 7, '', 'x', 'A'.repeat(1028), 'AAAA===', 'AA A=', 'AB=='])(
    'bounds and rejects malformed input without returning cursor details (%s)',
    cursor => {
      expect(() => codec().open(cursor)).toThrow(
        expect.objectContaining({ code: 'reset-required', retryable: false })
      )
    }
  )

  it('rejects changed ciphertext, tag, nonce and truncated framing uniformly', () => {
    const bytes = Utils.toArray(codec().seal({ phase: 'live', through: '42' }), 'base64')
    for (const at of [0, 32, bytes.length - 1]) {
      const changed = [...bytes]
      changed[at] ^= 1
      expect(() => codec().open(Utils.toBase64(changed))).toThrow(
        'Invalid or unavailable lookup cursor'
      )
    }
    expect(() => codec().open(Utils.toBase64(bytes.slice(0, 47)))).toThrow(
      'Invalid or unavailable lookup cursor'
    )
  })

  it.each([
    {},
    { phase: 'other' },
    { phase: 'snapshot', watermark: '01', after: null },
    { phase: 'snapshot', watermark: '0', after: '' },
    { phase: 'snapshot', watermark: '0', after: null, through: '0' },
    { phase: 'live', through: '18446744073709551616' },
    { phase: 'live', through: 1 },
    { phase: 'live', through: '1', after: null }
  ])('does not seal an invalid local position (%j)', input => {
    expect(() => codec().seal(input as LookupCursorPosition)).toThrow()
  })

  it.each(['', '0', 'A0', '0g', 'aa'.repeat(129), 'a\u0000', 'aa\n'])(
    'requires a canonical bounded index key (%s)',
    value => {
      expect(() => lookupIndexKey(value)).toThrow('Invalid lookup index order key')
    }
  )

  it('rejects unknown or corrupted saved framing even with an intact authentication tag', () => {
    const format = 'output-live-lookup-cursor/1'
    const binding = Utils.toHex(
      Hash.sha256(
        Utils.toArray(
          canonicalOutputJSON({ format, session: 'session-one', epoch: 'epoch-one' }),
          'utf8'
        )
      )
    )
    const encrypt = (bytes: number[]) =>
      Utils.toBase64(new SymmetricKey(secret, 'hex').encrypt(bytes) as number[])
    for (const value of [
      { format: 'output-live-lookup-cursor/2', binding, position: { phase: 'live', through: '1' } },
      { format, binding, position: { phase: 'snapshot', watermark: '0' } },
      { format, binding, position: { phase: 'live', through: '1' }, extra: true }
    ])
      expect(() =>
        codec().open(encrypt(Utils.toArray(canonicalOutputJSON(value), 'utf8')))
      ).toThrow('Invalid or unavailable lookup cursor')
    expect(() => codec().open(encrypt([255]))).toThrow('Invalid or unavailable lookup cursor')
  })
})

describe('persisted cursor framing compatibility', () => {
  it('retains the exact format and UTF-8 binding expected by an independent decoder', () => {
    const session = 'session-é',
      epoch = 'epoch-日'
    const position = { phase: 'live' as const, through: '42' }
    const cursor = new LookupCursorCodec(secret, session, epoch).seal(position)
    const bytes = new SymmetricKey(secret, 'hex').decrypt(
      Utils.toArray(cursor, 'base64')
    ) as number[]
    expect(JSON.parse(Utils.toUTF8(bytes))).toEqual({
      format: 'output-live-lookup-cursor/1',
      binding: Utils.toHex(
        Hash.sha256(
          Utils.toArray(
            canonicalOutputJSON({
              format: 'output-live-lookup-cursor/1',
              session,
              epoch
            }),
            'utf8'
          )
        )
      ),
      position
    })
  })

  it('rejects unknown phases even if their remaining fields resemble live history', () => {
    expect(() =>
      codec().seal({ phase: 'other', through: '1' } as unknown as LookupCursorPosition)
    ).toThrow(expect.objectContaining({ code: 'invalid', message: 'Invalid lookup cursor phase' }))
  })

  it('does not coerce an object into a canonical index key', () => {
    expect(() => lookupIndexKey({ length: 2, toString: () => 'ab' })).toThrow(
      expect.objectContaining({ code: 'invalid', message: 'Invalid lookup index order key' })
    )
  })
})
