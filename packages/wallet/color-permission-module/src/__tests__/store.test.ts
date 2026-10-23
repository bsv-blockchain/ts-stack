import { beforeEach, describe, expect, it } from '@jest/globals'
import { ColorStore } from '../store.js'
import { FakeStore } from './profileFixtures.js'

describe('ColorStore records', () => {
  let store: FakeStore
  let colorStore: ColorStore
  const T1 = '11'.repeat(32)
  const T2 = '22'.repeat(32)
  const ASSET = `${'33'.repeat(32)}_0`

  beforeEach(() => {
    store = new FakeStore()
    colorStore = new ColorStore(store)
  })

  it('round-trips the deploy cache under color.v1.deploy.', async () => {
    await expect(colorStore.getDeploy(ASSET)).resolves.toBeUndefined()
    await colorStore.putDeploy(ASSET, '0100')
    await expect(colorStore.getDeploy(ASSET)).resolves.toBe('0100')
    await colorStore.deleteDeploy(ASSET)
    await expect(colorStore.getDeploy(ASSET)).resolves.toBeUndefined()
    expect(store.writes).toEqual([`color.v1.deploy.${ASSET}`])
  })

  it('writes a settled record once, under color.v1.settled.', async () => {
    await expect(colorStore.settled(T1)).resolves.toBe(false)
    await colorStore.markSettled(T1)
    await colorStore.markSettled(T1)
    await colorStore.markSettled(T2)
    await expect(colorStore.settled(T1)).resolves.toBe(true)
    expect([...(await colorStore.settledSet())].sort((a, b) => a.localeCompare(b))).toEqual([
      T1,
      T2
    ])
    expect(store.writes).toEqual([`color.v1.settled.${T1}`, `color.v1.settled.${T2}`])
  })

  it('reads a torn or foreign settled record as absent (fail safe)', async () => {
    await store.set(`color.v1.settled.${T1}`, '')
    await store.set(`color.v1.settled.${T2}`, JSON.stringify({ outputs: [0], signer: 'x' }))
    await store.set('color.v1.settled.not-a-txid', '1')
    await store.set('color.v1.settledX', '1')
    await expect(colorStore.settled(T1)).resolves.toBe(false)
    await expect(colorStore.settled(T2)).resolves.toBe(false)
    expect((await colorStore.settledSet()).size).toBe(0)
    // A torn record is repaired by the next markSettled.
    await colorStore.markSettled(T1)
    await expect(colorStore.settled(T1)).resolves.toBe(true)
  })

  it('refuses a key for anything but a lowercase hex txid', async () => {
    await expect(colorStore.settled('xyz')).rejects.toThrow(TypeError)
    await expect(colorStore.markSettled('AB'.repeat(32))).rejects.toThrow(TypeError)
    expect(store.writes).toEqual([])
  })
})
