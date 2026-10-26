import AbstractResolver from './abstractResolver.js'
import HttpClient from '../httpClient.js'
import { PaymailServerResponseError } from '../../errors/index.js'
import type { DnsResponse } from './abstractResolver.js'

interface SrvRecord {
  name: string
  port: number
}

interface DnsError {
  code?: string
}

export interface DnsResolver {
  resolveSrv(
    domain: string,
    callback: (error: DnsError | null, records?: SrvRecord[]) => void
  ): void
}

interface DohResponse {
  Status: number
  AD?: boolean
  Answer?: Array<{ name: string; data: string; type: number }>
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

export interface DNSResolverOptions {
  dns?: DnsResolver
  dohServerBaseUrl?: string
}

class DNSResolver extends AbstractResolver {
  private readonly dohServiceBaseUrl: string
  private readonly httpClient: HttpClient
  private readonly dns?: DnsResolver

  constructor(httpClient: HttpClient, options: DNSResolverOptions = {}) {
    super()
    const { dns, dohServerBaseUrl = 'https://dns.google.com/resolve' } = options
    if (typeof dohServerBaseUrl !== 'string' || dohServerBaseUrl.length === 0) {
      throw new TypeError('dohServerBaseUrl must be a non-empty string')
    }
    if (dns != null && (typeof dns !== 'object' || typeof dns.resolveSrv !== 'function')) {
      throw new TypeError('dns must provide a resolveSrv function')
    }
    this.dohServiceBaseUrl = dohServerBaseUrl
    this.httpClient = httpClient
    this.dns = dns
  }

  async resolveSrv(aDomain: string): Promise<DnsResponse> {
    // Try to resolve the domain using the local DNS server first if available (Node only)
    if (this.dns) {
      const result = await this.resolveWithDns(aDomain, this.dns)
      if (result.isSecure) {
        return {
          domain: result.domain,
          port: result.port
        }
      }
    }
    return this.resolveWithDoh(aDomain)
  }

  private domainWithoutBsvAliasPrefix(aDomain: string): string {
    return aDomain.replace('_bsvalias._tcp.', '')
  }

  domainsAreEqual(domain1: string, domain2: string): boolean {
    const normDomain1 = domain1.replace(/\.$/, '').toLowerCase()
    const normDomain2 = domain2.replace(/\.$/, '').toLowerCase()

    // An SRV target may remain on the requested domain or move deeper beneath
    // it. A parent domain is not equivalent: treating "com" as equivalent to
    // "example.com" crosses the caller's authenticated domain boundary.
    return normDomain1 === normDomain2 || normDomain1.endsWith(`.${normDomain2}`)
  }

  private validateDohResponse(value: unknown, domain: string): DohResponse {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      throw new PaymailServerResponseError(
        `${domain} is not correctly configured: invalid DNS response`
      )
    }
    const candidate = value as Record<string, unknown>
    if (!Number.isInteger(candidate.Status)) {
      throw new PaymailServerResponseError(
        `${domain} is not correctly configured: invalid DNS response`
      )
    }
    if (candidate.AD != null && typeof candidate.AD !== 'boolean') {
      throw new PaymailServerResponseError(
        `${domain} is not correctly configured: invalid DNS response`
      )
    }
    if (candidate.Answer != null) {
      if (!Array.isArray(candidate.Answer) || candidate.Answer.length > 128) {
        throw new PaymailServerResponseError(
          `${domain} is not correctly configured: invalid DNS response`
        )
      }
      for (const answer of candidate.Answer) {
        if (
          answer == null ||
          typeof answer !== 'object' ||
          Array.isArray(answer) ||
          typeof (answer as Record<string, unknown>).name !== 'string' ||
          ((answer as Record<string, unknown>).name as string).length > 253 ||
          typeof (answer as Record<string, unknown>).data !== 'string' ||
          ((answer as Record<string, unknown>).data as string).length > 2048 ||
          !Number.isInteger((answer as Record<string, unknown>).type)
        ) {
          throw new PaymailServerResponseError(
            `${domain} is not correctly configured: invalid DNS response`
          )
        }
      }
    }
    return candidate as unknown as DohResponse
  }

  private normalizeDohOwner(value: string, domain: string): string {
    const normalized = value.replace(/\.$/, '').toLowerCase()
    if (
      normalized.length === 0 ||
      normalized.length > 253 ||
      normalized.split('.').some(label => label.length === 0 || label.length > 63)
    ) {
      throw new PaymailServerResponseError(
        `${domain} is not correctly configured: invalid DNS answer owner`
      )
    }
    return normalized
  }

