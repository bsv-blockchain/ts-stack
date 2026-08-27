import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  LCHComposer,
  LCHIssuer,
  LCH_MECHANISMS,
  LCH_PROFILES,
  LCHPublisher,
  LCHReader,
  MemoryContentSink,
  MemoryLicenseStore,
  WalletBRC77Signer,
  WalletBRC78KeyDelivery,
  matchFinalizedOutputs,
  objectId,
  sha256,
  toHex,
  type KeyGrant,
  type InspectedLCH,
  type LCHValue,
  type ProtectedAsset,
  type SegmentedEncryptionDescriptor,
  type SignedObject
} from '@bsv/lch'
import { createToneWav, randomBytes } from './demo.js'
import './style.css'

interface DemoAsset {
  name: string
  mediaType: string
  protected: ProtectedAsset
  offer: SignedObject
  offerId: Uint8Array
  lchBytes: Uint8Array
}

const creatorWallet = new ProtoWallet(new PrivateKey(11))
const buyerWallet = new ProtoWallet(new PrivateKey(12))
const creatorSigner = await WalletBRC77Signer.create({ wallet: creatorWallet })
const buyerSigner = await WalletBRC77Signer.create({ wallet: buyerWallet })
const issuer = new LCHIssuer(creatorSigner)
const content = new MemoryContentSink()
const licenses = new MemoryLicenseStore()
const publisher = new LCHPublisher(creatorSigner)
const reader = new LCHReader(content, licenses)
const creatorKeyDelivery = new WalletBRC78KeyDelivery(creatorWallet)
const buyerKeyDelivery = new WalletBRC78KeyDelivery(buyerWallet)
let current: DemoAsset | undefined
let pendingInspection: InspectedLCH | undefined
let placements = 0
let playerUrl: string | undefined

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="topbar">
    <a class="brand" href="#">LCH<span>STUDIO</span></a>
    <nav><a href="#watch">Watch</a><a href="#create">Create</a><a href="#compose">Compose</a></nav>
    <div class="network"><i></i> Local reference network</div>
  </header>
  <main>
    <section class="hero">
      <div><p class="eyebrow">BRC-170 REFERENCE IMPLEMENTATION</p><h1>Make once.<br><em>License forever.</em></h1>
      <p>Encrypted media, portable rights, direct creator payment, and compositions whose obligations survive every remix.</p></div>
      <div class="protocol-card"><span>OPENING NEVER SPENDS</span><strong>preflight</strong><b>→</b><strong>quote</strong><b>→</b><strong>consent</strong><b>→</b><strong>license</strong></div>
    </section>

    <section id="create" class="panel split">
      <div><p class="step">01 / PUBLISH</p><h2>Creator studio</h2><p>Choose audio or video, or mint the deterministic demo loop. The bytes are segmented, encrypted, signed, and wrapped as an LCH.</p>
        <div class="drop"><input id="media-file" type="file" accept="audio/*,video/*" /><label for="media-file">Drop a master here<br><span>audio or video · local only</span></label></div>
        <button id="tone" class="secondary">Generate 2-second loop</button>
      </div>
      <div class="receipt" id="publish-receipt"><div class="empty">No protected asset yet</div></div>
    </section>

    <section id="watch" class="panel watch">
      <div class="media-stage" id="media-stage"><div class="lock">LCH</div><p>Publish a work to create its viewer card.</p></div>
      <div class="purchase"><p class="step">02 / ACQUIRE</p><h2 id="asset-title">Licensed playback</h2><p id="asset-copy">Preflight validates the header and ciphertext before the wallet sees a quote.</p>
        <div class="price"><div><span>TOTAL</span><strong>12 sat</strong></div><div><span>SPLIT</span><strong>7 + 5</strong></div></div>
        <button id="acquire" disabled>Preflight & quote</button>
        <p class="fine">Demo confirmation exercises reordered-output matching and BRC-78 delivery. No transaction is broadcast.</p>
      </div>
    </section>

    <section id="compose" class="panel composer">
      <div><p class="step">03 / COMPOSE</p><h2>Whole-placement DAW</h2><p>Place the licensed loop on the timeline. Repeats are distinct ingredients; trim and stretch remain future mapping profiles.</p></div>
      <div class="timeline"><div class="ruler">0s <span>2s</span><span>4s</span><span>6s</span><span>8s</span></div><div class="track"><label>LOOP A</label><div id="clips" class="clips"></div></div></div>
      <div class="compose-actions"><button id="place" class="secondary" disabled>Place licensed loop</button><button id="manifest" disabled>Build composition record</button></div>
      <pre id="composition-output">Awaiting a licensed source…</pre>
    </section>
  </main>
  <footer><span>BRC-170 draft · @bsv/lch</span><span>Protocol logic, not a production storefront</span></footer>
