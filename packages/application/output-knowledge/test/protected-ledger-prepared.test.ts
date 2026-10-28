import { expect, it, jest } from '@jest/globals'
import type { ProtectedLedgerView } from '../src/private/ProtectedLedgerCodec.js'
import {
  fixture,
  configuration,
  clock,
  authorize,
  address,
  change
} from './protected-ledger-fixture.js'

it('derives an owned plan from the native observation and expires its view after the callback', () => {
  const f = fixture(),
    input = change()
  let escaped: ProtectedLedgerView | undefined,
    checks = 0
  expect(
    f.ledger.commitPrepared(
      '0',
      view => {
        escaped = view
        expect(view.get(address())).toBeUndefined()
        input.value.secret = view.observedAt
        return [input]
      },
      () => '120',
      () => {
        if (++checks === 2) input.value.secret = 'after-ownership'
      }
    )
  ).toBe('1')
  input.value.secret = 'caller-mutation'
  expect(checks).toBe(2)
  expect(() => escaped!.get(address())).toThrow('expired')
  expect(f.reopen().read([address()], clock, authorize)).toMatchObject({
    revision: '1',
    observedAt: '120',
    records: [{ value: { secret: '120' } }]
  })
})

it('rechecks authority after derivation and rolls back while retaining monotonic time', () => {
  const f = fixture(),
    prepare = jest.fn(() => [change()])
  expect(() =>
    f.ledger.commitPrepared(
      '0',
      prepare,
      () => '120',
      () => {
        if (prepare.mock.calls.length) throw new Error('Authority changed')
      }
    )
  ).toThrow('Authority changed')
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(f.reopen().read([address()], () => '99', authorize)).toEqual({
    revision: '0',
    observedAt: '120',
    records: [undefined]
  })
  expect(() =>
    f.ledger.commitPrepared(
      '0',
      () => {
        throw new Error('Preparation failed')
      },
      () => '130',
      authorize
    )
  ).toThrow('Preparation failed')
  expect(f.ledger.read([address()], clock, authorize).observedAt).toBe('130')
})

it('refuses stale heads before invoking preparation and preserves record CAS and atomic capacity', () => {
  const f = fixture({ ...configuration, maximumRecords: 2, maximumReservedBytes: 256 })
  f.ledger.commitPrepared('0', () => [change()], clock, authorize)
  const prepare = jest.fn(() => [change(2)])
  expect(() => f.ledger.commitPrepared('0', prepare, () => '110', authorize)).toThrow(
    'changed before commit'
  )
  expect(prepare).not.toHaveBeenCalled()
  expect(() =>
    f.ledger.commitPrepared(
      '1',
      () => [change(2), { ...change(), expectedRevision: '9' }],
      () => '120',
      authorize
    )
  ).toThrow('record changed')
  expect(() =>
    f.ledger.commitPrepared(
      '1',
      () => [change(2), change(3)],
      () => '130',
      authorize
    )
  ).toThrow('capacity is full')
  expect(f.reopen().read([address(), address(2)], clock, authorize)).toMatchObject({
    revision: '1',
    observedAt: '130',
    records: [{ revision: '1' }, undefined]
  })
})

it('rejects asynchronous, invalid and reentrant preparation without committing records', async () => {
  const f = fixture(),
    observed = jest.fn(clock)
  type Prepare = Parameters<typeof f.ledger.commitPrepared>[1]
  expect(() =>
    f.ledger.commitPrepared(
      '0',
      (async () => [change()]) as unknown as Prepare,
      observed,
      authorize
    )
  ).toThrow('synchronous')
  expect(observed).not.toHaveBeenCalled()
  for (const result of [Promise.reject(new Error('Invalid asynchronous plan')), undefined, {}]) {
    expect(() =>
      f.ledger.commitPrepared('0', (() => result) as unknown as Prepare, clock, authorize)
    ).toThrow('synchronous records')
  }
  expect(() =>
    f.ledger.commitPrepared(
      '0',
      () => {
        f.ledger.read([address()], clock, authorize)
        return [change()]
      },
      clock,
      authorize
    )
  ).toThrow('reentered')
  expect(() =>
    f.ledger.commitPrepared('0', () => [change()], clock, (() =>
      Promise.reject(new Error('Invalid asynchronous guard'))) as () => void)
  ).toThrow('asynchronous or invalid')
  await Promise.resolve()
  expect(f.ledger.read([address()], clock, authorize).revision).toBe('0')
})

