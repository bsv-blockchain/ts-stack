import { describe, expect, it, jest } from '@jest/globals'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import {
  BitcoinKnowledge,
  IndexedDBJournal,
  KnowledgeStore,
  SDKEvidenceVerifier,
  knowledgeMutation,
  type SourceBatch
} from '../src/index.js'
import { IndexedDBOperationStateStore } from '../src/operations/IndexedDBOperationStateStore.js'
import { LiveLookupSource } from '../src/sources/LiveLookupSource.js'
import { liveLookupSourceBinding } from '../src/sources/LiveLookupConfiguration.js'
import { context, partition, resolver } from './evidence-fixture.js'
import { liveFixture } from './live-lookup-fixture.js'

describe('live lookup with the IndexedDB ports', () => {
  it('reopens control and receipt databases independently and advances only after receipt', async () => {
    const fixture = liveFixture()
    const factory = new IDBFactory()
    const fetch = jest.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
      const request = JSON.parse(String(init?.body))
      return Promise.resolve(
        fixture.response(
          request.requestId
            ? fixture.packet
            : {
                ...fixture.packet,
                phase: 'live',
                cursor: 'live'
              }
        )
      )
    })
    const open = async (create: boolean) => {
      const worker = new BitcoinKnowledge({
        journalId: fixture.config.journalId,
        partition,
        nonFinal: false,
        verifier: new SDKEvidenceVerifier(resolver)
      })
      const journal = await IndexedDBJournal.open('receipts', fixture.config.journalId, {
        factory,
        keyRange: IDBKeyRange
      })
      const core = new KnowledgeStore(journal, worker, { partition })
      if (create) await core.commit('0', knowledgeMutation({ kind: 'context', context: context() }))
      const control = create
        ? await IndexedDBOperationStateStore.create(
            'control',
            fixture.prepared.namespace,
            fixture.prepared.binding,
            fixture.prepared.initial,
            { factory }
          )
        : await IndexedDBOperationStateStore.open(
            'control',
            fixture.prepared.namespace,
            liveLookupSourceBinding(fixture.config),
            { factory }
          )
      const source = new LiveLookupSource({
        configuration: fixture.config,
        core,
        control,
        trust: fixture.selection,
        fetch,
        now: () => 1000000
      })
      return { core, control, source }
    }
    let stores = await open(true)
    try {
      await stores.source.connect()
      const captured = await stores.control.read()
      await stores.core.close()
      await stores.control.close()
      stores = await open(false)
      const request = await stores.source.connect()
      expect(fetch).toHaveBeenCalledTimes(1)
      const iterator = stores.source
        .open(request, new AbortController().signal)
        [Symbol.asyncIterator]()
      try {
        const snapshot = (await iterator.next()).value as SourceBatch
        expect(snapshot).toEqual(captured.value.pending)
        expect((await stores.core.revision()).received).toBe('1')
        await stores.core.commit('1', knowledgeMutation({ kind: 'receive', batch: snapshot }))
        const live = (await iterator.next()).value as SourceBatch
        expect(live.coverage.phase).toBe('live')
        expect(live.checkpoint?.cursor).toBe('live')
        expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toHaveProperty(
          'cursor',
          'cursor-1'
        )
        expect((await stores.control.read()).value.previousReceipt).toEqual({
          key: knowledgeMutation({ kind: 'receive', batch: snapshot }).key,
          received: '2'
        })
      } finally {
        await iterator.return!()
      }
    } finally {
      await stores.core.close()
      await stores.control.close()
    }
  })
})
