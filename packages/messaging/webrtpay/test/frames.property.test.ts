import { describe, expect, it } from '@jest/globals'
import fc from 'fast-check'
import {
  FRAME_HEADER_BYTES,
  FrameDecoder,
  MAX_JSON_DEPTH,
  MAX_JSON_TOKENS,
  encodeMessage
} from '../src/channel/frames.js'
import { DEFAULTS } from '../src/types.js'
import { utf8Encode } from '../src/util/bytes.js'
import { WebRTPayError } from '../src/util/errors.js'
import { nestingDepth, rawFramesOf, structuralTokens } from './helpers/frames.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

// Graphemes only: a lone surrogate would not survive stringify -> UTF-8 -> parse.
const text = fc.string({ unit: 'grapheme', maxLength: 40 })
const message = fc.object({
  key: text,
  values: [
    text,
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null)
  ],
  maxDepth: 3,
  maxKeys: 6
})
const chunkSize = fc.oneof(
  fc.integer({ min: FRAME_HEADER_BYTES + 1, max: 64 }),
  fc.constant(DEFAULTS.chunkBytes)
)

/** What the receiver should see: the JSON round trip normalises -0 and similar. */
function normalised(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

function seqOf(frame: Uint8Array): number {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2, false)
}

/** Push every frame; return what came out or the error that stopped the stream. */
function run(
  decoder: FrameDecoder,
  frames: Uint8Array[]
): { messages: unknown[]; error?: WebRTPayError; at?: number } {
  const messages: unknown[] = []
  for (let i = 0; i < frames.length; i++) {
    try {
      const m = decoder.push(frames[i])
      if (m !== undefined) messages.push(m)
    } catch (e) {
      // Anything but a WebRTPayError is a bug in the decoder: let it fail the property.
      if (!(e instanceof WebRTPayError)) throw e
      return { messages, error: e, at: i }
    }
  }
  return { messages }
}

function isPlainObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

describe('frames: round trips', () => {
  it('random message sequences survive chunking and reassembly in order', () => {
    fc.assert(
      fc.property(
        fc.array(message, { minLength: 1, maxLength: 6 }),
        chunkSize,
        (messages, chunk) => {
          const decoder = new FrameDecoder({ maxMessageBytes: DEFAULTS.maxMessageBytes })
          const all: Uint8Array[] = []
          messages.forEach((m, seq) => {
            const frames = encodeMessage(seq, m, chunk)
            const length = utf8Encode(JSON.stringify(m)).length
            expect(frames).toHaveLength(Math.ceil(length / (chunk - FRAME_HEADER_BYTES)))
            frames.forEach((f, i) => {
              expect(f.length).toBeLessThanOrEqual(chunk)
              expect(f[0]).toBe(1)
              expect(f[1]).toBe(i === frames.length - 1 ? 1 : 0)
              expect(seqOf(f)).toBe(seq)
            })
            all.push(...frames)
          })
          const result = run(decoder, all)
          expect(result.error).toBeUndefined()
          expect(result.messages).toEqual(messages.map(normalised))
        }
      )
    )
  })

  it('a stream starting at any sequence number other than 0 is a protocol error', () => {
    fc.assert(
      fc.property(message, fc.integer({ min: 1, max: 0xffffffff }), chunkSize, (m, seq, chunk) => {
        const result = run(
          new FrameDecoder({ maxMessageBytes: DEFAULTS.maxMessageBytes }),
          encodeMessage(seq, m, chunk)
        )
        expect(result.error?.code).toBe('protocol')
        expect(result.at).toBe(0)
        expect(result.messages).toEqual([])
      })
    )
  })

  it('the cap fires on exactly the first frame whose running total passes it', () => {
    fc.assert(
      fc.property(
        message,
        fc.integer({ min: FRAME_HEADER_BYTES + 1, max: 48 }),
        fc.integer({ min: 0, max: 400 }),
        (m, chunk, cap) => {
          const frames = encodeMessage(0, m, chunk)
          const length = utf8Encode(JSON.stringify(m)).length
          const result = run(new FrameDecoder({ maxMessageBytes: cap }), frames)
          if (length <= cap) {
            expect(result.error).toBeUndefined()
            expect(result.messages).toEqual([normalised(m)])
          } else {
            const per = chunk - FRAME_HEADER_BYTES
            expect(result.error?.code).toBe('too_large')
            expect(result.at).toBe(Math.floor(cap / per))
            expect(result.messages).toEqual([])
          }
        }
      )
    )
  })
})

