import { expect, it } from '@jest/globals'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { canonicalOutputJSON, type OutputProtocolErrorCode } from '@bsv/sdk'
import { SQLiteProtectedLedger } from '../src/private/SQLiteProtectedLedger.js'
import { NodeProtectedPayloadCodec } from '../src/private/NodeProtectedPayloadCodec.js'
import type {
  ProtectedLedgerAddress,
  ProtectedLedgerChange,
  ProtectedLedgerView
} from '../src/private/ProtectedLedgerCodec.js'
import {
  address,
  authorize,
  change,
  clock,
  codec,
  configuration,
  custody,
  fixture
} from './protected-ledger-fixture.js'

function failure(work: () => unknown, code: OutputProtocolErrorCode, message: string): void {
  expect(work).toThrow(expect.objectContaining({ name: 'OutputProtocolError', code, message }))
}

it('accepts a custody codec at the exact head-capacity boundary', () => {
  const f = fixture(configuration, new NodeProtectedPayloadCodec(custody, 'fixture-key', 16384))
  expect(f.ledger.commit('0', [change()], clock, authorize)).toBe('1')
  expect(f.reopen().read([address()], clock, authorize).records[0]?.value).toEqual(change().value)
})

it('reserves the larger of head and record capacity before creating a file', () => {
  const f = fixture()
  const path = join(f.directory, 'large-records.db')
  failure(
    () =>
      SQLiteProtectedLedger.create(
        path,
        { ...configuration, maximumRecordBytes: 16385 },
        new NodeProtectedPayloadCodec(custody, 'fixture-key', 16384)
      ),
    'invalid',
    'Protected custody codec cannot honor ledger reservations'
  )
  expect(existsSync(path)).toBe(false)
})

it.each(['', ':memory:', 'file:private-ledger-invalid'])(
  'rejects the non-explicit file path %j before opening storage',
  path => {
    failure(
      () => SQLiteProtectedLedger.open(path, configuration, codec()),
      'invalid',
      'Protected ledger requires an explicit file'
    )
  }
)

it('commits and reads the inclusive 64-record boundary as one atomic revision', () => {
  const f = fixture({ ...configuration, maximumRecords: 64, maximumReservedBytes: 8192 })
  const changes = Array.from({ length: 64 }, (_, index) => change(index))
  expect(f.ledger.commit('0', changes, clock, authorize)).toBe('1')
  const result = f.reopen().read(
    changes.map(({ kind, key }) => ({ kind, key })),
    clock,
    authorize
  )
  expect(result.records).toHaveLength(64)
  expect(result.records.every(record => record?.revision === '1')).toBe(true)
  expect(result.records.map(record => record?.key)).toEqual(changes.map(record => record.key))
})

it.each([
  [],
  {},
  Array.from({ length: 65 }, (_, index) => ({
    kind: 'publication',
    key: index.toString(16).padStart(64, '0')
  }))
])('classifies invalid read batch shape before authorization: %j', input => {
  const f = fixture()
  let calls = 0
  failure(
    () =>
      f.ledger.read(input as ProtectedLedgerAddress[], clock, () => {
        calls++
      }),
    'invalid',
    'Protected ledger read batch must contain 1–64 addresses'
  )
  expect(calls).toBe(0)
})

it.each(['empty', 'nonarray', 'too many'] as const)(
  'classifies an invalid commit batch (%s) without any effect',
  kind => {
    const f = fixture()
    let input: unknown = []
    if (kind === 'nonarray') input = {}
    if (kind === 'too many') input = Array.from({ length: 65 }, (_, index) => change(index))
    let calls = 0
    failure(
      () =>
        f.ledger.commit('0', input as ProtectedLedgerChange[], clock, () => {
          calls++
        }),
      'invalid',
      'Protected ledger commit must contain 1–64 records'
    )
    expect(calls).toBe(0)
    expect(f.reopen().read([address()], clock, authorize).records).toEqual([undefined])
  }
)

it('rejects duplicate address plans before authorization or partial records', () => {
  const f = fixture()
  let calls = 0
  failure(
    () =>
      f.ledger.commit('0', [change(), change()], clock, () => {
        calls++
      }),
    'invalid',
    'Protected ledger commit repeats an address'
  )
  expect(calls).toBe(0)
  expect(f.ledger.read([address()], clock, authorize).revision).toBe('0')
})

it('accepts exactly reserved UTF-8 payload bytes across native reopen', () => {
  const value = { secret: 'é' },
    bytes = Buffer.byteLength(canonicalOutputJSON(value))
  const f = fixture({ ...configuration, maximumRecords: 1, maximumReservedBytes: bytes })
  f.ledger.commit('0', [change(1, value, bytes)], clock, authorize)
  const owner = f.reopen()
  expect(owner.read([address()], clock, authorize).records[0]).toMatchObject({
    value,
    reservedBytes: bytes
  })
  expect(
    owner.commit(
      '1',
      [{ ...change(1, value, bytes), expectedRevision: '1', reservedUpdates: 3 }],
      clock,
      authorize
    )
  ).toBe('2')
})

