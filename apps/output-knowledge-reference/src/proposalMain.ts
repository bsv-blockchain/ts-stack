import {
  canonicalOutputJSON,
  closedOutputObject,
  CompletedProtoWallet,
  OUTPUT_PROFILES,
  OutputProposalTransport,
  parseOutputCapabilities,
  parseOutputJSON,
  PrivateKey,
  Random,
  retainOutputCapability,
  signOutputPacket,
  Utils,
  type OutputJSONObject,
  type OutputSignedProposal
} from '@bsv/sdk'
import { IndexedDBJournal } from '@bsv/output-knowledge'
import {
  IndexedDBOperationStateStore,
  type OperationStateStore
} from '@bsv/output-knowledge/operations'
import {
  AuthorDocumentPolicy,
  ProposalPolicyRegistry,
  type CurrentProposalChannel
} from '@bsv/output-knowledge/proposals'
import { createReferenceProposalClient } from './referenceProposalClient.js'
import { fixtureChain } from './fixtureChain.js'
import './style.css'

type Client = Awaited<ReturnType<typeof createReferenceProposalClient>>
const element = <T extends HTMLElement>(id: string) => {
  const found = document.getElementById(id)
  if (!found) throw new Error('Missing proposal view element: ' + id)
  return found as T
}
const announce = (message: string) => {
  element('status').textContent = message
}
async function boundedJSON(url: string): Promise<unknown> {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'error'
    })
    if (!response.ok || !response.body) throw new Error('Reference endpoint unavailable')
    const reader = response.body.getReader(),
      parts: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.byteLength
        if (length > 262144) throw new Error('Reference response exceeds its bound')
        parts.push(next.value)
      }
    } finally {
      await reader.cancel()
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.length
    }
    return parseOutputJSON(bytes, { bytes: 262144 })
  } finally {
    clearTimeout(timer)
  }
}
const bootstrap = (await boundedJSON('/demo/config')) as {
  fixture: boolean
  host: {
    id: string
    identity: string
    baseURL: string
    service: string
  }
}
if (bootstrap.fixture !== true || new URL(bootstrap.host.baseURL).origin !== location.origin)
  throw new Error('Proposal fixture origin differs')
const host = { ...bootstrap.host },
  clock = () => String(Math.floor(Date.now() / 1000)),
  alice = new PrivateKey(91).toPublicKey().toString(),
  writers = [alice, new PrivateKey(92).toPublicKey().toString()].sort()
let client: Client | undefined,
  outbox: OperationStateStore | undefined,
  authorKey: PrivateKey | undefined,
  busy = false,
  refreshing = false
const policyDescription = new ProposalPolicyRegistry([
    { policy: new AuthorDocumentPolicy(), parameters: { maxTextBytes: 128 } }
  ]).describe()[0],
  policy = { id: policyDescription.id, digest: policyDescription.digest }
