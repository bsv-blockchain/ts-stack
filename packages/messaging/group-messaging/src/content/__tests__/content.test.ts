import { describe, expect, it } from 'vitest'
import { ContentDecodeError, decodeContent, encodeContent, markdown, text } from '../index.js'

describe('content envelope', () => {
  it('round-trips a text message', () => {
    const decoded = decodeContent(encodeContent(text('hello')))
    expect(decoded).toEqual({ v: 1, type: 'text', body: 'hello' })
  })

  it('falls back to the markdown source when no plain body is given', () => {
    expect(markdown('**hi**').body).toBe('**hi**')
    expect(markdown('**hi**', 'hi').body).toBe('hi')
  })

  it('surfaces the body of an unknown type so older clients degrade', () => {
    const decoded = decodeContent(encodeContent({ v: 1, type: 'poll', body: 'Which option?' }))
    expect(decoded.type).toBe('poll')
    expect(decoded.body).toBe('Which option?')
  })

  it('rejects content with no version', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ type: 'text' }))
    expect(() => decodeContent(bytes)).toThrow(ContentDecodeError)
  })
})

describe('decodeContent checks the kinds it declares', () => {
  const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

  /**
   * Any group member can send these. The envelope is returned untouched by
   * design, but a consumer rendering `content.body` is entitled to believe the
   * declared type, and today an object arrives where a string is promised.
   */
  it('rejects a body that is not a string', () => {
    expect(() => decodeContent(encode({ v: 1, type: 'text', body: { evil: true } }))).toThrow(
      ContentDecodeError
    )
  })

  it('rejects attachments that are not an array', () => {
    expect(() =>
      decodeContent(encode({ v: 1, type: 'attachment', attachments: { nope: 1 } }))
    ).toThrow(ContentDecodeError)
  })

  it('rejects extra that is not an object', () => {
    expect(() => decodeContent(encode({ v: 1, type: 'text', extra: 'not an object' }))).toThrow(
      ContentDecodeError
    )
  })

  it('still returns a well-formed envelope untouched', () => {
    const content = { v: 1, type: 'text', body: 'hello', extra: { a: 1 } }
    expect(decodeContent(encode(content))).toEqual(content)
  })
})

describe('decodeContent separates absent from null', () => {
  const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

  /**
   * Only `replyTo` and `expires` are declared nullable. Letting null through
   * everywhere makes the check miss the field a consumer is most likely to
   * render straight into a UI.
   */
  it('rejects a null body, which is not a string', () => {
    expect(() => decodeContent(encode({ v: 1, type: 'text', body: null }))).toThrow(
      ContentDecodeError
    )
  })

  it('accepts null for the two fields declared nullable', () => {
    const content = { v: 1, type: 'reply', replyTo: null, expires: null }
    expect(decodeContent(encode(content))).toEqual(content)
  })
})
