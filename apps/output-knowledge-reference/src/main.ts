import { AuthFetch, parseOutputCapabilities, parseOutputJSON } from '@bsv/sdk'
import type { AcceptedInput } from '@bsv/output-knowledge'
import type { ReferenceHost } from './referenceClient.js'
type ReferenceClient = Awaited<
  ReturnType<typeof import('./referenceClient.js').createReferenceClient>
>
import { fixtureLabels, referenceEvidence, type FixtureRecord } from './fixtureChain.js'
import './style.css'

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error('Missing reference UI element: ' + id)
  return found as T
}
const status = element('status')
function announce(message: string) {
  status.textContent = message
  const row = document.createElement('li')
  row.textContent = new Date().toLocaleTimeString() + ' · ' + message
  const list = element('activity')
  list.prepend(row)
  while (list.children.length > 8) list.lastElementChild!.remove()
}
async function boundedJSON(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(url, {
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal
    })
    if (!response.ok || !response.body) throw new Error('Reference endpoint unavailable')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.byteLength
        if (length > 262144) throw new Error('Reference response exceeds its limit')
        chunks.push(next.value)
      }
    } finally {
      await reader.cancel()
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return parseOutputJSON(bytes, { bytes: 262144 })
  } finally {
    clearTimeout(timer)
  }
}
// Bootstrap comes from the same loopback application, not arbitrary peer discovery.
const configuration = (await boundedJSON('/demo/config')) as {
  fixture: boolean
  host: ReferenceHost
  peers: ReferenceHost[]
}
if (configuration.fixture !== true || configuration.peers.length > 1)
  throw new Error('Invalid reference bootstrap')
