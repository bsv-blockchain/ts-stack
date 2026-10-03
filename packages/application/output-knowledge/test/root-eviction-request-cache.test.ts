import { afterEach, expect, it, jest } from '@jest/globals'
import { PublicKey, signOutputPacket, PrivateKey, canonicalOutputJSON } from '@bsv/sdk'
import { DatabaseSync } from 'node:sqlite'
import {
  fixture,
  signed,
  request,
  requester,
  clock,
  root,
  chain,
  requesterKey
} from './root-eviction-fixture.js'

afterEach(() => {
  jest.restoreAllMocks()
})

it('rechecks native bindings after reopening while sharing only signature mathematics', async () => {
  const f = await fixture()
  try {
    const packet = signed()
    const verify = jest.spyOn(PublicKey.prototype, 'verify')
    const retained = await f.store.retain(packet, requester, clock)
    expect(verify).toHaveBeenCalledTimes(1)
    await f.store.retain(structuredClone(packet), requester, clock)
    const publicResult = await f.store.result(requester, packet.body.requestId, clock.now)
    expect(verify).toHaveBeenCalledTimes(1)
    retained.request.body.reason = 'owned-return-only'
    expect((await f.store.retain(packet, requester, clock)).request).toEqual(packet)
    const reopened = f.reopen()
    expect(await reopened.result(requester, packet.body.requestId, clock.now)).toEqual(publicResult)
    expect(verify).toHaveBeenCalledTimes(1)
    const db = new DatabaseSync(f.path)
    try {
      const corrupt = structuredClone(packet)
      corrupt.body.reason = 'changed persisted meaning after reopen'
      db.prepare('UPDATE root_requests SET packet=?').run(canonicalOutputJSON(corrupt))
      await expect(reopened.result(requester, packet.body.requestId, clock.now)).rejects.toThrow(
        'signature'
      )
      expect(verify).toHaveBeenCalledTimes(2)
      await expect(reopened.result(requester, packet.body.requestId, clock.now)).rejects.toThrow(
        'signature'
      )
      expect(verify).toHaveBeenCalledTimes(3)
    } finally {
      db.close()
    }
  } finally {
    await f.cleanup()
  }
})

it('checks a new signature variant and repeats unsuccessful signature checks', async () => {
  const f = await fixture()
  try {
    const packet = signed(),
      variant = signed()
    expect(packet.signature).not.toBe(variant.signature)
    const verify = jest.spyOn(PublicKey.prototype, 'verify')
    await f.store.retain(packet, requester, clock)
    expect((await f.store.retain(variant, requester, clock)).request).toEqual(packet)
    expect(verify).toHaveBeenCalledTimes(2)
    const corrupt = structuredClone(packet)
    corrupt.body.reason = 'not-signed'
    await expect(f.store.retain(corrupt, requester, clock)).rejects.toThrow('signature')
    await expect(f.store.retain(corrupt, requester, clock)).rejects.toThrow('signature')
    expect(verify).toHaveBeenCalledTimes(4)
  } finally {
    await f.cleanup()
  }
})

it('never reuses an authenticated identity for a different requester, root or chain', async () => {
  const f = await fixture()
  try {
    const packet = signed()
    await f.store.retain(packet, requester, clock)
    const other = new PrivateKey(89).toPublicKey().toString()
    await expect(f.store.retain(packet, other, clock)).rejects.toThrow('selection')
    for (const body of [
      { ...request('cache_wrong_root_request'), recipient: other },
      {
        ...request('cache_wrong_chain_request'),
        chain: { ...chain, network: 'other' },
        targets: request().targets.map(t => ({
          ...t,
          outpoint: { ...t.outpoint, chain: { ...chain, network: 'other' } }
        }))
      }
    ]) {
      await expect(
        f.store.retain(
          signOutputPacket('root-eviction-request', body, requesterKey),
          requester,
          clock
        )
      ).rejects.toThrow('selection')
    }
    expect((await f.store.retain(packet, requester, clock)).request.body.recipient).toBe(root)
  } finally {
    await f.cleanup()
  }
})

it('checks live clock and immutable request-ID conflicts after positive authentication', async () => {
  const f = await fixture()
  try {
    const packet = signed()
    await expect(f.store.retain(packet, requester, { ...clock, now: '200' })).rejects.toThrow(
      'clock window'
    )
    await expect(f.store.retain(packet, requester, { ...clock, now: '201' })).rejects.toThrow(
      'clock window'
    )
    await f.store.retain(packet, requester, clock)
    const changed = signed({ ...packet.body, reason: 'new signed meaning' })
    await expect(f.store.retain(changed, requester, clock)).rejects.toThrow('conflicts')
  } finally {
    await f.cleanup()
  }
})

it('retains SQL field and signed packet corruption detection after a positive read', async () => {
  const f = await fixture()
  const db = new DatabaseSync(f.path)
  try {
    const packet = signed()
    await f.store.retain(packet, requester, clock)
    db.prepare('UPDATE root_requests SET targets=targets+1').run()
    await expect(f.store.result(requester, packet.body.requestId, clock.now)).rejects.toThrow(
      'binding'
    )
    db.prepare('UPDATE root_requests SET targets=targets-1').run()
    const corrupt = structuredClone(packet)
    corrupt.body.reason = 'tampered'
    db.prepare('UPDATE root_requests SET packet=?').run(canonicalOutputJSON(corrupt))
    await expect(f.store.result(requester, packet.body.requestId, clock.now)).rejects.toThrow(
      'signature'
    )
  } finally {
    db.close()
    await f.cleanup()
  }
})

it('bounds retained identities and re-verifies the oldest after FIFO eviction', async () => {
  const f = await fixture()
  try {
    const packets = Array.from({ length: 257 }, (_, i) => signed(request(`cache_request_id_${i}`)))
    const verify = jest.spyOn(PublicKey.prototype, 'verify')
    for (let i = 0; i < 256; i++) await f.store.retain(packets[i], requester, clock)
    await f.store.retain(packets[0], requester, clock)
    expect(verify).toHaveBeenCalledTimes(256)
    await f.store.retain(packets[256], requester, clock)
    await f.store.retain(packets[1], requester, clock)
    expect(verify).toHaveBeenCalledTimes(257)
    await f.store.retain(packets[0], requester, clock)
    expect(verify).toHaveBeenCalledTimes(258)
  } finally {
    await f.cleanup()
  }
})

it('preserves large admitted request envelopes through cached reads', async () => {
  const f = await fixture()
  try {
    const body = request()
    body.targets[0].advertisement.beef = Buffer.alloc(750000, 7).toString('base64')
    const packet = signed(body)
    await f.store.retain(packet, requester, clock)
    expect((await f.store.retain(packet, requester, clock)).request).toEqual(packet)
  } finally {
    await f.cleanup()
  }
})
