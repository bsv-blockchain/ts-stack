import { describe, expect, it } from 'vitest'
import { FramingError, decodeFrames, encodeFrames } from '../frames.js'

describe('frames', () => {
  it('round-trips a list of payloads, in order', () => {
    const frames = [new Uint8Array([1, 2, 3]), new Uint8Array([4]), new Uint8Array([5, 6])]

    expect(decodeFrames(encodeFrames(frames))).toEqual(frames)
  })

  it('round-trips an empty payload without losing the frame', () => {
    const frames = [new Uint8Array([1]), new Uint8Array(), new Uint8Array([2])]

    expect(decodeFrames(encodeFrames(frames))).toEqual(frames)
  })

  it('treats nothing stored and nothing queued alike', () => {
    expect(decodeFrames(undefined)).toEqual([])
    expect(decodeFrames(new Uint8Array())).toEqual([])
    expect(decodeFrames(encodeFrames([]))).toEqual([])
  })

  it("decodes a value that does not start at its buffer's origin", () => {
    const encoded = encodeFrames([new Uint8Array([7, 8])])
    const padded = new Uint8Array(encoded.length + 3)
    padded.set(encoded, 3)

    expect(decodeFrames(padded.subarray(3))).toEqual([new Uint8Array([7, 8])])
  })

  it('rejects a value whose last header is cut short', () => {
    const complete = encodeFrames([new Uint8Array([1, 2])])
    const truncated = new Uint8Array(complete.length + 2)
    truncated.set(complete, 0)

    expect(() => decodeFrames(truncated)).toThrow(FramingError)
    expect(() => decodeFrames(truncated)).toThrow(/Truncated frame header/)
  })

  it('rejects a value whose body is shorter than its header claims', () => {
    const truncated = encodeFrames([new Uint8Array([1, 2, 3, 4])]).slice(0, 6)

    expect(() => decodeFrames(truncated)).toThrow(FramingError)
    expect(() => decodeFrames(truncated)).toThrow(/Truncated frame body/)
  })
})
