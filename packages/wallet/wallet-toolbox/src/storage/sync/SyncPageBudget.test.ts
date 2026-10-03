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
