import { signPurchaseFixturePacket } from './private-purchase-signing.fixture.js'
import {
  OUTPUT_PROFILES,
  outputPacketDigest,
  PrivateKey,
  type OutputCapabilities,
  type OutputPurchasePrepare
} from '@bsv/sdk'
import {
  PrivatePurchaseContracts,
  type PrivatePurchaseInstallation,
  type PrivatePurchasePreparationTerms
} from '../src/private/PrivatePurchaseContracts.js'

/** Contract representations only; these bytes are not listing/domain evidence. */
export function purchaseContractFixture(overrides: Partial<PrivatePurchaseInstallation> = {}) {
  const key = new PrivateKey(41),
    chain = { network: 'purchase-contract-fixture', genesisHash: '11'.repeat(32) },
    rules = { id: 'urn:test:purchase-rules', parameters: { version: 1 } },
    installation: PrivatePurchaseInstallation = {
      chain,
      seller: key.toPublicKey().toString(),
      baseURL: 'https://seller.example/api',
      topic: 'tm_private_purchase',
      rulesDigest: outputPacketDigest('service-rules', rules),
      releasePolicy: { kind: 'local-admission' },
      domainProfile: 'urn:test:purchase-domain',
      domainSchema: 'urn:test:purchase-domain-evidence',
      maximumRequestBytes: 65536,
      maximumResponseBytes: 1048576,
      maximumPurchaseSeconds: '100',
      maximumRecoverySeconds: '172800',
      ...overrides
    },
    trust = {
      maximumAgeSeconds: '100',
      clockSkewSeconds: '1',
      rules: new Map([[rules.id, () => {}]])
    },
    contracts = new PrivatePurchaseContracts(installation, trust),
    request: OutputPurchasePrepare = {
      version: 1,
      requestId: 'original-purchase',
      topic: installation.topic,
      listing: { chain, txid: '22'.repeat(32), outputIndex: 0 },
      assetId: '33'.repeat(32),
      termsDigest: '44'.repeat(32),
      recipient: new PrivateKey(44).toPublicKey().toString(),
      request: 'AA=='
    },
    terms: PrivatePurchasePreparationTerms = {
      domainEvidence: { schema: installation.domainSchema, bytes: 'AA==' },
      purchaseUntil: '100',
      creationCutoff: '100',
      minimumRecoverySeconds: '0'
    },
    body: OutputCapabilities = {
      version: 1,
      identity: installation.seller,
      baseURL: installation.baseURL,
      chain,
      issuedAt: '10',
      expiresAt: '100',
      services: [
        {
          name: installation.topic,
          kind: 'topic',
          rules,
          rulesDigest: installation.rulesDigest,
          profiles: [
            {
              id: OUTPUT_PROFILES.purchase,
              authentication: 'brc103',
              payment: 'covenant',
              maxRequestBytes: 65536,
              maxResponseBytes: 1048576,
              parameters: {
                recoverySeconds: '86400',
                releasePolicies: [{ kind: 'local-admission' }],
                domainProfiles: [installation.domainProfile]
              }
            }
          ]
        }
      ]
    }
  function manifest() {
    return signPurchaseFixturePacket('capabilities', body, key)
  }
  function prepared() {
    return contracts.prepare(request, manifest(), terms, '20')
  }
  function original() {
    const selected = prepared()
    return contracts.authenticate(
      selected,
      signPurchaseFixturePacket('purchase-terms', selected.body, key)
    )
  }
  return {
    key,
    chain,
    rules,
    installation,
    trust,
    contracts,
    request,
    terms,
    body,
    manifest,
    prepared,
    original
  }
}