describe('frames: hostile input', () => {
  const rawFrames = fc.array(fc.uint8Array({ maxLength: 48 }), { maxLength: 24 })

  const headeredFrame = fc
    .record({
      flags: fc.oneof(fc.constant(0), fc.constant(1), fc.integer({ min: 0, max: 255 })),
      seq: fc.oneof(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 0xffffffff })),
      payload: fc.oneof(
        fc.uint8Array({ maxLength: 48 }),
        fc
          .constantFrom(
            '{}',
            '{"a":',
            '1}',
            '[]',
            'null',
            '{"a":1}',
            '',
            ' {"a":1} ',
            '{}}',
            '{"a":' + '['.repeat(MAX_JSON_DEPTH + 1),
            '{"a":' + '['.repeat(MAX_JSON_DEPTH + 1) + ']'.repeat(MAX_JSON_DEPTH + 1) + '}'
          )
          .map(utf8Encode)
      )
    })
    .map(({ flags, seq, payload }) => {
      const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length)
      frame[0] = 1
      frame[1] = flags
      new DataView(frame.buffer).setUint32(2, seq, false)
      frame.set(payload, FRAME_HEADER_BYTES)
      return frame
    })

  function assertOnlyWebRTPayErrors(frames: Uint8Array[], cap: number): void {
    const decoder = new FrameDecoder({ maxMessageBytes: cap })
    let failed: WebRTPayError | undefined
    for (const frame of frames) {
      try {
        const m = decoder.push(frame)
        // Once failed, the decoder must never accept anything again.
        expect(failed).toBeUndefined()
        if (m !== undefined) expect(isPlainObject(m)).toBe(true)
      } catch (e) {
        expect(e).toBeInstanceOf(WebRTPayError)
        const err = e as WebRTPayError
        expect(['protocol', 'too_large']).toContain(err.code)
        if (failed) expect(err).toBe(failed)
        failed = err
      }
    }
  }

  it('random byte frames only ever throw WebRTPayError', () => {
    fc.assert(
      fc.property(rawFrames, fc.integer({ min: 0, max: 64 }), (frames, cap) => {
        assertOnlyWebRTPayErrors(frames, cap)
      })
    )
  })

  it('well-formed headers with random payloads only ever throw WebRTPayError', () => {
    fc.assert(
      fc.property(
        fc.array(headeredFrame, { maxLength: 24 }),
        fc.integer({ min: 0, max: 64 }),
        (frames, cap) => {
          assertOnlyWebRTPayErrors(frames, cap)
        }
      )
    )
  })

  it('corrupted, truncated, dropped, duplicated and reordered streams only ever throw WebRTPayError', () => {
    const stream = fc
      .tuple(fc.array(message, { minLength: 1, maxLength: 4 }), fc.integer({ min: 7, max: 40 }))
      .map(([messages, chunk]) => messages.flatMap((m, seq) => encodeMessage(seq, m, chunk)))
    const mutation = fc.oneof(
      fc.record({
        kind: fc.constant('flip' as const),
        at: fc.nat(),
        offset: fc.nat(),
        value: fc.integer({ min: 0, max: 255 })
      }),
      fc.record({ kind: fc.constant('truncate' as const), at: fc.nat(), keep: fc.nat() }),
      fc.record({ kind: fc.constant('drop' as const), at: fc.nat() }),
      fc.record({ kind: fc.constant('duplicate' as const), at: fc.nat() }),
      fc.record({ kind: fc.constant('swap' as const), at: fc.nat(), other: fc.nat() })
    )

    fc.assert(
      fc.property(
        stream,
        fc.array(mutation, { minLength: 1, maxLength: 3 }),
        (frames, mutations) => {
          let out = frames.map(f => f.slice())
          for (const m of mutations) {
            const i = m.at % out.length
            if (m.kind === 'flip') {
              const f = out[i]
              f[m.offset % f.length] = m.value
            } else if (m.kind === 'truncate') {
              out[i] = out[i].subarray(0, m.keep % (out[i].length + 1))
            } else if (m.kind === 'drop') {
              out = out.filter((_, j) => j !== i)
            } else if (m.kind === 'duplicate') {
              out = [...out.slice(0, i + 1), out[i], ...out.slice(i + 1)]
            } else {
              const j = m.other % out.length
              ;[out[i], out[j]] = [out[j], out[i]]
            }
            if (out.length === 0) return
          }
          assertOnlyWebRTPayErrors(out, 4096)
        }
      )
    )
  })
})