it('owns and bounds the complete local plan before writing any record', () => {
  const f = fixture(),
    options = { maximumBatchBytes: 1024 }
  expect(() => f.ledger.commitPrepared('0', () => [], clock, authorize, options)).toThrow('1–64')
  expect(() =>
    f.ledger.commitPrepared('0', () => [change(), change()], clock, authorize, options)
  ).toThrow('repeats an address')
  const sparse = [change()]
  Reflect.deleteProperty(sparse, '0')
  expect(() => f.ledger.commitPrepared('0', () => sparse, clock, authorize, options)).toThrow(
    'sparse'
  )
  const accessor = [change()]
  Object.defineProperty(accessor, '0', {
    enumerable: true,
    get: () => {
      throw new Error('Must not invoke accessor')
    }
  })
  expect(() => f.ledger.commitPrepared('0', () => accessor, clock, authorize, options)).toThrow(
    'accessor or hole'
  )
  expect(() =>
    f.ledger.commitPrepared('0', () => [change()], clock, authorize, { maximumBatchBytes: 1 })
  ).toThrow('byte allowance')
  expect(f.reopen().read([address()], clock, authorize).revision).toBe('0')
})

it('recovers a committed prepared write after a lost reply without repeating it', () => {
  const f = fixture(),
    original = f.ledger.commitPrepared.bind(f.ledger)
  jest.spyOn(f.ledger, 'commitPrepared').mockImplementationOnce((...args) => {
    original(...args)
    throw new Error('Lost native commit reply')
  })
  expect(() =>
    f.ledger.commitPrepared(
      '0',
      () => [change()],
      () => '121',
      authorize
    )
  ).toThrow('Lost native commit reply')
  const reopened = f.reopen(),
    prepare = jest.fn(() => [change()])
  expect(reopened.read([address()], clock, authorize)).toMatchObject({
    revision: '1',
    observedAt: '121'
  })
  expect(() => reopened.commitPrepared('0', prepare, clock, authorize)).toThrow(
    'changed before commit'
  )
  expect(prepare).not.toHaveBeenCalled()
})

it('keeps the native view and call-time byte allowance immutable through both callbacks', () => {
  const f = fixture()
  for (const location of ['prepare', 'guard'] as const) {
    const mutate = (view: ProtectedLedgerView) => {
      view.observedAt = '1'
    }
    expect(() =>
      f.ledger.commitPrepared(
        '0',
        view => {
          if (location === 'prepare') mutate(view)
          return [change()]
        },
        () => '120',
        location === 'guard' ? mutate : authorize
      )
    ).toThrow(TypeError)
  }
  const options = { maximumBatchBytes: 1 }
  expect(() =>
    f.ledger.commitPrepared(
      '0',
      () => {
        options.maximumBatchBytes = 1024
        return [change()]
      },
      () => '130',
      authorize,
      options
    )
  ).toThrow('byte allowance')
  const prepare = jest.fn(() => [change()])
  expect(() =>
    f.ledger.commitPrepared('0', prepare, clock, authorize, { maximumBatchBytes: 0 })
  ).toThrow()
  expect(prepare).not.toHaveBeenCalled()
  expect(f.reopen().read([address()], clock, authorize)).toEqual({
    revision: '0',
    observedAt: '130',
    records: [undefined]
  })
})
