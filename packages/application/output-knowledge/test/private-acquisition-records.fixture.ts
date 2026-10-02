import {
  Beef,
  OUTPUT_PROFILES,
  PrivateKey,
  Utils,
  outputPacketDigest,
  signOutputPacket,
  type OutputChain,
  type OutputCapabilities
} from '@bsv/sdk'
import {
  PrivateAcquisitionContracts,
  type PrivateAcquisitionInstallation
} from '../src/private/PrivateAcquisitionContracts.js'
import { PrivateAcquisitionRecords } from '../src/private/PrivateAcquisitionRecords.js'
import { acquisitionFixture } from './private-acquisition.fixture.js'
import { context } from './evidence-fixture.js'

export async function acquisitionRecordFixture(chain?: OutputChain) {
  const f = await acquisitionFixture(chain),
    key = new PrivateKey(83)
  const rules = { id: 'urn:test:acquisition-record-rules', parameters: { version: 1 } }
  const installation: PrivateAcquisitionInstallation = {
    chain: f.chain,
    seller: f.seller,
    baseURL: 'https://seller.example/api',
    service: f.request.service,
    rulesDigest: outputPacketDigest('service-rules', rules),
    acceptancePolicy: { kind: 'local-admission' },
    maximumRequestBytes: 65536,
    maximumResponseBytes: 1048576,
    maximumQuoteSeconds: '100',
    maximumRecoverySeconds: '172800'
  }
  const trust = {
    maximumAgeSeconds: '100',
    clockSkewSeconds: '1',
    rules: new Map([[rules.id, () => {}]])
  }
  const contracts = new PrivateAcquisitionContracts(installation, trust)
  const body: OutputCapabilities = {
    version: 1,
    identity: f.seller,
    baseURL: installation.baseURL,
    chain: f.chain,
    issuedAt: '10',
    expiresAt: '100',
    services: [
      {
        name: f.request.service,
        kind: 'lookup',
        rules,
        rulesDigest: installation.rulesDigest,
        profiles: [
          {
            id: OUTPUT_PROFILES.acquisition,
            authentication: 'brc103',
            payment: 'brc105',
            maxRequestBytes: 65536,
            maxResponseBytes: 1048576,
            parameters: { recoverySeconds: '86400', acceptancePolicy: { kind: 'local-admission' } }
          }
        ]
      }
    ]
  }
  const terms = {
    satoshis: '100',
    derivationPrefix: f.challenge.derivationPrefix,
    payableUntil: '100',
    creationCutoff: '100',
    minimumRecoverySeconds: '0'
  }
  const manifest = () => signOutputPacket('capabilities', body, key)
  const quote = contracts.prepare(f.request, manifest(), terms, '20')
  const source = f.transaction.inputs[0].sourceTransaction!
  const beef = new Beef()
  beef.mergeTransaction(source)
  const evidence = {
    txid: source.id('hex'),
    outputIndex: 0,
    beef: Utils.toBase64(beef.toBinaryAtomic(source.id('hex')))
  }
  const verificationContext = context()
  verificationContext.view.chain = f.chain
  const policy = { id: 'urn:test:acquisition-domain', digest: '88'.repeat(32) }
  const settings = { contracts, validationPolicy: policy, maximumRecordBytes: 1048576 }
  const records = new PrivateAcquisitionRecords(settings)
  const input = {
    request: quote.request,
    challenge: quote.challenge,
    capability: quote.capability,
    evidence,
    verificationContext,
    schema: 'urn:test:access-result',
    maximumContextBytes: 65536,
    maximumAcceptanceBytes: 131072
  }
  return {
    f,
    key,
    rules,
    installation,
    trust,
    contracts,
    body,
    terms,
    manifest,
    quote,
    evidence,
    verificationContext,
    policy,
    settings,
    records,
    input
  }
}
