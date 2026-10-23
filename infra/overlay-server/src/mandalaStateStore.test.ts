import assert from 'node:assert/strict'
import test from 'node:test'
import type { MandalaStorageManager } from '@bsv/overlay-topics'
import { createMandalaStateStore } from './mandalaStateStore.js'

test('resolves the shared store lazily and forwards the published state surface', async () => {
  const calls: string[] = []
  let ready = false
  const store = new Proxy({} as MandalaStorageManager, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined
      return async (...args: unknown[]) => {
        calls.push(`${property}:${JSON.stringify(args)}`)
        return `${property}-result`
      }
    }
  })
  const adapter = createMandalaStateStore(() => {
    if (!ready) throw new Error('storage unavailable')
    return store
  })

  await assert.rejects(adapter.getAssetState('asset'), /storage unavailable/)
  ready = true

  assert.equal(await adapter.getAssetState('asset'), 'getAssetState-result')
  assert.equal(await adapter.getTokenRow('token', 2), 'getTokenRow-result')
  assert.equal(await adapter.getAuthorityRow('auth', 3), 'getAuthorityRow-result')
  assert.equal(await adapter.getOwnerJournal('journal', 4, 'tm_mandala'), 'getOwnerJournal-result')
  assert.equal(await adapter.recordOwners([]), 'recordOwners-result')
  assert.equal(await adapter.repairOwnerRow({} as never), 'repairOwnerRow-result')
  assert.equal(await adapter.takeToken('spent', 5), 'takeToken-result')
  assert.equal(await adapter.takeAuthority('authority', 6), 'takeAuthority-result')
  assert.equal(await adapter.adjustBalance('identity', 7), 'adjustBalance-result')
  assert.equal(await adapter.circulatingSupply('token-id'), 'circulatingSupply-result')
  assert.deepEqual(calls, [
    'getAssetState:["asset"]',
    'getTokenRow:["token",2]',
    'getAuthorityRow:["auth",3]',
    'getOwnerJournal:["journal",4,"tm_mandala"]',
    'recordOwners:[[]]',
    'repairOwnerRow:[{}]',
    'takeToken:["spent",5]',
    'takeAuthority:["authority",6]',
    'adjustBalance:["identity",7]',
    'circulatingSupply:["token-id"]'
  ])
})
