import { SyncPageBudget } from './SyncPageBudget'
import type { RequestSyncChunkArgs, SyncChunk } from '../../sdk/WalletStorage.interfaces'

const args = {
  maxItems: 1000,
  maxRoughSize: 2000000,
  offsets: [{ name: 'provenTx', offset: 700 }]
} as RequestSyncChunkArgs
const chunk = (count: number, proof = false): SyncChunk => ({
  fromStorageIdentityKey: 'from',
  toStorageIdentityKey: 'to',
  userIdentityKey: 'user',
  [proof ? 'provenTxs' : 'transactions']: Array.from({ length: count }, () => ({}))
})

test('starts conservatively, grows cheap pages and preserves byte bounds and offsets', () => {
  const budget = new SyncPageBudget()
  expect(budget.apply(args).maxItems).toBe(64)
  for (let i = 0; i < 5; i++) budget.committed(chunk(budget.apply(args).maxItems), 100)
  expect(budget.apply(args)).toEqual(args)
  expect(budget.apply({ ...args, maxItems: 1 }).maxItems).toBe(1)
  expect(args.maxItems).toBe(1000)
})

test('limits proof-heavy pages by work and shrinks after slow committed pages', () => {
  const budget = new SyncPageBudget()
  budget.committed(chunk(64, true), 100)
  expect(budget.apply(args).maxItems).toBe(128)
  budget.committed(chunk(128, true), 100)
  expect(budget.apply(args).maxItems).toBe(128)
  budget.committed(chunk(128, true), 20000)
  expect(budget.apply(args).maxItems).toBe(32)
  budget.committed(chunk(1, true), 20000)
  expect(budget.apply(args).maxItems).toBe(1)
})

test('ignores unusable timings and empty pages and starts each copy independently', () => {
  const budget = new SyncPageBudget()
  for (const time of [NaN, Infinity, -1]) budget.committed(chunk(64), time)
  budget.committed(chunk(0), 100)
  expect(budget.apply(args).maxItems).toBe(64)
  budget.committed(chunk(64), 0)
  expect(budget.apply(args).maxItems).toBe(128)
  expect(new SyncPageBudget().apply(args).maxItems).toBe(64)
})

test.each([false, true])('amortizes fixed latency without collapsing to single rows (proofs=%s)', proof => {
  const budget = new SyncPageBudget()
  const limits: number[] = []
  let remaining = 10000
  let pages = 0
  while (remaining > 0) {
    const limit = budget.apply(args).maxItems
    limits.push(limit)
    const count = Math.min(limit, remaining)
    // Independent fixed costs in the source request and destination commit.
    budget.committed(chunk(count, proof), 20000 + count * 2, 15000 + count)
    remaining -= count
    pages++
    expect(pages).toBeLessThan(200)
  }
  expect(Math.min(...limits)).toBeGreaterThan(1)
  expect(limits.slice(-5).every(limit => limit === (proof ? 128 : 1000))).toBe(true)
})

test('distinguishes per-proof work from fixed overhead and responds to a slowdown', () => {
  const budget = new SyncPageBudget()
  for (let i = 0; i < 10; i++) {
    const count = budget.apply(args).maxItems
    budget.committed(chunk(count, true), 16000 + count * 100, 15000 + count * 20)
  }
  expect(budget.apply(args).maxItems).toBeGreaterThanOrEqual(49)
  expect(budget.apply(args).maxItems).toBeLessThanOrEqual(51)
  const before = budget.apply(args).maxItems
  budget.committed(chunk(before, true), 16000 + before * 1000, 15000 + before * 20)
  expect(budget.apply(args).maxItems).toBeLessThan(before / 2)
})

test('recovers from the single-row floor using bounded upward probes', () => {
  const budget = new SyncPageBudget()
  budget.committed(chunk(1, true), 20000, 19000)
  const limits: number[] = []
  for (let i = 0; i < 30; i++) {
    const count = budget.apply(args).maxItems
    limits.push(count)
    budget.committed(chunk(count, true), 20000, 19000)
  }
  expect(limits[0]).toBe(1)
  expect(limits.slice(0, 4)).toContain(2)
  expect(limits.slice(-5)).toEqual([128, 128, 128, 128, 128])
})

test('does not reuse cheap metadata estimates for expensive proofs', () => {
  const budget = new SyncPageBudget()
  for (let i = 0; i < 10; i++) budget.committed(chunk(budget.apply(args).maxItems), 20000, 19000)
  budget.committed(chunk(100, true), 50000, 1000)
  expect(budget.apply(args).maxItems).toBeLessThanOrEqual(10)
})

