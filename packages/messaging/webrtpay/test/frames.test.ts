import { describe, expect, it, jest } from '@jest/globals'
import {
  FRAME_HEADER_BYTES,
  FrameDecoder,
  MAX_JSON_DEPTH,
  MAX_JSON_TOKENS,
  encodeMessage
} from '../src/channel/frames.js'
import { DEFAULTS } from '../src/types.js'
import { concatBytes, utf8Encode } from '../src/util/bytes.js'
import { WebRTPayError } from '../src/util/errors.js'
import type { WebRTPayErrorCode } from '../src/util/errors.js'
import { nestingDepth, rawFrame, rawFramesOf, structuralTokens } from './helpers/frames.js'

function codeOf(fn: () => unknown): WebRTPayErrorCode | undefined {
  try {
    fn()
  } catch (e) {
    if (e instanceof WebRTPayError) return e.code
    throw e
  }
  return undefined
}

function decoder(maxMessageBytes = 1_000_000): FrameDecoder {
  return new FrameDecoder({ maxMessageBytes })
}

function feed(d: FrameDecoder, frames: Uint8Array[]): unknown[] {
  const out: unknown[] = []
  for (const f of frames) {
    const m = d.push(f)
    if (m !== undefined) out.push(m)
  }
  return out
}

describe('encodeMessage', () => {
  it('uses a 6-byte header and a 16 KiB frame budget by default', () => {
    expect(FRAME_HEADER_BYTES).toBe(6)
    expect(DEFAULTS.chunkBytes).toBe(16384)
  })

  it('writes [version 1][flags][seq u32 big-endian][payload]', () => {
    const frames = encodeMessage(0x01020304, { a: 1 })
    expect(frames).toHaveLength(1)
    expect(Array.from(frames[0].subarray(0, 6))).toEqual([1, 1, 1, 2, 3, 4])
    expect(Array.from(frames[0].subarray(6))).toEqual(Array.from(utf8Encode('{"a":1}')))
  })

  it('encodes the largest sequence number', () => {
    const [frame] = encodeMessage(0xffffffff, {})
    expect(Array.from(frame.subarray(2, 6))).toEqual([255, 255, 255, 255])
  })

  it('emits a single final frame for an empty object', () => {
    const frames = encodeMessage(0, {})
    expect(frames).toHaveLength(1)
    expect(frames[0]).toHaveLength(FRAME_HEADER_BYTES + 2)
    expect(frames[0][1]).toBe(1)
  })

  it('splits a 1 MiB message into ceil(len / 16378) frames and decodes it back', () => {
    const message = { data: 'x'.repeat(1024 * 1024 - '{"data":""}'.length) }
    const json = utf8Encode(JSON.stringify(message))
    expect(json).toHaveLength(1024 * 1024)

    const frames = encodeMessage(7, message)
    expect(frames).toHaveLength(Math.ceil(json.length / (16384 - 6)))
    frames.forEach((f, i) => {
      expect(f.length).toBeLessThanOrEqual(16384)
      if (i < frames.length - 1) expect(f).toHaveLength(16384)
      expect(f[0]).toBe(1)
      expect(f[1]).toBe(i === frames.length - 1 ? 1 : 0)
      expect(new DataView(f.buffer, f.byteOffset, f.byteLength).getUint32(2, false)).toBe(7)
    })
    expect(concatBytes(...frames.map(f => f.subarray(6)))).toEqual(json)

    expect(feed(decoder(2 * 1024 * 1024), encodeMessage(0, message))).toEqual([message])
  })

  it('does not add a trailing empty frame when the payload is an exact multiple', () => {
    const per = 16384 - 6
    const one = { s: 'a'.repeat(per - '{"s":""}'.length) }
    expect(utf8Encode(JSON.stringify(one))).toHaveLength(per)
    expect(encodeMessage(0, one)).toHaveLength(1)

    const two = { s: 'a'.repeat(2 * per - '{"s":""}'.length) }
    expect(utf8Encode(JSON.stringify(two))).toHaveLength(2 * per)
    const frames = encodeMessage(0, two)
    expect(frames).toHaveLength(2)
    expect(frames.map(f => f[1])).toEqual([0, 1])
    expect(frames.every(f => f.length === 16384)).toBe(true)

    const over = { s: 'a'.repeat(per + 1 - '{"s":""}'.length) }
    expect(encodeMessage(0, over)).toHaveLength(2)
  })

  it('honours a custom chunk size', () => {
    const frames = encodeMessage(0, { k: 'abcdefghij' }, 10)
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.every(f => f.length <= 10)).toBe(true)
    expect(feed(decoder(), frames)).toEqual([{ k: 'abcdefghij' }])
  })

  it('splits multi-byte UTF-8 sequences across frames and reassembles them', () => {
    const message = { s: 'a€𝄞é' }
    const frames = encodeMessage(0, message, FRAME_HEADER_BYTES + 1)
    expect(frames).toHaveLength(utf8Encode(JSON.stringify(message)).length)
    expect(feed(decoder(), frames)).toEqual([message])
  })

  it('returns frames that own their bytes, so they can be handed to channel.send', () => {
    for (const f of encodeMessage(0, { s: 'a'.repeat(100) }, 40)) {
      expect(f.byteOffset).toBe(0)
      expect(f.buffer.byteLength).toBe(f.length)
    }
  })

  it('rejects a sequence number outside u32', () => {
    for (const seq of [-1, 1.5, 2 ** 32, Number.NaN, Infinity]) {
      expect(() => encodeMessage(seq, {})).toThrow(RangeError)
    }
  })

  it('rejects a chunk size that leaves no room for payload', () => {
    for (const chunk of [0, 5, 6, 6.5, Number.NaN]) {
      expect(() => encodeMessage(0, {}, chunk)).toThrow(RangeError)
    }
    expect(() => encodeMessage(0, {}, 7)).not.toThrow()
  })

  it('rejects a value that JSON cannot represent', () => {
    expect(() => encodeMessage(0, undefined)).toThrow(TypeError)
    expect(() => encodeMessage(0, () => 1)).toThrow(TypeError)
    expect(() => encodeMessage(0, Symbol('x'))).toThrow(TypeError)
  })
})

