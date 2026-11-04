/** Browser resource data only. The database name selects the original private
 * namespace; current native database/lock ownership still must be checked. */
export interface Brc38PrivateIdbStructuredPolicy {
  readonly databaseName: string
  readonly maximumTemporaryIndexBytes: number
  readonly maximumIndexMembers: number
  readonly maximumStructuredBytes: number
  readonly maximumCanonicalBytes: number
  readonly signal?: AbortSignal
}
export function brc38PrivateIdbStructuredPolicy(
  selected: Brc38PrivateIdbStructuredPolicy
): Readonly<Brc38PrivateIdbStructuredPolicy> {
  const policy = Object.freeze({
    databaseName: selected.databaseName,
    maximumTemporaryIndexBytes: selected.maximumTemporaryIndexBytes,
    maximumIndexMembers: selected.maximumIndexMembers,
    maximumStructuredBytes: selected.maximumStructuredBytes,
    maximumCanonicalBytes: selected.maximumCanonicalBytes,
    signal: selected.signal
  })
  const bound = (value: number, minimum: number, maximum: number) =>
    Number.isSafeInteger(value) && value >= minimum && value <= maximum
  if (
    !/^wallet-toolbox-brc38-private-v1-[0-9a-f]{32}$/.test(policy.databaseName) ||
    !bound(policy.maximumTemporaryIndexBytes, 1048576, 17179869184) ||
    !bound(policy.maximumIndexMembers, 1, 2000000000) ||
    !bound(policy.maximumStructuredBytes, 2, 1000000000) ||
    !bound(policy.maximumCanonicalBytes, 2, 1000000000)
  )
    throw new RangeError('Invalid private browser structured admission')
  policy.signal?.throwIfAborted()
  return policy
}
