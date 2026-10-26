import {
  canonicalOutputJSON,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputString,
  outputU32,
  outputU64,
  type OutputRootEvictionResult,
  type OutputSignedRootEvictionRequest
} from '@bsv/sdk'
import type {
  RootEvictionCapacity,
  RootEvictionConfiguration,
  RootEvictionServingTarget
} from './RootEvictionStorage.js'

const maximums: Readonly<RootEvictionCapacity> = Object.freeze({
  requests: 4096,
  requestBytes: 67108864,
  targets: 65536,
  blockers: 64,
  assessments: 4096
})
export const rootPosition = (value: string): string =>
  outputU64(value).toString(16).padStart(16, '0')
export function rootDecimal(value: unknown): string {
  outputAssert(
    typeof value === 'string' && /^[0-9a-f]{16}$/.test(value),
    'Invalid retained root revision',
    'unavailable'
  )
  return BigInt('0x' + value).toString()
}
export const rootBytes = (value: string): number => new TextEncoder().encode(value).length

export function rootConfiguration(input: RootEvictionConfiguration): {
  root: string
  chain: RootEvictionConfiguration['chain']
  capacity: Readonly<RootEvictionCapacity>
  coordination?: Readonly<{ contractBytes: number }>
  localRules?: Readonly<{ rules: number; bytes: number }>
  seal: string
} {
  outputAssert(
    Object.keys(input).every(key =>
      ['root', 'chain', 'capacity', 'coordination', 'localRules'].includes(key)
    ) && Object.keys(input.chain).length === 2,
    'Invalid root storage configuration'
  )
  const root = outputIdentity(input.root)
  const chain = {
    network: outputString(input.chain.network),
    genesisHash: outputHex32(input.chain.genesisHash)
  }
  const capacity = { ...maximums, ...input.capacity }
  for (const key of Object.keys(capacity) as (keyof RootEvictionCapacity)[])
    outputAssert(
      Object.hasOwn(maximums, key) &&
        Number.isSafeInteger(capacity[key]) &&
        capacity[key] > 0 &&
        capacity[key] <= maximums[key],
      'Invalid root storage capacity'
    )
  let coordination: Readonly<{ contractBytes: number }> | undefined
  if (input.coordination !== undefined) {
    const contractBytes = input.coordination.contractBytes ?? 67108864
    outputAssert(
      Object.keys(input.coordination).every(key => key === 'contractBytes') &&
        Number.isSafeInteger(contractBytes) &&
        contractBytes > 0 &&
        contractBytes <= 67108864,
      'Invalid root contract capacity'
    )
    coordination = Object.freeze({ contractBytes })
  }
  let localRules: Readonly<{ rules: number; bytes: number }> | undefined
  if (input.localRules !== undefined) {
    const rules = input.localRules.rules ?? 4096
    const bytes = input.localRules.bytes ?? 67108864
    outputAssert(
      coordination !== undefined &&
        Object.keys(input.localRules).every(key => key === 'rules' || key === 'bytes') &&
        Number.isSafeInteger(rules) &&
        rules > 0 &&
        rules <= 4096 &&
        Number.isSafeInteger(bytes) &&
        bytes > 0 &&
        bytes <= 67108864,
      'Invalid root local-rule capacity or missing coordination'
    )
    localRules = Object.freeze({ rules, bytes })
  }
  const original = { format: 'root-eviction/1', root, chain, capacity }
  const coordinated = coordination
    ? { ...original, format: 'root-eviction/2', coordination }
    : original
  return {
    root,
    chain,
    capacity: Object.freeze(capacity),
    ...(coordination ? { coordination } : {}),
    ...(localRules ? { localRules } : {}),
    seal: canonicalOutputJSON(
      localRules ? { ...coordinated, format: 'root-eviction/3', localRules } : coordinated
    )
  }
}

export function rootTarget(input: RootEvictionServingTarget): RootEvictionServingTarget {
  outputAssert(
    Object.keys(input).length === 3 &&
      Object.keys(input.outpoint).length === 3 &&
      Object.keys(input.outpoint.chain).length === 2 &&
      (input.service === 'ls_ship' || input.service === 'ls_slap'),
    'Invalid root serving target'
  )
  return {
    service: input.service,
    outpoint: {
      chain: {
        network: outputString(input.outpoint.chain.network),
        genesisHash: outputHex32(input.outpoint.chain.genesisHash)
      },
      txid: outputHex32(input.outpoint.txid),
      outputIndex: outputU32(input.outpoint.outputIndex)
    },
    advertisementDigest: outputHex32(input.advertisementDigest)
  }
}
export function rootTargetKey(input: RootEvictionServingTarget): string {
  return canonicalOutputJSON({ service: input.service, outpoint: input.outpoint })
}

/** Reserve the complete future result budget before any request can acquire a basis. */
export function reserveRootResult(
  packet: OutputSignedRootEvictionRequest,
  policyDigest: string,
  blockerLimit: number,
  responseLimit = 1048576
): void {
  const blockers = Array.from({ length: blockerLimit }, (_, index) => ({
    decisionId: index.toString(16).padStart(64, '0'),
    policyDigest
  }))
  const body: OutputRootEvictionResult = {
    version: 1,
    root: packet.body.recipient,
    requestDigest: 'f'.repeat(64),
    policyDigest,
    issuedAt: '18446744073709551615',
    outcomes: packet.body.targets.map(target => ({
      service: target.service,
      outpoint: target.outpoint,
      actionStatus: 'applied',
      // Control characters occupy one permitted UTF-8 byte but six JSON bytes.
      reasonCode: '\u0000'.repeat(1024),
      decisionId: 'f'.repeat(64),
      affectedDecisionIds: ['f'.repeat(64)],
      revision: '18446744073709551615',
      serving: { state: 'suppressed', revision: '18446744073709551615', blockers }
    }))
  }
  // 174 raw signature bytes is the wire parser's conservative maximum, not a
  // promise that the signing adapter uses all of them.
  canonicalOutputJSON({ body, signature: 's'.repeat(232) }, { bytes: responseLimit })
}