describe('FrameDecoder', () => {
  it('accepts consecutive sequence numbers from 0', () => {
    const d = decoder()
    expect(d.push(rawFrame(0, true, '{"n":0}'))).toEqual({ n: 0 })
    expect(d.push(rawFrame(1, true, '{"n":1}'))).toEqual({ n: 1 })
    expect(d.push(rawFrame(2, true, '{"n":2}'))).toEqual({ n: 2 })
  })

  it('rejects a skipped sequence number', () => {
    const d = decoder()
    expect(d.push(rawFrame(0, true, '{}'))).toEqual({})
    expect(codeOf(() => d.push(rawFrame(2, true, '{}')))).toBe('protocol')
  })

  it('requires the first message to be sequence 0', () => {
    expect(codeOf(() => decoder().push(rawFrame(1, true, '{}')))).toBe('protocol')
  })

  it('rejects a repeated or reversed sequence number', () => {
    const d = decoder()
    d.push(rawFrame(0, true, '{}'))
    d.push(rawFrame(1, true, '{}'))
    expect(codeOf(() => d.push(rawFrame(1, true, '{}')))).toBe('protocol')
    const e = decoder()
    e.push(rawFrame(0, true, '{}'))
    e.push(rawFrame(1, true, '{}'))
    expect(codeOf(() => e.push(rawFrame(0, true, '{}')))).toBe('protocol')
  })

  it('keeps every chunk of one message on the same sequence number', () => {
    const d = decoder()
    expect(d.push(rawFrame(0, false, '{"a":'))).toBeUndefined()
    expect(codeOf(() => d.push(rawFrame(1, true, '1}')))).toBe('protocol')
  })

  it('advances the sequence number only when a message completes', () => {
    const d = decoder()
    expect(d.push(rawFrame(0, false, '{"a":'))).toBeUndefined()
    expect(d.push(rawFrame(0, false, '1,"b"'))).toBeUndefined()
    expect(d.push(rawFrame(0, true, ':2}'))).toEqual({ a: 1, b: 2 })
    expect(d.push(rawFrame(1, true, '{"c":3}'))).toEqual({ c: 3 })
  })

  it('reassembles several multi-frame messages in a row without leftovers', () => {
    const d = decoder()
    const messages = [{ s: 'a'.repeat(50) }, { s: 'b'.repeat(70) }, { n: 1 }]
    const frames = messages.flatMap((m, i) => encodeMessage(i, m, 16))
    expect(frames.length).toBeGreaterThan(messages.length)
    expect(feed(d, frames)).toEqual(messages)
  })

  it('rejects a frame shorter than the header', () => {
    for (let n = 0; n < FRAME_HEADER_BYTES; n++) {
      expect(codeOf(() => decoder().push(new Uint8Array(n).fill(1)))).toBe('protocol')
    }
  })

  it('rejects an unknown version', () => {
    for (const version of [0, 2, 9, 255]) {
      expect(codeOf(() => decoder().push(rawFrame(0, true, '{}', { version })))).toBe('protocol')
    }
  })

  it('rejects reserved flag bits', () => {
    for (const flags of [2, 3, 0x80, 0xff]) {
      expect(codeOf(() => decoder().push(rawFrame(0, true, '{}', { flags })))).toBe('protocol')
    }
  })

  it('rejects a message that is not JSON', () => {
    for (const text of ['not json', '{"a":', '{a:1}', "{'a':1}", '{} {}', '{}x', '']) {
      expect(codeOf(() => decoder().push(rawFrame(0, true, text)))).toBe('protocol')
    }
  })

  it('rejects invalid UTF-8', () => {
    const bad = new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d])
    expect(codeOf(() => decoder().push(rawFrame(0, true, bad)))).toBe('protocol')
  })

  it('rejects a top level that is not an object', () => {
    for (const text of ['1', '"x"', 'true', 'null', '[]', '[{}]', '0']) {
      expect(codeOf(() => decoder().push(rawFrame(0, true, text)))).toBe('protocol')
    }
  })

  it('accepts an empty object and nested values', () => {
    expect(decoder().push(rawFrame(0, true, '{}'))).toEqual({})
    expect(decoder().push(rawFrame(0, true, '{"a":[1,{"b":null}],"c":"d"}'))).toEqual({
      a: [1, { b: null }],
      c: 'd'
    })
  })

  it('completes an empty object with a zero-length final frame', () => {
    const d = decoder()
    expect(d.push(rawFrame(0, false, '{}'))).toBeUndefined()
    expect(d.push(rawFrame(0, true, new Uint8Array(0)))).toEqual({})
    expect(d.push(rawFrame(1, true, '{"next":true}'))).toEqual({ next: true })
  })

  it('rejects a lone zero-length final frame', () => {
    expect(codeOf(() => decoder().push(rawFrame(0, true, new Uint8Array(0))))).toBe('protocol')
  })

  it('throws too_large on the frame that crosses the cap', () => {
    const message = { s: 'a'.repeat(2000 - '{"s":""}'.length) }
    expect(utf8Encode(JSON.stringify(message))).toHaveLength(2000)
    // 500-byte payloads: 500, 1000 are within the 1000-byte cap, 1500 is not.
    const frames = encodeMessage(0, message, FRAME_HEADER_BYTES + 500)
    expect(frames).toHaveLength(4)

    const d = decoder(1000)
    expect(d.push(frames[0])).toBeUndefined()
    expect(d.push(frames[1])).toBeUndefined()
    expect(codeOf(() => d.push(frames[2]))).toBe('too_large')
  })

  it('accepts a message of exactly the cap', () => {
    const message = { s: 'a'.repeat(1000 - '{"s":""}'.length) }
    expect(utf8Encode(JSON.stringify(message))).toHaveLength(1000)
    const d = decoder(1000)
    expect(feed(d, encodeMessage(0, message, FRAME_HEADER_BYTES + 500))).toEqual([message])
  })

  it('throws too_large for a single frame over the cap', () => {
    const frame = rawFrame(0, true, `{"s":"${'a'.repeat(1000)}"}`)
    expect(codeOf(() => decoder(1000).push(frame))).toBe('too_large')
  })

  it('applies the cap to each message separately', () => {
    const message = { s: 'a'.repeat(900 - '{"s":""}'.length) }
    const d = decoder(1000)
    expect(feed(d, [...encodeMessage(0, message), ...encodeMessage(1, message)])).toEqual([
      message,
      message
    ])
  })

  it('setMaxMessageBytes raises and lowers the cap for the frames that follow', () => {
    const message = { s: 'a'.repeat(2000 - '{"s":""}'.length) }
    const d = decoder(1000)
    d.setMaxMessageBytes(2000)
    expect(feed(d, encodeMessage(0, message, FRAME_HEADER_BYTES + 500))).toEqual([message])

    d.setMaxMessageBytes(1999)
    expect(codeOf(() => feed(d, encodeMessage(1, message)))).toBe('too_large')
  })

  it('setMaxMessageBytes lets a message in progress grow to the raised cap', () => {
    const message = { s: 'a'.repeat(2000 - '{"s":""}'.length) }
    const frames = encodeMessage(0, message, FRAME_HEADER_BYTES + 500)
    const d = decoder(1000)
    expect(d.push(frames[0])).toBeUndefined()
    expect(d.push(frames[1])).toBeUndefined()
    d.setMaxMessageBytes(2000)
    expect(feed(d, frames.slice(2))).toEqual([message])
  })

  it('setMaxMessageBytes rejects a value that is not a size', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => decoder().setMaxMessageBytes(bad)).toThrow(RangeError)
    }
  })

  it('checks sequence before size', () => {
    const d = decoder(10)
    expect(codeOf(() => d.push(rawFrame(5, true, 'a'.repeat(100))))).toBe('protocol')
  })

  it('stays failed after an error', () => {
    const d = decoder()
    d.push(rawFrame(0, true, '{}'))
    expect(codeOf(() => d.push(rawFrame(7, true, '{}')))).toBe('protocol')
    // The frame that would have been next in order is no longer accepted.
    expect(codeOf(() => d.push(rawFrame(1, true, '{}')))).toBe('protocol')

    const big = decoder(10)
    expect(codeOf(() => big.push(rawFrame(0, true, 'a'.repeat(100))))).toBe('too_large')
    expect(codeOf(() => big.push(rawFrame(0, true, '{}')))).toBe('too_large')
  })

  it('reads frames that are views into a larger buffer', () => {
    const frame = rawFrame(0, true, '{"v":1}')
    const backing = new Uint8Array(frame.length + 10).fill(0xee)
    backing.set(frame, 5)
    const view = backing.subarray(5, 5 + frame.length)
    expect(view.byteOffset).toBe(5)
    expect(decoder().push(view)).toEqual({ v: 1 })
  })

  it('reads any binary view by its bytes', () => {
    const bytes = rawFrame(0, true, '{"v":1}')
    expect(decoder().push(Buffer.from(bytes))).toEqual({ v: 1 })
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(decoder().push(dataView as unknown as Uint8Array)).toEqual({ v: 1 })
  })

  it('copies buffered payloads so a reused frame buffer cannot corrupt a message', () => {
    const d = decoder()
    const first = rawFrame(0, false, '{"a":')
    expect(d.push(first)).toBeUndefined()
    first.fill(0) // the transport recycles its buffer
    expect(d.push(rawFrame(0, true, '1}'))).toEqual({ a: 1 })
  })

  it('fails as protocol, keeping the cause, on a frame whose buffer was detached', () => {
    const thrown = (fn: () => unknown): unknown => {
      try {
        fn()
      } catch (e) {
        return e
      }
      throw new Error('Expected a throw')
    }
    const frame = rawFrame(0, true, '{}')
    structuredClone(frame.buffer, { transfer: [frame.buffer] }) // the caller gave it away
    const d = decoder()
    const error = thrown(() => d.push(frame))
    expect(error).toBeInstanceOf(WebRTPayError)
    expect(error).toMatchObject({ code: 'protocol', message: 'Frame could not be processed' })
    // by name: the typed array realm's TypeError is not the test's
    expect((error as WebRTPayError).cause).toHaveProperty('name', 'TypeError')
    // the decoder stays failed with that same error
    expect(thrown(() => d.push(rawFrame(0, true, '{}')))).toBe(error)
  })

  it('rejects a frame that is not binary', () => {
    for (const frame of ['{}', null, undefined, 42, {}, [1, 0, 0, 0, 0, 0]]) {
      expect(codeOf(() => decoder().push(frame as unknown as Uint8Array))).toBe('protocol')
    }
  })

  it('reassembles a message split into thousands of one-byte chunks', () => {
    const message = { s: 'z'.repeat(40_000), t: '€'.repeat(2000) }
    const frames = encodeMessage(0, message, FRAME_HEADER_BYTES + 1)
    expect(frames.length).toBeGreaterThan(40_000)
    expect(feed(decoder(), frames)).toEqual([message])
  })

  it('is not slowed or grown by endless empty non-final frames', () => {
    const d = decoder(1000)
    const empty = rawFrame(0, false, new Uint8Array(0))
    let completed = 0
    for (let i = 0; i < 200_000; i++) if (d.push(empty) !== undefined) completed++
    expect(completed).toBe(0)
    expect(d.push(rawFrame(0, true, '{"ok":1}'))).toEqual({ ok: 1 })
  })

  it('rejects an invalid cap', () => {
    for (const maxMessageBytes of [-1, 1.5, Number.NaN, Infinity]) {
      expect(() => new FrameDecoder({ maxMessageBytes })).toThrow(RangeError)
    }
    expect(() => new FrameDecoder({ maxMessageBytes: 0 })).not.toThrow()
  })
})

