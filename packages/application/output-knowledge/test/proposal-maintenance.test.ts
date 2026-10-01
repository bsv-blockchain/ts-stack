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
import { author, scope, registry, signed, finalize } from './proposal-fixture.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
function fixture() {
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
  for (const changed of [
    { durability: 'volatile' as const },
    { getChannelEntry: undefined },
    { getProposalEntry: undefined }
  ])
    expect(() => new ProposalJournalMaintenance(f.decorated(changed))).toThrow()
  await f.put()
  await f.put('22'.repeat(32))
  const page = await f.source.page(1)
  const other = new ProposalJournalMaintenance(f.decorated({ namespace: 'different' }))
  await expect(other.page(1, page.next)).rejects.toMatchObject({ code: 'context-changed' })
  const cursor = JSON.parse(page.next!)
  for (const changed of [
    { ...cursor, after: '3' },
    { ...cursor, through: '3' },
    { ...cursor, through: '0' },
    { ...cursor, extra: true }
  ])
    await expect(f.source.page(1, JSON.stringify(changed))).rejects.toThrow()
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
    await expect(source.page(2)).rejects.toMatchObject({ code: 'unavailable' })
  }
)

it('does not disguise missing channel/proposal indexes and defers a concurrent index change', async () => {
  const f = fixture(),
    plan = await f.put()
  for (const changes of [
    { getChannelEntry: async () => undefined },
    { getProposalEntry: async () => undefined }
  ]) {
    const source = new ProposalJournalMaintenance(f.decorated(changes))
    await expect(source.page(1)).rejects.toMatchObject({ code: 'unavailable' })
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
  await expect(changed.page(1)).rejects.toThrow('channel changed')
  const race = new ProposalJournalMaintenance(
    f.decorated({ getProposalEntry: async () => ({ ...entry, revision: '2' }) })
  )
  expect(await race.page(1)).toEqual({ items: [] })
  expect((await f.source.page(1)).items[0].proposalId).toBe(plan.next.proposalId)
})
