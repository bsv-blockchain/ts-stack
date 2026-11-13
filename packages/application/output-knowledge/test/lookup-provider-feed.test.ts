import { expect, it } from '@jest/globals'
import {
  LookupProviderService,
  type LookupProviderFeedOptions,
  type LookupProviderOptions
} from '../src/lookup/LookupProviderService.js'
import type { LookupIndexFeed } from '../src/lookup/LookupIndexFeed.js'
import {
  providerFixture,
  providerBatch,
  providerEntry,
  providerRead
} from './lookup-provider-fixture.js'

it('serves progressive and live results from a feed that does not expose generic mutation or close', async () => {
  const f = await providerFixture('brc103')
  try {
    const index: LookupIndexFeed = Object.freeze({
      durability: f.index.durability,
      namespace: f.index.namespace,
      configuration: f.index.configuration,
      head: f.index.head.bind(f.index),
      group: f.index.group.bind(f.index),
      advanceTime: f.index.advanceTime.bind(f.index),
      snapshot: f.index.snapshot.bind(f.index),
      changes: f.index.changes.bind(f.index)
    })
    const options: LookupProviderFeedOptions = {
      index,
      sessions: f.sessions,
      contracts: f.contracts,
      now: () => f.clock.now,
      authorize: async () => ({
        access: f.caller.principal!,
        guards: [
          { id: 'serving', revision: await f.sessions.guard('serving'), failure: 'unauthorized' }
        ]
      })
    }
    // Existing callers retain their complete storage type and remain assignable.
    const legacy: LookupProviderOptions = { ...options, index: f.index }
    const compatible: LookupProviderFeedOptions = legacy
    expect(compatible.index).toBe(f.index)
    const service = new LookupProviderService(options)
    const initial = providerBatch(await service.open(f.open, f.caller))
    expect(initial.groups).toEqual([])
    expect(initial.snapshotComplete).toBe(true)
    await f.index.commit({ base: '0', evaluatedAt: '1000', edits: [providerEntry(0)], event: {} })
    const live = providerBatch(await service.read(providerRead(initial), f.caller))
    expect(live.groups).toHaveLength(1)
    expect(live.through).toBe('1')
    expect(Object.keys(index)).not.toContain('commit')
    expect(Object.keys(index)).not.toContain('close')
    expect(Object.keys(index)).not.toContain('compact')
    await service.close({ version: 1, session: initial.session }, f.caller)
    expect((await f.index.head()).sequence).toBe('1')
  } finally {
    await f.cleanup()
  }
})