test('does not carry a fitted fixed query cost into another metadata table', () => {
  const budget = new SyncPageBudget()
  for (let i = 0; i < 10; i++) {
    const count = budget.apply(args).maxItems
    budget.committed(chunk(count), 20000 + count * 2, 19000 + count)
  }
  expect(budget.apply(args).maxItems).toBe(1000)
  const outputPage = {
    ...chunk(100),
    transactions: undefined,
    outputs: Array.from({ length: 100 }, () => ({}))
  } as SyncChunk
  budget.committed(outputPage, 50000, 49000)
  // The old table's 20-second fixed cost must not make this new work look cheap.
  expect(budget.apply(args).maxItems).toBe(10)
})

test('keeps page size stable under modest latency noise and shrinks a real slowdown', () => {
  const budget = new SyncPageBudget()
  for (let i = 0; i < 10; i++) {
    const count = budget.apply(args).maxItems
    budget.committed(chunk(count, true), 16000 + count * 100, 15000 + count * 20)
  }
  const settled = budget.apply(args).maxItems
  const limits: number[] = []
  for (let i = 0; i < 24; i++) {
    const count = budget.apply(args).maxItems
    limits.push(count)
    budget.committed(chunk(count, true), 16000 + count * 100 + (i % 2 === 0 ? 100 : -100), 15000 + count * 20)
  }
  expect(limits.every(limit => limit === settled)).toBe(true)
  budget.committed(chunk(settled, true), 16000 + settled * 1000, 15000 + settled * 20)
  expect(budget.apply(args).maxItems).toBeLessThan(settled / 2)
})

test('uses observed page bytes conservatively without changing caller limits or cursors', () => {
  const budget = new SyncPageBudget()
  budget.committed(chunk(64), 100, 50, 64 * 250000)
  const original = JSON.stringify(args)
  expect(budget.apply(args)).toEqual({ ...args, maxItems: 8 })
  expect(budget.apply({ ...args, maxItems: 3 }).maxItems).toBe(3)
  budget.committed(chunk(8), 100, 50, 8 * 500000)
  expect(budget.apply(args).maxItems).toBe(4)
  budget.committed(chunk(4), 100, 50, 4 * 1000)
  expect(budget.apply(args).maxItems).toBe(5)
  expect(JSON.stringify(args)).toBe(original)
})

test('ignores invalid byte measurements and forgets bytes on a table transition', () => {
  const budget = new SyncPageBudget()
  for (const bytes of [NaN, Infinity, -1, 0, 1.5]) budget.committed(chunk(64), 100, 50, bytes)
  expect(budget.apply(args).maxItems).toBe(1000)
  budget.committed(chunk(1), 100, 50, 4000000)
  expect(budget.apply(args).maxItems).toBe(1)
  budget.committed(chunk(64, true), 100, 50)
  expect(budget.apply(args).maxItems).toBe(128)
})

test('workload identity is independent of property order for a mixed legacy chunk', () => {
  const budget = new SyncPageBudget()
  const rows = Array.from({ length: 16 }, () => ({}))
  const mixed = { ...chunk(0), transactions: rows, outputs: rows } as SyncChunk
  for (let i = 0; i < 10; i++) budget.committed(mixed, 100, 50, 32 * 250000)
  const expected = budget.apply(args)
  budget.committed(
    {
      outputs: rows,
      transactions: rows,
      fromStorageIdentityKey: 'from',
      toStorageIdentityKey: 'to',
      userIdentityKey: 'user'
    } as SyncChunk,
    100,
    50
  )
  expect(budget.apply(args)).toEqual(expected)
})

test('uses the known next table before fetching and preserves observations within that table', () => {
  const budget = new SyncPageBudget()
  budget.committed(chunk(1, true), 20000, 19000, 4000000)
  expect(budget.apply(args).maxItems).toBe(1)
  expect(budget.apply(args, 'txLabels').maxItems).toBe(64)
  expect(budget.apply(args, 'txLabels').maxItems).toBe(64)
  const labels = { ...chunk(0), txLabels: Array.from({ length: 64 }, () => ({})) } as SyncChunk
  budget.committed(labels, 100, 50, 64 * 128)
  expect(budget.apply(args, 'txLabels').maxItems).toBe(128)
  expect(budget.apply(args, 'txLabels').maxItems).toBe(128)
})

test('known table transitions preserve smaller caller limits and original byte and cursor values', () => {
  const budget = new SyncPageBudget()
  budget.committed(chunk(64), 100, 50, 64 * 250000)
  expect(budget.apply(args).maxItems).toBe(8)
  const limits = { ...args, maxItems: 3, maxRoughSize: 1234 }
  const original = JSON.stringify(limits)
  const request = budget.apply(limits, 'outputs')
  expect(request).toEqual(limits)
  expect(request.offsets).toBe(limits.offsets)
  expect(JSON.stringify(limits)).toBe(original)
  expect(budget.apply(args, 'outputs').maxItems).toBe(64)
  expect(budget.apply(args, 'provenTxs').maxItems).toBe(64)
})

