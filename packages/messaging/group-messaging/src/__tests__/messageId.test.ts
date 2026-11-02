import { describe, expect, it } from 'vitest'
import { messageIdOf } from '../messageId.js'

describe('messageIdOf', () => {
  it('gives the same id to the same bytes', () => {
    const message = new Uint8Array([1, 2, 3, 4])

    expect(messageIdOf(message)).toBe(messageIdOf(Uint8Array.from(message)))
  })

  it('gives different ids to bytes that differ by one bit', () => {
    expect(messageIdOf(new Uint8Array([1, 2, 3, 4]))).not.toBe(
      messageIdOf(new Uint8Array([1, 2, 3, 5]))
    )
  })

  it('is a sha-256 digest in lower-case hex', () => {
    expect(messageIdOf(new Uint8Array())).toMatch(/^[0-9a-f]{64}$/)
    // The empty digest, so a reimplementation elsewhere can be checked against
    // a published vector rather than against this implementation.
    expect(messageIdOf(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
  })
})
