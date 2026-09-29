import { asyncValues } from '../../dist/internal/asyncValues.js'
import { writeFileSync } from 'node:fs'
import {
  BitcoinKnowledge,
  KnowledgeStore,
  MemoryJournal,
  SDKEvidenceVerifier,
  knowledgeMutation
} from '../../dist/index.js'
import { knowledgeLocalFrame } from '../../dist/VerificationLedger.js'
import { candidate, chain, context, partition, resolver } from '../evidence-fixture.ts'

// Run explicitly after a package build. These are historical compatibility
// samples, never fixtures to regenerate automatically to accept a changed result.
const sourceCommit = process.argv[2]
if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(sourceCommit))
  throw new Error('Supply the checked-out full source commit as the only argument')
const now = Date.now()
const scope = {
  chain,
  provider: 'legacy-source',
  service: 'records',
  queryDigest: '11'.repeat(32),
  rulesDigest: '22'.repeat(32),
  access: 'public',
  epoch: 'legacy-epoch'
}
const { epoch: _epoch, ...source } = scope
const cases = []
for await (const version of asyncValues([1, 2])) {
  const rules = version === 1 ? [] : [{ source, maximumAgeSeconds: '600' }]
  const storage = new MemoryJournal(`legacy-v${version}`)
  const worker = new BitcoinKnowledge({
    journalId: storage.namespace,
    partition,
    nonFinal: true,
    sourceCurrentness: rules,
    verifier: new SDKEvidenceVerifier(resolver)
  })
  const store = new KnowledgeStore(storage, worker, { partition, now: () => now })
  const initial = context()
  const first = knowledgeMutation({ kind: 'context', context: initial })
  await storage.append('0', first, knowledgeLocalFrame(true, [], rules))
  const batch = {
    provenance: {
      partition,
      generation: '0',
      adapter: scope.provider,
      scope,
      authentication: 'configured-transport',
      peer: scope.provider,
      receivedAt: String(Math.floor(now / 1000))
    },
    groups: [
      {
        id: 'seed',
        sequence: '0',
        observations: ['A', 'B', 'Q', 'QC'].map(id => ({
          id,
          scope,
          kind: 'output',
          payload: { evidence: candidate(id).evidence }
        }))
      }
    ],
    coverage: { scope, phase: 'finite', status: 'complete' }
  }
  await store.commit('1', knowledgeMutation({ kind: 'receive', batch }))
  await worker.advance(store, new AbortController().signal)
  const before = await store.read()
  await store.commit(
    (await store.revision()).received,
    knowledgeMutation({
      kind: 'context',
      context: { ...initial, id: 'second-legacy-context', generation: '1' }
    })
  )
  await worker.advance(store, new AbortController().signal)
  cases.push({
    version,
    journalId: storage.namespace,
    rules,
    entries: (await store.inspect()).entries,
    before,
    after: await store.read()
  })
  await store.close()
}
const fixture = {
  sourceCommit,
  now,
  partition,
  cases
}
writeFileSync(
  new URL('./local-journals-v1-v2.json', import.meta.url),
  JSON.stringify(fixture, null, 2) + '\n'
)
