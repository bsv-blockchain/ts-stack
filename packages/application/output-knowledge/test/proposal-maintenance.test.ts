import { afterEach, expect, it, jest } from '@jest/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Utils } from '@bsv/sdk'
import { SQLiteProposalJournal } from '../src/proposals/SQLiteProposalJournal.js'
import { ProposalJournalMaintenance } from '../src/proposals/ProposalMaintenance.js'
import { ProposalTransitions } from '../src/proposals/ProposalTransitions.js'
import { proposalChannelKey } from '../src/proposals/ProposalPolicyRegistry.js'
import type {
  ProposalJournalStorage,
  ProposalJournalEntry
} from '../src/proposals/ProposalJournal.js'
import { author, scope, createRegistry, signed, finalize } from './proposal-fixture.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
function fixture() {
  const registry = createRegistry()
  const directory = mkdtempSync(join(tmpdir(), 'proposal-maintenance-'))
  const lifecycle = new ProposalTransitions(registry, scope, {
    maxLifetimeSeconds: '100',
    futureSkewSeconds: '2'
  })
  const storage = SQLiteProposalJournal.create(
    join(directory, 'journal.sqlite'),
    'maintenance',
    author,
    lifecycle
  )
  cleanup.push(async () => {
    await storage.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const source = new ProposalJournalMaintenance(storage)
  const put = async (channel = '11'.repeat(32)) => {
    const proposal = signed({ channel })
    const plan = lifecycle.put(undefined, proposal, author, '10')
    expect((await storage.commit(plan)).status).toBe('committed')
    return plan
  }
  const decorated = (changes: Partial<ProposalJournalStorage>): ProposalJournalStorage =>
    new Proxy(storage, {
      get(target, key) {
        if (Object.hasOwn(changes, key)) return Reflect.get(changes, key)
        const value: unknown = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  return { storage, source, lifecycle, put, decorated }
}

it('keeps a finite high-water pass while returning only current active or reserved heads', async () => {
  const f = fixture(),
    a = await f.put()
  const update = f.lifecycle.put(
    a.next,
    signed({ channel: a.next.proposal.body.channel, revision: '1', previous: a.next.proposalId }),
    author,
    '11'
  )
  await f.storage.commit(update)
  const b = await f.put('22'.repeat(32))
  await f.storage.commit(f.lifecycle.expire(b.next, '100'))
  const c = await f.put('33'.repeat(32)),
    tx = finalize(c.next.proposal)
  const reserve = f.lifecycle.reserve(
    c.next,
    author,
    {
      version: 1,
      operationId: 'reserved-operation',
      service: scope.service,
      proposalId: c.next.proposalId,
      txid: tx.id('hex'),
      beef: 'AA=='
    },
    Utils.toBase64(tx.toBinary()),
    '99'
  )
  await f.storage.commit(reserve)
  const page = await f.source.page(3)
  expect(page.items).toEqual([
    {
      channelKey: proposalChannelKey(a.next.proposal.body),
      proposalId: update.next.proposalId,
      state: 'active'
    }
  ])
  expect(JSON.parse(page.next!)).toMatchObject({ through: '6', after: '3' })
  const d = await f.put('44'.repeat(32))
  const last = await f.source.page(256, page.next)
  expect(last).toEqual({
    items: [
      {
        channelKey: proposalChannelKey(c.next.proposal.body),
        proposalId: c.next.proposalId,
        state: 'finalizing'
      }
    ]
  })
  const fresh = await f.source.page(256)
  expect(fresh.items.map(item => item.proposalId)).toEqual([
    update.next.proposalId,
    c.next.proposalId,
    d.next.proposalId
  ])
  fresh.items[0].proposalId = 'ff'.repeat(32)
  expect((await f.source.page(256)).items[0].proposalId).toBe(update.next.proposalId)
})

it('returns an empty completed pass for a deliberately empty installed journal', async () => {
  const f = fixture()
  expect(await f.source.page(1)).toEqual({ items: [] })
})

it.each([0, 257, 1.5, NaN, Infinity])(
  'rejects page size %s before storage access',
  async maximum => {
    const f = fixture(),
      head = jest.fn<ProposalJournalStorage['head']>()
    const source = new ProposalJournalMaintenance(f.decorated({ head }))
    await expect(source.page(maximum)).rejects.toThrow('bound')
    expect(head).not.toHaveBeenCalled()
  }
)

it('requires durable indexed storage and validates the cursor namespace/identity binding', async () => {
  const f = fixture()
  expect(() => new ProposalJournalMaintenance(f.decorated({ durability: 'volatile' }))).toThrow(
    expect.objectContaining({
      code: 'invalid',
      message: 'Proposal maintenance requires durable storage'
    })
  )
  for (const changed of [{ getChannelEntry: undefined }, { getProposalEntry: undefined }])
    expect(() => new ProposalJournalMaintenance(f.decorated(changed))).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Proposal maintenance requires indexed retained records'
      })
    )
  await f.put()
  await f.put('22'.repeat(32))
  const page = await f.source.page(1)
  const other = new ProposalJournalMaintenance(f.decorated({ namespace: 'different' }))
  await expect(other.page(1, page.next)).rejects.toMatchObject({
    code: 'context-changed',
    message: 'Proposal maintenance cursor changed storage'
  })
  const cursor = JSON.parse(page.next!)
  for (const changed of [
    { ...cursor, after: '3' },
    { ...cursor, through: '3' },
    { ...cursor, through: '0' }
  ])
    await expect(f.source.page(1, JSON.stringify(changed))).rejects.toMatchObject({
      code: 'context-changed',
      message: 'Proposal maintenance cursor exceeds retained history'
    })
  await expect(f.source.page(1, JSON.stringify({ ...cursor, extra: true }))).rejects.toThrow()
  for (const malformed of ['', 'x'.repeat(16385), '{}', JSON.stringify({ ...cursor, after: 1 })])
    await expect(f.source.page(1, malformed)).rejects.toThrow()
  expect(await f.source.page(1, JSON.stringify({ ...cursor, after: cursor.through }))).toEqual({
    items: []
  })
})

it.each(['empty', 'oversized', 'unordered', 'gap', 'beyond'] as const)(
  'reports %s retained history explicitly',
  async kind => {
    const f = fixture()
    await f.put()
    await f.put('22'.repeat(32))
    const entries = await f.storage.read('0', 2)
    const altered: Record<typeof kind, ProposalJournalEntry[]> = {
      empty: [],
      oversized: [entries[0], entries[0], entries[1]],
      unordered: [{ ...entries[0], revision: '0' }],
      gap: [entries[1]],
      beyond: [{ ...entries[0], revision: '3' }]
    }
    const source = new ProposalJournalMaintenance(f.decorated({ read: async () => altered[kind] }))
    const messages = {
      empty: 'Proposal maintenance history is missing',
      oversized: 'Proposal maintenance history is missing',
      unordered: 'Proposal maintenance history is unordered',
      gap: 'Proposal maintenance history has a gap',
      beyond: 'Proposal maintenance history is missing'
    }
    await expect(source.page(2)).rejects.toMatchObject({
      code: 'unavailable',
      message: messages[kind]
    })
  }
)

it('does not disguise missing channel/proposal indexes and defers a concurrent index change', async () => {
  const f = fixture(),
    plan = await f.put()
  for (const [changes, message] of [
    [{ getChannelEntry: async () => undefined }, 'Proposal maintenance channel is missing'],
    [{ getProposalEntry: async () => undefined }, 'Proposal maintenance proposal is missing']
  ] as const) {
    const source = new ProposalJournalMaintenance(f.decorated(changes))
    await expect(source.page(1)).rejects.toMatchObject({ code: 'unavailable', message })
  }
  const entry = (await f.storage.getChannelEntry(proposalChannelKey(plan.next.proposal.body)))!
  const changed = new ProposalJournalMaintenance(
    f.decorated({
      getChannelEntry: async () => ({
        ...entry,
        transition: {
          ...entry.transition,
          next: { ...entry.transition.next, proposal: signed({ channel: '88'.repeat(32) }) }
        }
      })
    })
  )
  await expect(changed.page(1)).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Proposal maintenance channel changed'
  })
  const race = new ProposalJournalMaintenance(
    f.decorated({ getProposalEntry: async () => ({ ...entry, revision: '2' }) })
  )
  expect(await race.page(1)).toEqual({ items: [] })
  expect((await f.source.page(1)).items[0].proposalId).toBe(plan.next.proposalId)
})

