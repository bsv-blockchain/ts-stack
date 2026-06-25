import { describe, it, expect } from '@jest/globals'
import DNSResolver from '../../../../dist/cjs/src/paymailClient/resolver/dnsResolver.js'
import HttpClient from '../../../../dist/cjs/src/paymailClient/httpClient.js'

// These tests previously hit live networks (system DNS + dns.google.com DoH),
// which made them flaky in CI ("Premature close" / timeouts). The DNS and HTTP
// layers are mocked here so the resolver logic is exercised deterministically.

interface DohJson { Status: number, AD?: boolean, Answer?: Array<{ data: string }> }

const dohResponses: Record<string, DohJson> = {
  // SRV target on a subdomain of the queried domain => treated as secure.
  handcash: { Status: 0, AD: true, Answer: [{ data: '10 10 443 cloud.handcash.io.' }] },
  // AD unset and target domain mismatched => resolver rejects as insecure.
  centbee: { Status: 0, AD: false, Answer: [{ data: '10 10 443 someother.example.com.' }] }
}

const mockHttpClient = {
  async request (url: string): Promise<{ json: () => Promise<DohJson> }> {
    const key = Object.keys(dohResponses).find(k => url.includes(k))
    const body = key ? dohResponses[key] : { Status: 3 }
    return { json: async () => body }
  }
} as unknown as HttpClient

const srvError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

const mockDns = {
  resolveSrv (domain: string, cb: (err: NodeJS.ErrnoException | null, records?: Array<{ name: string, port: number }>) => void): void {
    if (domain.includes('handcash')) {
      cb(null, [{ name: 'cloud.handcash.io', port: 443 }])
    } else if (domain.includes('relysia')) {
      // No SRV record => resolver falls back to the domain itself on port 443.
      cb(srvError('ENODATA'))
    } else if (domain.includes('centbee')) {
      // Non-ENODATA error => not secure via system DNS, forces DoH fallback.
      cb(srvError('ESERVFAIL'))
    } else {
      cb(srvError('ENOTFOUND'))
    }
  }
}

describe('# DNS resolver', () => {
  it('should resolve SRV records for handcash.io', async () => {
    const dnsResolver = new DNSResolver(mockHttpClient, { dns: mockDns })
    const result = await dnsResolver.queryBsvaliasDomain('handcash.io')
    expect(result.domain).toBe('cloud.handcash.io')
    expect(result.port).toBe(443)
  })

  it('should resolve SRV records for relysia', async () => {
    const dnsResolver = new DNSResolver(mockHttpClient, { dns: mockDns })
    const result = await dnsResolver.queryBsvaliasDomain('relysia.com')
    expect(result.domain).toBe('relysia.com')
    expect(result.port).toBe(443)
  })

  it('should resolve with DOH when dns module is unavailable', async () => {
    const dnsResolver = new DNSResolver(mockHttpClient)
    const result = await dnsResolver.queryBsvaliasDomain('handcash.io')
    expect(result.domain).toBe('cloud.handcash.io')
    expect(result.port).toBe(443)
  })

  it('should throw error with unsecured domain', async () => {
    const dnsResolver = new DNSResolver(mockHttpClient, { dns: mockDns })
    await expect(dnsResolver.queryBsvaliasDomain('centbee.com')).rejects.toThrow('centbee.com is not correctly configured: insecure domain')
  })
})
