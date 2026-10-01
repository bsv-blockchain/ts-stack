import { afterEach, expect, it, jest } from '@jest/globals'
import { DatabaseSync } from 'node:sqlite'
import { canonicalOutputJSON, OutputProtocolError } from '@bsv/sdk'
import type { ProposalJournalResponseReference } from '../src/proposals/ProposalJournalSend.js'
import { proposalSendFixture } from './proposal-send-fixture.js'

const fixtures: Awaited<ReturnType<typeof proposalSendFixture>>[] = []
async function make() {
  const value = await proposalSendFixture()
  fixtures.push(value)
  return value
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(value => value.close()))
})

it('checks an owned exact channel record and response while preserving original bytes and history', async () => {
  const f = await make(),
    before = await f.store.head()
  const queued: number[][] = []
  expect(f.store.responseEnqueue).toBe('proposal-journal-send/1')
  await f.store.enqueueResponse(
    { reference: f.channel, bytes: f.bytes },
    (entry, bytes) => {
      expect(entry?.transition.next).toEqual(f.first.next)
      expect(bytes).toEqual(f.bytes)
      entry!.transition.next.state.recordedAt = '90'
      bytes.fill(0)
      return true
    },
    bytes => {
      queued.push(Array.from(bytes))
      return undefined
    }
  )
  expect(queued).toEqual([Array.from(f.bytes)])
  expect(await f.store.head()).toEqual(before)
  expect((await f.store.getProposalEntry(f.first.next.proposalId))?.transition.next).toEqual(
    f.first.next
  )
})

it('uses the fresh channel head but separately retains a superseded proposal and historical receipt', async () => {
  const f = await make(),
    writer = f.open()
  await writer.commit(f.next)
  let queued = false
  await expect(
    f.store.enqueueResponse(
      { reference: f.channel, bytes: f.bytes },
      entry => {
        if (entry?.transition.next.proposalId !== f.first.next.proposalId)
          throw new OutputProtocolError('reset-required', 'Selected proposal changed')
        return true
      },
      () => {
        queued = true
        return undefined
      }
    )
  ).rejects.toMatchObject({ code: 'reset-required' })
  expect(queued).toBe(false)
  await f.store.enqueueResponse(
    { reference: f.proposal, bytes: f.bytes },
    entry => {
      expect(entry?.transition.next).toEqual(f.first.next)
      return true
    },
    () => {
      queued = true
      return undefined
    }
  )
  expect(queued).toBe(true)
  expect((await f.store.head()).revision).toBe('2')
})

it('does not invalidate a selected record because an unrelated channel changed', async () => {
  const f = await make()
  const { author, signed } = await import('./proposal-fixture.js')
  const other = f.lifecycle.put(undefined, signed({ channel: 'ff'.repeat(32) }), author, '10')
  await f.open().commit(other)
  let queued = false
  await f.store.enqueueResponse(
    { reference: f.channel, bytes: f.bytes },
    entry => {
      expect(entry?.transition.next).toEqual(f.first.next)
      return true
    },
    () => {
      queued = true
      return undefined
    }
  )
  expect(queued).toBe(true)
})

