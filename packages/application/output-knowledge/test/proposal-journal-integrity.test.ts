import { afterEach, expect, it, jest } from '@jest/globals'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { OutputProtocolError } from '@bsv/sdk'
import { SQLiteProposalJournal } from '../src/proposals/SQLiteProposalJournal.js'
import { proposalSendFixture } from './proposal-send-fixture.js'
import { author, recipient, signed } from './proposal-fixture.js'

const fixtures: Awaited<ReturnType<typeof proposalSendFixture>>[] = []
async function fixture() {
  const f = await proposalSendFixture()
  fixtures.push(f)
  return f
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(f => f.close()))
})

it('replays installed policy after the native read cursor has finished', async () => {
  const f = await fixture()
  await f.open().commit(f.next)
  const prepare = DatabaseSync.prototype.prepare
  let activeCursors = 0
  const reads: number[] = []
  const database = jest.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
    this: DatabaseSync,
    sql: string
  ) {
    const statement = prepare.call(this, sql)
    if (sql.includes('FROM proposal_journal_entries')) {
      const iterate = statement.iterate
      Object.defineProperty(statement, 'iterate', {
        configurable: true,
        value: (...bindings: unknown[]) => {
          const rows = Reflect.apply(iterate, statement, bindings) as Iterable<
            Record<string, unknown>
          >
          return (function* () {
            activeCursors++
            try {
              yield* rows
            } finally {
              activeCursors--
            }
          })()
        }
      })
    }
    return statement
  })
  const parse = f.lifecycle.parse.bind(f.lifecycle)
  const policy = jest.spyOn(f.lifecycle, 'parse').mockImplementation(input => {
    reads.push(activeCursors)
    return parse(input)
  })
  try {
    expect((await f.store.head()).revision).toBe('2')
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every(count => count === 0)).toBe(true)
    expect(activeCursors).toBe(0)
  } finally {
    policy.mockRestore()
    database.mockRestore()
  }
})

it('replays a complete multi-page prefix and subsequently discovers a later append', async () => {
  const f = await fixture()
  const reader = f.open()
  let previous = f.first.next
  for (let i = 1; i <= 129; i++) {
    const proposal = signed({ revision: i.toString(), previous: previous.proposalId })
    const transition = f.lifecycle.put(previous, proposal, author, '11')
    expect((await f.store.commit(transition)).status).toBe('committed')
    previous = transition.next
  }
  expect(await reader.head()).toMatchObject({ revision: '130', entries: 130 })
  expect(await reader.read('0', 140)).toHaveLength(130)
  const later = signed({ revision: '130', previous: previous.proposalId })
  expect((await f.store.commit(f.lifecycle.put(previous, later, author, '11'))).status).toBe(
    'committed'
  )
  expect(await reader.head()).toMatchObject({ revision: '131', entries: 131 })
})

it('refuses a missing entry table even when its cached prefix has no new revisions', async () => {
  const f = await fixture()
  const database = new DatabaseSync(f.file)
  try {
    database.exec('DROP TABLE proposal_journal_entries')
  } finally {
    database.close()
  }
  await expect(f.store.head()).rejects.toThrow('no such table')
})

it('rejects a harmless nested read during installed-policy replay and releases the read gate', async () => {
  const f = await fixture()
  await f.open().commit(f.next)
  const parse = f.lifecycle.parse.bind(f.lifecycle)
  let armed = true
  let nested: Promise<PromiseSettledResult<unknown>[]> | undefined
  const policy = jest.spyOn(f.lifecycle, 'parse').mockImplementation(input => {
    if (armed) {
      armed = false
      nested = Promise.allSettled([f.store.head()])
    }
    return parse(input)
  })
  try {
    expect((await f.store.head()).revision).toBe('2')
    expect(nested).toBeDefined()
    const result = (await nested!)[0]
    expect(result.status).toBe('rejected')
    if (result.status !== 'rejected') throw new Error('Expected nested read rejection')
    expect(result.reason).toBeInstanceOf(OutputProtocolError)
    expect(result.reason).toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('reentered')
    })
    expect((await f.store.head()).revision).toBe('2')
  } finally {
    policy.mockRestore()
  }
})

it('releases the read transaction after an installed policy refuses replay', async () => {
  const f = await fixture()
  await f.open().commit(f.next)
  const refusal = new Error('Installed replay policy refused')
  const policy = jest.spyOn(f.lifecycle, 'parse').mockImplementationOnce(() => {
    throw refusal
  })
  try {
    await expect(f.store.head()).rejects.toBe(refusal)
    expect((await f.store.head()).revision).toBe('2')
    expect((await f.store.commit(f.next)).status).toBe('replayed')
  } finally {
    policy.mockRestore()
  }
})

async function rejected(result: Promise<unknown>, code: string): Promise<void> {
  const outcome = (await Promise.allSettled([result]))[0]
  expect(outcome.status).toBe('rejected')
  if (outcome.status !== 'rejected') throw new Error('Expected a protocol rejection')
  expect(outcome.reason).toBeInstanceOf(OutputProtocolError)
  expect(outcome.reason).toMatchObject({ code, message: expect.stringMatching(/\S/) })
}

