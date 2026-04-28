export interface DnsResponse {
  domain: string
  port: number
}

abstract class AbstractResolver {
  /**
     * Resolves the SRV records for a given domain.
     * @param aDomain The domain for which to resolve SRV records.
     * @returns A Promise resolving to the DNS resolution result.
     */
  abstract resolveSrv (aDomain: string): Promise<DnsResponse>

  /**
     * Queries the BSV alias domain information.
     * @param aDomain The domain to query for BSV alias information.
     * @returns A Promise resolving to the query result.
     */
  abstract queryBsvaliasDomain (aDomain: string): Promise<DnsResponse>
}

export default AbstractResolver