describe('FrameDecoder nesting limit', () => {
  /** `n` empty arrays inside one another. */
  const arrays = (n: number): string => '['.repeat(n) + ']'.repeat(n)

  /** An object holding `depth - 1` further levels (arrays, or alternating with objects). */
  function nested(depth: number, mixed = false): string {
    const open: string[] = []
    const close: string[] = []
    for (let level = 1; level < depth; level++) {
      const object = mixed && level % 2 === 0
      open.push(object ? '{"k":' : '[')
      close.push(object ? '}' : ']')
    }
    return `{"a":${open.join('')}1${close.reverse().join('')}}`
  }

  /** Run `fn` with `JSON.parse` spied on; returns how many times it was called. */
  function parseCalls(fn: () => void): number {
    const spy = jest.spyOn(JSON, 'parse')
    try {
      fn()
      return spy.mock.calls.length
    } finally {
      spy.mockRestore()
    }
  }

  it('measures depth the way the limit is documented', () => {
    expect(nestingDepth(JSON.parse('{"a":1}'))).toBe(1)
    expect(nestingDepth(JSON.parse('{"a":[{}]}'))).toBe(3)
    expect(nestingDepth(JSON.parse(nested(MAX_JSON_DEPTH)))).toBe(MAX_JSON_DEPTH)
    expect(nestingDepth(JSON.parse(nested(MAX_JSON_DEPTH, true)))).toBe(MAX_JSON_DEPTH)
  })

  it('rejects a deeply nested 1 MiB object as protocol without parsing it', () => {
    const depth = 524_288
    const text = '{"a":' + arrays(depth) + '}'
    expect(text.length).toBeGreaterThan(1024 * 1024)
    const frames = rawFramesOf(text)
    expect(frames.length).toBeGreaterThan(60)

    const d = decoder(2 * 1024 * 1024)
    let error: unknown
    const started = performance.now()
    const calls = parseCalls(() => {
      try {
        feed(d, frames)
      } catch (e) {
        error = e
      }
    })
    const elapsed = performance.now() - started

    expect(error).toBeInstanceOf(WebRTPayError)
    expect((error as WebRTPayError).code).toBe('protocol')
    expect(calls).toBe(0)
    expect(elapsed).toBeLessThan(1000)
    // The decoder stays failed, like after any other protocol error.
    expect(() => d.push(rawFrame(1, true, '{}'))).toThrow(error as Error)
  })

  it('decodes nesting exactly up to the limit and rejects one level more', () => {
    for (const mixed of [false, true]) {
      const ok = nested(MAX_JSON_DEPTH, mixed)
      const tooDeep = nested(MAX_JSON_DEPTH + 1, mixed)
      expect(nestingDepth(JSON.parse(tooDeep))).toBe(MAX_JSON_DEPTH + 1)

      expect(decoder().push(rawFrame(0, true, ok))).toEqual(JSON.parse(ok))
      expect(codeOf(() => decoder().push(rawFrame(0, true, tooDeep)))).toBe('protocol')

      // Same texts split into tiny frames, so reassembly feeds the check.
      expect(feed(decoder(), rawFramesOf(ok, 0, FRAME_HEADER_BYTES + 5))).toEqual([JSON.parse(ok)])
      expect(codeOf(() => feed(decoder(), rawFramesOf(tooDeep, 0, FRAME_HEADER_BYTES + 5)))).toBe(
        'protocol'
      )
    }
  })

  it('counts only open containers, not their total', () => {
    const wide =
      '{"a":[' + Array.from({ length: 100 }, () => arrays(MAX_JSON_DEPTH - 2)).join(',') + ']}'
    expect(nestingDepth(JSON.parse(wide))).toBe(MAX_JSON_DEPTH)
    expect(decoder().push(rawFrame(0, true, wide))).toEqual(JSON.parse(wide))
  })

  it('rejects nesting that is never closed', () => {
    const text = '{"a":' + '['.repeat(MAX_JSON_DEPTH + 1)
    expect(codeOf(() => decoder().push(rawFrame(0, true, text)))).toBe('protocol')
  })

  it('does not count brackets, braces or quotes inside strings', () => {
    const strings = [
      '['.repeat(1000),
      '{'.repeat(1000) + '}'.repeat(1000),
      '"',
      '\\',
      '\\\\',
      '\\"',
      '"[[[[',
      '\\"[[[['.repeat(50),
      '\\\\"[[{{'.repeat(50),
      '€[[{{é'.repeat(100)
    ]
    for (const s of strings) {
      const literal = JSON.stringify(s)
      const alone = `{"s":${literal}}`
      expect(decoder().push(rawFrame(0, true, alone))).toEqual({ s })

      // The string must close where JSON says, so nesting after it is still counted, both
      // when it is within the limit and when it is one level over.
      const before = (n: number): string => `{"s":${literal},"a":${arrays(n)}}`
      const after = (n: number): string => `{"a":${arrays(n)},"s":${literal}}`
      for (const build of [before, after]) {
        const ok = build(MAX_JSON_DEPTH - 1)
        expect(decoder().push(rawFrame(0, true, ok))).toEqual(JSON.parse(ok))
        const tooDeep = build(MAX_JSON_DEPTH)
        expect(codeOf(() => decoder().push(rawFrame(0, true, tooDeep)))).toBe('protocol')
      }
    }
  })

  it('accepts JSON whitespace around the object', () => {
    expect(decoder().push(rawFrame(0, true, ' \n\t\r{"a":1} \n'))).toEqual({ a: 1 })
  })

  it('rejects a top level that is not an object without parsing it', () => {
    const texts = ['', ' ', '1', '"x"', 'true', 'null', '[]', '[{}]', arrays(MAX_JSON_DEPTH * 100)]
    const calls = parseCalls(() => {
      for (const text of texts) {
        expect(codeOf(() => decoder().push(rawFrame(0, true, text)))).toBe('protocol')
      }
      // A byte-order mark is not JSON whitespace.
      expect(codeOf(() => decoder().push(rawFrame(0, true, '﻿{}')))).toBe('protocol')
    })
    expect(calls).toBe(0)
  })

  it('rejects more closing brackets than opening ones without parsing', () => {
    const calls = parseCalls(() => {
      for (const text of ['{}}', '{}]', '{"a":[]]}', '{}' + '}'.repeat(100) + arrays(40)]) {
        expect(codeOf(() => decoder().push(rawFrame(0, true, text)))).toBe('protocol')
      }
    })
    expect(calls).toBe(0)
  })

  it('still reports too_large first for an oversized bomb', () => {
    const text = '{"a":' + arrays(5000) + '}'
    expect(codeOf(() => decoder(1000).push(rawFrame(0, true, text)))).toBe('too_large')
  })
})