test.each([0, 0.4, 1])('shrinks immediately after equal-size pages become expensive (read share=%s)', readShare => {
  const budget = new SyncPageBudget()
  const capped = { ...args, maxItems: 64 }
  for (let i = 0; i < 8; i++) {
    budget.committed(chunk(64), 100, 100 * readShare)
    expect(budget.apply(capped).maxItems).toBe(64)
  }
  // The caller's row cap has kept every observed page the same size. A new
  // 200-ms-per-record cost must constrain the very next five-second request.
  budget.committed(chunk(64), 12800, 12800 * readShare)
  expect(budget.apply(capped).maxItems).toBe(25)
})

test('retains the metadata ceiling when the caller allows more rows', () => {
  const budget = new SyncPageBudget()
  const wide = { ...args, maxItems: 5000 }
  for (let i = 0; i < 8; i++) budget.committed(chunk(budget.apply(wide).maxItems), 0)
  expect(budget.apply(wide).maxItems).toBe(1000)
})

test('probes the single-row floor only periodically and returns after expensive proofs', () => {
  const budget = new SyncPageBudget()
  budget.committed(chunk(64, true), 640000, 320000)
  const limits: number[] = []
  for (let i = 0; i < 12; i++) {
    const count = budget.apply(args).maxItems
    limits.push(count)
    budget.committed(chunk(count, true), count * 10000, count * 5000)
  }
  expect(limits).toEqual([1, 1, 1, 2, 1, 1, 1, 2, 1, 1, 1, 2])
})

test.each([
  [125, 50],
  [125.1, 39]
])('holds a 20-percent boundary but shrinks beyond it (cost=%s)', (cost, expected) => {
  const budget = new SyncPageBudget()
  budget.committed(chunk(64), 6400)
  for (let i = 0; i < 8; i++) budget.committed(chunk(50), 5000)
  expect(budget.apply(args).maxItems).toBe(50)
  budget.committed(chunk(50), 50 * cost)
  expect(budget.apply(args).maxItems).toBe(expected)
})

test('recovers gradually from large payloads while preserving the byte ceiling', () => {
  const budget = new SyncPageBudget()
  budget.committed(chunk(64), 0, 0, 64 * 500000)
  const limits = [budget.apply(args).maxItems]
  for (let i = 0; i < 3; i++) {
    budget.committed(chunk(64), 0, 0, 64 * 100000)
    limits.push(budget.apply(args).maxItems)
  }
  expect(limits).toEqual([4, 5, 6, 7])
})

test('invalid timing and byte observations cannot discard an established workload budget', () => {
  const budget = new SyncPageBudget()
  budget.committed(chunk(64), 100, 50, 64 * 500000)
  const expected = budget.apply(args)
  for (const readMs of [NaN, Infinity, -1, 101]) {
    budget.committed(chunk(64, true), 100, readMs, 64)
    expect(budget.apply(args)).toEqual(expected)
  }
  for (const bytes of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    budget.committed(chunk(64), 100, 50, bytes)
    expect(budget.apply(args)).toEqual(expected)
  }
  budget.committed(chunk(0, true), 0, 0, 1)
  expect(budget.apply(args)).toEqual(expected)
})

test('forgets an old slowdown after sustained cheap equal-size pages', () => {
  const budget = new SyncPageBudget()
  const capped = { ...args, maxItems: 64 }
  for (let i = 0; i < 6; i++) budget.committed(chunk(64), 12800, 6400)
  expect(budget.apply(capped).maxItems).toBe(25)
  for (let i = 0; i < 32; i++) budget.committed(chunk(64), 640, 320)
  expect(budget.apply(capped).maxItems).toBe(64)
  // An ever-growing history would still let the original slow pages dominate.
  // Sustained 10-ms records must recover most of the five-second work budget.
  expect(budget.apply(args).maxItems).toBeGreaterThanOrEqual(400)
  expect(budget.apply(args).maxItems).toBeLessThanOrEqual(500)
})

test('holds modest cost recovery inside hysteresis and grows after a sustained improvement', () => {
  const budget = new SyncPageBudget()
  budget.committed(chunk(64), 6400)
  for (let i = 0; i < 8; i++) budget.committed(chunk(50), 5000)
  for (let i = 0; i < 8; i++) {
    budget.committed(chunk(50), 4000)
    expect(budget.apply(args).maxItems).toBe(50)
  }
  for (let i = 0; i < 32; i++) budget.committed(chunk(50), 4000)
  expect(budget.apply(args).maxItems).toBeGreaterThan(60)
  expect(budget.apply(args).maxItems).toBeLessThanOrEqual(62)
})
