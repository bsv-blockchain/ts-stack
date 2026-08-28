import type { WalletInterface } from '@bsv/sdk'
import {
  LCH_PROFILES,
  LCH_SETTLEMENT_PROFILES,
  LCHReader,
  toHex,
  type SegmentedEncryptionDescriptor
} from '@bsv/lch'
import {
  EDITORIAL_CASES,
  buildEditorialComposition,
  createToneWav,
  runCoreProfileChecks,
  transformToneWav,
  type EditorialPlacement
} from './demo.js'
import { createFixtureWallet } from './fixtureWallet.js'
import {
  ReferenceLCHClient,
  type ReferenceAcquisitionPlan,
  type ReferenceAcquisitionResult
} from './referenceClient.js'
import { ReferenceLCHServer } from './referenceServer.js'
import './style.css'

interface DemoAsset {
  name: string
  mediaType: string
  plaintext: Uint8Array
  assetId: Uint8Array
  offerId: Uint8Array
  lchBytes: Uint8Array
}

const issuerWallet = createFixtureWallet(11)
const recordingWallet = createFixtureWallet(12)
const compositionWallet = createFixtureWallet(13)
const fixtureBuyerWallet = createFixtureWallet(14)
const referenceOrigin = 'https://lch-reference.invalid'
let buyerWallet: WalletInterface = fixtureBuyerWallet
let server = await createServer(7, 5)
let client = createClient(server, buyerWallet)
let current: DemoAsset | undefined
let pendingPlan: ReferenceAcquisitionPlan | undefined
let currentLicenseId: Uint8Array | undefined
let placements: EditorialPlacement[] = []
let playerUrl: string | undefined
let transformUrl: string | undefined

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="topbar">
    <div><strong>LCH reference workbench</strong><small>Draft BRC-170 · neutral open-source test application</small></div>
    <span class="wallet-mode">BRC-100 fixture wallets</span>
    <div class="network"><i></i><span>fixture wallets ready</span></div>
  </header>
  <main>
    <section class="intro">
      <p class="kicker">REFERENCE IMPLEMENTATION</p>
      <h1>Create, pay for, play, and compose an LCH asset.</h1>
      <p>This open reference workbench follows one asset through the draft BRC-170 roles. Every signed object, payment split, recovered key, profile boundary, and composition binding remains inspectable.</p>
      <div class="safety"><strong>Transaction boundary.</strong> Preflight resolves and verifies the ciphertext, Offer, Quote, and every Payment Demand. Only the separately labelled confirmation asks the selected BRC-100 wallet to create the transaction.</div>
    </section>

    <section class="flow" aria-label="LCH deployment flow">
      <div><b>Creator</b><span>plaintext + rights interests</span></div>
      <div><b>Content host</b><span>verified ciphertext locator</span></div>
      <div><b>Issuer service</b><span>LCH, Offer, Quote, License</span></div>
      <div><b>Buyer wallet</b><span>one BRC-100 action</span></div>
      <div><b>Payee endpoints</b><span>readiness, authorization, Receipt</span></div>
      <div><b>Evidence provider</b><span>signed processor acceptance</span></div>
      <div><b>Delivery provider</b><span>retention + Payee retrieval</span></div>
      <div><b>Player</b><span>BRC-78 keys + authenticated media</span></div>
    </section>

    <section id="publish" class="panel split">
      <div>
        <p class="step">1 · CREATOR WIZARD</p><h2>Publish a protected asset</h2>
        <p>Choose media, declare the two reference rights interests, and set the exact split that becomes signed Payment Demands.</p>
        <div class="fields"><label>Recording controller <input id="recording-price" type="number" min="1" step="1" value="7" /> sat</label><label>Composition controller <input id="composition-price" type="number" min="1" step="1" value="5" /> sat</label></div>
        <label class="storage">Recording settlement profile <select id="recording-settlement"><option value="${LCH_SETTLEMENT_PROFILES.authorizedOutput}" selected>authorized-output-v1 · offline-capable</option><option value="${LCH_SETTLEMENT_PROFILES.receiptComplete}">receipt-complete-v1 · Payee Receipt required</option></select><span>This Payee choice is signed in its Demand; an unknown profile fails before payment.</span></label>
        <label class="storage">Content adapter <select disabled><option>Detached verified reference store</option></select><span>Production examples replace this ContentSink with CHIRP or UHRP.</span></label>
        <div class="drop"><input id="media-file" type="file" accept="audio/*,video/*" /><label for="media-file">Choose local media<br><span>bytes remain in this browser</span></label></div>
        <button id="tone">Generate PCM test loop</button>
      </div>
      <div class="receipt" id="publish-receipt"><div class="empty">No protected asset</div></div>
    </section>

    <section id="acquire" class="panel split">
      <div class="media-stage" id="media-stage"><div class="placeholder">encrypted media</div></div>
      <div>
        <p class="step">2 · PLAYER + WALLET</p><h2 id="asset-title">Verified acquisition</h2>
        <p id="asset-copy">Publish a fixture to enable preflight.</p>
        <div class="price"><span>SIGNED QUOTE</span><strong id="quote-total">12 satoshis</strong><code id="quote-split">7 + 5 · two signed delivery routes · one transaction</code></div>
        <button id="acquire-button" disabled>Preflight &amp; quote</button>
        <label class="offline-case"><input id="offline-recording" type="checkbox" checked /> Take the recording controller offline immediately after its refreshed readiness is signed</label>
        <p class="fine">The composition controller uses receipt-complete-v1. The recording controller opts into authorized-output-v1: its exact BRC-29 destination, evidence provider, and durable Delivery route are signed before payment. Silence alone never releases a License.</p>
        <button id="recover-recording" class="secondary" disabled>Bring recording controller online and recover stored Delivery</button>
        <div id="settlement-receipt" class="receipt settlement"><div class="empty">No wallet transaction or License</div></div>
      </div>
    </section>

    <section id="profiles" class="panel">
      <div class="section-heading"><div><p class="step">3 · PROFILES</p><h2>Initial profile checks</h2><p>These executable scenarios pin interoperability boundaries across the initial profiles.</p></div><button id="run-checks" disabled>Run all edge cases</button></div>
      <div id="profile-grid" class="profile-grid">
        ${Object.entries(LCH_PROFILES)
          .map(
            ([name, iri]) =>
              `<article data-profile="${iri}"><span>pending</span><h3>${profileLabel(name)}</h3><code>${fragment(iri)}</code><ul><li>awaiting licensed fixture</li></ul></article>`
          )
          .join('')}
        <article data-profile="${LCH_SETTLEMENT_PROFILES.authorizedOutput}"><span>pending</span><h3>Authorized output settlement</h3><code>authorized-output-v1</code><ul><li>awaiting acquisition case</li></ul></article>
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
  <footer><span>BRC-170 draft · @bsv/lch 0.1.0</span><span>Open reference code · exact fixtures and conformance cases</span></footer>