`

const fileInput = document.querySelector<HTMLInputElement>('#media-file')!
const toneButton = document.querySelector<HTMLButtonElement>('#tone')!
const acquireButton = document.querySelector<HTMLButtonElement>('#acquire')!
const placeButton = document.querySelector<HTMLButtonElement>('#place')!
const manifestButton = document.querySelector<HTMLButtonElement>('#manifest')!

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (file !== undefined)
    void file
      .arrayBuffer()
      .then(buffer =>
        publish(new Uint8Array(buffer), file.type || 'application/octet-stream', file.name)
      )
})
toneButton.addEventListener(
  'click',
  () => void publish(createToneWav(), 'audio/wav', 'signal-loop.wav')
)
acquireButton.addEventListener('click', () => void acquire())
placeButton.addEventListener('click', place)
manifestButton.addEventListener('click', buildComposition)

async function publish(bytes: Uint8Array, mediaType: string, name: string): Promise<void> {
  status('Protecting and signing…')
  const protectedAsset = await publisher.protect(bytes, {
    mediaType,
    name,
    rights: [
      {
        interest: 'master',
        holder: { name: 'Demo Creator' },
        controller: creatorSigner.identityKey
      },
      {
        interest: 'composition',
        holder: { name: 'Demo Composer' },
        controller: creatorSigner.identityKey
      }
    ],
    sink: content,
    segmentSize: 64 * 1024,
    keyPeriodSegments: 1
  })
  const policyJson = {
    '@context': ['http://www.w3.org/ns/odrl.jsonld'],
    '@type': 'Offer',
    uid: 'lch:offer:self',
    profile: 'https://bsv.brc.dev/apps/0170#odrl-profile',
    permission: [{ target: `lch:asset:sha256:${toHex(protectedAsset.assetId)}`, action: 'play' }]
  }
  const policyBytes = new TextEncoder().encode(JSON.stringify(policyJson))
  const offer = await issuer.createOffer({
    assetId: protectedAsset.assetId,
    usageProfile: LCH_PROFILES.fixedRender,
    seller: creatorSigner.identityKey,
    licenseIssuer: creatorSigner.identityKey,
    requiredInterests: ['master', 'composition'],
    policy: {
      mediaType: 'application/ld+json',
      digest: await sha256(policyBytes),
      inline: policyBytes
    },
    payment: {
      protocol: LCH_MECHANISMS.brc105Multipay,
      endpoint: 'https://seller.example/lch/license',
      asset: 'BSV',
      unit: 'satoshi',
      recoveryPeriodSeconds: 86_400,
      pricing: { kind: 'fixed', requirements: [] }
    },
    keyDelivery: { mechanism: LCH_MECHANISMS.brc78Key },
    enforcement: {
      class: 'https://bsv.brc.dev/apps/0170#conformingApplication',
      connectivity: 'https://bsv.brc.dev/apps/0170#either'
    },
    notBefore: Math.floor(Date.now() / 1000),
    nonce: randomBytes(16)
  })
  const offerId = await objectId('offer', offer.body)
  const wrapped = await publisher.publish(
    protectedAsset,
    [{ mode: 'inline', offer } as unknown as Record<string, LCHValue>],
    true
  )
  current = { name, mediaType, protected: protectedAsset, offer, offerId, lchBytes: wrapped.bytes }
  pendingInspection = undefined
  acquireButton.disabled = false
  placeButton.disabled = true
  manifestButton.disabled = true
  placements = 0
  document.querySelector('#clips')!.replaceChildren()
  document.querySelector('#asset-title')!.textContent = name
  document.querySelector('#asset-copy')!.textContent =
    `${mediaType} · ${bytes.length.toLocaleString()} plaintext bytes · ${wrapped.bytes.length.toLocaleString()} wrapped bytes`
  document.querySelector('#publish-receipt')!.innerHTML = receiptRows([
    ['ASSET', short(toHex(protectedAsset.assetId))],
    ['OFFER', short(toHex(offerId))],
    [
      'SEGMENTS',
      String(
        (protectedAsset.asset.representation as Record<string, LCHValue>).encryption !== undefined
          ? Math.max(1, Math.ceil(bytes.length / (64 * 1024)))
          : 0
      )
    ],
    ['STORAGE', 'verified memory adapter'],
    ['PROFILE', 'fixed-render-v1']
  ])
  document.querySelector('#media-stage')!.innerHTML =
    `<div class="lock">LCH</div><p>Encrypted preview locked behind a portable license.</p>`
  status('Header and offer ready')
}

async function acquire(): Promise<void> {
  if (current === undefined) return
  acquireButton.disabled = true
  if (pendingInspection === undefined) {
    acquireButton.textContent = 'Validating ciphertext…'
    const inspected = await reader.inspect(current.lchBytes)
    await reader.resolve(inspected)
    pendingInspection = inspected
    acquireButton.textContent = 'Confirm 12 satoshis'
    acquireButton.disabled = false
    status('Preflight passed · explicit confirmation required')
    return
  }
  const inspected = pendingInspection
  pendingInspection = undefined
  acquireButton.textContent = 'Confirming demo wallet…'
  const scripts = [randomBytes(25), randomBytes(25)]
  matchFinalizedOutputs(
    [
      { demandId: new Uint8Array(32).fill(1), satoshis: 7n, lockingScript: scripts[0] },
      { demandId: new Uint8Array(32).fill(2), satoshis: 5n, lockingScript: scripts[1] }
    ],
    [
      { satoshis: 5n, lockingScript: scripts[1] },
      { satoshis: 7n, lockingScript: scripts[0] }
    ]
  )
  const recoveredKeys = new Map<string, Uint8Array>()
  const keyGrants: KeyGrant[] = []
  for (const [keyIdHex, cek] of current.protected.keys) {
    const keyId = Uint8Array.from(keyIdHex.match(/../gu) ?? [], pair => Number.parseInt(pair, 16))
    const payload = await creatorKeyDelivery.deliver(toHex(buyerSigner.identityKey), keyId, cek)
    const recovered = await buyerKeyDelivery.recover(payload)
    recoveredKeys.set(toHex(recovered.keyId), recovered.cek)
    keyGrants.push({ keyId, delivery: LCH_MECHANISMS.brc78Key, payload })
  }
  const agreementBytes = new TextEncoder().encode(
    JSON.stringify({
      '@context': ['http://www.w3.org/ns/odrl.jsonld'],
      '@type': 'Agreement',
      uid: 'lch:license:self',
      profile: 'https://bsv.brc.dev/apps/0170#odrl-profile',
      permission: [
        { target: `lch:asset:sha256:${toHex(current.protected.assetId)}`, action: 'play' }
      ]
    })
  )
  const requestBody: Record<string, LCHValue> = {
    version: 1,
    assetId: current.protected.assetId,
    offerId: current.offerId,
    buyer: buyerSigner.identityKey,
    action: 'play',
    selection: { type: 'all' },
    acceptedPolicyDigest: current.offer.body.policy as Record<string, LCHValue>,
    createdAt: Math.floor(Date.now() / 1000)
  }
  const requestId = await objectId('license-request', requestBody)
  const license = await issuer.issueLicense({
    assetId: current.protected.assetId,
    offerId: current.offerId,
    requestId,
    issuer: creatorSigner.identityKey,
    subject: buyerSigner.identityKey,
    issuedAt: Math.floor(Date.now() / 1000),
    agreement: {
      mediaType: 'application/ld+json',
      digest: await sha256(agreementBytes),
      inline: agreementBytes
    },
    selection: { type: 'all' },
    fulfillments: [{ dutyUid: 'urn:lch:duty:demo', receiptIds: [new Uint8Array(32).fill(3)] }],
    keyGrants,
    encryption: (current.protected.asset.representation as Record<string, LCHValue>)
      .encryption as unknown as SegmentedEncryptionDescriptor
  })
  await licenses.put({
    assetId: toHex(current.protected.assetId),
    offerId: toHex(current.offerId),
    license,
    storedAt: BigInt(Math.floor(Date.now() / 1000))
  })
  const plaintext = await reader.decrypt(inspected, recoveredKeys)
  if (playerUrl !== undefined) URL.revokeObjectURL(playerUrl)
  playerUrl = URL.createObjectURL(new Blob([plaintext.slice().buffer], { type: current.mediaType }))
  const element = current.mediaType.startsWith('video/') ? 'video' : 'audio'
  document.querySelector('#media-stage')!.innerHTML =
    `<${element} controls autoplay src="${playerUrl}"></${element}><div class="verified">✓ authenticated segments · signed license</div>`
  acquireButton.textContent = 'Licensed for playback'
  placeButton.disabled = false
  manifestButton.disabled = false
  status(`License ${short(toHex(await objectId('license', license.body)))} stored`)
}

function place(): void {
  placements += 1
  const clip = document.createElement('button')
  clip.className = 'clip'
  clip.textContent = `PLACEMENT ${placements}`
  clip.style.gridColumn = `${placements} / span 2`
  document.querySelector('#clips')!.append(clip)
}

function buildComposition(): void {
  if (current === undefined || placements === 0) {
    status('Place at least one loop first')
    return
  }
  const composer = new LCHComposer(new Uint8Array(32).fill(0xc2))
  for (let index = 0; index < placements; index += 1) {
    composer.addWholePlacement({
      sourceAssetId: current.protected.assetId,
      sourceLicenseId: new Uint8Array(32).fill(0x17),
      c2paIngredient: {
        url: `self#jumbf=/c2pa/demo/c2pa.assertions/c2pa.ingredient.v3/${index}`,
        alg: 'sha256',
        hash: new Uint8Array(32).fill(index + 1)
      },
      relationship: 'componentOf',
      sourceSelection: { type: 'all' },
      metadata: { placementIndex: index }
    })
  }
  document.querySelector('#composition-output')!.textContent = JSON.stringify(
    diagnostic(composer.build()),
    null,
    2
  )
  status(`${placements} independently accountable placement${placements === 1 ? '' : 's'}`)
}

function diagnostic(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: toHex(value) }
  if (typeof value === 'bigint') return { $uint: value.toString() }
  if (Array.isArray(value)) return value.map(diagnostic)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, diagnostic(item)]))
  return value
}

function receiptRows(rows: Array<[string, string]>): string {
  return rows
    .map(([label, value]) => `<div><span>${label}</span><code>${value}</code></div>`)
    .join('')
}

function short(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`
}

function status(message: string): void {
  document.querySelector('.network')!.innerHTML = `<i></i> ${message}`
}
