import { readFileSync } from 'node:fs'
import { BitcoinKnowledge, KnowledgeStore, knowledgeMutation } from '../../dist/index.js'
import { SQLiteJournal } from '../../dist/storage/SQLiteJournal.js'
import { SQLiteOperationStateStore } from '../../dist/operations/SQLiteOperationStateStore.js'
import { LiveLookupSource } from '../../dist/sources/LiveLookupSource.js'

// Synthetic client recovery fixture. Exit deliberately without closing SQLite.
const input = JSON.parse(readFileSync(0, 'utf8'))
const { configuration, prepared, packet, selection, path, stage } = input
const trust = { ...selection, rules: new Map([[input.rulesId, () => {}]]) }
const journal = new SQLiteJournal(`${path}/receipts.sqlite`, configuration.journalId)
const worker = new BitcoinKnowledge({
  journalId: journal.namespace,
  partition: configuration.partition,
  nonFinal: false,
  verifier: { verify: () => Promise.reject(new Error('Empty receipt must not verify evidence')) }
})
const core = new KnowledgeStore(journal, worker, { partition: configuration.partition })
const control = SQLiteOperationStateStore.open(
  `${path}/control.sqlite`,
  prepared.namespace,
  prepared.binding,
  prepared.limits
)
const compareAndSwap = control.compareAndSwap.bind(control)
control.compareAndSwap = async (revision, value) => {
  const result = await compareAndSwap(revision, value)
  if ((stage === 'capture' && value.pending !== null) || (stage === 'advance' && value.job === '1'))
    process.exit(42)
  return result
}
const fetch = (_url, init) => {
  if (stage === 'before-http') process.exit(42)
  const request = JSON.parse(init.body)
  return Promise.resolve(
    new Response(
      JSON.stringify(
        request.requestId
          ? packet
          : {
              ...packet,
              phase: 'live',
              cursor: 'cursor-live'
            }
      ),
      { headers: input.headers }
    )
  )
}
const source = new LiveLookupSource({
  configuration,
  control,
  core,
  trust,
  fetch,
  now: () => 1000000
})
const request = await source.connect()
const iterator = source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
const first = await iterator.next()
await core.commit(
  (await core.revision()).received,
  knowledgeMutation({ kind: 'receive', batch: first.value })
)
if (stage === 'receipt') process.exit(42)
await iterator.next()
if (stage === 'live-capture') process.exit(42)
throw new Error('Requested exit stage was not reached')
