import { afterEach, describe, expect, it } from '@jest/globals'
import { readFileSync } from 'node:fs'
import {
  BitcoinKnowledge,
  EvidencePool,
  KnowledgeStore,
  MemoryJournal,
  SDKEvidenceVerifier,
  knowledgeMutation,
  type AcceptedInput,
  type JournalEntry,
  type OutputPartition,
  type SourceCurrentnessRule
} from '../src/index.js'
import {
  VerificationLedger,
  knowledgeLocalFrame,
  parseKnowledgeLocalFrame,
  type KnowledgeLocalVersion
} from '../src/VerificationLedger.js'
import { resolver } from './evidence-fixture.js'

interface LegacySample {
  version: 1 | 2
  journalId: string
  rules: SourceCurrentnessRule[]
  entries: JournalEntry[]
  before: AcceptedInput
  after: AcceptedInput
}
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/local-journals-v1-v2.json', import.meta.url), 'utf8')
) as {
  sourceCommit: string
  now: number
  partition: OutputPartition
  cases: LegacySample[]
}
const stores: KnowledgeStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})
function open(storage: MemoryJournal, rules: SourceCurrentnessRule[] = [], offline = true) {
  const worker = new BitcoinKnowledge({
    journalId: storage.namespace,
    partition: fixture.partition,
    nonFinal: true,
    sourceCurrentness: rules,
    verifier: offline
      ? {
          async verify() {
            throw new Error('Legacy journal replay must remain offline')
          }
        }
      : new SDKEvidenceVerifier(resolver)
  })
  const store = new KnowledgeStore(storage, worker, {
    partition: fixture.partition,
    now: () => fixture.now
  })
  stores.push(store)
  return { store, worker }
}

describe('versioned local replay compatibility', () => {
  it.each(fixture.cases)(
    'reopens retained version $version bytes and appends without changing historical decisions',
    async sample => {
      expect(fixture.sourceCommit).toBe('02a620fdb687f12a48f61c4ca8a0049c655b0588')
      const storage = new MemoryJournal(sample.journalId)
      let received = '0'
      for (const entry of sample.entries) {
        expect(
          await storage.append(received, { key: entry.key, body: entry.body }, entry.local)
        ).toEqual({ status: 'committed', revision: entry.revision })
        received = entry.revision.received
      }
      const { store } = open(storage, sample.rules)
      expect((await store.inspect()).entries).toEqual(sample.entries)
      expect(await store.read(sample.before.revision.accepted)).toEqual(sample.before)
      expect(await store.read()).toEqual(sample.after)
      const ids = sample.before.assessments.map(row => row.id)
      expect(ids.length).toBeGreaterThan(1)
      if (sample.version === 1) expect(ids).not.toEqual([...ids].sort())
      else expect(ids).toEqual([...ids].sort())
      const context = { ...sample.after.context, id: 'continued-preview-context', generation: '2' }
      expect(
        await store.commit(received, knowledgeMutation({ kind: 'context', context }))
      ).toMatchObject({ status: 'committed' })
      expect((await store.inspect()).entries.at(-1)?.local?.version).toBe(sample.version)
      expect(await store.read(sample.before.revision.accepted)).toEqual(sample.before)
      expect(await store.read(sample.after.revision.accepted)).toEqual(sample.after)
    }
  )

  it('uses canonical assessment ID order for a new empty-policy journal and recovers it offline', async () => {
    const sample = fixture.cases[0],
      storage = new MemoryJournal(sample.journalId)
    const { store, worker } = open(storage, [], false)
    await store.commit('0', knowledgeMutation(sample.entries[0].body))
    await store.commit('1', knowledgeMutation(sample.entries[1].body))
    await worker.advance(store, new AbortController().signal)
    const result = await store.read()
    expect(result.assessments).toEqual(
      [...sample.before.assessments].sort((a, b) => a.id.localeCompare(b.id))
    )
    expect(result.facts).toEqual(sample.before.facts)
    expect(result.reconciled).toEqual(sample.before.reconciled)
    const records = (await store.inspect()).entries
    expect(
      records.filter(row => row.local !== undefined).every(row => row.local?.version === 3)
    ).toBe(true)
    expect(records[0].local).toMatchObject({
      profile: 'urn:bsv:output-knowledge:local-verification:3',
      currentnessRules: []
    })
    expect(await open(storage).store.read()).toEqual(result)
  })

  it('rejects version changes without a new namespace and does not partly install a failed frame', () => {
    const pool = new EvidencePool('journal'),
      ledger = new VerificationLedger(true)
    expect(ledger.version).toBeUndefined()
    ledger.apply(knowledgeLocalFrame(true, [], [], 3), pool, new Map())
    expect(ledger.version).toBe(3)
    for (const version of [1, 2] as const)
      expect(() =>
        ledger.apply(knowledgeLocalFrame(true, [], [], version), pool, new Map())
      ).toThrow('new journal namespace')
    const legacy = new VerificationLedger(true)
    legacy.apply(knowledgeLocalFrame(true, []), pool, new Map())
    expect(() => legacy.apply(knowledgeLocalFrame(true, [], [], 3), pool, new Map())).toThrow(
      'new journal namespace'
    )
    expect(legacy.version).toBe(1)
    // Historic empty-rule v2 frames were accepted with the v1 policy.
    legacy.apply(knowledgeLocalFrame(true, [], [], 2), pool, new Map())
    expect(legacy.version).toBe(2)
    const pristine = new VerificationLedger(false)
    expect(() => pristine.apply(knowledgeLocalFrame(true, [], [], 3), pool, new Map())).toThrow(
      'Spend policy'
    )
    expect(pristine.version).toBeUndefined()
    expect(pristine.entries()).toEqual([])
  })

  it('requires exact profile, version and policy fields, retaining the legacy encoder default', () => {
    const rules = fixture.cases[1].rules
    expect(knowledgeLocalFrame(true, []).version).toBe(1)
    expect(knowledgeLocalFrame(true, [], rules).version).toBe(2)
    expect(() => knowledgeLocalFrame(true, [], rules, 1)).toThrow('Version 1')
    expect(() => knowledgeLocalFrame(true, [], [], 4 as KnowledgeLocalVersion)).toThrow('Unknown')
    const modern = knowledgeLocalFrame(true, [], rules, 3)
    expect(parseKnowledgeLocalFrame(modern)).toEqual(modern)
    expect(() => parseKnowledgeLocalFrame({ ...modern, version: 2 })).toThrow('Unknown')
    const { currentnessRules: _rules, ...missing } = modern
    expect(() => parseKnowledgeLocalFrame(missing)).toThrow('configuration')
    expect(() =>
      parseKnowledgeLocalFrame({ ...knowledgeLocalFrame(true, []), currentnessRules: [] })
    ).toThrow('configuration')
  })
})
