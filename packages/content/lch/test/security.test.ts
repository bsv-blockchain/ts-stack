import { describe, expect, it, jest } from '@jest/globals'
import { fetchLCH, isPublicAddress, validateEndpoint } from '../src/index.js'

describe('endpoint trust', () => {
  it.each([
    '127.0.0.1',
    '10.2.3.4',
    '169.254.2.3',
    '192.168.1.1',
    '192.88.99.1',
    '::1',
    'fc00::1',
    'fec0::1',
    '2001:db8::1',
    '100::1',
    '2001:10::1',
    '3fff::1',
    '5f00::1',
    '::ffff:7f00:1',
    '[::ffff:7f00:1]',
    '::ffff:0:7f00:1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '[2001:4860::8888',
    '2001:4860::1%eth0',
    '2001:::1',
    '2001:4860::1::2'
  ])('rejects non-public address %s', address => expect(isPublicAddress(address)).toBe(false))

  it('requires public DNS validation and accepts explicit local development origins', async () => {
    expect(isPublicAddress('999.1.1.1')).toBe(false)
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true)
    expect(isPublicAddress('::ffff:808:808')).toBe(true)
    expect(isPublicAddress('64:ff9b::808:808')).toBe(true)
    expect(isPublicAddress('2002:808:808::')).toBe(true)
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
    expect(isPublicAddress('2001:1::1')).toBe(true)
    expect(isPublicAddress('2001:3::1')).toBe(true)
    expect(isPublicAddress('2001:4:112::1')).toBe(true)
    expect(isPublicAddress('2001:20::1')).toBe(true)
    expect(isPublicAddress('2001:30::1')).toBe(true)
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

  it('rejects URL-normalized IPv4-mapped IPv6 loopback before connection', async () => {
    const loopback = new URL('https://[::ffff:127.0.0.1]/content')
    const publicAddress = new URL('https://[::ffff:8.8.8.8]/content')
    expect(loopback.hostname).toBe('[::ffff:7f00:1]')
    expect(publicAddress.hostname).toBe('[::ffff:808:808]')
    expect(isPublicAddress(loopback.hostname)).toBe(false)
    expect(isPublicAddress(publicAddress.hostname)).toBe(true)
    await expect(validateEndpoint(loopback.href)).rejects.toMatchObject({
      code: 'ERR_LCH_ENDPOINT'
    })
    const connect = jest.fn(async () => new Response('unexpected'))
    await expect(fetchLCH(loopback.href, {}, 'content', { connect })).rejects.toMatchObject({
      code: 'ERR_LCH_ENDPOINT'
    })
    expect(connect).not.toHaveBeenCalled()
  })
})
