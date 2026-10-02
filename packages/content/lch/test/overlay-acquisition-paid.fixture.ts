import {
  P2PKH,
  PrivateKey,
  PublicKey,
  Transaction,
  Utils,
  Hash,
  outputPacketDigest,
  signOutputPacket,
  canonicalOutputJSON,
  type OutputPaidLookupAcquired
} from '@bsv/sdk'
import { afterEach } from '@jest/globals'
import { createSecretKey } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLiteProtectedOperationObjectStore } from '../../../application/output-knowledge/src/operations/SQLiteProtectedOperationObjectStore.js'
import { NodeProtectedPayloadCodec } from '../../../application/output-knowledge/src/private/NodeProtectedPayloadCodec.js'
import { SDKEvidenceVerifier } from '../../../application/output-knowledge/src/SDKEvidenceVerifier.js'
import { SDKPrivateAcquisitionFunding } from '../../../application/output-knowledge/src/private/SDKPrivateAcquisitionFunding.js'
import { SDKPrivateReleaseEvidence } from '../../../application/output-knowledge/src/private/SDKPrivateReleaseEvidence.js'
import {
  candidate,
  chain as fixtureChain,
  context,
  resolver,
  transactions
} from '../../../application/output-knowledge/test/evidence-fixture.js'
import { WalletBRC78KeyDelivery, type KeyGrant, type SignedObject } from '../src/index.js'
import { LCH_OVERLAY_PROFILES, encodeLCHOverlayContext } from '../src/overlayAcquisitionCodec.js'
import { validateLCHOverlayPaidTerms } from '../src/overlayAcquisitionTerms.js'
import { createLCHOverlayFixedRenderAgreement } from '../src/overlayAcquisitionPolicy.js'
import {
  LCHOverlayPaidDomain,
  type LCHOverlayPaidDomainOptions
} from '../src/overlayAcquisitionPaid.js'
import { lchOverlayFixture } from './overlay-acquisition.fixture.js'
import { lchOverlayCustodyBinding } from '../src/overlayAcquisitionCustody.js'

const cleanup = new Set<() => Promise<void>>()
afterEach(async () => {
  for await (const close of cleanup) await close()
  cleanup.clear()
})

