import { describe, expect, it } from 'vitest'
import {
  parsePublicationInput,
  publicationAuthorized,
  publicationTokenForMode
} from '../src/serverSecurity.js'

describe('LCH creator publication authorization', () => {
  it('requires a strong token whenever real wallets are connected', () => {
    expect(() => publicationTokenForMode('connected', undefined)).toThrow('LCH_PUBLICATION_TOKEN')
    expect(() => publicationTokenForMode('connected', 'short')).toThrow('LCH_PUBLICATION_TOKEN')
    expect(publicationTokenForMode('fixture', undefined)).toBeUndefined()
  })

  it('accepts only an exact bearer token without throwing on length differences', () => {
    const token = 'a'.repeat(32)
    expect(publicationAuthorized({ headers: { authorization: `Bearer ${token}` } }, token)).toBe(
      true
    )
    expect(publicationAuthorized({ headers: { authorization: `Bearer ${token}x` } }, token)).toBe(
      false
    )
    expect(publicationAuthorized({ headers: {} }, token)).toBe(false)
  })

  it('accepts only bounded canonical publication fields', () => {
    expect(
      parsePublicationInput({
        name: 'clip.wav',
        mediaType: 'audio/wav',
        bytesBase64: Buffer.from('fixture').toString('base64')
      })
    ).toMatchObject({ name: 'clip.wav', mediaType: 'audio/wav' })
    for (const invalid of [
      null,
      [],
      { name: 'clip\u202efile', mediaType: 'audio/wav', bytesBase64: '' },
      { name: 'clip', mediaType: 'text/html; charset=utf-8', bytesBase64: '' },
      { name: 'clip', mediaType: 'text/plain', bytesBase64: 'YR==' },
      { name: 'clip', mediaType: 'text/plain', bytesBase64: 'A'.repeat(23_000_000) }
    ]) {
      expect(() => parsePublicationInput(invalid)).toThrow(TypeError)
    }
  })
})