  private validateDnsName(value: string, domain: string): string {
    const normalized = value.replace(/\.$/, '').toLowerCase()
    if (
      normalized.length === 0 ||
      normalized.length > 253 ||
      !normalized.split('.').every(label => DNS_LABEL.test(label))
    ) {
      throw new PaymailServerResponseError(
        `${domain} is not correctly configured: invalid SRV target`
      )
    }
    return normalized
  }

  private validatePort(value: number | string, domain: string): number {
    const port = this.validateUint16(value, domain, 'port')
    if (port === 0) {
      throw new PaymailServerResponseError(
        `${domain} is not correctly configured: invalid SRV port`
      )
    }
    return port
  }

  private validateUint16(
    value: number | string,
    domain: string,
    field: 'port' | 'priority' | 'weight'
  ): number {
    let port: number
    if (typeof value === 'number') {
      port = value
    } else {
      port = /^\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN
    }
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new PaymailServerResponseError(
        `${domain} is not correctly configured: invalid SRV ${field}`
      )
    }
    return port
  }

  private async resolveWithDns(
    aDomain: string,
    dns: DnsResolver
  ): Promise<DnsResponse & { isSecure: boolean }> {
    return new Promise((resolve, reject) => {
      dns.resolveSrv(aDomain, (err, records) => {
        try {
          if (err) {
            if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') {
              // Record not found, assume port 443 and domain is the same as the input per spec
              resolve({
                domain: this.domainWithoutBsvAliasPrefix(aDomain),
                port: 443,
                isSecure: true
              })
            } else {
              // Handle other types of errors
              resolve({
                domain: this.domainWithoutBsvAliasPrefix(aDomain),
                port: 443,
                isSecure: false
              })
            }
          } else {
            const [record] = records ?? []
            if (!record) {
              resolve({
                domain: this.domainWithoutBsvAliasPrefix(aDomain),
                port: 443,
                isSecure: false
              })
              return
            }
            const requestedDomain = this.domainWithoutBsvAliasPrefix(aDomain)
            const domain = this.validateDnsName(record.name, requestedDomain)
            const port = this.validatePort(record.port, requestedDomain)
            const isSecure = this.domainsAreEqual(domain, requestedDomain)
            resolve({ domain, port, isSecure })
          }
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  private readonly resolveWithDoh = async (aDomain: string): Promise<DnsResponse> => {
    const response = await this.httpClient.request(
      `${this.dohServiceBaseUrl}?name=${encodeURIComponent(aDomain)}&type=SRV&cd=0`
    )
    const domain = this.domainWithoutBsvAliasPrefix(aDomain)
    const dohResponse = this.validateDohResponse(await response.json(), domain)

    // Record not found assume port 443 and domain is the same as the input per spec
    if (dohResponse.Status === 3) {
      return {
        domain,
        port: 443
      }
    }
    if (dohResponse.Status !== 0 || !dohResponse.Answer) {
      throw new PaymailServerResponseError(
        `${this.domainWithoutBsvAliasPrefix(aDomain)} is not correctly configured: insecure domain`
      )
    }

    const expectedOwner = this.normalizeDohOwner(aDomain, domain)
    const answer = dohResponse.Answer.find(
      candidate =>
        candidate.type === 33 && this.normalizeDohOwner(candidate.name, domain) === expectedOwner
    )
    if (!answer) {
      throw new PaymailServerResponseError(
        `${domain} is not correctly configured: missing SRV answer`
      )
    }
    const data = answer.data.trim().split(/\s+/)
    const priority = data[0]
    const weight = data[1]
    const port = data[2]
    const responseDomain = data[3]
    if (
      priority === undefined ||
      weight === undefined ||
      port === undefined ||
      responseDomain === undefined ||
      data.length !== 4
    ) {
      throw new PaymailServerResponseError(
        `${domain} is not correctly configured: invalid SRV answer`
      )
    }
    this.validateUint16(priority, domain, 'priority')
    this.validateUint16(weight, domain, 'weight')
    const validatedPort = this.validatePort(port, domain)
    const validatedDomain = this.validateDnsName(responseDomain, domain)

    if (!dohResponse.AD && !this.domainsAreEqual(validatedDomain, domain)) {
      throw new PaymailServerResponseError(`${domain} is not correctly configured: insecure domain`)
    }

    return {
      domain: validatedDomain,
      port: validatedPort
    }
  }

  async queryBsvaliasDomain(aDomain: string): Promise<DnsResponse> {
    return this.resolveSrv(`_bsvalias._tcp.${aDomain}`)
  }
}

export default DNSResolver
