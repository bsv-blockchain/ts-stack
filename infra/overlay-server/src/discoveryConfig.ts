import type { LookupResolverConfig } from '@bsv/sdk'
import { readBooleanEnv } from './securityConfig.js'

export interface DiscoveryRuntimeConfiguration {
  suppressDefaultSyncAdvertisements: boolean
  lookupResolverConfig?: LookupResolverConfig
}

/** Public discovery roots must advertise and bootstrap their own discovery services. */
export function readDiscoveryRuntimeConfiguration(
  environment: Record<string, string | undefined>,
  network: 'main' | 'test' | 'ttn',
  hostingURL: string
): DiscoveryRuntimeConfiguration {
  if (!readBooleanEnv(environment, 'DISCOVERY_ROOT', false)) {
    return { suppressDefaultSyncAdvertisements: true }
  }

  let hosting: URL
  try {
    hosting = new URL(hostingURL)
  } catch {
    throw new TypeError('DISCOVERY_ROOT requires a credential-free HTTPS hosting origin')
  }
  if (
    hosting.protocol !== 'https:' ||
    hosting.username !== '' ||
    hosting.password !== '' ||
    hosting.search !== '' ||
    hosting.hash !== '' ||
    (hosting.pathname !== '' && hosting.pathname !== '/')
  ) {
    throw new TypeError('DISCOVERY_ROOT requires a credential-free HTTPS hosting origin')
  }

  const networkPreset = { main: 'mainnet', test: 'testnet', ttn: 'teratestnet' } as const
  return {
    suppressDefaultSyncAdvertisements: false,
    lookupResolverConfig: {
      networkPreset: networkPreset[network],
      hostOverrides: { ls_ship: [hosting.origin] },
      slapTrackers: [hosting.origin]
    }
  }
}
