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
  Answer?: Array<{ data: string; type?: number }>
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

    // Domains are equal if they are identical after normalization,
    // or if one is a subdomain of the other (e.g., 'sub.example.com' and 'example.com').
    if (
      normDomain1 === normDomain2 ||
      normDomain1.endsWith(`.${normDomain2}`) ||
      normDomain2.endsWith(`.${normDomain1}`)
    ) {
      return true
    }

    return false
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
    const port =
      typeof value === 'number'
        ? value
        : /^\d+$/.test(value)
          ? Number.parseInt(value, 10)
          : Number.NaN
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
    const dohResponse = (await response.json()) as DohResponse
    const domain = this.domainWithoutBsvAliasPrefix(aDomain)

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

    const answer =
      dohResponse.Answer.find(candidate => candidate.type === 33) ??
      dohResponse.Answer.find(candidate => candidate.type === undefined)
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

    if (!dohResponse.AD && !this.domainsAreEqual(domain, validatedDomain)) {
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