let client: ReferenceClient | undefined
let hosts: ReferenceHost[] = []
let busy = false
let observing: Promise<void> | undefined
let refreshing = false
function render(input: AcceptedInput) {
  element('revision').textContent = 'Accepted revision ' + input.revision.accepted
  const records = element('records')
  records.replaceChildren()
  for (const name of Object.keys(fixtureLabels) as FixtureRecord[]) {
    const txid = referenceEvidence(name).evidence.txid
    const assessments = input.assessments.filter(row => row.outpoint.txid === txid)
    const spent = assessments.some(row => row.state === 'spent')
    const verified = input.facts.some(row => row.txid === txid)
    const present = input.reconciled.memberships.filter(
      row => row.outpoint.txid === txid && row.present
    )
    const card = document.createElement('article')
    card.dataset.record = name
    card.dataset.spent = String(spent)
    card.dataset.verified = String(verified)
    card.dataset.memberships = String(present.length)
    const title = document.createElement('h3')
    title.textContent = fixtureLabels[name]
    const badge = document.createElement('p')
    let state = 'unknown',
      label = 'Not discovered'
    if (spent) {
      state = 'spent'
      label = 'Verified spend'
    } else if (verified) {
      state = 'known'
      label = 'No spend observed'
    }
    badge.className = 'badge ' + state
    badge.textContent = label
    const sources = document.createElement('p')
    sources.textContent = present.length
      ? 'Present at ' +
        present
          .map(
            row => hosts.find(host => host.identity === row.scope.provider)?.id ?? 'retained source'
          )
          .join(', ')
      : 'No current source membership'
    const id = document.createElement('code')
    id.textContent = txid.slice(0, 18) + '…:0'
    card.append(title, badge, sources, id)
    records.append(card)
  }
}
async function connectHost(active: ReferenceClient, host: ReferenceHost, fresh: boolean) {
  if (active.connectedHosts().includes(host.id)) return
  const manifest = fresh
    ? parseOutputCapabilities(await boundedJSON(host.baseURL + '/overlay/v1/capabilities'), true)
    : undefined
  await active.connect(host, manifest)
}
async function connect(fresh: boolean) {
  if (!client) throw new Error('Open a local view first')
  const active = client
  try {
    // Preserve deterministic opening order and stop at the first failed host.
    await hosts.reduce(
      (previous, host) => previous.then(() => connectHost(active, host, fresh)),
      Promise.resolve()
    )
  } finally {
    const connected = client.connectedHosts().length
    element<HTMLButtonElement>('offline').disabled = connected === 0
    element<HTMLButtonElement>('reconnect').disabled = connected === hosts.length
  }
  announce(
    'Connected as ' + element<HTMLSelectElement>('account').value + '. Listening for live changes.'
  )
}
async function start(fresh: boolean) {
  if (client) throw new Error('Reload to open a different local view')
  const workspace = element<HTMLInputElement>('workspace').value
  if (!/^[A-Za-z0-9-]{1,40}$/.test(workspace))
    throw new Error('Workspace must use 1–40 letters, numbers or hyphens')
  const account = element<HTMLSelectElement>('account').value
  if (account !== 'alice' && account !== 'bob') throw new Error('Unknown participant')
  const database = 'output-reference-v1-' + workspace + '-' + account
  hosts = [
    configuration.host,
    ...(element<HTMLInputElement>('federate').checked ? configuration.peers : [])
  ]
  const [{ createReferenceClient }, { IndexedDBJournal }, { IndexedDBOperationStateStore }] =
    await Promise.all([
      import('./referenceClient.js'),
      import('@bsv/output-knowledge'),
      import('@bsv/output-knowledge/operations')
    ])
  client = await createReferenceClient({
    account,
    journal: await IndexedDBJournal.open(database, 'knowledge'),
    controls: (namespace, binding, initial) =>
      initial
        ? IndexedDBOperationStateStore.create(
            database + '-control',
            namespace,
            binding,
            initial.value,
            { limits: initial.limits }
          )
        : IndexedDBOperationStateStore.open(database + '-control', namespace, binding)
  })
  const active = client
  observing = (async () => {
    for await (const event of active.runtime.events()) {
      if (event.kind === 'knowledge') render(event.input)
      else if (event.kind === 'error')
        announce('Source ' + (event.source ?? 'runtime') + ': ' + event.code)
    }
  })()
  void observing.catch(error =>
    announce(error instanceof Error ? error.message : 'Observer stopped')
  )
  render(await active.core.read())
  for (const id of ['start', 'resume', 'account', 'workspace', 'federate'])
    (element(id) as HTMLButtonElement).disabled = true
  document.querySelectorAll<HTMLButtonElement>('[data-command]').forEach(button => {
    button.disabled = false
  })
  if (navigator.storage?.persist) await navigator.storage.persist()
  await connect(fresh)
}
async function action(work: () => Promise<void>) {
  if (busy) return
  busy = true
  try {
    await work()
  } catch (error) {
    announce(error instanceof Error ? error.message : 'Operation failed')
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
element('offline').addEventListener('click', () => {
  void action(async () => {
    await client?.disconnect()
    element<HTMLButtonElement>('offline').disabled = true
    element<HTMLButtonElement>('reconnect').disabled = false
    announce('Offline. Local verified history is retained.')
  })
})
element('reconnect').addEventListener('click', () => {
  void action(() => connect(false))
})
document.querySelectorAll<HTMLButtonElement>('[data-command]').forEach(button => {
  button.addEventListener('click', () => {
    void action(async () => {
      if (!client) throw new Error('Open a view first')
      const response = await new AuthFetch(client.wallet).fetch(location.origin + '/demo/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: button.dataset.command }),
        allowPayments: false,
        requireMutualAuth: true,
        expectedIdentityKey: configuration.host.identity
      })
      if (!response.ok) throw new Error('Producer command was not committed')
      announce('Committed ' + button.dataset.command + ' at host ' + configuration.host.id + '.')
    })
  })
})
setInterval(() => {
  if (!client || refreshing) return
  refreshing = true
  void client
    .refreshContext()
    .catch(error => announce(error instanceof Error ? error.message : 'Context refresh failed'))
    .finally(() => {
      refreshing = false
    })
}, 20000)