function proposalCard(row: CurrentProposalChannel) {
  const card = document.createElement('article')
  card.dataset.proposal = row.proposalId
  card.dataset.status = row.state.status
  card.dataset.expires = row.proposal.body.expiresAt
  const active =
    document.visibilityState === 'visible' &&
    row.activeIntent &&
    BigInt(clock()) < BigInt(row.proposal.body.expiresAt)
  card.dataset.active = String(active)
  const title = document.createElement('h3'),
    badge = document.createElement('p'),
    text = document.createElement('p')
  title.textContent =
    row.proposal.body.author === alice ? 'Alice’s working document' : 'Bob’s working document'
  badge.dataset.intent = 'true'
  badge.textContent = active
    ? 'Active author intent · Provider reports ' + row.state.status
    : 'Intent inactive · Provider reports ' + row.state.status
  const payload = parseOutputJSON(
    Uint8Array.from(Utils.toArray(row.proposal.body.payload, 'base64')),
    { bytes: 1024 }
  )
  closedOutputObject(payload, ['text'])
  text.textContent = typeof payload.text === 'string' ? payload.text : 'Invalid document'
  card.append(title, badge, text)
  return card
}
async function render() {
  if (!client || refreshing) return
  refreshing = true
  try {
    const view = await client.readCurrent(),
      records = element('records')
    records.replaceChildren()
    for (const source of view.sources)
      for (const row of source.channels) {
        records.append(proposalCard(row))
      }
    element('revision').textContent = 'Accepted evaluation ' + view.evaluatedAt
  } catch (error) {
    element('records').replaceChildren()
    announce(error instanceof Error ? error.message : 'Current proposal view unavailable')
  } finally {
    refreshing = false
  }
}
async function connect(fresh: boolean) {
  if (!client) throw new Error('Open a local proposal view first')
  const manifest = fresh
    ? parseOutputCapabilities(await boundedJSON(host.baseURL + '/overlay/v1/capabilities'), true)
    : undefined
  await client.connect(manifest)
  element<HTMLButtonElement>('offline').disabled = false
  element<HTMLButtonElement>('reconnect').disabled = true
  announce('Connected. New private source state appears automatically.')
}
async function start(fresh: boolean) {
  if (client) throw new Error('Reload before choosing another local view')
  const workspace = element<HTMLInputElement>('workspace').value,
    account = element<HTMLSelectElement>('account').value
  if (!/^[A-Za-z0-9-]{1,40}$/.test(workspace))
    throw new Error('Use 1–40 letters, numbers or hyphens')
  if (!['alice', 'bob'].includes(account)) throw new Error('Unknown fixture participant')
  authorKey = new PrivateKey(account === 'alice' ? 91 : 92)
  const database = 'reference-working-documents-' + workspace + '-' + account,
    binding = {
      format: 'reference-proposal-outbox/1',
      author: authorKey.toPublicKey().toString(),
      host
    }
  outbox = fresh
    ? await IndexedDBOperationStateStore.create(
        database + '-commands',
        'outbox',
        binding,
        { pending: null, last: null },
        { limits: { configurationBytes: 4096, stateBytes: 16384 } }
      )
    : await IndexedDBOperationStateStore.open(database + '-commands', 'outbox', binding, {
        limits: { configurationBytes: 4096, stateBytes: 16384 }
      })
  client = await createReferenceProposalClient({
    host,
    identityKey: authorKey,
    journal: await IndexedDBJournal.open(database, 'knowledge'),
    controls: (namespace, configuration, initial) =>
      initial
        ? IndexedDBOperationStateStore.create(
            database + '-control',
            namespace,
            configuration,
            initial.value,
            { limits: initial.limits }
          )
        : IndexedDBOperationStateStore.open(database + '-control', namespace, configuration)
  })
  const active = client
  void (async () => {
    for await (const event of active.runtime.events()) {
      if (event.kind === 'knowledge') await render()
      else if (event.kind === 'error') announce('Source update unavailable: ' + event.code)
    }
  })().catch(error => announce(error instanceof Error ? error.message : 'Observer stopped'))
  for (const id of ['start', 'resume', 'workspace', 'account'])
    (element(id) as HTMLButtonElement).disabled = true
  element<HTMLButtonElement>('publish').disabled = false
  element<HTMLButtonElement>('retry').disabled = false
  await connect(fresh)
  await render()
}
async function writeState(revision: string, value: OutputJSONObject) {
  const result = await outbox!.compareAndSwap(revision, value)
  if (result.status === 'conflict') {
    if (canonicalOutputJSON((await outbox!.read()).value) !== canonicalOutputJSON(value))
      throw new Error('Another tab changed this operation. Resume its saved request.')
  }
}
async function publish() {
  if (!outbox || !authorKey) throw new Error('Open a local view first')
  const saved = await outbox.read()
  if (saved.value.pending !== null)
    throw new Error('Retry the saved proposal before creating another')
  const text = element<HTMLInputElement>('text').value
  if (new TextEncoder().encode(text).length > 128) throw new Error('Use at most 128 UTF-8 bytes')
  const proposal = signOutputPacket<OutputSignedProposal['body']>(
    'proposal',
    {
      version: 1,
      chain: fixtureChain,
      service: host.service,
      policy,
      channel: Utils.toHex(Random(32)),
      revision: '0',
      previous: null,
      author: authorKey.toPublicKey().toString(),
      recipients: writers,
      anchors: [],
      issuedAt: clock(),
      expiresAt: String(BigInt(clock()) + 15n),
      operation: 'update',
      payload: Utils.toBase64(Utils.toArray(canonicalOutputJSON({ text }), 'utf8'))
    },
    authorKey
  )
  const manifest = await boundedJSON(host.baseURL + '/overlay/v1/capabilities'),
    contract = retainOutputCapability(manifest, {
      baseURL: host.baseURL,
      identity: host.identity,
      authenticatedPeer: host.identity,
      chain: fixtureChain,
      kind: 'topic',
      service: host.service,
      profile: OUTPUT_PROFILES.proposal,
      now: clock(),
      maximumAgeSeconds: '100',
      clockSkewSeconds: '2',
      rules: new Map([
        [
          'urn:reference:proposal-records:1',
          (parameters: unknown) => {
            if (canonicalOutputJSON(parameters) !== '{}')
              throw new Error('Unexpected reference rules')
          }
        ]
      ])
    }).record
  const pending = parseOutputJSON(
    canonicalOutputJSON({ contract, request: { version: 1, proposal } })
  )
  await writeState(saved.revision, { ...saved.value, pending })
  await retry()
}
async function retry() {
  if (!outbox || !authorKey) throw new Error('Open a local view first')
  const saved = await outbox.read()
  if (saved.value.pending === null) {
    announce('No saved request is pending.')
    return
  }
  closedOutputObject(saved.value.pending, ['contract', 'request'])
  const request = saved.value.pending.request
  closedOutputObject(request, ['version', 'proposal'])
  const response = await new OutputProposalTransport({
    operation: 'put',
    contract: saved.value.pending.contract,
    request,
    wallet: new CompletedProtoWallet(authorKey),
    now: clock,
    trust: {
      baseURL: host.baseURL,
      identity: host.identity,
      chain: fixtureChain,
      kind: 'topic',
      service: host.service,
      profile: OUTPUT_PROFILES.proposal,
      rules: new Map([
        [
          'urn:reference:proposal-records:1',
          (parameters: unknown) => {
            if (canonicalOutputJSON(parameters) !== '{}')
              throw new Error('Unexpected reference rules')
          }
        ]
      ])
    }
  }).send()
  await writeState(saved.revision, { pending: null, last: response.proposalId })
  announce('The author-signed proposal is recorded. This is working state, not Bitcoin admission.')
}
async function action(work: () => Promise<void>) {
  if (busy) return
  busy = true
  try {
    await work()
  } catch (error) {
    announce(error instanceof Error ? error.message : 'Operation unavailable')
  } finally {
    busy = false
  }
}
element('start').addEventListener('click', () => {
  void action(() => start(true))
})
element('resume').addEventListener('click', () => {
  void action(() => start(false))
})
element('publish').addEventListener('click', () => {
  void action(publish)
})
element('retry').addEventListener('click', () => {
  void action(retry)
})
element('offline').addEventListener('click', () => {
  void action(async () => {
    await client!.disconnect()
    element<HTMLButtonElement>('offline').disabled = true
    element<HTMLButtonElement>('reconnect').disabled = false
    announce('Offline. Original source custody and cursor are retained.')
  })
})
element('reconnect').addEventListener('click', () => {
  void action(() => connect(false))
})
document.addEventListener('visibilitychange', () => {
  for (const card of document.querySelectorAll<HTMLElement>('[data-active]')) {
    card.dataset.active = 'false'
    const label = card.querySelector<HTMLElement>('[data-intent]')
    if (label) label.textContent = 'Awaiting current intent evaluation'
  }
  if (document.visibilityState === 'visible') void render()
})
window.addEventListener('pagehide', () => {
  void client?.close()
  void outbox?.close()
})
// A bounded presentation refresh retires visible intent even when a source is
// disconnected. The core's accepted monotonic clock remains independently authoritative.
setInterval(() => {
  if (document.visibilityState === 'visible') void render()
}, 250)
