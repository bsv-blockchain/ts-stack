interface RegistryTrust {
  identityKey: string
  trust: number
}

export function mostTrustedRecord<T extends { registryOperator?: string }>(
  records: T[],
  trusted: readonly RegistryTrust[]
): T | undefined {
  if (trusted.length === 0) return records[0]

  const trustByIdentity = new Map(trusted.map(({ identityKey, trust }) => [identityKey, trust]))
  let selected: T | undefined
  let selectedTrust = Number.NEGATIVE_INFINITY
  for (const record of records) {
    const trust = trustByIdentity.get(record.registryOperator ?? '')
    if (trust !== undefined && trust > selectedTrust) {
      selected = record
      selectedTrust = trust
    }
  }
  return selected
}

export function webURL(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    // Malformed registry metadata has no link destination.
    return undefined
  }
}
