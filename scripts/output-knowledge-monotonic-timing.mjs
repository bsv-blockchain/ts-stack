import assert from 'node:assert/strict'

const MAX_METHODS = 64
const MAX_CALLS = 100000000
const MAX_TOTAL_NS = 9000000000000000n

/** Diagnostic delegation only. Arguments, receivers and results are never kept. */
export function createMonotonicTiming(clock = process.hrtime.bigint) {
  const rows = new Map()
  let last,
    refusal = null
  const read = () => {
    try {
      const value = clock()
      if (typeof value !== 'bigint' || value < 0n || (last !== undefined && value < last)) {
        refusal ??= 'non-monotonic-clock'
        return undefined
      }
      last = value
      return value
    } catch {
      refusal ??= 'clock-refused'
      return undefined
    }
  }
  return {
    wrap(target, key, label) {
      assert.match(label, /^[A-Za-z][A-Za-z0-9.]{0,127}$/)
      assert.ok(rows.size < MAX_METHODS && !rows.has(label), 'Timing method identity')
      const descriptor = Object.getOwnPropertyDescriptor(target, key)
      assert.ok(descriptor && typeof descriptor.value === 'function', 'Timing method required')
      assert.ok(descriptor.configurable || descriptor.writable, 'Timing method is immutable')
      const original = descriptor.value,
        row = { calls: 0, nanoseconds: 0n }
      const delegated = {
        call(...args) {
          const before = read()
          try {
            return Reflect.apply(original, this, args)
          } finally {
            const after = read()
            if (before !== undefined && after !== undefined && after >= before) {
              row.calls++
              row.nanoseconds += after - before
              if (row.calls > MAX_CALLS || row.nanoseconds > MAX_TOTAL_NS)
                refusal ??= 'timing-bound'
            }
          }
        }
      }.call
      Object.defineProperty(target, key, { ...descriptor, value: delegated })
      rows.set(label, row)
    },
    snapshot() {
      return {
        format: 'output-knowledge-monotonic-timing/1',
        clock: 'process.hrtime.bigint',
        refusal,
        synchronousInclusive: true,
        instrumentationOverheadIncluded: true,
        applicationValuesPrinted: false,
        fullFunctionalQualified: false,
        rows: [...rows].map(([method, row]) => ({
          method,
          calls: row.calls,
          nanoseconds: row.nanoseconds.toString()
        }))
      }
    }
  }
}

/** Admit complete scalar counters, never repaired, clamped or sampled timings. */
export function validateMonotonicTiming(value) {
  assert.deepEqual(Object.keys(value).sort(), [
    'applicationValuesPrinted',
    'clock',
    'format',
    'fullFunctionalQualified',
    'instrumentationOverheadIncluded',
    'refusal',
    'rows',
    'synchronousInclusive'
  ])
  assert.equal(value.format, 'output-knowledge-monotonic-timing/1')
  assert.equal(value.clock, 'process.hrtime.bigint')
  assert.equal(value.refusal, null, 'Monotonic timing refused')
  assert.equal(value.synchronousInclusive, true)
  assert.equal(value.instrumentationOverheadIncluded, true)
  assert.equal(value.applicationValuesPrinted, false)
  assert.equal(value.fullFunctionalQualified, false)
  assert.ok(Array.isArray(value.rows) && value.rows.length > 0 && value.rows.length <= MAX_METHODS)
  const names = new Set()
  for (const row of value.rows) {
    assert.deepEqual(Object.keys(row).sort(), ['calls', 'method', 'nanoseconds'])
    assert.match(row.method, /^[A-Za-z][A-Za-z0-9.]{0,127}$/)
    assert.ok(!names.has(row.method), 'Duplicate timing method')
    names.add(row.method)
    assert.ok(Number.isSafeInteger(row.calls) && row.calls >= 0 && row.calls <= MAX_CALLS)
    assert.match(row.nanoseconds, /^(0|[1-9][0-9]{0,15})$/)
    assert.ok(BigInt(row.nanoseconds) <= MAX_TOTAL_NS)
    assert.ok(row.calls > 0 || row.nanoseconds === '0', 'Uncalled timing method')
  }
  return value
}
