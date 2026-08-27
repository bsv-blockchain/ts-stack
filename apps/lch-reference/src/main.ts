import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
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
  type InspectedLCH,
  type KeyGrant,
  type LCHValue,
  type ProtectedAsset,
  type SegmentedEncryptionDescriptor,
  type SignedObject
} from '@bsv/lch'
import {
  EDITORIAL_CASES,
  buildEditorialComposition,
  createToneWav,
  randomBytes,
  runCoreProfileChecks,
  transformToneWav,
  type EditorialPlacement
} from './demo.js'
import './style.css'

interface DemoAsset {
  name: string
  mediaType: string
  plaintext: Uint8Array
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
let currentLicenseId: Uint8Array | undefined
let placements: EditorialPlacement[] = []
let playerUrl: string | undefined
let transformUrl: string | undefined

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="topbar">
    <div><strong>LCH reference workbench</strong><small>Draft BRC-170 · neutral open-source test application</small></div>
    <div class="network"><i></i><span>idle</span></div>
  </header>
  <main>
    <section class="intro">
      <p class="kicker">REFERENCE IMPLEMENTATION</p>
      <h1>Exercise the protocol, not a product.</h1>
      <p>This browser harness publishes, acquires, decrypts, and composes a local test asset. It exposes intermediate identifiers and runs boundary cases for every initial LCH usage profile.</p>
      <div class="safety"><strong>No live commerce.</strong> Opening never spends. The confirmation step constructs and matches simulated outputs but does not broadcast a transaction.</div>
    </section>

    <section id="publish" class="panel split">
      <div>
        <p class="step">1 · PUBLISH</p><h2>Create a protected fixture</h2>
        <p>Use the deterministic PCM loop for repeatable transform tests, or inspect an audio/video file locally.</p>
        <div class="drop"><input id="media-file" type="file" accept="audio/*,video/*" /><label for="media-file">Choose local media<br><span>bytes remain in this browser</span></label></div>
        <button id="tone">Generate PCM test loop</button>
      </div>
      <div class="receipt" id="publish-receipt"><div class="empty">No protected asset</div></div>
    </section>

    <section id="acquire" class="panel split">
      <div class="media-stage" id="media-stage"><div class="placeholder">encrypted media</div></div>
      <div>
        <p class="step">2 · ACQUIRE</p><h2 id="asset-title">Explicit acquisition boundary</h2>
        <p id="asset-copy">Publish a fixture to enable preflight.</p>
        <div class="price"><span>SIMULATED QUOTE</span><strong>12 satoshis</strong><code>7 + 5 · reordered outputs</code></div>
        <button id="acquire-button" disabled>Preflight &amp; quote</button>
        <p class="fine">The second click is the explicit confirmation boundary. BRC-78 delivers every required key period after exact output matching.</p>
      </div>
    </section>

    <section id="profiles" class="panel">
      <div class="section-heading"><div><p class="step">3 · PROFILES</p><h2>Initial profile checks</h2><p>These executable scenarios target interoperability boundaries, not a sample business model.</p></div><button id="run-checks" disabled>Run all edge cases</button></div>
      <div id="profile-grid" class="profile-grid">
        ${Object.entries(LCH_PROFILES)
          .map(
            ([name, iri]) =>
              `<article data-profile="${iri}"><span>pending</span><h3>${profileLabel(name)}</h3><code>${fragment(iri)}</code><ul><li>awaiting licensed fixture</li></ul></article>`
          )
          .join('')}
      </div>
      <pre id="profile-output">No checks have run.</pre>
    </section>

