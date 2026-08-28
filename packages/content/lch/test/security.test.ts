import { describe, expect, it } from '@jest/globals'
import { isPublicAddress, validateEndpoint } from '../src/index.js'

describe('endpoint trust', () => {
  it.each(['127.0.0.1', '10.2.3.4', '169.254.2.3', '192.168.1.1', '::1', 'fc00::1', '2001:db8::1'])(
    'rejects non-public address %s',
    address => expect(isPublicAddress(address)).toBe(false)
  )

  it('requires public DNS validation and accepts explicit local development origins', async () => {
    expect(isPublicAddress('999.1.1.1')).toBe(false)
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true)
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false)
    await expect(validateEndpoint('not-an-absolute-url')).rejects.toMatchObject({
      code: 'ERR_LCH_ENDPOINT'
    })
    await expect(validateEndpoint('https://8.8.8.8/content')).resolves.toBeInstanceOf(URL)
    await expect(validateEndpoint('https://example.com/content')).rejects.toMatchObject({
      code: 'ERR_LCH_ENDPOINT'
    })
    await expect(
      validateEndpoint('https://example.com/content', {
        resolve: async () => ['93.184.216.34']
      })
    ).resolves.toBeInstanceOf(URL)
    await expect(
      validateEndpoint('https://example.com/content', {
        resolve: async () => ['127.0.0.1']
      })
    ).rejects.toMatchObject({ code: 'ERR_LCH_ENDPOINT' })
    await expect(validateEndpoint('https://127.0.0.1/content')).rejects.toMatchObject({
      code: 'ERR_LCH_ENDPOINT'
    })
    await expect(
      validateEndpoint('https://127.0.0.1/content', { allowLocalOrigins: ['https://127.0.0.1'] })
    ).resolves.toBeInstanceOf(URL)
  })
})
