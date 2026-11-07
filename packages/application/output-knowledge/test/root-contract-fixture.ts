import {
  canonicalOutputJSON,
  OUTPUT_PROFILES,
  outputAssert,
  outputPacketDigest,
  PrivateKey,
  signOutputPacket,
  type OutputCapabilities,
  type OutputJSONObject
} from '@bsv/sdk'
import type { RootEvictionCapabilityTrust } from '../src/root-eviction/RootEvictionContracts.js'

export const rootContractKey = new PrivateKey(182)
export const rootContractIdentity = rootContractKey.toPublicKey().toString()
export const rootContractChain = { network: 'mock', genesisHash: 'a1'.repeat(32) }
export const rootContractRules = {
  id: 'https://root.example.test/rules/manual-v1',
  parameters: { mode: 'manual' }
}
export function rootContractManifest(): OutputCapabilities {
  return {
    version: 1,
    identity: rootContractIdentity,
    baseURL: 'https://root.example.test/api',
    chain: { ...rootContractChain },
    issuedAt: '100',
    expiresAt: '200',
    services: [
      {
        kind: 'coordination',
        name: 'root-advertisements',
        rules: structuredClone(rootContractRules),
        rulesDigest: outputPacketDigest('service-rules', rootContractRules),
        profiles: [
          {
            id: OUTPUT_PROFILES.eviction,
            authentication: 'brc103',
            payment: 'none',
            maxRequestBytes: 1048576,
            maxResponseBytes: 1048576,
            parameters: { maxTargets: 64, maxLifetimeSeconds: '86400' }
          }
        ]
      }
    ]
  }
}
export function rootContractTrust(): RootEvictionCapabilityTrust {
  return {
    baseURL: 'https://root.example.test/api',
    identity: rootContractIdentity,
    chain: { ...rootContractChain },
    maximumAgeSeconds: '100',
    clockSkewSeconds: '5',
    rules: new Map([
      [
        rootContractRules.id,
        (parameters: OutputJSONObject) => {
          outputAssert(
            canonicalOutputJSON(parameters) === canonicalOutputJSON(rootContractRules.parameters),
            'Root fixture rule parameters differ',
            'unsupported'
          )
        }
      ]
    ])
  }
}
export function rootContractPacket(body = rootContractManifest()) {
  return {
    packet: signOutputPacket('capabilities', body, rootContractKey),
    selector: outputPacketDigest('capabilities', body)
  }
}
