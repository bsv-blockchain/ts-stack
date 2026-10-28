import { expect, it } from '@jest/globals'
import { assertProposalFeedCapacity } from '../src/proposals/ProposalChannelFeedCapacity.js'
import type {
  ProposalJournalHead,
  ProposalJournalLimits
} from '../src/proposals/ProposalJournal.js'
import type { LookupIndexConfiguration, LookupIndexHead } from '../src/lookup/LookupIndexStorage.js'
function fixture() {
  const journal: ProposalJournalHead = {
    revision: '10',
    entries: 10,
    bytes: 1000,
    channels: 2,
    reserved: { entries: 1, bytes: 100 }
  }
  const index: LookupIndexHead = {
    sequence: '10',
    recordedAt: '10',
    processedThrough: '10',
    retention: { floor: '0', checkedAt: '0' },
    retained: { keys: 2, versions: 10, groups: 10, bytes: 1000, pins: 0 }
  }
  const journalLimits: ProposalJournalLimits = {
    entries: 12,
    bytes: 1200,
    entryBytes: 100,
    channels: 2,
    channelsPerAuthor: 2
  }
  const config: LookupIndexConfiguration = {
    binding: {},
    records: { rowBytes: 100, groupBytes: 300, changes: 1 },
    capacity: { keys: 2, versions: 12, groups: 12, bytes: 1800, pins: 1 }
  }
  const obligations = { active: 1, finalizing: 1 }
  return {
    journal,
    index,
    journalLimits,
    config,
    obligations,
    check: () => assertProposalFeedCapacity(journal, index, obligations, journalLimits, config)
  }
}
it('holds active expiry as well as the existing native terminal receipt reservation at exact capacity', () => {
  const f = fixture()
  expect(f.check).not.toThrow()
  f.journalLimits.bytes--
  expect(f.check).toThrow(expect.objectContaining({ code: 'limited' }))
})
it.each(['entries', 'bytes'] as const)(
  'rejects insufficient future journal %s capacity before effects',
  key => {
    const f = fixture()
    f.journalLimits[key]--
    expect(f.check).toThrow(expect.objectContaining({ code: 'limited' }))
  }
)
it.each(['versions', 'groups', 'bytes'] as const)(
  'rejects insufficient future index %s capacity',
  key => {
    const f = fixture()
    f.config.capacity[key]--
    expect(f.check).toThrow(expect.objectContaining({ code: 'limited' }))
  }
)
it.each(['revision', 'sequence'] as const)('reserves protocol revision space in %s', key => {
  const f = fixture()
  if (key === 'revision') f.journal.revision = '18446744073709551614'
  else f.index.sequence = '18446744073709551614'
  expect(f.check).toThrow(expect.objectContaining({ code: 'limited' }))
})
it('distinguishes inconsistent retained obligations from exhausted capacity', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.obligations.active = -1
    },
    (f: ReturnType<typeof fixture>) => {
      f.obligations.active = 1.1
    },
    (f: ReturnType<typeof fixture>) => {
      f.obligations.finalizing = 3
    },
    (f: ReturnType<typeof fixture>) => {
      f.obligations.active = 2
    },
    (f: ReturnType<typeof fixture>) => {
      f.journal.reserved = undefined
    },
    (f: ReturnType<typeof fixture>) => {
      f.journal.reserved!.entries = 0
    },
    (f: ReturnType<typeof fixture>) => {
      f.journal.reserved!.bytes = 99
    }
  ]) {
    const f = fixture()
    mutate(f)
    expect(f.check).toThrow(expect.objectContaining({ code: 'unavailable' }))
  }
})
it('releases consumed obligations without erasing retained records', () => {
  const f = fixture()
  f.obligations.active = 0
  f.obligations.finalizing = 0
  f.journal.reserved = { entries: 0, bytes: 0 }
  f.journal.entries = 12
  f.journal.bytes = 1200
  f.index.retained.versions = 12
  f.index.retained.groups = 12
  f.index.retained.bytes = 1800
  f.journal.revision = '18446744073709551615'
  f.index.sequence = f.journal.revision
  expect(f.check).not.toThrow()
})

it('accepts the complete channel count and distinguishes malformed counts from inconsistent reservations', () => {
  const exact = fixture()
  exact.obligations.active = 2
  exact.obligations.finalizing = 0
  exact.journal.reserved = { entries: 0, bytes: 0 }
  expect(exact.check).not.toThrow()
  for (const field of ['active', 'finalizing'] as const) {
    for (const count of [-1, 0.5, 3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = fixture()
      f.obligations[field] = count
      expect(f.check).toThrow(
        expect.objectContaining({
          code: 'unavailable',
          message: 'Invalid retained proposal feed obligations'
        })
      )
    }
  }
  const inconsistent = fixture()
  inconsistent.journal.reserved!.bytes--
  expect(inconsistent.check).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Proposal feed obligations differ from journal state'
    })
  )
  const exhausted = fixture()
  exhausted.config.capacity.versions--
  expect(exhausted.check).toThrow(
    expect.objectContaining({
      code: 'limited',
      message: 'Proposal feed cannot reserve its future lifecycle records'
    })
  )
})
