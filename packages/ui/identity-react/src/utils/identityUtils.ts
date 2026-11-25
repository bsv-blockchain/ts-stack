import {
  IdentityClient,
  KNOWN_IDENTITY_TYPES as knownCertificateTypes,
  IdentityClientOptions,
  OriginatorDomainNameStringUnder250Bytes,
  WalletInterface
} from '@bsv/sdk'
import { Certifier } from '../types'

export const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
export const isIdentityKey = (key: string) => {
  const regex = /^(02|03)[0-9a-fA-F]{64}$/
  return regex.test(key)
}

export const fetchIdentities = async (
  query: string,
  wallet?: WalletInterface | undefined,
  options?: Partial<IdentityClientOptions> | undefined,
  originator?: OriginatorDomainNameStringUnder250Bytes | undefined,
  signal?: AbortSignal,
  onContactError?: (error: unknown) => void
) => {
  // Bail immediately if already aborted
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  // Query results are cached by the hook. Each uncached lookup gets fresh contacts,
  // so clearing that cache also refreshes a separately edited Contacts basket.
  const client = new IdentityClient(wallet, options, originator)
  const resolutionOptions = {
    useContacts: true,
    contactErrorMode: 'fallback' as const,
    contactTimeoutMs: 2000,
    onContactError: (error: unknown) => {
      if (!signal?.aborted) onContactError?.(error)
    }
  }

  // Race the actual fetch against the abort signal so callers can cancel
  // in-flight requests when a newer query supersedes this one.
  const fetchPromise = isIdentityKey(query)
    ? client.resolveByIdentityKey({ identityKey: query.toLowerCase() }, resolutionOptions)
    : client.resolveByAttributes({ attributes: { any: query } }, resolutionOptions)

  if (!signal) return await fetchPromise

  let abortListener: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abortListener, { once: true })
    if (signal.aborted) abortListener()
  })
  try {
    return await Promise.race([fetchPromise, aborted])
  } finally {
    signal.removeEventListener('abort', abortListener)
  }
}

// Returns the correct tool tip depending on the certifier and certificate type
export const getCertifierToolTip = (certifier: Certifier, certificateType: string) => {
  switch (certificateType) {
    case knownCertificateTypes.discordCert:
      return `Discord account certified by ${certifier.name}`
    case knownCertificateTypes.xCert:
      return `X (Twitter) account certified by ${certifier.name}`
    case knownCertificateTypes.phoneCert:
      return `Phone number certified by ${certifier.name}`
    case knownCertificateTypes.emailCert:
      return `Email address certified by ${certifier.name}`
    default:
      return `Certified by ${certifier.name}`
  }
}