describe('frames: nesting limit', () => {
  /** An object whose deepest point has exactly `depth` open containers. */
  function nestedValue(depth: number, objectLevels: boolean[]): unknown {
    let inner: unknown = 1
    for (let level = 1; level < depth; level++) {
      inner = objectLevels[level % objectLevels.length] ? { k: inner } : [inner]
    }
    return { a: inner }
  }

  // Structural characters and escapes: the strings most likely to confuse a byte scanner.
  const structural = fc.string({
    unit: fc.constantFrom('[', ']', '{', '}', '"', '\\', ',', ':', ' ', 'é', '€'),
    maxLength: 300
  })
  const levels = fc.array(fc.boolean(), { minLength: 1, maxLength: 8 })
  const depth = fc.integer({ min: 1, max: 2 * MAX_JSON_DEPTH })

  it('the limit is exact whatever strings sit next to the nesting', () => {
    fc.assert(
      fc.property(
        depth,
        levels,
        structural,
        fc.boolean(),
        chunkSize,
        (d, objectLevels, s, stringFirst, chunk) => {
          const nest = nestedValue(d, objectLevels) as { a: unknown }
          const value = stringFirst ? { s, a: nest.a } : { a: nest.a, s }
          const frames = encodeMessage(0, value, chunk)
          const result = run(
            new FrameDecoder({ maxMessageBytes: DEFAULTS.maxMessageBytes }),
            frames
          )
          if (d <= MAX_JSON_DEPTH) {
            expect(result.error).toBeUndefined()
            expect(result.messages).toEqual([normalised(value)])
          } else {
            expect(result.error?.code).toBe('protocol')
            expect(result.at).toBe(frames.length - 1)
            expect(result.messages).toEqual([])
          }
        }
      )
    )
  })

  // Any text at all: the decoder must agree with "JSON.parse, top level an object, at most
  // MAX_JSON_DEPTH deep and at most MAX_JSON_TOKENS structural tokens". A scanner that is
  // too strict rejects good messages; one that is too lax lets a bomb through. (The token
  // oracle counts from the parsed value, so it is exact for texts without duplicate keys;
  // the soup can repeat a key, but never comes near the limit.)
  const soup = fc
    .array(
      fc.constantFrom(
        '{',
        '}',
        '[',
        ']',
        '"',
        '\\',
        '\\"',
        ',',
        ':',
        ' ',
        '\n',
        '1',
        'a',
        '"a":',
        '{"a":',
        'null',
        'é'
      ),
      { maxLength: 150 }
    )
    .map(parts => parts.join(''))
  // Runs of brackets that are balanced (depth around the limit) or off by one either way.
  const brackets = fc
    .record({
      open: fc.oneof(
        fc.integer({ min: MAX_JSON_DEPTH - 3, max: MAX_JSON_DEPTH + 2 }),
        fc.nat({ max: 80 })
      ),
      skew: fc.constantFrom(0, 0, 0, -1, 1),
      suffix: fc.constantFrom('}', '}', '}', '', '}}')
    })
    .map(
      ({ open, skew, suffix }) =>
        '{"a":' + '['.repeat(open) + ']'.repeat(Math.max(0, open + skew)) + suffix
    )
  const serialised = fc
    .tuple(depth, levels, fc.constantFrom(undefined, 1, '\t'))
    .map(([d, objectLevels, indent]) => JSON.stringify(nestedValue(d, objectLevels), null, indent))
  // Wide values whose structural token count lands within a few of the limit, either side,
  // next to strings full of structural characters.
  const wide = fc
    .record({
      slack: fc.integer({ min: -3, max: 3 }),
      asObject: fc.boolean(),
      s: structural,
      indent: fc.constantFrom(undefined, 1)
    })
    .map(({ slack, asObject, s, indent }) => {
      // `{"s":…,"a":X}` has 4 tokens around X: `{`, two `:` and one `,`.
      const budget = MAX_JSON_TOKENS - 4 + slack
      const a = asObject
        ? Object.fromEntries(Array.from({ length: Math.floor(budget / 2) }, (_, i) => [`k${i}`, i]))
        : Array.from({ length: budget }, (_, i) => i)
      return JSON.stringify({ s, a }, null, indent)
    })
  const anyText = fc.oneof(soup, brackets, serialised, wide)

  function expectedOutcome(textOfMessage: string): { value: unknown } | 'protocol' {
    let value: unknown
    try {
      value = JSON.parse(textOfMessage)
    } catch {
      return 'protocol'
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'protocol'
    return nestingDepth(value) <= MAX_JSON_DEPTH && structuralTokens(value) <= MAX_JSON_TOKENS
      ? { value }
      : 'protocol'
  }

  it('accepts exactly the JSON objects within the depth and token limits, for any text', () => {
    fc.assert(
      fc.property(anyText, chunkSize, (t, chunk) => {
        const expected = expectedOutcome(t)
        const result = run(
          new FrameDecoder({ maxMessageBytes: DEFAULTS.maxMessageBytes }),
          rawFramesOf(t, 0, chunk)
        )
        if (expected === 'protocol') {
          expect(result.error?.code).toBe('protocol')
          expect(result.messages).toEqual([])
        } else {
          expect(result.error).toBeUndefined()
          expect(result.messages).toEqual([expected.value])
        }
      })
    )
  })

  // Which error, not just its code: an independent model of the checks in the order the
  // decoder runs them. The top level must open with `{` after JSON whitespace; then, outside
  // strings (a string runs to its closing quote or the end, `\` taking the next character
  // with it), `{` `[` `,` `:` are tokens, `{` `[` open a container and `}` `]` close one,
  // and the first character that passes a bound decides (at an opener the token bound
  // first). Text within the bounds is up to JSON.parse.
  const PIECES = /"(?:[^"\\]|\\[\s\S])*"?|[\s\S]/g

  function firstBoundPassed(t: string): string | undefined {
    let depth = 0
    let tokens = 0
    for (const [piece] of t.matchAll(PIECES)) {
      const opens = piece === '{' || piece === '['
      if (opens || piece === ',' || piece === ':') tokens++
      if (tokens > MAX_JSON_TOKENS) {
        return `Message has more than ${MAX_JSON_TOKENS} structural tokens`
      }
      if (opens) depth++
      if (piece === '}' || piece === ']') depth--
      if (depth > MAX_JSON_DEPTH) return `Message nests deeper than ${MAX_JSON_DEPTH} levels`
      if (depth < 0) return 'Message has unbalanced brackets'
    }
    return undefined
  }

  function modelFailure(t: string): string | undefined {
    if (!/^[ \t\n\r]*\{/.test(t)) return 'Message is not a JSON object'
    const breach = firstBoundPassed(t)
    if (breach !== undefined) return breach
    try {
      JSON.parse(t)
    } catch {
      return 'Message is not valid JSON'
    }
    return undefined
  }

  // Texts that cross the token, depth and balance bounds within a few characters of each
  // other, so the order of the checks decides which error is reported.
  const crowded = fc
    .record({
      commas: fc.integer({ min: MAX_JSON_TOKENS - 45, max: MAX_JSON_TOKENS - 25 }),
      opens: fc.integer({ min: MAX_JSON_DEPTH - 4, max: MAX_JSON_DEPTH + 4 }),
      closes: fc.nat({ max: MAX_JSON_DEPTH + 8 }),
      tail: fc.constantFrom('', '}', ']}', ',', '"[', '"\\')
    })
    .map(
      ({ commas, opens, closes, tail }) =>
        '{"a":[' + '0,'.repeat(commas) + '['.repeat(opens) + ']'.repeat(closes) + tail
    )

  it('reports the error of the first bound a text passes, for any text', () => {
    fc.assert(
      fc.property(fc.oneof(anyText, crowded), chunkSize, (t, chunk) => {
        const result = run(
          new FrameDecoder({ maxMessageBytes: DEFAULTS.maxMessageBytes }),
          rawFramesOf(t, 0, chunk)
        )
        expect(result.error?.message).toBe(modelFailure(t))
      })
    )
  })
})
