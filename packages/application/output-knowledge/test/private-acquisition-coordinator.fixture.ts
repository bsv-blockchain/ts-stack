import { afterEach } from '@jest/globals'
import {
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Transaction,
  Utils,
  type OutputWalletFundingOperation
} from '@bsv/sdk'
import { SDKEvidenceVerifier } from '../src/SDKEvidenceVerifier.js'
import { PrivateAcquisitionAccess } from '../src/private/PrivateAcquisitionAccess.js'
import {
  PrivateAcquisitionCoordinator,
  type PrivateAcquisitionCoordinatorOptions
} from '../src/private/PrivateAcquisitionCoordinator.js'
import { SDKPrivateAcquisitionFunding } from '../src/private/SDKPrivateAcquisitionFunding.js'
import { SDKPrivateReleaseEvidence } from '../src/private/SDKPrivateReleaseEvidence.js'
import type {
  PrivateAcquisitionDomain,
  PrivateAcquisitionRelease
} from '../src/private/PrivateAcquisitionPorts.js'
import type {
  PrivateAcquisitionWallet,
  PrivateAcquisitionWalletOutcome
} from '../src/private/PrivateAcquisitionWallet.js'
import { acquisitionStoreFixture } from './private-acquisition-store.fixture.js'
import {
  candidate,
  chain as defaultChain,
  context,
  resolver,
  transactions
} from './evidence-fixture.js'

const cleanup = new Set<PrivateAcquisitionCoordinator>()
afterEach(async () => {
  for (const coordinator of cleanup) await coordinator.stop()
  cleanup.clear()
})
export async function acquisitionCoordinatorFixture(
  overrides: Partial<PrivateAcquisitionCoordinatorOptions> = {},
  chain = defaultChain
) {
  const verificationContext = () => {
    const original = context()
    return { ...original, view: { ...original.view, chain } }
  }
  const f = await acquisitionStoreFixture({}, chain)
  const request = {
    ...f.f.f.request,
    listing: { chain, txid: transactions.get('P')!.id('hex'), outputIndex: 0 }
  }
  const paymentTransaction = new Transaction(
    1,
    [
      {
        sourceTransaction: transactions.get('P')!,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(new PrivateKey(63)),
        sequence: 0xffffffff
      }
    ],
    [
      {
        satoshis: 100,
        lockingScript: new P2PKH().lock(PublicKey.fromString(f.f.f.sellerPaymentKey).toAddress())
      }
    ],
    0
  )
  await paymentTransaction.sign()
  const payment = {
    ...f.f.f.payment(),
    transaction: Utils.toBase64(paymentTransaction.toAtomicBEEF())
  }
  let permitted = true,
    authority = true,
    available = true,
    releaseReady = true,
    issueReady = true,
    credits = 0,
    domainValid = true
  const counts = { prepare: 0, validate: 0, issue: 0, status: 0, internalize: 0, assess: 0 }
  const receipts = new Map<string, PrivateAcquisitionWalletOutcome>()
  const domain: PrivateAcquisitionDomain = {
    async prepare() {
      counts.prepare++
      if (!available) throw new Error('Synthetic catalogue unavailable')
      return {
        terms: f.f.terms,
        evidence: candidate('P').evidence,
        verificationContext: verificationContext(),
        schema: f.original.schema,
        maximumContextBytes: f.original.maximumContextBytes,
        maximumAcceptanceBytes: f.original.maximumAcceptanceBytes,
        material: 'AQID'
      }
    },
    async validate(input) {
      counts.validate++
      if (
        !domainValid ||
        input.assetId !== request.assetId ||
        input.termsDigest !== request.termsDigest
      )
        throw new Error('Synthetic domain binding differs')
    },
    isCurrent() {
      return authority
    },
    async issue(_original, _progress, material) {
      counts.issue++
      if (!issueReady) throw new Error('Synthetic issuer unavailable')
      return material
    }
  }
  const wallet: PrivateAcquisitionWallet = {
    async status(state) {
      counts.status++
      return receipts.get(state.funding!.operation.id) ?? { state: 'absent' }
    },
    async internalize(state) {
      counts.internalize++
      const operation = state.funding!.operation
      if (!receipts.has(operation.id)) {
        credits++
        receipts.set(operation.id, { state: 'accepted', receipt: f.f.f.receipt(state) })
      }
      return receipts.get(operation.id)!
    }
  }
  const evidence = new SDKPrivateReleaseEvidence(resolver)
  const release: PrivateAcquisitionRelease = {
    async assess(original, _state, verified, signal) {
      counts.assess++
      if (!releaseReady) return undefined
      const acceptedAt = f.clock()
      return evidence.verify(
        {
          chain,
          txid: verified.operation.funding.txid,
          policy: original.challenge.acceptancePolicy,
          acceptedAt
        },
        {
          chain,
          txid: verified.operation.funding.txid,
          policy: original.challenge.acceptancePolicy
        },
        { now: acceptedAt, localAcceptedAt: acceptedAt, current: () => authority && releaseReady },
        signal
      )
    }
  }
  const options: PrivateAcquisitionCoordinatorOptions = {
    store: f.owner.store,
    contracts: f.f.contracts,
    access: new PrivateAcquisitionAccess(f.owner.domain, request.service, () => permitted),
    listing: new SDKEvidenceVerifier(resolver),
    funding: new SDKPrivateAcquisitionFunding(resolver, new ProtoWallet(new PrivateKey(83)), () =>
      verificationContext()
    ),
    domain,
    wallet,
    release,
    validationPolicy: f.f.policy,
    manifest: f.f.manifest,
    clock: f.clock,
    ...overrides
  }
  const coordinator = new PrivateAcquisitionCoordinator(options)
  cleanup.add(coordinator)
  const selection = f.f.contracts.retain(f.f.manifest(), f.clock()).selection
  const caller = {
    buyer: f.buyer,
    capability: selection.digest,
    profile: selection.profile.id,
    current: () => permitted
  }
  const current = () => f.owner.store.load(f.id, f.buyer, f.clock, f.guard)
  const quote = () => coordinator.acquire(request, undefined, caller)
  const pay = () => coordinator.acquire(request, payment, caller)
  const recover = () => coordinator.recover(f.id, caller)
  const projected = () => {
    let result: unknown
    f.owner.store.disclose(current()!, f.buyer, f.clock, f.guard, value => {
      result = value
    })
    return result
  }
  return {
    f,
    request,
    payment,
    paymentTransaction,
    counts,
    options,
    domain,
    wallet,
    release,
    coordinator,
    caller,
    current,
    quote,
    pay,
    recover,
    projected,
    dispose: async () => {
      await coordinator.stop()
      cleanup.delete(coordinator)
      f.dispose()
    },
    setAccess: (value: boolean) => {
      permitted = value
    },
    setAuthority: (value: boolean) => {
      authority = value
    },
    setAvailable: (value: boolean) => {
      available = value
    },
    setRelease: (value: boolean) => {
      releaseReady = value
    },
    setIssue: (value: boolean) => {
      issueReady = value
    },
    setDomainValid: (value: boolean) => {
      domainValid = value
    },
    setWallet: (value: PrivateAcquisitionWalletOutcome) => {
      const operation: OutputWalletFundingOperation = current()!.state.progress.funding!.operation
      receipts.set(operation.id, value)
    },
    getCredits: () => credits
  }
}
