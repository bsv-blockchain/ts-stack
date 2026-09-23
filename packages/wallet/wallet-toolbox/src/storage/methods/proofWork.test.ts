import type { StorageProvider } from '../StorageProvider'
import { findProofRecords, mapProofWork } from './proofWork'

test('bounds proof concurrency and drains already-started I/O before rejecting', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let active = 0
  let started = 0
  let peak = 0
  let settled = false
  const failure = new Error('proof lookup failed')
  const pending = mapProofWork(
    Array.from({ length: 20 }, (_, index) => index),
    async index => {
      active++
      started++
      peak = Math.max(peak, active)
      try {
        if (index === 0) throw failure
        await gate
        return index
      } finally {
        active--
      }
    }
  )
  const rejected = expect(pending).rejects.toBe(failure)
  void pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await Promise.resolve()
  await Promise.resolve()
  expect(started).toBe(8)
  expect(peak).toBeLessThanOrEqual(8)
  expect(settled).toBe(false)
  release()
  await rejected
  expect(active).toBe(0)
  expect(started).toBe(8)
})

test('deduplicates and bounds large proof lookups before reaching SQL bindings', async () => {
  const findProvenTxs = jest.fn(async () => [])
  const txids = Array.from({ length: 1201 }, (_, i) => i.toString(16).padStart(64, '0'))
  await expect(
    findProofRecords({ findProvenTxs } as unknown as StorageProvider, [...txids, ...txids])
  ).resolves.toEqual([])
  expect(findProvenTxs).toHaveBeenCalledTimes(5)
  const requests = findProvenTxs.mock.calls as unknown as [{ txids: string[] }][]
  expect(requests.every(([args]) => args.txids.length <= 250)).toBe(true)
  expect(requests.flatMap(([args]) => args.txids)).toEqual(txids)
})