it('updates a record at full record capacity without charging another slot', () => {
  const f = fixture({ ...configuration, maximumRecords: 1, maximumReservedBytes: 256 })
  f.ledger.commit('0', [change()], clock, authorize)
  expect(
    f.ledger.commit(
      '1',
      [{ ...change(1, { secret: 'updated' }, 256), expectedRevision: '1' }],
      clock,
      authorize
    )
  ).toBe('2')
  expect(f.reopen().read([address()], clock, authorize).records[0]?.reservedBytes).toBe(256)
})

it('charges only the increase in an existing byte reservation and retains exact capacity', () => {
  const f = fixture({ ...configuration, maximumRecords: 3, maximumReservedBytes: 384 })
  f.ledger.commit('0', [change(1), change(2)], clock, authorize)
  expect(
    f.ledger.commit(
      '1',
      [{ ...change(1, undefined, 256), expectedRevision: '1' }],
      clock,
      authorize
    )
  ).toBe('2')
  failure(
    () => f.ledger.commit('2', [change(3)], clock, authorize),
    'limited',
    'Protected ledger capacity is full'
  )
  expect(
    f
      .reopen()
      .read([address(1), address(2), address(3)], clock, authorize)
      .records.map(record => record?.reservedBytes)
  ).toEqual([256, 128, undefined])
})

it.each(['records', 'bytes'] as const)(
  'classifies exhausted %s capacity as limited and rolls back the whole batch',
  limit => {
    const f = fixture({
      ...configuration,
      maximumRecords: limit === 'records' ? 2 : 3,
      maximumReservedBytes: limit === 'bytes' ? 256 : 512
    })
    failure(
      () => f.ledger.commit('0', [change(1), change(2), change(3)], () => '101', authorize),
      'limited',
      'Protected ledger capacity is full'
    )
    expect(f.reopen().read([address(1), address(2), address(3)], clock, authorize)).toEqual({
      revision: '0',
      observedAt: '101',
      records: [undefined, undefined, undefined]
    })
  }
)

it.each(['exceeds', 'shrinks'] as const)(
  'rejects a reservation that %s the agreed capacity with a limited outcome',
  mode => {
    const f = fixture()
    f.ledger.commit('0', [change()], clock, authorize)
    const next =
      mode === 'exceeds' ? change(1, { secret: 'x'.repeat(120) }) : change(1, undefined, 64)
    failure(
      () => f.ledger.commit('1', [{ ...next, expectedRevision: '1' }], clock, authorize),
      'limited',
      'Protected record reservation cannot be exceeded or silently reduced'
    )
    expect(f.reopen().read([address()], clock, authorize).records[0]?.value).toEqual(change().value)
  }
)

it('preserves promised completion capacity with a limited outcome', () => {
  const f = fixture()
  f.ledger.commit('0', [change()], clock, authorize)
  failure(
    () =>
      f.ledger.commit(
        '1',
        [{ ...change(), expectedRevision: '1', reservedUpdates: 2 }],
        clock,
        authorize
      ),
    'limited',
    'Protected completion reservation cannot be silently discarded'
  )
  expect(f.reopen().read([address()], clock, authorize).records[0]?.reservedUpdates).toBe(4)
})

it.each(['head', 'record', 'disclosure'] as const)(
  'reports a stale %s revision as conflict without committing or disclosing',
  kind => {
    const f = fixture()
    f.ledger.commit('0', [change()], clock, authorize)
    let deliveries = 0
    if (kind === 'head')
      failure(
        () => f.ledger.commit('0', [change(2)], clock, authorize),
        'conflict',
        'Protected ledger changed before commit'
      )
    if (kind === 'record')
      failure(
        () => f.ledger.commit('1', [{ ...change(), expectedRevision: '0' }], clock, authorize),
        'conflict',
        'Protected record changed before commit'
      )
    if (kind === 'disclosure')
      failure(
        () =>
          f.ledger.disclose('0', [address()], clock, authorize, () => {
            deliveries++
          }),
        'conflict',
        'Protected ledger changed before disclosure'
      )
    expect(deliveries).toBe(0)
    expect(f.ledger.read([address(), address(2)], clock, authorize)).toMatchObject({
      revision: '1',
      records: [{ revision: '1' }, undefined]
    })
  }
)

it.each(['clock', 'guard', 'enqueue'] as const)(
  'rejects an async %s before its body can run',
  callback => {
    const f = fixture()
    let invoked = 0
    const invalid = async () => {
      invoked++
      return '100'
    }
    failure(
      () =>
        f.ledger.disclose(
          '0',
          [address()],
          callback === 'clock' ? (invalid as unknown as () => string) : clock,
          callback === 'guard' ? invalid : authorize,
          callback === 'enqueue' ? invalid : () => {}
        ),
      'invalid',
      'Protected ledger callback must be synchronous'
    )
    expect(invoked).toBe(0)
    expect(f.reopen().read([address()], () => '0', authorize).observedAt).toBe('0')
  }
)

it('expires the authorization view even when the guard rejects', () => {
  const f = fixture()
  let retained: ProtectedLedgerView | undefined
  expect(() =>
    f.ledger.read([address()], clock, view => {
      retained = view
      throw new Error('denied')
    })
  ).toThrow('denied')
  failure(
    () => retained!.get(address()),
    'unavailable',
    'Protected ledger authorization view has expired'
  )
})
