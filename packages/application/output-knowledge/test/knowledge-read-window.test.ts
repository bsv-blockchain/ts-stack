import { describe, expect, it } from '@jest/globals'
import { KnowledgeStore } from '../src/KnowledgeStore.js'
import { MemoryJournal } from '../src/storage/MemoryJournal.js'
import { knowledgeMutation } from '../src/storage/Journal.js'
import type { AcceptedInput } from '../src/ports.js'
import { emptyReducer } from './empty-reducer.js'
import { context, partition } from './evidence-fixture.js'

async function fixture(deadline?: (input: AcceptedInput) => string | undefined) {
  let clock = 1000
  const reducer = { ...emptyReducer(), ...(deadline ? { nextInvalidation: deadline } : {}) }
  const journal = new MemoryJournal('test')
  const store = new KnowledgeStore(journal, reducer, { partition, now: () => clock })
  await store.commit('0', knowledgeMutation({ kind: 'context', context: context() }))
  return {
    store,
    reducer,
    journal,
    setClock: (value: number) => {
      clock = value
    }
  }
}

describe('installed read publication window', () => {
  it('withholds current, historical and watch delivery at exclusive expiry, while preserving retained history', async () => {
    const f = await fixture(() => '2')
    try {
      f.setClock(1999)
      expect((await f.store.read()).revision.accepted).toBe('1')
      expect((await f.store.read('1')).revision.accepted).toBe('1')
      f.setClock(2000)
      await expect(f.store.read()).rejects.toMatchObject({ code: 'expired', retryable: true })
      await expect(f.store.read('1')).rejects.toMatchObject({ code: 'expired', retryable: true })
      const watcher = f.store.watch('0')[Symbol.asyncIterator]()
      await expect(watcher.next()).rejects.toMatchObject({ code: 'expired' })
      expect((await f.store.inspect()).entries).toHaveLength(1)
    } finally {
      await f.store.close()
    }
  })

  it('owns hook input and retains the originally installed function', async () => {
    const f = await fixture(input => {
      input.context.id = 'mutated'
      return '2'
    })
    try {
      expect((await f.store.read()).context.id).toBe(context().id)
      f.reducer.nextInvalidation = () => '9999'
      f.setClock(2000)
      await expect(f.store.read()).rejects.toMatchObject({ code: 'expired' })
    } finally {
      await f.store.close()
    }
  })

  it('recovers only after a durable accepted invalidation and preserves old historical expiry', async () => {
    const initial = context().id
    const f = await fixture(input => (input.context.id === initial ? '2' : undefined))
    try {
      f.setClock(2000)
      await expect(f.store.read()).rejects.toMatchObject({ code: 'expired' })
      await f.store.commit(
        '1',
        knowledgeMutation({ kind: 'context', context: { ...context(), id: 'after-expiry' } })
      )
      expect((await f.store.read()).revision.accepted).toBe('2')
      await expect(f.store.read('1')).rejects.toMatchObject({ code: 'expired' })
    } finally {
      await f.store.close()
    }
  })

  it.each([undefined, () => undefined])(
    'preserves default reducer reads when no companion deadline exists',
    async deadline => {
      const f = await fixture(deadline)
      try {
        f.setClock(2000)
        expect((await f.store.read()).context.id).toBe(context().id)
      } finally {
        await f.store.close()
      }
    }
  )

  it.each(['-1', '01', '18446744073709551616'])(
    'rejects malformed installed deadline %s',
    async value => {
      const f = await fixture(() => value)
      try {
        await expect(f.store.read()).rejects.toMatchObject({ code: 'invalid' })
      } finally {
        await f.store.close()
      }
    }
  )

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'fails closed on malformed publication clock %s',
    async value => {
      const f = await fixture(() => '2')
      try {
        f.setClock(value)
        await expect(f.store.read()).rejects.toMatchObject({ code: 'invalid' })
      } finally {
        await f.store.close()
      }
    }
  )

  it('compares the full U64 deadline without narrowing it to a floating-point second count', async () => {
    const f = await fixture(() => '18446744073709551615')
    try {
      f.setClock(Number.MAX_SAFE_INTEGER)
      expect((await f.store.read()).context.id).toBe(context().id)
    } finally {
      await f.store.close()
    }
  })
})
