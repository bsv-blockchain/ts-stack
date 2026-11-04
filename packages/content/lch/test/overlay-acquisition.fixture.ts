import {
  PrivateKey,
  ProtoWallet,
  OUTPUT_PROFILES,
  signOutputPacket,
  selectOutputCapability,
  Utils,
  type OutputCapabilities,
  type OutputChain,
  type OutputPaidLookupAcquire
} from '@bsv/sdk'
import {
  LCHBuyer,
  LCHIssuer,
  LCHPublisher,
  LCHReader,
  LCH_MECHANISMS,
  LCH_PROFILES,
  MemoryContentSink,
  WalletBRC77Signer,
  encodeDeterministicCbor,
  objectId,
  sha256,
  toHex,
  fromHex,
  type LCHValue,
  type SignedObject
} from '../src/index.js'
import { LCH_OVERLAY_PROFILES } from '../src/overlayAcquisitionCodec.js'
import { LCH_OVERLAY_PAID_MECHANISMS } from '../src/overlayAcquisitionTerms.js'

export async function lchOverlayFixture(
  chain?: OutputChain,
  installation?: {
    baseURL: string
    service: string
    rules: { id: string; parameters: { version: number } }
    maximumRequestBytes: number
    maximumResponseBytes: number
  },
  embedCiphertext = true,
  timeline?: { now: number }
) {
  timeline ??= { now: 20 }
  chain ??= { network: 'fixture', genesisHash: '09'.repeat(32) }
  installation ??= {
    baseURL: 'https://seller.example/api',
    service: 'catalogue',
    rules: { id: 'urn:reference:lch-paid-rules', parameters: { version: 1 } },
    maximumRequestBytes: 1048576,
    maximumResponseBytes: 4194304
  }
  const sellerKey = new PrivateKey(83),
    buyerKey = new PrivateKey(84),
    sellerWallet = new ProtoWallet(sellerKey),
    buyerWallet = new ProtoWallet(buyerKey),
    seller = await WalletBRC77Signer.create({ wallet: sellerWallet }),
    buyer = await WalletBRC77Signer.create({ wallet: buyerWallet }),
    storage = new MemoryContentSink(),
    publisher = new LCHPublisher(seller),
    plaintext = new TextEncoder().encode('Licensed reference audio content'),
    asset = await publisher.protect(plaintext, {
      mediaType: 'audio/wav',
      name: 'fixture.wav',
      rights: [
        {
          interest: 'sound-recording',
          holder: { name: 'Reference artist' },
          controller: seller.identityKey
        }
      ],
      sink: storage,
      segmentSize: 8,
      keyPeriodSegments: 2
    }),
    { baseURL, service } = installation,
    policy = {
      '@context': 'http://www.w3.org/ns/odrl.jsonld',
      '@type': 'Offer',
      uid: 'lch:offer:self',
      profile: 'https://bsv.brc.dev/apps/0170#odrl-profile',
      assigner: 'lch:identity:secp256k1:' + toHex(seller.identityKey),
      permission: [
        {
          action: 'play',
          target: 'lch:asset:sha256:' + toHex(asset.assetId),
          duty: [
            {
              uid: 'urn:reference:compensation',
              compensatedParty: 'lch:identity:secp256k1:' + toHex(seller.identityKey),
              action: {
                '@id': 'http://www.w3.org/ns/odrl/2/compensate',
                refinement: [
                  {
                    leftOperand: 'http://www.w3.org/ns/odrl/2/payAmount',
                    operator: 'http://www.w3.org/ns/odrl/2/eq',
                    rightOperand: {
                      '@value': '100',
                      '@type': 'http://www.w3.org/2001/XMLSchema#integer'
                    },
                    unit: 'https://bsv.brc.dev/apps/0170#satoshi'
                  }
                ]
              }
            }
          ]
        }
      ],
      prohibition: [
        {
          action: 'https://bsv.brc.dev/apps/0170#unwrap',
          target: 'lch:asset:sha256:' + toHex(asset.assetId)
        }
      ]
    },
    policyBytes = new TextEncoder().encode(JSON.stringify(policy)),
    issuer = new LCHIssuer(seller),
    offer = await issuer.createOffer({
      assetId: asset.assetId,
      usageProfile: LCH_PROFILES.fixedRender,
      seller: seller.identityKey,
      licenseIssuer: seller.identityKey,
      requiredInterests: ['sound-recording'],
      policy: {
        mediaType: 'application/ld+json',
        inline: policyBytes,
        digest: await sha256(policyBytes)
      },
      payment: {
        protocol: LCH_MECHANISMS.brc105Single,
        endpoint: baseURL + '/overlay/v1/private/acquire',
        asset: 'BSV',
        unit: 'satoshi',
        recoveryPeriodSeconds: 86400,
        pricing: {
          kind: 'fixed',
          requirements: [
            {
              dutyUid: 'urn:reference:compensation',
              payee: seller.identityKey,
              buyer: buyer.identityKey,
              endpoint: baseURL + '/overlay/v1/private/acquire',
              satoshis: 100
            }
          ]
        }
      },
      keyDelivery: { mechanism: LCH_MECHANISMS.brc78Key },
      enforcement: { class: 'https://bsv.brc.dev/apps/0170#conformingApplication' },
      notBefore: timeline.now - 19,
      notAfter: timeline.now + 80,
      nonce: crypto.getRandomValues(new Uint8Array(16)),
      critical: [LCH_OVERLAY_PROFILES.acquisition, LCH_OVERLAY_PROFILES.paidSettlement],
      extensions: {
        [LCH_OVERLAY_PROFILES.paidSettlement]: { version: 1 },
        [LCH_OVERLAY_PROFILES.acquisition]: {
          version: 1,
          mode: 'paid-lookup',
          seller: seller.identityKey,
          service,
          endpoint: baseURL,
          chain: { network: chain.network, genesisHash: fromHex(chain.genesisHash) }
        }
      }
    }),
    request = await new LCHBuyer(buyer).createRequest({
      assetId: asset.assetId,
      offerId: await objectId('offer', offer.body),
      action: 'play',
      selection: { type: 'all' },
      acceptedPolicyDigest: (offer.body.policy as Record<string, LCHValue>).digest as Uint8Array,
      createdAt: timeline.now
    }),
    requestBytes = encodeDeterministicCbor(request as unknown as LCHValue),
    published = await publisher.publish(
      asset,
      [{ mode: 'inline', offer: offer as unknown as LCHValue }],
      embedCiphertext
    ),
    rules = installation.rules,
    body: OutputCapabilities = {
      version: 1,
      identity: toHex(seller.identityKey),
      baseURL,
      chain,
      issuedAt: String(timeline.now - 10),
      expiresAt: String(timeline.now + 80),
      services: [
        {
          kind: 'lookup',
          name: service,
          rules,
          rulesDigest: (await import('@bsv/sdk')).outputPacketDigest('service-rules', rules),
          profiles: [
            {
              id: OUTPUT_PROFILES.acquisition,
              authentication: 'brc103',
              payment: 'brc105',
              maxRequestBytes: installation.maximumRequestBytes,
              maxResponseBytes: installation.maximumResponseBytes,
              parameters: {
                recoverySeconds: '86400',
                acceptancePolicy: { kind: 'local-admission' }
              }
            }
          ]
        }
      ],
      extensions: {
        [LCH_OVERLAY_PROFILES.acquisition]: {
          version: 1,
          bindings: [
            {
              kind: 'lookup',
              service,
              mode: 'paid-lookup',
              mechanisms: [...LCH_OVERLAY_PAID_MECHANISMS]
            }
          ]
        }
      }
    },
    selection = selectOutputCapability(signOutputPacket('capabilities', body, sellerKey), {
      identity: body.identity,
      baseURL,
      chain,
      kind: 'lookup',
      service,
      profile: OUTPUT_PROFILES.acquisition,
      maximumAgeSeconds: '100',
      clockSkewSeconds: '0',
      now: String(timeline.now),
      rules: new Map([[rules.id, () => {}]])
    }),
    acquire: OutputPaidLookupAcquire = {
      version: 1,
      requestId: toHex(await objectId('license-request', request.body)),
      service,
      assetId: toHex(asset.assetId),
      termsDigest: toHex(await objectId('offer', offer.body)),
      listing: { chain, txid: '11'.repeat(32), outputIndex: 0 },
      recipient: toHex(buyer.identityKey),
      request: Utils.toBase64(requestBytes)
    },
    input = {
      reader: new LCHReader(storage),
      header: published.bytes,
      offer,
      request: requestBytes,
      acquire,
      selection,
      installedMechanisms: new Set(LCH_OVERLAY_PAID_MECHANISMS)
    }
  return {
    input,
    sellerKey,
    buyerKey,
    sellerWallet,
    buyerWallet,
    seller,
    buyer,
    storage,
    publisher,
    asset,
    plaintext,
    policy,
    issuer,
    offer,
    request,
    requestBytes,
    acquire,
    selection,
    body
  }
}
export function cloneSigned(value: SignedObject): SignedObject {
  return { body: value.body, signatures: value.signatures.map(signature => signature.slice()) }
}
