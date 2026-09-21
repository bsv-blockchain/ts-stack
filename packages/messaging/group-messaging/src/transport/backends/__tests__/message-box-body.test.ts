import { describe, expect, it } from 'vitest'
import {
  decodeBody,
  encodeBody,
  MalformedBodyError,
  UnparsableBodyError
} from '../message-box-body.js'

describe('the MessageBox body', () => {
  it('round-trips a payload through a JSON string', () => {
    const payload = Uint8Array.from([0, 1, 2, 250, 255])
    const body = encodeBody(payload)

    expect(JSON.parse(body)).toMatchObject({ v: 1 })
    expect(decodeBody(body)).toEqual(payload)
  })

  it('round-trips an empty payload', () => {
    expect(decodeBody(encodeBody(new Uint8Array()))).toEqual(new Uint8Array())
  })

  it('refuses a body that is not JSON as retryable, not as malformed', () => {
    expect(() => decodeBody('not json')).toThrow(UnparsableBodyError)
    expect(() => decodeBody('not json')).not.toThrow(MalformedBodyError)
  })

  it("treats the real client's decrypt-failure sentinel as retryable", () => {
    // MessageBoxClient replaces the body with this literal string whenever
    // walletClient.decrypt throws — a locked wallet, a declined prompt. It is
    // not evidence the message is bad.
    expect(() => decodeBody('[Error: Failed to decrypt or parse message]')).toThrow(
      UnparsableBodyError
    )
  })

  it('refuses a version this build does not know', () => {
    expect(() => decodeBody(JSON.stringify({ v: 99, payload: 'AAE=' }))).toThrow(MalformedBodyError)
  })

  it('refuses a body with no payload', () => {
    expect(() => decodeBody(JSON.stringify({ v: 1 }))).toThrow(MalformedBodyError)
  })

  it('round-trips every byte value, so no ciphertext is silently corrupted', () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index)
    expect(decodeBody(encodeBody(all))).toEqual(all)
  })

  it('refuses a body that is valid JSON but not an object', () => {
    expect(() => decodeBody('42')).toThrow(MalformedBodyError)
    expect(() => decodeBody('"a string"')).toThrow(MalformedBodyError)
  })

  it('refuses a payload that is not base64, as our own error type', () => {
    expect(() => decodeBody(JSON.stringify({ v: 1, payload: '!!!not base64!!!' }))).toThrow(
      MalformedBodyError
    )
  })

  it('decodes a body the real client already parsed into an object', () => {
    // @bsv/message-box-client's tryParse runs JSON.parse on every inbound
    // body before we see it, so our own JSON-string envelope always arrives
    // pre-parsed in production. This pins that path directly.
    const payload = Uint8Array.from([1, 2, 3])
    const envelope = JSON.parse(encodeBody(payload)) as Record<string, unknown>
    expect(decodeBody(envelope)).toEqual(payload)
  })

  it('refuses an object body that is not our envelope', () => {
    expect(() => decodeBody({ some: 'object' })).toThrow(MalformedBodyError)
  })
})