it('keeps a WAL journal and decodes hexadecimal storage positions after revision fifteen', async () => {
  const f = await fixture()
  for (let i = 1; i <= 16; i++) {
    const proposal = signed({ channel: i.toString(16).padStart(64, '0') })
    await f.store.commit(f.lifecycle.put(undefined, proposal, author, '11'))
  }
  expect((await f.store.head()).revision).toBe('17')
  await f.store.close()
  expect((await f.open().head()).revision).toBe('17')
  const database = new DatabaseSync(f.file)
  try {
    expect(database.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
  } finally {
    database.close()
  }
})

it.each(['00000000000000000', 'x0000000000000000', '0000000000000000x', '000000000000000G'])(
  'rejects corrupt persisted revision framing %s',
  async revision => {
    const f = await fixture(),
      database = new DatabaseSync(f.file)
    try {
      database.prepare('UPDATE proposal_journal_meta SET revision=?').run(revision)
    } finally {
      database.close()
    }
    await rejected(f.store.head(), 'unavailable')
  }
)

it.each([
  ["UPDATE proposal_journal_meta SET revision='0000000000000000'", 'unavailable'],
  ['UPDATE proposal_journal_meta SET entries=entries+1', 'unavailable'],
  ['UPDATE proposal_journal_meta SET retained_bytes=retained_bytes+1', 'unavailable'],
  ['UPDATE proposal_journal_meta SET retained_bytes=-1', 'unavailable'],
  ["UPDATE proposal_journal_meta SET configuration='changed'", 'context-changed'],
  [`UPDATE proposal_journal_meta SET service_identity='${recipient}'`, 'context-changed'],
  ["UPDATE proposal_journal_capacity SET limits='{}'", 'context-changed']
])('rejects independently changed metadata before serving: %s', async (sql, code) => {
  const f = await fixture(),
    database = new DatabaseSync(f.file)
  try {
    database.exec(sql)
  } finally {
    database.close()
  }
  await rejected(f.store.head(), code)
  await rejected(
    f.store.enqueueResponse(
      { reference: f.channel, bytes: f.bytes },
      () => true,
      () => undefined
    ),
    code
  )
})

it.each(['length', 'canonical'])(
  'revalidates the complete retained entry on restart (%s)',
  async mode => {
    const f = await fixture()
    await f.store.close()
    const database = new DatabaseSync(f.file)
    try {
      if (mode === 'length')
        database.exec('UPDATE proposal_journal_entries SET entry_bytes=entry_bytes+1')
      else
        database.exec(
          "UPDATE proposal_journal_entries SET transition=' ' || transition, entry_bytes=entry_bytes+1; UPDATE proposal_journal_meta SET retained_bytes=retained_bytes+1"
        )
    } finally {
      database.close()
    }
    await rejected(
      Promise.resolve().then(() => f.open()),
      'unavailable'
    )
  }
)

it('rejects non-durable paths and preserves native file-creation errors', async () => {
  const f = await fixture()
  for (const path of [':memory:', 'file:/unconfigured/proposal.sqlite'])
    await rejected(
      Promise.resolve().then(
        () => new SQLiteProposalJournal(path, 'invalid-path', author, f.lifecycle)
      ),
      'invalid'
    )
  expect(
    () =>
      new SQLiteProposalJournal(
        join(f.directory, 'missing', 'journal.sqlite'),
        'invalid-path',
        author,
        f.lifecycle
      )
  ).toThrow(expect.objectContaining({ code: 'ENOENT' }))
})

it('maps both native lock codes but preserves every other lock-acquisition error exactly', async () => {
  const f = await fixture(),
    original = DatabaseSync.prototype.exec
  const errors: unknown[] = [
    null,
    undefined,
    false,
    0,
    'driver failure',
    Object.assign(new Error('other driver failure'), { errcode: 7 }),
    new Error('driver failure'),
    { errcode: 5 },
    { errcode: 6 }
  ]
  for (const failure of errors) {
    const fault = jest.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql: string
    ) {
      if (sql === 'BEGIN IMMEDIATE') throw failure
      original.call(this, sql)
    })
    let called = false
    try {
      const result = f.store.enqueueResponse(
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
      if (
        failure !== null &&
        typeof failure === 'object' &&
        'errcode' in failure &&
        (failure.errcode === 5 || failure.errcode === 6)
      ) {
        await rejected(result, 'unavailable')
      } else {
        const outcome = (await Promise.allSettled([result]))[0]
        expect(outcome).toEqual({ status: 'rejected', reason: failure })
      }
      expect(called).toBe(false)
    } finally {
      fault.mockRestore()
    }
  }
})

it('owns the input bytes before invoking caller code and emits deliberate protocol errors for malformed callbacks', async () => {
  const f = await fixture(),
    expected = f.bytes.slice()
  let observed: Uint8Array | undefined
  await f.store.enqueueResponse(
    { reference: f.channel, bytes: f.bytes },
    () => {
      f.bytes.fill(0)
      return true
    },
    bytes => {
      observed = bytes
      return undefined
    }
  )
  expect(observed).toEqual(expected)
  for (const callback of [undefined, null, 0, 'callback', {}, []]) {
    await rejected(
      f.store.enqueueResponse(
        { reference: f.channel, bytes: expected },
        callback as never,
        () => undefined
      ),
      'invalid'
    )
    await rejected(
      f.store.enqueueResponse(
        { reference: f.channel, bytes: expected },
        () => true,
        callback as never
      ),
      'invalid'
    )
  }
  await rejected(
    f.store.enqueueResponse(
      { reference: { kind: 'other' } as never, bytes: expected },
      () => true,
      () => undefined
    ),
    'invalid'
  )
  await rejected(
    f.store.enqueueResponse(
      { reference: f.channel, bytes: [] as never },
      () => true,
      () => undefined
    ),
    'invalid'
  )
  await rejected(
    f.store.enqueueResponse(
      { reference: f.channel, bytes: expected },
      () => false,
      () => undefined
    ),
    'unauthorized'
  )
  await rejected(
    f.store.enqueueResponse(
      { reference: f.channel, bytes: expected },
      () => true,
      (() => true) as never
    ),
    'invalid'
  )
  await f.store.close()
  await rejected(f.store.head(), 'unavailable')
})
