import assert from 'node:assert/strict'
import test from 'node:test'
import { createMandalaStateStore } from './mandalaStateStore.js'

test('resolves the shared store lazily and matches the exact admin history tuple', async () => {
  const state = { assetId: 'asset' }
  const token = { txid: 'token', outputIndex: 2 }
  let ready = false
  const store = {
    async getAssetState(assetId: string) {
      assert.equal(assetId, 'asset')
      return state
    },
    async getTokenRow(txid: string, index: number) {
      assert.equal(txid, 'token')
      assert.equal(index, 2)
      return token
    },
    async findAdminHistoryByAssetId() {
      return [{ assetId: 'asset', txid: 'admin', outputIndex: 1 }]
    }
  }
  type Store = ReturnType<Parameters<typeof createMandalaStateStore>[0]>
  const adapter = createMandalaStateStore(() => {
    if (!ready) throw new Error('storage unavailable')
    return store as unknown as Store
  })
  await assert.rejects(adapter.isAdminOutpoint('asset', 'admin', 1), /storage unavailable/)
  ready = true
  assert.equal(await adapter.getAssetState('asset'), state)
  assert.equal(await adapter.getTokenRow('token', 2), token)
  assert.equal(await adapter.isAdminOutpoint('asset', 'admin', 1), true)
  assert.equal(await adapter.isAdminOutpoint('other', 'admin', 1), false)
  assert.equal(await adapter.isAdminOutpoint('asset', 'other', 1), false)
  assert.equal(await adapter.isAdminOutpoint('asset', 'admin', 0), false)
})
