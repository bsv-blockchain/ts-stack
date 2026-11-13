import { DirectDeliverySource } from '../src/sources/index.js'
import { describe, expect, it } from '@jest/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  BitcoinKnowledge,
  KnowledgeStore,
  MemoryJournal,
  OutputKnowledge,
  SDKEvidenceVerifier,
  runtimeLimits,
  type JournalStorage,
  type SourceRequest
} from '../src/index.js'
import { SQLiteJournal } from '../src/storage/SQLiteJournal.js'
import { candidate, chain, context, partition, resolver } from './evidence-fixture.js'

const scope = {
  chain,
  provider: 'configured-peer',
  service: 'messages',
  queryDigest: '03'.repeat(32),
  rulesDigest: '04'.repeat(32),
  access: 'participants',
  epoch: 'membership-1'
}
const request = (): SourceRequest => ({
  partition,
  generation: '0',
  scope,
  limits: runtimeLimits()
})
const delivery = (id = 'one') => ({
  id,
  observations: [
    { id, scope, kind: 'output' as const, payload: { evidence: candidate('Q').evidence } }
  ]
})
const abort = () => new AbortController()
function runtimeFor(journal: JournalStorage) {
  const worker = new BitcoinKnowledge({
      journalId: journal.namespace,
      partition,
      nonFinal: false,
      verifier: new SDKEvidenceVerifier(resolver)
    }),
    store = new KnowledgeStore(journal, worker, { partition })
  return { store, runtime: new OutputKnowledge({ store, worker }) }
}

describe('direct delivery source receipt acknowledgement', () => {
  it('requires durable storage unless volatile receipt policy is explicitly selected', async () => {
    const { runtime } = runtimeFor(new MemoryJournal('volatile')),
      source = new DirectDeliverySource({ id: 'direct', scope })
    try {
      expect(() => runtime.attach(source, request())).toThrow('durable')
      await expect(source.deliver(delivery())).rejects.toMatchObject({ code: 'unavailable' })
    } finally {
      await runtime.close()
    }
  })

  it('acknowledges only after the durable append, retaining receipt on reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'direct-receipt-')),
      file = join(dir, 'receipts.sqlite'),
      journal = new SQLiteJournal(file, 'direct'),
      originalAppend = journal.append.bind(journal)
    let release!: () => void, entered!: () => void
    const pending = new Promise<void>(resolve => {
        release = resolve
      }),
      started = new Promise<void>(resolve => {
        entered = resolve
      })
    journal.append = async (revision, mutation, local) => {
      if (mutation.body.kind === 'receive') {
        entered()
        await pending
      }
      return originalAppend(revision, mutation, local)
    }
    const { store, runtime } = runtimeFor(journal),
      source = new DirectDeliverySource({ id: 'direct', scope })
    let acknowledged = false
    try {
      await runtime.setContext(context())
      const subscription = runtime.attach(source, request()),
        accepted = source.deliver(delivery()).then(() => {
          acknowledged = true
        })
      await started
      expect(acknowledged).toBe(false)
      expect((await store.revision()).received).toBe('1')
      release()
      await accepted
      expect((await store.inspect()).entries.some(row => row.body.kind === 'receive')).toBe(true)
      source.close()
      await subscription.done
      await runtime.flush()
      await runtime.close()
      const recovered = new SQLiteJournal(file, 'direct')
      try {
        const records = await recovered.read('0', 4096)
        expect(
          records.some(row => row.body.kind === 'receive' && row.body.batch.groups[0].id === 'one')
        ).toBe(true)
      } finally {
        await recovered.close()
      }
    } finally {
      release()
      await runtime.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never acknowledges a failed receipt commit', async () => {
    const journal = new MemoryJournal('failure'),
      append = journal.append.bind(journal)
    journal.append = async (revision, mutation, local) => {
      if (mutation.body.kind === 'receive') throw new Error('Storage unavailable')
      return append(revision, mutation, local)
    }
    const { runtime } = runtimeFor(journal),
      source = new DirectDeliverySource({ id: 'direct', scope, allowVolatileReceipts: true })
    try {
      await runtime.setContext(context())
      const subscription = runtime.attach(source, request()),
        result = source.deliver(delivery())
      await expect(result).rejects.toMatchObject({ code: 'cancelled' })
      await expect(subscription.done).rejects.toThrow('Storage unavailable')
    } finally {
      await runtime.close()
    }
  })

  it('fails the whole bounded bridge on overflow without advancing an acknowledgement', async () => {
    const source = new DirectDeliverySource({ id: 'direct', scope, maximumQueuedDeliveries: 1 }),
      iterator = source.open(request(), abort().signal)[Symbol.asyncIterator](),
      first = source.deliver(delivery('first'))
    await expect(source.deliver(delivery('second'))).rejects.toMatchObject({ code: 'limited' })
    await expect(first).rejects.toMatchObject({ code: 'limited' })
    await expect(iterator.next()).rejects.toMatchObject({ code: 'limited' })
  })

  it('owns observation bytes and rejects a changed scope before enqueueing', async () => {
    const source = new DirectDeliverySource({ id: 'direct', scope }),
      controller = abort(),
      iterator = source.open(request(), controller.signal)[Symbol.asyncIterator](),
      input = delivery(),
      result = source.deliver(input)
    input.observations[0].payload.evidence.beef = 'AA=='
    const value = (await iterator.next()).value
    expect(value.groups[0].observations[0].payload.evidence.beef).not.toBe('AA==')
    const invalid = delivery('foreign')
    invalid.observations[0].scope = { ...scope, provider: 'another-peer' }
    await expect(source.deliver(invalid)).rejects.toMatchObject({ code: 'invalid' })
    await iterator.return!()
    await expect(result).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('acknowledges a consumed receipt and cancels pending reads without claiming completeness', async () => {
    const source = new DirectDeliverySource({ id: 'direct', scope }),
      controller = abort(),
      iterator = source.open(request(), controller.signal)[Symbol.asyncIterator](),
      next = iterator.next(),
      result = source.deliver(delivery())
    expect((await next).value.coverage.status).toBe('partial')
    const waiting = iterator.next()
    await result
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' })
  })
})
