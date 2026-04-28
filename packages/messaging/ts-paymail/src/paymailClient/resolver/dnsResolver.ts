import AbstractResolver from './abstractResolver.js'
import HttpClient from '../httpClient.js'
import { PaymailServerResponseError } from '../../errors/index.js'

export interface DNSResolverOptions {
  dns?: any
  dohServerBaseUrl?: string
}

class DNSResolver extends AbstractResolver {
  private readonly dohServiceBaseUrl: string
  private readonly httpClient: HttpClient
  private readonly dns: any

  constructor (options: DNSResolverOptions = {}, httpClient: HttpClient) {
    super()
    const { dns, dohServerBaseUrl = 'https://dns.google.com/resolve' } = options
    this.dohServiceBaseUrl = dohServerBaseUrl
    this.httpClient = httpClient
    this.dns = dns
  }

  async resolveSrv (aDomain: string): Promise<{ domain: string, port: number }> {
    // Try to resolve the domain using the local DNS server first if available (Node only)
    if (this.dns) {
      const result = await this.resolveWithDns(aDomain)
      if (result.isSecure) {
        return {
          domain: result.domain,
          port: result.port
        }
      }
    }
    return await this.resolveWithDoh(aDomain)
  }

  private domainWithoutBsvAliasPrefix (aDomain: string): string {
    return aDomain.replace('_bsvalias._tcp.', '')
  }

  domainsAreEqual (domain1: string, domain2: string): boolean {
    const normDomain1 = domain1.replace(/\.$/, '')
    const normDomain2 = domain2.replace(/\.$/, '')

    // Domains are equal if they are identical after normalization,
    // or if one is a subdomain of the other (e.g., 'sub.example.com' and 'example.com').
    if (normDomain1 === normDomain2 || normDomain1.endsWith('.' + normDomain2) || normDomain2.endsWith('.' + normDomain1)) {
      return true
    }

    return false
  }

  private async resolveWithDns (aDomain: string): Promise<any> {
    return await new Promise((resolve) => {
      this.dns.resolveSrv(aDomain, (err, records) => {
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
          const { name, port } = records[0]
          const isSecure = this.domainsAreEqual(name, this.domainWithoutBsvAliasPrefix(aDomain))
          resolve({ domain: name, port, isSecure })
        }
      })
    })
  }

  private readonly resolveWithDoh = async (aDomain: string): Promise<any> => {
    const response = await this.httpClient.request(`${this.dohServiceBaseUrl}?name=${aDomain}&type=SRV&cd=0`)
    const dohResponse = await response.json()
    const domain = this.domainWithoutBsvAliasPrefix(aDomain)

    // Record not found assume port 443 and domain is the same as the input per spec
    if (dohResponse.Status === 3) {
      return {
        domain,
        port: 443
      }
    }
    if (dohResponse.Status !== 0 || !dohResponse.Answer) {
      throw new PaymailServerResponseError(`${this.domainWithoutBsvAliasPrefix(aDomain)} is not correctly configured: insecure domain`)
    }

    const data = dohResponse.Answer[0].data.split(' ')
    const port = data[2]
    let responseDomain = data[3]
    responseDomain = responseDomain.endsWith('.') ? responseDomain.slice(0, -1) : responseDomain

    if (!dohResponse.AD && !this.domainsAreEqual(domain, responseDomain)) {
      throw new PaymailServerResponseError(`${this.domainWithoutBsvAliasPrefix(aDomain)} is not correctly configured: insecure domain`)
    }

    return {
      domain: responseDomain,
      port: parseInt(port)
    }
  }

  async queryBsvaliasDomain (aDomain) {
    return await this.resolveSrv(`_bsvalias._tcp.${aDomain}`)
  }
}

export default DNSResolver