    <section id="compose" class="panel">
      <div class="section-heading"><div><p class="step">4 · COMPOSE</p><h2>Whole-placement edit cases</h2><p>Repeats, reversal, time-warping, and distortion are demonstrated as real edits. Their non-critical timeline metadata does not create new permission or settlement semantics.</p></div></div>
      <div id="edit-controls" class="edit-controls">
        ${EDITORIAL_CASES.map(
          (item, index) =>
            `<button class="secondary" data-edit="${index}" disabled>Add ${item.label}</button>`
        ).join('')}
      </div>
      <div class="timeline"><div class="track-label">derived timeline</div><div id="clips" class="clips"><span>no placements</span></div></div>
      <div class="compose-actions"><button id="preview-edit" class="secondary" disabled>Preview last PCM edit</button><button id="manifest" disabled>Build composition record</button></div>
      <audio id="edit-preview" controls hidden></audio>
      <p class="fine">Each placement binds a distinct C2PA ingredient assertion. The app-specific edit description is immutable evidence but is ignored by the whole-placement obligation resolver.</p>
      <pre id="composition-output">Awaiting a licensed source.</pre>
    </section>
  </main>
  <footer><span>BRC-170 draft · @bsv/lch 0.1.0</span><span>Open reference code · not a storefront or legal determination</span></footer>
`

const fileInput = document.querySelector<HTMLInputElement>('#media-file')!
const toneButton = document.querySelector<HTMLButtonElement>('#tone')!
const acquireButton = document.querySelector<HTMLButtonElement>('#acquire-button')!
const checksButton = document.querySelector<HTMLButtonElement>('#run-checks')!
const manifestButton = document.querySelector<HTMLButtonElement>('#manifest')!
const previewButton = document.querySelector<HTMLButtonElement>('#preview-edit')!
const editButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-edit]')]

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (file !== undefined) {
    void file
      .arrayBuffer()
      .then(buffer =>
        publish(new Uint8Array(buffer), file.type || 'application/octet-stream', file.name)
      )
  }
})
toneButton.addEventListener(
  'click',
  () => void publish(createToneWav(), 'audio/wav', 'lch-reference-loop.wav')
)
acquireButton.addEventListener('click', () => void acquire())
checksButton.addEventListener('click', () => void runChecks())
manifestButton.addEventListener('click', () => void buildComposition())
previewButton.addEventListener('click', previewLastEdit)
editButtons.forEach(button => {
  button.addEventListener('click', () => {
    const index = Number(button.dataset.edit)
    const template = EDITORIAL_CASES[index]
    if (template !== undefined) place(template)
  })
})

async function publish(bytes: Uint8Array, mediaType: string, name: string): Promise<void> {
  status('protecting and signing')
  const protectedAsset = await publisher.protect(bytes, {
    mediaType,
    name,
    rights: [
      {
        interest: 'master',
        holder: { name: 'Reference creator' },
        controller: creatorSigner.identityKey
      },
      {
        interest: 'composition',
        holder: { name: 'Reference composer' },
        controller: creatorSigner.identityKey
      }
    ],
    sink: content,
    segmentSize: 16 * 1024,
    keyPeriodSegments: 1
  })
  const policyBytes = new TextEncoder().encode(
    JSON.stringify({
      '@context': ['http://www.w3.org/ns/odrl.jsonld'],
      '@type': 'Offer',
      uid: 'lch:offer:self',
      profile: 'https://bsv.brc.dev/apps/0170#odrl-profile',
      permission: [
        { target: `lch:asset:sha256:${toHex(protectedAsset.assetId)}`, action: 'play' },
        { target: `lch:asset:sha256:${toHex(protectedAsset.assetId)}`, action: 'derive' }
      ]
    })
  )
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
  current = {
    name,
    mediaType,
    plaintext: bytes,
    protected: protectedAsset,
    offer,
    offerId,
    lchBytes: wrapped.bytes
  }
  pendingInspection = undefined
  currentLicenseId = undefined
  placements = []
  acquireButton.disabled = false
  acquireButton.textContent = 'Preflight & quote'
  checksButton.disabled = true
  editButtons.forEach(button => (button.disabled = true))
  manifestButton.disabled = true
  previewButton.disabled = true
  document.querySelector('#clips')!.innerHTML = '<span>no placements</span>'
  document.querySelector('#composition-output')!.textContent = 'Awaiting a licensed source.'
  document.querySelector('#profile-output')!.textContent = 'No checks have run.'
  resetProfileCards()
  document.querySelector('#asset-title')!.textContent = name
  document.querySelector('#asset-copy')!.textContent =
    `${mediaType} · ${bytes.length.toLocaleString()} plaintext bytes · ${wrapped.bytes.length.toLocaleString()} wrapped bytes`
  document.querySelector('#publish-receipt')!.innerHTML = receiptRows([
    ['ASSET ID', short(toHex(protectedAsset.assetId))],
    ['OFFER ID', short(toHex(offerId))],
    [
      'KEY PERIODS',
      String(
        (
          (protectedAsset.asset.representation as Record<string, LCHValue>)
            .encryption as unknown as SegmentedEncryptionDescriptor
        ).keyPeriods.length
      )
    ],
    ['CONTENT ADAPTER', 'verified in-memory'],
    ['USAGE PROFILE', 'fixed-render-v1']
  ])
  document.querySelector('#media-stage')!.innerHTML =
    '<div class="placeholder">ciphertext verified · plaintext locked</div>'
  status('header and offer ready')
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
    status('preflight passed · explicit confirmation required')
    return
  }
  const inspected = pendingInspection
  pendingInspection = undefined
  acquireButton.textContent = 'Applying simulated payment…'
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
        { target: `lch:asset:sha256:${toHex(current.protected.assetId)}`, action: 'play' },
        { target: `lch:asset:sha256:${toHex(current.protected.assetId)}`, action: 'derive' }
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
    requestNonce: randomBytes(16),
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
    fulfillments: [{ dutyUid: 'urn:lch:duty:reference', receiptIds: [new Uint8Array(32).fill(3)] }],
    keyGrants,
    encryption: (current.protected.asset.representation as Record<string, LCHValue>)
      .encryption as unknown as SegmentedEncryptionDescriptor
  })
  currentLicenseId = await objectId('license', license.body)
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
    `<${element} controls src="${playerUrl}"></${element}><div class="verified">authenticated segments · signed license</div>`
  acquireButton.textContent = 'Licensed fixture ready'
  checksButton.disabled = false
  editButtons.forEach(button => (button.disabled = false))
  status(`license ${short(toHex(currentLicenseId))} stored`)
  await runChecks()
}

async function runChecks(): Promise<void> {
  if (current === undefined || currentLicenseId === undefined) return
  checksButton.disabled = true
  status('running profile edge cases')
  try {
    const checks = await runCoreProfileChecks(current.protected.assetId, currentLicenseId)
    checks.forEach(check => {
      const card = document.querySelector<HTMLElement>(`[data-profile="${check.profile}"]`)!
      card.classList.add('passed')
      card.querySelector('span')!.textContent = 'pass'
      card.querySelector('ul')!.innerHTML = check.observations
        .map(item => `<li>${item}</li>`)
        .join('')
    })
    document.querySelector('#profile-output')!.textContent = JSON.stringify(checks, null, 2)
    status('all six initial profiles passed')
  } catch (error) {
    document.querySelector('#profile-output')!.textContent = String(error)
    status('profile check failed')
  } finally {
    checksButton.disabled = false
  }
}

function place(template: Omit<EditorialPlacement, 'id'>): void {
  const placement: EditorialPlacement = { id: placements.length + 1, ...template }
  placements = [...placements, placement]
  const clips = document.querySelector('#clips')!
  if (placements.length === 1) clips.replaceChildren()
  const clip = document.createElement('button')
  clip.className = `clip ${placement.kind}`
  clip.textContent = `${placement.id}. ${placement.label}`
  clips.append(clip)
  manifestButton.disabled = false
  previewButton.disabled = false
  status(`${placements.length} whole placement${placements.length === 1 ? '' : 's'} staged`)
}

function previewLastEdit(): void {
  const placement = placements.at(-1)
  if (current === undefined || placement === undefined) return
  if (current.mediaType !== 'audio/wav') {
    status('PCM edit preview requires the generated WAV fixture')
    return
  }
  try {
    const transformed = transformToneWav(current.plaintext, placement)
    if (transformUrl !== undefined) URL.revokeObjectURL(transformUrl)
    transformUrl = URL.createObjectURL(
      new Blob([transformed.slice().buffer], { type: 'audio/wav' })
    )
    const audio = document.querySelector<HTMLAudioElement>('#edit-preview')!
    audio.src = transformUrl
    audio.hidden = false
    void audio.play()
    status(`${placement.label} PCM transform rendered locally`)
  } catch (error) {
    status(error instanceof Error ? error.message : 'edit preview failed')
  }
}

async function buildComposition(): Promise<void> {
  if (current === undefined || currentLicenseId === undefined || placements.length === 0) return
  const record = await buildEditorialComposition(
    current.protected.assetId,
    currentLicenseId,
    placements
  )
  document.querySelector('#composition-output')!.textContent = JSON.stringify(
    diagnostic(record),
    null,
    2
  )
  status(`${placements.length} distinct C2PA ingredient bindings built`)
}

function diagnostic(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: toHex(value) }
  if (typeof value === 'bigint') return { $uint: value.toString() }
  if (Array.isArray(value)) return value.map(diagnostic)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, diagnostic(item)]))
  }
  return value
}

function receiptRows(rows: Array<[string, string]>): string {
  return rows
    .map(([label, value]) => `<div><span>${label}</span><code>${value}</code></div>`)
    .join('')
}

function resetProfileCards(): void {
  document.querySelectorAll<HTMLElement>('#profile-grid article').forEach(card => {
    card.classList.remove('passed')
    card.querySelector('span')!.textContent = 'pending'
    card.querySelector('ul')!.innerHTML = '<li>awaiting licensed fixture</li>'
  })
}

function profileLabel(value: string): string {
  return value.replaceAll(/([A-Z])/gu, ' $1').replace(/^./u, character => character.toUpperCase())
}

function fragment(value: string): string {
  return value.slice(value.indexOf('#') + 1)
}

function short(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`
}

function status(message: string): void {
  document.querySelector('.network span')!.textContent = message
}
