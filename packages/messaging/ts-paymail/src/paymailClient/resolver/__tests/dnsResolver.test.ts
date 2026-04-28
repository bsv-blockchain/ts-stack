import { describe, it, expect } from '@jest/globals'
import dns from 'dns'
import DNSResolver from '../../../../dist/cjs/src/paymailClient/resolver/dnsResolver.js'
import HttpClient from '../../../../dist/cjs/src/paymailClient/httpClient.js'

describe('# DNS resolver', () => {
  it('should resolve SRV records for handcash.io', async () => {
    const dnsResolver = new DNSResolver({ dns }, new HttpClient())
    const result = await dnsResolver.queryBsvaliasDomain('handcash.io')
    expect(result.domain).toBe('cloud.handcash.io')
    expect(result.port).toBe(443)
  })

  it('should resolve SRV records for relysia', async () => {
    const dnsResolver = new DNSResolver({ dns }, new HttpClient())
    const result = await dnsResolver.queryBsvaliasDomain('relysia.com')
    expect(result.domain).toBe('relysia.com')
    expect(result.port).toBe(443)
  })

  it('should resolve with DOH when dns module is unavailable', async () => {
    const dnsResolver = new DNSResolver({ dns }, new HttpClient())
    const result = await dnsResolver.queryBsvaliasDomain('handcash.io')
    expect(result.domain).toBe('cloud.handcash.io')
    expect(result.port).toBe(443)
  })

  it('should throw error with unsecured domain', async () => {
    const dnsResolver = new DNSResolver({ dns }, new HttpClient())
    await expect(dnsResolver.queryBsvaliasDomain('centbee.com')).rejects.toThrow('centbee.com is not correctly configured: insecure domain')
  })
})