describe('FrameDecoder token limit', () => {
  /** `{"a":[0,0,…]}` with exactly `tokens` structural tokens: `{`, `:`, `[` and the commas. */
  function wideArray(tokens: number): string {
    return `{"a":[${Array.from({ length: tokens - 2 }, () => '0').join(',')}]}`
  }

  /** `{"k0":0,"k1":0,…}` with `members` members: 2 tokens each (`{` plus `:`s and `,`s). */
  function wideObject(members: number): string {
    return `{${Array.from({ length: members }, (_, i) => `"k${i}":0`).join(',')}}`
  }

  function parseCalls(fn: () => void): number {
    const spy = jest.spyOn(JSON, 'parse')
    try {
      fn()
      return spy.mock.calls.length
    } finally {
      spy.mockRestore()
    }
  }

  it('measures tokens the way the limit is documented', () => {
    expect(structuralTokens(JSON.parse('{"a":1}'))).toBe(2)
    expect(structuralTokens(JSON.parse('{"a":[1,2,{}],"b":"x,:[{"}'))).toBe(8)
    expect(structuralTokens(JSON.parse(wideArray(MAX_JSON_TOKENS)))).toBe(MAX_JSON_TOKENS)
    expect(structuralTokens(JSON.parse(wideObject(MAX_JSON_TOKENS / 2)))).toBe(MAX_JSON_TOKENS)
  })

  it('decodes exactly MAX_JSON_TOKENS tokens and rejects one more before parsing', () => {
    expect(MAX_JSON_TOKENS).toBe(4096)
    for (const [ok, over] of [
      [wideArray(MAX_JSON_TOKENS), wideArray(MAX_JSON_TOKENS + 1)],
      [wideObject(MAX_JSON_TOKENS / 2), `${wideObject(MAX_JSON_TOKENS / 2).slice(0, -1)},"z":0}`]
    ]) {
      expect(decoder().push(rawFrame(0, true, ok))).toEqual(JSON.parse(ok))
      // Split into tiny frames, so reassembly feeds the check too.
      expect(feed(decoder(), rawFramesOf(ok, 0, FRAME_HEADER_BYTES + 7))).toEqual([JSON.parse(ok)])
      const calls = parseCalls(() => {
        expect(codeOf(() => decoder().push(rawFrame(0, true, over)))).toBe('protocol')
        expect(codeOf(() => feed(decoder(), rawFramesOf(over, 0, FRAME_HEADER_BYTES + 7)))).toBe(
          'protocol'
        )
      })
      expect(calls).toBe(0)
    }
  })

  it('rejects a 16 MiB array of empty objects quickly and without parsing it', () => {
    // The audit's amplification bomb: valid JSON, depth 3, about 5.6 million objects.
    const head = '{"t":"x","a":['
    const count = Math.floor((DEFAULTS.inboundMaxMessageBytes - head.length - 2) / 3)
    const text = head + Array.from({ length: count }, () => '{}').join(',') + ']}'
    expect(text.length).toBeLessThanOrEqual(DEFAULTS.inboundMaxMessageBytes)
    const frames = rawFramesOf(text)

    const d = decoder(DEFAULTS.inboundMaxMessageBytes)
    let error: unknown
    const started = performance.now()
    const calls = parseCalls(() => {
      try {
        feed(d, frames)
      } catch (e) {
        error = e
      }
    })

    expect((error as WebRTPayError).code).toBe('protocol')
    expect(calls).toBe(0)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('does not count commas, colons or brackets inside strings', () => {
    const noisy = ',:[{'.repeat(5000)
    const text = JSON.stringify({ s: noisy, t: `\\"${noisy}`, a: [noisy] })
    expect(decoder().push(rawFrame(0, true, text))).toEqual(JSON.parse(text))
  })

  it('leaves room for a large payment: its transaction is a single string', () => {
    const payment = {
      t: 'payment',
      id: 'abc',
      token: {
        customInstructions: { derivationPrefix: 'cA==', derivationSuffix: 'cw==' },
        transaction: 'A'.repeat(2 * 1024 * 1024),
        amount: 1000,
        outputIndex: 0
      },
      note: 'lunch'
    }
    expect(structuralTokens(payment)).toBeLessThan(32)
    expect(feed(decoder(4 * 1024 * 1024), encodeMessage(0, payment))).toEqual([payment])
  })
})

describe('FrameDecoder message checks report the first problem', () => {
  const NOT_OBJECT = 'Message is not a JSON object'
  const TOO_DEEP = 'Message nests deeper than 32 levels'
  const TOO_MANY = 'Message has more than 4096 structural tokens'
  const UNBALANCED = 'Message has unbalanced brackets'
  const NOT_JSON = 'Message is not valid JSON'

  /** The message of the protocol error that pushing `text` as one final frame throws. */
  function failure(text: string): string {
    let error: unknown
    try {
      decoder().push(rawFrame(0, true, text))
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(WebRTPayError)
    expect((error as WebRTPayError).code).toBe('protocol')
    return (error as WebRTPayError).message
  }

  /**
   * `{"a":[` then `commas` elements and `opens` more arrays: the last `[` is token
   * 3 + commas + opens and opens container 2 + opens.
   */
  const crowded = (commas: number, opens: number): string =>
    '{"a":[' + '0,'.repeat(commas) + '['.repeat(opens)

  const cases: [string, string, string][] = [
    ['an empty message', '', NOT_OBJECT],
    ['only JSON whitespace', ' \t\n\r', NOT_OBJECT],
    ['an array opening 40 more arrays', ' [' + '['.repeat(40), NOT_OBJECT],
    ['a byte before the object', 'x{}', NOT_OBJECT],
    ['an object that never closes', ' \n{"a":1', NOT_JSON],
    ['an unclosed string full of brackets', '{"a":"' + '['.repeat(40), NOT_JSON],
    ['a string ending in a backslash', '{"a":"\\', NOT_JSON],
    [
      'an escaped quote, so the brackets after it are string',
      '{"a":"\\"' + '['.repeat(40),
      NOT_JSON
    ],
    [
      'an escaped backslash, so the quote after it closes',
      '{"a":"\\\\"' + '['.repeat(40),
      TOO_DEEP
    ],
    ['33 open containers before text that is not JSON', '{"a":' + '['.repeat(33) + 'x', TOO_DEEP],
    ['32 open containers in text that is not JSON', '{' + '['.repeat(31), NOT_JSON],
    ['33 open objects', '{' + '{'.repeat(32), TOO_DEEP],
    ['33 open arrays', '{' + '['.repeat(32), TOO_DEEP],
    ['4097 tokens of colons', '{' + ':'.repeat(4096), TOO_MANY],
    ['4097 tokens of commas', '{' + ','.repeat(4096), TOO_MANY],
    ['4096 tokens in text that is not JSON', '{' + ','.repeat(4095), NOT_JSON],
    ['token 4097 opening container 33', crowded(4063, 31), TOO_MANY],
    ['token 4096 opening container 33', crowded(4062, 31), TOO_DEEP],
    ['an extra brace before 5000 commas', '{}}' + ','.repeat(5000), UNBALANCED],
    ['an extra bracket before 40 openers', '{}]' + '['.repeat(40), UNBALANCED],
    ['4097 tokens before extra brackets', crowded(4100, 0) + ']'.repeat(4), TOO_MANY],
    ['33 open containers before extra brackets', '{' + '['.repeat(40) + ']'.repeat(50), TOO_DEEP]
  ]

  it.each(cases)('%s', (_, text, message) => {
    expect(failure(text)).toBe(message)
  })

  it('keeps the parser error as the cause of invalid JSON, and no cause otherwise', () => {
    const error = (text: string): WebRTPayError => {
      try {
        decoder().push(rawFrame(0, true, text))
      } catch (e) {
        return e as WebRTPayError
      }
      throw new Error('expected a throw')
    }
    expect(error('{"a":').cause).toBeInstanceOf(SyntaxError)
    expect(error('[]')).not.toHaveProperty('cause')
  })
})