`

const fileInput = document.querySelector<HTMLInputElement>('#media-file')!
const toneButton = document.querySelector<HTMLButtonElement>('#tone')!
const acquireButton = document.querySelector<HTMLButtonElement>('#acquire-button')!
const checksButton = document.querySelector<HTMLButtonElement>('#run-checks')!
const manifestButton = document.querySelector<HTMLButtonElement>('#manifest')!
const previewButton = document.querySelector<HTMLButtonElement>('#preview-edit')!
const recoveryButton = document.querySelector<HTMLButtonElement>('#recover-recording')!
const offlineRecording = document.querySelector<HTMLInputElement>('#offline-recording')!
const recordingSettlement = document.querySelector<HTMLSelectElement>('#recording-settlement')!
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
recoveryButton.addEventListener('click', () => void recoverRecordingPayment())
recordingSettlement.addEventListener('change', () => {
  const authorized = recordingSettlement.value === LCH_SETTLEMENT_PROFILES.authorizedOutput
  offlineRecording.disabled = !authorized
  if (!authorized) offlineRecording.checked = false
})
editButtons.forEach(button => {
  button.addEventListener('click', () => {
    const index = Number(button.dataset.edit)
    const template = EDITORIAL_CASES[index]
    if (template !== undefined) place(template)
  })
})

async function publish(bytes: Uint8Array, mediaType: string, name: string): Promise<void> {
  status('protecting and signing')
  const recordingPrice = exactPrice('recording-price')
  const compositionPrice = exactPrice('composition-price')
  const recordingSettlementProfile = recordingSettlement.value
  server = await createServer(recordingPrice, compositionPrice, recordingSettlementProfile)
  client = createClient(server, buyerWallet)
  const published = await server.publish({ bytes, mediaType, name })
  const inspected = await new LCHReader(server.content).inspect(published.lch)
  current = {
    name,
    mediaType,
    plaintext: bytes,
    assetId: published.assetId,
    offerId: published.offerId,
    lchBytes: published.lch
  }
  pendingPlan = undefined
  currentLicenseId = undefined
  placements = []
  acquireButton.disabled = false
  acquireButton.textContent = 'Preflight & quote'
  checksButton.disabled = true
  editButtons.forEach(button => (button.disabled = true))
  manifestButton.disabled = true
  previewButton.disabled = true
  recoveryButton.disabled = true
  document.querySelector('#clips')!.innerHTML = '<span>no placements</span>'
  document.querySelector('#composition-output')!.textContent = 'Awaiting a licensed source.'
  document.querySelector('#settlement-receipt')!.innerHTML =
    '<div class="empty">No wallet transaction or License</div>'
  document.querySelector('#profile-output')!.textContent = 'No checks have run.'
  resetProfileCards()
  document.querySelector('#asset-title')!.textContent = name
  document.querySelector('#asset-copy')!.textContent =
    `${mediaType} · ${bytes.length.toLocaleString()} plaintext bytes · ${published.lch.length.toLocaleString()} detached-header bytes`
  document.querySelector('#quote-total')!.textContent =
    `${recordingPrice + compositionPrice} satoshis`
  document.querySelector('#quote-split')!.textContent =
    `${recordingPrice} + ${compositionPrice} · two signed delivery routes · one transaction`
  document.querySelector('#publish-receipt')!.innerHTML = receiptRows([
    ['ASSET ID', short(toHex(published.assetId))],
    ['OFFER ID', short(toHex(published.offerId))],
    [
      'KEY PERIODS',
      String(
        (inspected.representation.encryption as unknown as SegmentedEncryptionDescriptor).keyPeriods
          .length
      )
    ],
    ['CONTENT ADAPTER', 'detached + digest verified'],
    ['PAYMENT SPLIT', `${recordingPrice} / ${compositionPrice} sat`],
    ['RECORDING SETTLEMENT', fragment(recordingSettlementProfile)],
    ['PAYEE ROUTES', server.payeeEndpoints.map(item => endpointLabel(item.endpoint)).join(' + ')],
    ['USAGE PROFILE', 'fixed-render-v1']
  ])
  document.querySelector('#media-stage')!.innerHTML =
    '<div class="placeholder">ciphertext verified · plaintext locked</div>'
  status('header and offer ready')
}

async function acquire(): Promise<void> {
  if (current === undefined) return
  acquireButton.disabled = true
  try {
    if (pendingPlan === undefined) {
      await prepareAcquisition(current)
      return
    }
    await completeAcquisition(current, pendingPlan)
  } catch (error) {
    renderAcquisitionError(error)
  }
}

async function prepareAcquisition(asset: DemoAsset): Promise<void> {
  acquireButton.textContent = 'Validating Offer, Quote & Demands…'
  pendingPlan = await client.prepare(asset.lchBytes)
  acquireButton.textContent = `Confirm ${pendingPlan.totalSatoshis} satoshis in wallet`
  acquireButton.disabled = false
  const providers = pendingPlan.authorizations.map(
    item =>
      `${endpointLabel(String(item.body.evidenceEndpoint))} + ${endpointLabel(String(item.body.deliveryEndpoint))}`
  )
  document.querySelector('#settlement-receipt')!.innerHTML = receiptRows([
    ['SIGNED READINESS', `${pendingPlan.readiness.length} / ${pendingPlan.demands.length}`],
    [
      'SIGNED DESTINATIONS',
      `${pendingPlan.authorizations.length} authorized-output / ${pendingPlan.demands.length} total`
    ],
    ['FALLBACK PROVIDERS', providers.length === 0 ? 'none selected' : providers.join(', ')],
    ['TRANSACTION', 'not created'],
    ['NEXT STEP', 'explicit wallet confirmation']
  ])
  status('signed readiness passed · no transaction created · confirmation required')
}

async function completeAcquisition(
  asset: DemoAsset,
  plan: ReferenceAcquisitionPlan
): Promise<void> {
  acquireButton.textContent = 'Creating wallet transaction…'
  if (offlineRecording.checked) server.setPayeeOfflineAfterNextReadiness('recording controller')
  const result = await client.acquire(plan)
  pendingPlan = undefined
  currentLicenseId = result.licenseId
  renderLicensedAsset(asset, result)
  await runChecks()
}

function renderLicensedAsset(asset: DemoAsset, result: ReferenceAcquisitionResult): void {
  if (playerUrl !== undefined) URL.revokeObjectURL(playerUrl)
  playerUrl = URL.createObjectURL(
    new Blob([result.plaintext.slice().buffer], { type: asset.mediaType })
  )
  const element = asset.mediaType.startsWith('video/') ? 'video' : 'audio'
  document.querySelector('#media-stage')!.innerHTML =
    `<${element} controls src="${playerUrl}"></${element}><div class="verified">authenticated segments · signed license</div>`
  acquireButton.textContent = 'Licensed asset ready'
  checksButton.disabled = false
  editButtons.forEach(button => (button.disabled = false))
  recoveryButton.disabled = result.authorizedOutputs.length === 0
  const receiptState =
    buyerWallet === fixtureBuyerWallet
      ? `${recordingWallet.receivedSatoshis} sat recording + ${compositionWallet.receivedSatoshis} sat composition`
      : `${result.receipts.length} signed payee receipts`
  document.querySelector('#settlement-receipt')!.innerHTML = receiptRows([
    ['TRANSACTION', short(result.transactionId)],
    ['TRANSACTION EVIDENCE', result.transactionState],
    ['RECORDING WALLET', `${recordingWallet.receivedSatoshis} sat internalized`],
    ['RECORDING ENDPOINT', endpointLabel(server.payeeEndpoints[0]!.endpoint)],
    ['COMPOSITION WALLET', `${compositionWallet.receivedSatoshis} sat internalized`],
    ['COMPOSITION ENDPOINT', endpointLabel(server.payeeEndpoints[1]!.endpoint)],
    ['PAYEE RECEIPTS', String(result.receipts.length)],
    ['AUTHORIZED OUTPUT PROOFS', String(result.authorizedOutputs.length)],
    [
      'DELIVERY AVAILABILITY',
      result.authorizedOutputs.length === 0 ? 'not used' : 'signed through recovery deadline'
    ],
    [
      'LATE PAYEE RECOVERY',
      result.authorizedOutputs.length === 0 ? 'not needed' : 'stored Delivery available'
    ],
    ['LICENSE', short(toHex(result.licenseId))],
    ['RECOVERY', result.recovered ? 'verified' : 'not verified']
  ])
  status(`transaction ${short(result.transactionId)} · ${receiptState} · license recovery verified`)
  const settlementCard = document.querySelector<HTMLElement>(
    `[data-profile="${LCH_SETTLEMENT_PROFILES.authorizedOutput}"]`
  )!
  settlementCard.classList.add('passed')
  settlementCard.querySelector('span')!.textContent = 'pass'
  settlementCard.querySelector('ul')!.innerHTML = result.authorizedOutputs.length
    ? '<li>Payee offline after signed readiness</li><li>exact output independently verified</li><li>accepted transaction + durable Delivery attested</li><li>License issued before late wallet internalization</li>'
    : '<li>online Payee Receipt remains valid</li><li>fallback was not needed</li>'
}

function renderAcquisitionError(error: unknown): void {
  const pending = client.pendingPayment()
  const requiresRecovery = pending !== undefined
  if (!requiresRecovery) pendingPlan = undefined
  acquireButton.textContent = requiresRecovery
    ? 'Retry delivery & License recovery'
    : 'Preflight & quote'
  acquireButton.disabled = false
  if (pending !== undefined)
    document.querySelector('#settlement-receipt')!.innerHTML = receiptRows([
      ['TRANSACTION', short(pending.transactionId)],
      ['TRANSACTION STATE', `${pending.transactionState} · broadcast not established`],
      ['SETTLEMENT', pending.settlementState],
      [
        'SETTLEMENT PROOFS',
        `${pending.receipts + pending.authorizedOutputs} / ${pending.requiredProofs}`
      ],
      ['RECOVERY UNTIL', new Date(Number(pending.recoveryUntil) * 1_000).toISOString()]
    ])
  status(error instanceof Error ? error.message : 'acquisition failed')
}

async function recoverRecordingPayment(): Promise<void> {
  recoveryButton.disabled = true
  try {
    server.setPayeeOnline('recording controller', true)
    const receipts = await server.recoverStoredPayments('recording controller')
    updateReceiptRow('RECORDING WALLET', `${recordingWallet.receivedSatoshis} sat internalized`)
    updateReceiptRow(
      'LATE PAYEE RECOVERY',
      `${receipts.length} Receipt${receipts.length === 1 ? '' : 's'} · internalized once`
    )
    status(
      `${receipts.length} late Receipt${receipts.length === 1 ? '' : 's'} recovered · recording wallet internalized ${recordingWallet.receivedSatoshis} sat`
    )
    recoveryButton.textContent = 'Stored Delivery recovered by recording controller'
  } catch (error) {
    recoveryButton.disabled = false
    status(error instanceof Error ? error.message : 'late Delivery recovery failed')
  }
}

async function runChecks(): Promise<void> {
  if (current === undefined || currentLicenseId === undefined) return
  checksButton.disabled = true
  status('running profile edge cases')
  try {
    const checks = await runCoreProfileChecks(current.assetId, currentLicenseId)
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
  const record = await buildEditorialComposition(current.assetId, currentLicenseId, placements)
  document.querySelector('#composition-output')!.textContent = JSON.stringify(
    diagnostic(record),
    null,
    2
  )
  status(`${placements.length} distinct C2PA ingredient bindings built`)
}

async function createServer(
  recordingSatoshis: number,
  compositionSatoshis: number,
  recordingSettlementProfile: string = LCH_SETTLEMENT_PROFILES.authorizedOutput
): Promise<ReferenceLCHServer> {
  return ReferenceLCHServer.create({
    issuerWallet,
    publicBaseUrl: referenceOrigin,
    payees: [
      {
        wallet: recordingWallet,
        satoshis: recordingSatoshis,
        dutyUid: 'urn:lch:duty:recording',
        interest: 'recording',
        label: 'recording controller',
        settlementProfile: recordingSettlementProfile
      },
      {
        wallet: compositionWallet,
        satoshis: compositionSatoshis,
        dutyUid: 'urn:lch:duty:composition',
        interest: 'composition',
        label: 'composition controller'
      }
    ]
  })
}

function createClient(
  referenceServer: ReferenceLCHServer,
  wallet: WalletInterface
): ReferenceLCHClient {
  return new ReferenceLCHClient(wallet, referenceServer.content, {
    endpointPolicy: {
      allowLocalOrigins: [referenceOrigin],
      connect: async (url, init) => referenceServer.http.handle(new Request(url, init))
    }
  })
}

function exactPrice(id: string): number {
  const value = Number(document.querySelector<HTMLInputElement>(`#${id}`)!.value)
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error('Prices must be positive integers')
  return value
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

function updateReceiptRow(label: string, value: string): void {
  const row = [...document.querySelectorAll<HTMLElement>('#settlement-receipt > div')].find(
    candidate => candidate.querySelector('span')?.textContent === label
  )
  const code = row?.querySelector('code')
  if (code !== null && code !== undefined) code.textContent = value
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

function endpointLabel(value: string): string {
  const url = new URL(value)
  return `${url.host}${url.pathname}`
}

function status(message: string): void {
  document.querySelector('.network span')!.textContent = message
}
