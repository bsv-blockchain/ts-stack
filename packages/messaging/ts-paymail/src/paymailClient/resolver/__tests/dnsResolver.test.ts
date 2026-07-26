import { describe, it, expect } from '@jest/globals'
import DNSResolver from '../dnsResolver.js'
import HttpClient from '../../httpClient.js'

// These tests previously hit live networks (system DNS + dns.google.com DoH),
// which made them flaky in CI ("Premature close" / timeouts). The DNS and HTTP
// layers are mocked here so the resolver logic is exercised deterministically.

interface DohJson {
  Status: number
  AD?: boolean
  Answer?: Array<{ data: string; type?: number }>
}

const dohResponses: Record<string, DohJson> = {
  // SRV target on a subdomain of the queried domain => treated as secure.
  handcash: { Status: 0, AD: true, Answer: [{ data: '10 10 443 cloud.handcash.io.' }] },
  // AD unset and target domain mismatched => resolver rejects as insecure.
  centbee: { Status: 0, AD: false, Answer: [{ data: '10 10 443 someother.example.com.' }] }
}

const mockHttpClient = {
  async request(url: string): Promise<{ json: () => Promise<DohJson> }> {
    const key = Object.keys(dohResponses).find(k => url.includes(k))
    const body = key ? dohResponses[key] : { Status: 3 }
    return { json: async () => body }
  }
} as unknown as HttpClient

const srvError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

const mockDns = {
  resolveSrv(
    domain: string,
    cb: (err: NodeJS.ErrnoException | null, records?: Array<{ name: string; port: number }>) => void
  ): void {
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
    await expect(dnsResolver.queryBsvaliasDomain('centbee.com')).rejects.toThrow(
      'centbee.com is not correctly configured: insecure domain'
    )
  })

  it('falls back to the original domain when DoH reports NXDOMAIN', async () => {
    const dnsResolver = new DNSResolver(mockHttpClient)
    await expect(dnsResolver.queryBsvaliasDomain('unknown.example')).resolves.toEqual({
      domain: 'unknown.example',
      port: 443
    })
  })

  it('rejects unsuccessful, empty, and malformed DoH answers', async () => {
    const responses: DohJson[] = [
      { Status: 2 },
      { Status: 0, Answer: [] },
      { Status: 0, AD: true, Answer: [{ data: 'malformed' }] },
      { Status: 0, AD: true, Answer: [{ data: '10 10 not-a-port broken.example.' }] },
      { Status: 0, AD: true, Answer: [{ data: '10 10 0 broken.example.' }] },
      { Status: 0, AD: true, Answer: [{ data: '10 10 65536 broken.example.' }] },
      { Status: 0, AD: true, Answer: [{ data: '10 10 443 bad_target.example.' }] },
      { Status: 0, AD: true, Answer: [{ data: '-1 10 443 broken.example.' }] },
      { Status: 0, AD: true, Answer: [{ data: '10 65536 443 broken.example.' }] },
      { Status: 0, AD: true, Answer: [{ data: '10 10 443 broken.example. extra' }] },
      { Status: 0, AD: true, Answer: [{ type: 1, data: '10 10 443 broken.example.' }] }
    ]
    for (const response of responses) {
      const client = {
        request: async () => ({ json: async () => response })
      } as unknown as HttpClient
      const resolver = new DNSResolver(client)
      await expect(resolver.queryBsvaliasDomain('broken.example')).rejects.toThrow(
        'not correctly configured'
      )
    }
  })

  it('selects the SRV answer when a DoH response also contains another record type', async () => {
    const client = {
      request: async () => ({
        json: async () => ({
          Status: 0,
          AD: true,
          Answer: [
            { type: 5, data: 'alias.example.' },
            { type: 33, data: '10 10 443 paymail.example.' }
          ]
        })
      })
    } as unknown as HttpClient
    const resolver = new DNSResolver(client)

    await expect(resolver.queryBsvaliasDomain('example')).resolves.toEqual({
      domain: 'paymail.example',
      port: 443
    })
  })

  it('normalizes trailing dots and accepts parent/subdomain relationships', () => {
    const resolver = new DNSResolver(mockHttpClient)
    expect(resolver.domainsAreEqual('paymail.example.com.', 'example.com')).toBe(true)
    expect(resolver.domainsAreEqual('PAYMAIL.EXAMPLE.COM.', 'example.com')).toBe(true)
    expect(resolver.domainsAreEqual('example.com', 'example.com.')).toBe(true)
    expect(resolver.domainsAreEqual('example.com', 'attacker.test')).toBe(false)
  })

  it('falls back to DoH when local DNS returns no records', async () => {
    const dns = {
      resolveSrv(
        _domain: string,
        callback: (
          error: NodeJS.ErrnoException | null,
          records?: Array<{ name: string; port: number }>
        ) => void
      ): void {
        callback(null, [])
      }
    }
    const resolver = new DNSResolver(mockHttpClient, { dns })
    await expect(resolver.queryBsvaliasDomain('handcash.io')).resolves.toEqual({
      domain: 'cloud.handcash.io',
      port: 443
    })
  })

  it('rejects invalid local DNS ports', async () => {
    const dns = {
      resolveSrv(
        _domain: string,
        callback: (
          error: NodeJS.ErrnoException | null,
          records?: Array<{ name: string; port: number }>
        ) => void
      ): void {
        callback(null, [{ name: 'example.test', port: 65_536 }])
      }
    }
    const resolver = new DNSResolver(mockHttpClient, { dns })

    await expect(resolver.queryBsvaliasDomain('example.test')).rejects.toThrow('invalid SRV port')
  })
})
