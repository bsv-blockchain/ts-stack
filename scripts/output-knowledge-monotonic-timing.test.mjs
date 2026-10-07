import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMonotonicTiming,
  validateMonotonicTiming
} from './output-knowledge-monotonic-timing.mjs'

test('synchronous timing preserves exact receiver, arguments, return and thrown identities', () => {
  let tick = 0n
  const timing = createMonotonicTiming(() => (tick += 10n)),
    result = {},
    failure = {}
  const owner = {
    value: result,
    read(arg) {
      assert.equal(arg, result)
      return this.value
    },
    fail() {
      throw failure
    }
  }
  const original = Object.getOwnPropertyDescriptor(owner, 'read')
  timing.wrap(owner, 'read', 'Fixture.read')
  timing.wrap(owner, 'fail', 'Fixture.fail')
  assert.equal(owner.read(result), result)
  assert.throws(
    () => owner.fail(),
    error => error === failure
  )
  const current = Object.getOwnPropertyDescriptor(owner, 'read')
  assert.deepEqual({ ...current, value: original.value }, original)
  assert.deepEqual(validateMonotonicTiming(timing.snapshot()).rows, [
    { method: 'Fixture.read', calls: 1, nanoseconds: '10' },
    { method: 'Fixture.fail', calls: 1, nanoseconds: '10' }
  ])
})

test('nested native-shaped calls retain inclusive totals without recording operation data', () => {
  let tick = 0n
  const timing = createMonotonicTiming(() => ++tick)
  const owner = {
    inner() {
      return 'private value'
    },
    outer() {
      return this.inner()
    }
  }
  timing.wrap(owner, 'inner', 'Fixture.inner')
  timing.wrap(owner, 'outer', 'Fixture.outer')
  assert.equal(owner.outer(), 'private value')
  const report = validateMonotonicTiming(timing.snapshot())
  assert.deepEqual(report.rows, [
    { method: 'Fixture.inner', calls: 1, nanoseconds: '1' },
    { method: 'Fixture.outer', calls: 1, nanoseconds: '3' }
  ])
  assert.equal(JSON.stringify(report).includes('private value'), false)
})

test('bad clocks refuse timing without changing the operation or repairing observations', () => {
  for (const clock of [
    (() => {
      let tick = 10n
      return () => --tick
    })(),
    () => {
      throw Error('clock')
    },
    () => 1
  ]) {
    const timing = createMonotonicTiming(clock),
      result = {},
      owner = {
        read() {
          return result
        }
      }
    timing.wrap(owner, 'read', 'Fixture.read')
    assert.equal(owner.read(), result)
    assert.throws(() => validateMonotonicTiming(timing.snapshot()), /Monotonic timing refused/)
  }
})

test('only bounded unique scalar counters and genuine data methods are admitted', () => {
  let getterCalls = 0
  const timing = createMonotonicTiming(),
    owner = {
      get read() {
        getterCalls++
        return () => {}
      }
    }
  assert.throws(() => timing.wrap(owner, 'read', 'Fixture.read'), /Timing method required/)
  assert.equal(getterCalls, 0)
  const plain = { read() {} }
  timing.wrap(plain, 'read', 'Fixture.read')
  assert.throws(() => timing.wrap(plain, 'read', 'Fixture.read'), /Timing method identity/)
  const valid = timing.snapshot()
  for (const rows of [
    [{ method: 'Fixture.read', calls: -1, nanoseconds: '0' }],
    [{ method: 'Fixture.read', calls: 1, nanoseconds: '-1' }],
    [{ method: 'Fixture.read', calls: 1, nanoseconds: '01' }],
    [{ method: 'Fixture.read', calls: 0, nanoseconds: '1' }],
    [{ method: 'Fixture.read', calls: 1, nanoseconds: '9000000000000001' }],
    [{ method: 'Fixture.read', calls: 100000001, nanoseconds: '0' }],
    [...valid.rows, ...valid.rows]
  ])
    assert.throws(() => validateMonotonicTiming({ ...valid, rows }))
})

test('clock bounds and rejected wrapping cannot alter an operation or accept an incomplete report', () => {
  let tick = 0n
  const timing = createMonotonicTiming(() => (tick += 9000000000000001n))
  const result = {},
    owner = {
      read() {
        return result
      }
    }
  timing.wrap(owner, 'read', 'Fixture.read')
  assert.equal(owner.read(), result)
  assert.equal(timing.snapshot().refusal, 'timing-bound')
  assert.throws(() => validateMonotonicTiming(timing.snapshot()), /Monotonic timing refused/)
  const immutable = Object.freeze({
    read() {
      return result
    }
  })
  assert.throws(() => createMonotonicTiming().wrap(immutable, 'read', 'Fixture.read'), /immutable/)
  assert.equal(immutable.read(), result)
  for (const value of [
    null,
    {},
    { ...timing.snapshot(), refusal: null, rows: [] },
    { ...timing.snapshot(), refusal: null, extra: 'unexpected' }
  ])
    assert.throws(() => validateMonotonicTiming(value))
})
