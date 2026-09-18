import { SyncPageBudget } from './SyncPageBudget'
import type { RequestSyncChunkArgs, SyncChunk } from '../../sdk/WalletStorage.interfaces'

const args = { maxItems: 1000, maxRoughSize: 2000000, offsets: [{ name: 'provenTx', offset: 700 }] } as RequestSyncChunkArgs
const chunk = (count: number, proof = false): SyncChunk => ({
  fromStorageIdentityKey: 'from', toStorageIdentityKey: 'to', userIdentityKey: 'user',
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