export async function lchPaidFixture(
  chain = fixtureChain,
  installation?: Parameters<typeof lchOverlayFixture>[1],
  embedCiphertext = true
) {
  const snapshot = () => ({ ...context(), view: { ...context().view, chain } })
  const f = await lchOverlayFixture(chain, installation, embedCiphertext),
    acquire = {
      ...f.acquire,
      listing: { chain, txid: transactions.get('P')!.id('hex'), outputIndex: 0 }
    },
    input = { ...f.input, acquire },
    terms = await validateLCHOverlayPaidTerms(input),
    challenge = {
      version: 1 as const,
      acquisitionId: outputPacketDigest('acquisition', {
        chain,
        seller: f.body.identity,
        buyer: acquire.recipient,
        service: acquire.service,
        requestId: acquire.requestId
      }),
      requestDigest: outputPacketDigest('acquire-request', acquire),
      seller: f.body.identity,
      buyer: acquire.recipient,
      assetId: acquire.assetId,
      termsDigest: acquire.termsDigest,
      satoshis: '100',
      derivationPrefix: 'reference-prefix',
      acceptancePolicy: { kind: 'local-admission' as const },
      rulesDigest: f.selection.service.rulesDigest,
      payableUntil: '100',
      recoveryUntil: '86500'
    },
    suffix = 'reference-suffix',
    destination = (
      await f.sellerWallet.getPublicKey({
        protocolID: [2, '3241645161d8'],
        keyID: challenge.derivationPrefix + ' ' + suffix,
        counterparty: challenge.buyer,
        forSelf: true
      })
    ).publicKey,
    transaction = new Transaction(
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
          lockingScript: new P2PKH().lock(PublicKey.fromString(destination).toAddress())
        }
      ],
      0
    )
  await transaction.sign()
  const payment = {
      derivationPrefix: challenge.derivationPrefix,
      derivationSuffix: suffix,
      transaction: Utils.toBase64(transaction.toAtomicBEEF())
    },
    funding = { chain, txid: transaction.id('hex'), outputIndex: 0 },
    acceptance = {
      chain,
      txid: funding.txid,
      policy: challenge.acceptancePolicy,
      acceptedAt: '20'
    },
    body = {
      version: 1 as const,
      seller: challenge.seller,
      buyer: challenge.buyer,
      requestId: acquire.requestId,
      offerId: acquire.termsDigest,
      assetId: acquire.assetId,
      dutyUid: terms.policy.dutyUid,
      acquisitionId: challenge.acquisitionId,
      funding,
      satoshis: '100',
      acceptancePolicy: challenge.acceptancePolicy,
      releaseEvidenceDigest: outputPacketDigest('release-evidence', acceptance),
      issuedAt: '20',
      recoveryUntil: challenge.recoveryUntil
    },
    settlement = signOutputPacket('lch-lookup-settlement', body, f.sellerKey),
    settlementId = outputPacketDigest('lch-lookup-settlement', body),
    delivery = new WalletBRC78KeyDelivery(f.sellerWallet),
    grants: KeyGrant[] = []
  for await (const [key, cek] of f.asset.keys)
    grants.push({
      keyId: Uint8Array.from(Utils.toArray(key, 'hex')),
      delivery: 'https://bsv.brc.dev/apps/0170#brc78-key-v1',
      payload: await delivery.deliver(
        acquire.recipient,
        Uint8Array.from(Utils.toArray(key, 'hex')),
        cek
      )
    })
  const agreement = await createLCHOverlayFixedRenderAgreement(terms.policy),
    licenseOptions = {
      assetId: f.asset.assetId,
      offerId: Uint8Array.from(Utils.toArray(acquire.termsDigest, 'hex')),
      requestId: Uint8Array.from(Utils.toArray(acquire.requestId, 'hex')),
      issuer: f.seller.identityKey,
      subject: f.buyer.identityKey,
      issuedAt: 20,
      agreement,
      selection: { type: 'all' as const },
      keyGrants: grants,
      encryption: terms.encryption,
      fulfillments: [
        {
          dutyUid: terms.policy.dutyUid,
          settlementProfile: LCH_OVERLAY_PROFILES.paidSettlement,
          receiptIds: [Uint8Array.from(Utils.toArray(settlementId, 'hex'))]
        }
      ],
      critical: [LCH_OVERLAY_PROFILES.acquisition, LCH_OVERLAY_PROFILES.paidSettlement],
      extensions: {
        [LCH_OVERLAY_PROFILES.acquisition]: {
          version: 1,
          mode: 'paid-lookup',
          settlementId: Uint8Array.from(Utils.toArray(settlementId, 'hex'))
        },
        [LCH_OVERLAY_PROFILES.paidSettlement]: { version: 1 }
      }
    },
    license = await f.issuer.issueLicense(licenseOptions),
    json = (value: unknown) => new TextEncoder().encode(canonicalOutputJSON(value)),
    wrapper = {
      version: 1 as const,
      license,
      evidence: [{ type: 'offer' as const, object: f.offer }],
      settlement: json(settlement),
      paymentEvidence: json({
        version: 1,
        challenge,
        payment: { txid: funding.txid, outputIndex: 0, beef: payment.transaction },
        release: acceptance,
        derivationSuffix: suffix
      })
    },
    delivered: OutputPaidLookupAcquired = {
      version: 1,
      acquisitionId: challenge.acquisitionId,
      status: 'delivered',
      recoveryUntil: challenge.recoveryUntil,
      challenge,
      funding,
      acceptance,
      result: {
        evidence: candidate('P').evidence,
        schema: LCH_OVERLAY_PROFILES.acquisition,
        context: Utils.toBase64(await encodeLCHOverlayContext(wrapper, 'paid-lookup'))
      }
    },
    fundVerifier = new SDKPrivateAcquisitionFunding(resolver, f.buyerWallet, snapshot),
    evidenceVerifier = new SDKEvidenceVerifier(resolver),
    releaseVerifier = new SDKPrivateReleaseEvidence(resolver)
  let now = '20',
    allowed = true
  const counts = { funding: 0, listing: 0, release: 0 }
  const options: LCHOverlayPaidDomainOptions = {
      original: {
        header: input.header,
        offer: input.offer,
        request: input.request,
        acquire,
        selection: input.selection
      },
      source: { id: 'urn:reference:bounded-content', read: f.storage.read.bind(f.storage) },
      wallet: f.buyerWallet,
      authorityNetwork: 'testnet',
      maximumCiphertextBytes: 1048576,
      current: () => allowed,
      clock: () => now,
      verification: {
        id: 'urn:reference:actual-sdk-script-spv-and-retained-local-acceptance',
        funding: async (...args) => {
          counts.funding++
          return fundVerifier.verifyForBuyer(...args)
        },
        listing: async (evidence, selected, signal) => {
          counts.listing++
          if (selected.txid !== evidence.txid || selected.outputIndex !== evidence.outputIndex)
            throw new Error('Wrong listing')
          const result = await evidenceVerifier.verify(
            {
              chain: selected.chain,
              evidence,
              variantId: Utils.toHex(Hash.sha256(Utils.toArray(evidence.beef, 'base64')))
            },
            snapshot(),
            signal
          )
          if (result.status !== 'verified') throw new Error('Listing not independently verified')
        },
        release: async (evidence, expected, signal) => {
          counts.release++
          return releaseVerifier.verify(
            evidence,
            expected,
            { now, localAcceptedAt: '20', current: () => allowed },
            signal
          )
        }
      }
    },
    domain = await LCHOverlayPaidDomain.create(options)
  const directory = mkdtempSync(join(tmpdir(), 'lch-overlay-custody-')),
    configuration = {
      storeId: 'c1'.repeat(32),
      recipient: acquire.recipient,
      binding: lchOverlayCustodyBinding(domain.id),
      maximumObjects: 2,
      maximumObjectBytes: 1048576
    },
    codec = new NodeProtectedPayloadCodec(
      { resolve: () => createSecretKey(Buffer.alloc(32, 84)) },
      'reference'
    ),
    path = join(directory, 'domain.sqlite'),
    owners: SQLiteProtectedOperationObjectStore[] = [],
    objects = SQLiteProtectedOperationObjectStore.create(path, configuration, codec)
  owners.push(objects)
  cleanup.add(async () => {
    for await (const owner of owners) await owner.close()
    rmSync(directory, { recursive: true, force: true })
  })
  await domain.initializeCustody(objects)
  function openObjects() {
    const reopened = SQLiteProtectedOperationObjectStore.open(path, configuration, codec)
    owners.push(reopened)
    return reopened
  }
  async function replaceLicense(value: SignedObject) {
    return {
      ...delivered,
      result: {
        ...delivered.result!,
        context: Utils.toBase64(
          await encodeLCHOverlayContext(
            {
              ...wrapper,
              license: value
            },
            'paid-lookup'
          )
        )
      }
    }
  }
  return {
    ...f,
    input,
    acquire,
    terms,
    challenge,
    payment,
    funding,
    acceptance,
    settlement,
    settlementId,
    license,
    licenseOptions,
    wrapper,
    delivered,
    options,
    domain,
    objects,
    openObjects,
    counts,
    replaceLicense,
    setNow: (value: string) => {
      now = value
    },
    setAccess: (value: boolean) => {
      allowed = value
    }
  }
}