it.each([false, undefined, null, 1, 'true', Promise.resolve(true)])(
  'requires an exact synchronous true from the disclosure check (%s)',
  async result => {
    const f = await make()
    let queued = false
    await expect(
      f.store.enqueueResponse(
        { reference: f.channel, bytes: f.bytes },
        () => result as boolean,
        () => {
          queued = true
          return undefined
        }
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    expect(queued).toBe(false)
    expect((await f.store.head()).revision).toBe('1')
  }
)

it('passes missing and control records explicitly and never infers permission from absence', async () => {
  const f = await make()
  for (const reference of [
    { kind: 'channel' as const, channelKey: 'missing' },
    { kind: 'proposal' as const, proposalId: 'ff'.repeat(32) },
    { kind: 'control' as const }
  ]) {
    let validated = false,
      queued = false
    await expect(
      f.store.enqueueResponse(
        { reference, bytes: new Uint8Array() },
        entry => {
          expect(entry).toBeUndefined()
          validated = true
          return false
        },
        () => {
          queued = true
          return undefined
        }
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    expect(validated).toBe(true)
    expect(queued).toBe(false)
  }
  let queued = false
  await f.store.enqueueResponse(
    { reference: { kind: 'control' }, bytes: new Uint8Array() },
    entry => entry === undefined,
    () => {
      queued = true
      return undefined
    }
  )
  expect(queued).toBe(true)
})

it('serializes actual independent writers through the entire native enqueue', async () => {
  const f = await make(),
    writer = f.open()
  const blocked: Promise<PromiseSettledResult<unknown>[]>[] = []
  const before = await f.store.head()
  await f.store.enqueueResponse(
    { reference: f.channel, bytes: f.bytes },
    entry => {
      expect(entry?.transition.next).toEqual(f.first.next)
      blocked.push(Promise.allSettled([writer.commit(f.next)]))
      return true
    },
    () => {
      blocked.push(Promise.allSettled([writer.commit(f.next)]))
      return undefined
    }
  )
  for (const attempt of blocked)
    expect((await attempt)[0]).toMatchObject({
      status: 'rejected',
      reason: { code: 'ERR_SQLITE_ERROR' }
    })
  expect(await f.store.head()).toEqual(before)
  expect((await writer.commit(f.next)).status).toBe('committed')
  expect((await f.store.getChannelEntry(f.channel.channelKey))?.transition.next).toEqual(
    f.next.next
  )
})

it('rejects reads, mutations, close and nested sends reentered from a callback', async () => {
  const f = await make()
  let reentered!: Promise<PromiseSettledResult<unknown>[]>
  await f.store.enqueueResponse(
    { reference: f.channel, bytes: f.bytes },
    () => {
      reentered = Promise.allSettled([
        f.store.head(),
        f.store.commit(f.next),
        f.store.close(),
        f.store.enqueueResponse(
          { reference: f.channel, bytes: f.bytes },
          () => true,
          () => undefined
        )
      ])
      return true
    },
    () => undefined
  )
  for (const result of await reentered)
    expect(result).toMatchObject({ status: 'rejected', reason: { code: 'unavailable' } })
  expect((await f.store.head()).revision).toBe('1')
  expect((await f.store.commit(f.next)).status).toBe('committed')
})

it('releases the gate after validator or enqueue failures without rewriting the journal', async () => {
  const f = await make(),
    writer = f.open()
  await expect(
    f.store.enqueueResponse(
      { reference: f.channel, bytes: f.bytes },
      () => {
        throw new Error('access provider failed')
      },
      () => undefined
    )
  ).rejects.toThrow('access provider failed')
  await expect(
    f.store.enqueueResponse(
      { reference: f.channel, bytes: f.bytes },
      () => true,
      () => {
        throw new Error('native enqueue failed')
      }
    )
  ).rejects.toThrow('native enqueue failed')
  await expect(
    f.store.enqueueResponse(
      { reference: f.channel, bytes: f.bytes },
      () => true,
      () => true as never
    )
  ).rejects.toThrow('must be synchronous')
  expect((await writer.commit(f.next)).status).toBe('committed')
})

it('rejects async callbacks before either callback can start', async () => {
  const f = await make()
  let called = false
  const asyncCheck = async () => {
    called = true
    return true
  }
  const asyncSend = async () => {
    called = true
  }
  await expect(
    f.store.enqueueResponse(
      { reference: f.channel, bytes: f.bytes },
      asyncCheck as never,
      () => undefined
    )
  ).rejects.toThrow('synchronous')
  await expect(
    f.store.enqueueResponse(
      { reference: f.channel, bytes: f.bytes },
      () => true,
      asyncSend as never
    )
  ).rejects.toThrow('synchronous')
  expect(called).toBe(false)
})

it('bounds and closes the candidate/reference before acquiring the gate', async () => {
  const f = await make()
  const invalid: unknown[] = [
    { kind: 'channel' },
    { kind: 'proposal', proposalId: 'short' },
    { kind: 'other' },
    { kind: 'control', proposalId: f.first.next.proposalId },
    { kind: 'proposal', proposalId: f.first.next.proposalId, channelKey: f.channel.channelKey },
    { kind: 'channel', channelKey: '' },
    { kind: 'control', ignored: true }
  ]
  for (const reference of invalid)
    await expect(
      f.store.enqueueResponse(
        { reference: reference as ProposalJournalResponseReference, bytes: f.bytes },
        () => true,
        () => undefined
      )
    ).rejects.toThrow()
  for (const bytes of [[], new Uint8Array(4194305)])
    await expect(
      f.store.enqueueResponse(
        { reference: f.channel, bytes: bytes as Uint8Array },
        () => true,
        () => undefined
      )
    ).rejects.toThrow('capacity')
  await expect(
    f.store.enqueueResponse(
      Object.assign({ reference: f.channel, bytes: f.bytes }, { ignored: true }),
      () => true,
      () => undefined
    )
  ).rejects.toThrow()
  let size = 0
  await f.store.enqueueResponse(
    { reference: f.channel, bytes: new Uint8Array(4194304) },
    () => true,
    bytes => {
      size = bytes.length
      return undefined
    }
  )
  expect(size).toBe(4194304)
  await f.store.close()
  await expect(
    f.store.enqueueResponse(
      { reference: f.channel, bytes: f.bytes },
      () => true,
      () => undefined
    )
  ).rejects.toThrow('closed')
})

it('reports a busy independent database without calling validation or enqueue', async () => {
  const f = await make(),
    other = new DatabaseSync(f.file)
  other.exec('BEGIN IMMEDIATE')
  let called = false
  try {
    await expect(
      f.store.enqueueResponse(
        { reference: f.channel, bytes: f.bytes },
        () => {
          called = true
          return true
        },
        () => {
          called = true
          return undefined
        }
      )
    ).rejects.toMatchObject({ code: 'unavailable', retryable: true })
    expect(called).toBe(false)
  } finally {
    other.exec('ROLLBACK')
    other.close()
  }
  await f.store.enqueueResponse(
    { reference: f.channel, bytes: f.bytes },
    () => true,
    () => undefined
  )
})

it('checks refreshed local context together with the selected committed record after reopening', async () => {
  const f = await make()
  const expired = f.lifecycle.expire(f.first.next, '100')
  const local = { note: 'original-selected-contract' }
  await f.store.commit(expired, local)
  await f.store.close()
  const reopened = f.open()
  await reopened.enqueueResponse(
    { reference: f.proposal, bytes: f.bytes },
    entry => {
      expect(entry?.local).toEqual(local)
      expect(entry?.transition.next.state.status).toBe('expired')
      expect(canonicalOutputJSON(entry?.transition.next)).toBe(canonicalOutputJSON(expired.next))
      return true
    },
    () => undefined
  )
})

it('retires a connection after uncertain completion without repeating an already queued response', async () => {
  const f = await make()
  const original = DatabaseSync.prototype.exec
  let armed = true,
    queued = 0
  const fault = jest.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
    this: DatabaseSync,
    sql: string
  ) {
    original.call(this, sql)
    if (armed && sql === 'COMMIT') {
      armed = false
      throw new Error('commit acknowledgement lost')
    }
  })
  try {
    await expect(
      f.store.enqueueResponse(
        { reference: f.channel, bytes: f.bytes },
        () => true,
        () => {
          queued += 1
          return undefined
        }
      )
    ).rejects.toThrow('commit acknowledgement lost')
  } finally {
    fault.mockRestore()
  }
  expect(queued).toBe(1)
  await expect(f.store.head()).rejects.toThrow('closed')
  expect((await f.open().getChannelEntry(f.channel.channelKey))?.transition.next).toEqual(
    f.first.next
  )
})

it('preserves an unexpected lock-acquisition error without running callbacks', async () => {
  const f = await make()
  const original = DatabaseSync.prototype.exec
  let called = false
  const fault = jest.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
    this: DatabaseSync,
    sql: string
  ) {
    if (sql === 'BEGIN IMMEDIATE') throw new Error('driver unavailable')
    original.call(this, sql)
  })
  try {
    await expect(
      f.store.enqueueResponse(
        { reference: f.channel, bytes: f.bytes },
        () => {
          called = true
          return true
        },
        () => {
          called = true
          return undefined
        }
      )
    ).rejects.toThrow('driver unavailable')
  } finally {
    fault.mockRestore()
  }
  expect(called).toBe(false)
  expect((await f.store.head()).revision).toBe('1')
})