it('checks the cursor type and UTF-8 budget before interpreting its retained history', async () => {
  const f = fixture()
  await f.put()
  await f.put('22'.repeat(32))
  const { next } = await f.source.page(1)
  for (const value of [42, { length: 1 }, new TextEncoder().encode(next!), ' '.repeat(16385)])
    await expect(f.source.page(1, value as never)).rejects.toMatchObject({
      code: 'invalid',
      message: 'Invalid proposal maintenance cursor'
    })
  // JSON whitespace is accepted; exactly the stated byte budget must still work.
  expect((await f.source.page(1, next!.padEnd(16384))).items).toHaveLength(1)
  const oversizedUTF8 = JSON.stringify({ ...JSON.parse(next!), binding: 'é'.repeat(8200) })
  expect(oversizedUTF8.length).toBeLessThan(16384)
  await expect(f.source.page(1, oversizedUTF8)).rejects.toMatchObject({ code: 'limited' })
})

it('rejects a page over its requested bound even when every record is valid and ordered', async () => {
  const f = fixture()
  await f.put()
  await f.put('22'.repeat(32))
  const entries = await f.storage.read('0', 2)
  const source = new ProposalJournalMaintenance(f.decorated({ read: async () => entries }))
  await expect(source.page(1)).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Proposal maintenance history is missing'
  })
})
