import { expect, it, jest } from '@jest/globals'
import { PrivateKey, Utils } from '@bsv/sdk'
import { PrivatePublicationCoordinator } from '../src/private/PrivatePublicationCoordinator.js'
import { transactions } from './evidence-fixture.js'
import { allow } from './private-publication-fixture.js'
import type { PrivatePublicationAdmission } from '../src/private/PrivatePublicationPorts.js'

import { coordinatorFixture as fixture } from './private-publication-coordinator-fixture.js'

it('stages private bytes before admission and returns ready only after native binding', async () => {
  const f = fixture()
  const result = await f.coordinator.publish(f.contract.request, f.caller)
  expect(result).toEqual({
    version: 1,
    publicationId: f.status.publicationId,
    txid: f.contract.request.evidence.txid,
    status: 'ready',
    updatedAt: '20'
  })
  expect(f.native.rows()).toHaveLength(3)
  expect(f.calls).toHaveLength(1)
  expect(f.validate).toHaveBeenCalledTimes(1)
  const loaded = f.store.loadVerified(f.status.publicationId, () => '20', allow)!
  expect(loaded.binding.phase).toBe('active')
  expect(loaded.original.capability).toEqual(f.contract.record.capability)
  expect(JSON.stringify(result)).not.toContain('AQID')
})
it('status uses retained original state without new chain verification or discovery', async () => {
  const f = fixture()
  await f.coordinator.publish(f.contract.request, f.caller)
  f.time('101')
  f.validate.mockClear()
  f.manifest.mockClear()
  await expect(f.coordinator.status(f.status, f.caller)).resolves.toMatchObject({ status: 'ready' })
  expect(f.validate).not.toHaveBeenCalled()
  expect(f.manifest).not.toHaveBeenCalled()
})
it('recovers an expired manifest obligation and verifies alternate BEEF without changing its original contract', async () => {
  const f = fixture()
  await f.coordinator.publish(f.contract.request, f.caller)
  const original = structuredClone(
    f.store.loadVerified(f.status.publicationId, () => '20', allow)!.original
  )
  f.time('101')
  f.manifest.mockClear()
  const alternate = {
    ...f.contract.request,
    evidence: {
      ...f.contract.request.evidence,
      beef: Utils.toBase64(transactions.get('P')!.toBEEF())
    }
  }
  await expect(f.coordinator.publish(alternate, f.caller)).resolves.toMatchObject({
    status: 'ready'
  })
  expect(f.validate).toHaveBeenCalledTimes(2)
  expect(f.manifest).not.toHaveBeenCalled()
  expect(f.calls).toHaveLength(1)
  expect(f.store.loadVerified(f.status.publicationId, () => '101', allow)!.original).toEqual(
    original
  )
})
it('requires publisher ownership before revealing state or its original selector', async () => {
  const f = fixture()
  await f.coordinator.publish(f.contract.request, f.caller)
  const wrong = {
    ...f.caller,
    publisher: new PrivateKey(64).toPublicKey().toString(),
    capability: '99'.repeat(32)
  }
  await expect(f.coordinator.status(f.status, wrong)).rejects.toMatchObject({
    code: 'not-found',
    message: 'Private publication not found'
  })
  await expect(
    f.coordinator.status({ ...f.status, publicationId: '99'.repeat(32) }, wrong)
  ).rejects.toMatchObject({ code: 'not-found', message: 'Private publication not found' })
  f.revokeAccess()
  await expect(f.coordinator.status(f.status, f.caller)).rejects.toMatchObject({
    code: 'not-found',
    message: 'Private publication not found'
  })
})
it('rejects an unselected capability before verification or staging', async () => {
  const f = fixture()
  await expect(
    f.coordinator.publish(f.contract.request, { ...f.caller, capability: '99'.repeat(32) })
  ).rejects.toMatchObject({ code: 'context-changed' })
  expect(f.validate).not.toHaveBeenCalled()
  expect(f.native.rows()).toEqual([])
})
it('does not stage if the selected manifest expires during domain validation', async () => {
  const f = fixture()
  f.validate.mockImplementation(async () => f.time('101'))
  await expect(f.coordinator.publish(f.contract.request, f.caller)).rejects.toMatchObject({
    code: 'expired'
  })
  expect(f.native.rows()).toEqual([])
  expect(f.calls).toEqual([])
})
it('rejects invalid domain material before reserving any durable operation', async () => {
  const f = fixture()
  f.validate.mockRejectedValue(new Error('Synthetic key does not match the asset'))
  await expect(f.coordinator.publish(f.contract.request, f.caller)).rejects.toThrow(
    'Synthetic key does not match'
  )
  expect(f.native.rows()).toEqual([])
  expect(f.calls).toEqual([])
})
it('retains admitting across a lost reply and resumes the same operation', async () => {
  const f = fixture()
  const first = f.options.admission.recover
  let fail = true
  f.options.admission.recover = async (...args) => {
    const result = await first(...args)
    if (fail) {
      fail = false
      throw new Error('Lost reply after effect')
    }
    return result
  }
  const coordinator = new PrivatePublicationCoordinator(f.options)
  await expect(coordinator.publish(f.contract.request, f.caller)).rejects.toThrow(
    'Lost reply after effect'
  )
  expect(
    f.store.loadVerified(f.status.publicationId, () => '20', allow)!.fence.state.progress.phase
  ).toBe('admitting')
  f.time('101')
  await expect(coordinator.resume(f.status, f.caller)).resolves.toMatchObject({ status: 'ready' })
  expect(f.calls).toHaveLength(2)
  expect(new Set(f.calls).size).toBe(1)
})
it('returns pending for unresolved admission without inventing rejection or repeated work', async () => {
  const f = fixture()
  const recover = jest.fn<PrivatePublicationAdmission['recover']>(async job => ({
    status: 'unresolved',
    operationId: job.operationId,
    txid: job.request.evidence.txid
  }))
  const coordinator = new PrivatePublicationCoordinator({
    ...f.options,
    admission: { ...f.admission, recover }
  })
  await expect(coordinator.publish(f.contract.request, f.caller)).resolves.toMatchObject({
    status: 'pending'
  })
  expect(recover).toHaveBeenCalledTimes(1)
  expect(f.store.loadVerified(f.status.publicationId, () => '20', allow)!.binding.phase).toBe(
    'reserved'
  )
})
it('retains definitive selected-output exclusion without claiming transaction-wide rollback', async () => {
  const f = fixture()
  const coordinator = new PrivatePublicationCoordinator({
    ...f.options,
    admission: {
      ...f.admission,
      async recover(job) {
        return {
          status: 'excluded',
          operationId: job.operationId,
          txid: job.request.evidence.txid,
          steak: {
            [job.request.topic]: { outputsToAdmit: [], coinsToRetain: [], coinsRemoved: [] }
          },
          assessmentContextId: 'excluded-assessment',
          context: 'matching-private-values'
        }
      }
    }
  })
  await expect(coordinator.publish(f.contract.request, f.caller)).resolves.toMatchObject({
    status: 'rejected',
    reason: 'The original topic assessment excludes the selected output'
  })
  const loaded = f.store.loadVerified(f.status.publicationId, () => '20', allow)!
  expect(loaded.fence.state.progress).toMatchObject({
    phase: 'excluded',
    admission: { assessmentContextId: 'excluded-assessment' }
  })
  expect(loaded.binding.phase).toBe('reserved')
})
it('expires only a still-staged record before any admission reservation', async () => {
  const f = fixture()
  f.stage()
  f.time('31')
  await expect(f.coordinator.resume(f.status, f.caller)).resolves.toMatchObject({
    status: 'expired'
  })
  expect(f.calls).toEqual([])
})
it('checks original full chain premises before a physical stage', async () => {
  const f = fixture()
  f.validate.mockImplementation(async () => f.revokeChain())
  await expect(f.coordinator.publish(f.contract.request, f.caller)).rejects.toMatchObject({
    code: 'context-changed'
  })
  expect(f.native.rows()).toEqual([])
})
it('detects replacement of installed admission methods before effects', async () => {
  const f = fixture()
  f.admission.recover = async () => {
    throw new Error('Replacement must not run')
  }
  await expect(f.coordinator.publish(f.contract.request, f.caller)).rejects.toMatchObject({
    code: 'not-found'
  })
  expect(f.native.rows()).toEqual([])
})
it('retains occupied physical capacity after a cancelled non-cooperating validation', async () => {
  const f = fixture({ maximumWork: 1, perPublisherWork: 1 })
  let release: () => void = () => {},
    entered: () => void = () => {}
  const entry = new Promise<void>(resolve => {
    entered = resolve
  })
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  f.validate.mockImplementation(async () => {
    entered()
    await held
  })
  const abort = new AbortController()
  const pending = f.coordinator
    .publish(f.contract.request, { ...f.caller, signal: abort.signal })
    .then(
      value => ({ value }),
      error => ({ error })
    )
  try {
    try {
      await Promise.race([
        entry,
        pending.then(() => {
          throw new Error('Publication settled before its held validation was entered')
        })
      ])
      abort.abort()
      expect(await pending).toMatchObject({ error: { code: 'cancelled' } })
      await expect(f.coordinator.publish(f.contract.request, f.caller)).rejects.toMatchObject({
        code: 'limited'
      })
    } finally {
      release()
    }
    await new Promise(resolve => setImmediate(resolve))
    expect(f.native.rows()).toEqual([])
    f.validate.mockImplementation(async () => {})
    await expect(f.coordinator.publish(f.contract.request, f.caller)).resolves.toMatchObject({
      status: 'ready'
    })
  } finally {
    release()
    await f.coordinator.stop()
    await pending
  }
})

it('owns the remote body before asynchronous work can observe caller mutation', async () => {
  const f = fixture(),
    request = structuredClone(f.contract.request)
  const pending = f.coordinator.publish(request, f.caller)
  request.privateValues = 'BA=='
  request.evidence.txid = '99'.repeat(32)
  await expect(pending).resolves.toMatchObject({ status: 'ready' })
  expect(f.store.loadVerified(f.status.publicationId, () => '20', allow)!.blob.privateValues).toBe(
    'AQID'
  )
})
it('refuses readiness if original verification authority changes during admission', async () => {
  const f = fixture(),
    original = f.admission.recover
  const coordinator = new PrivatePublicationCoordinator({
    ...f.options,
    admission: {
      ...f.admission,
      async recover(...args) {
        const result = await original(...args)
        f.revokeChain()
        return result
      }
    }
  })
  await expect(coordinator.publish(f.contract.request, f.caller)).rejects.toMatchObject({
    code: 'context-changed'
  })
  const loaded = f.store.loadVerified(f.status.publicationId, () => '20', allow)!
  expect(loaded.fence.state.progress.phase).toBe('admitting')
  expect(loaded.binding.phase).toBe('reserved')
})
it('never associates a changed private payload with a retained semantic request fence', async () => {
  const f = fixture()
  await f.coordinator.publish(f.contract.request, f.caller)
  await expect(
    f.coordinator.publish({ ...f.contract.request, privateValues: 'BA==' }, f.caller)
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(f.calls).toHaveLength(1)
})
it('keeps a malformed or unrelated outcome pending without treating it as a no-effect rejection', async () => {
  const f = fixture(),
    original = f.admission.recover
  const recover = jest.fn<PrivatePublicationAdmission['recover']>(async (...args) => ({
    ...(await original(...args)),
    txid: '99'.repeat(32)
  }))
  const coordinator = new PrivatePublicationCoordinator({
    ...f.options,
    admission: { ...f.admission, recover }
  })
  await expect(coordinator.publish(f.contract.request, f.caller)).rejects.toMatchObject({
    code: 'conflict'
  })
  expect(
    f.store.loadVerified(f.status.publicationId, () => '20', allow)!.fence.state.progress.phase
  ).toBe('admitting')
  expect(recover).toHaveBeenCalledTimes(1)
})

it('stop revokes new intake and waits for non-cooperating physical validation to settle', async () => {
  const f = fixture()
  let release: () => void = () => {},
    entered: () => void = () => {}
  const entry = new Promise<void>(resolve => {
    entered = resolve
  })
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  f.validate.mockImplementation(async () => {
    entered()
    await held
  })
  const pending = f.coordinator.publish(f.contract.request, f.caller).then(
    value => ({ value }),
    error => ({ error })
  )
  try {
    await Promise.race([
      entry,
      pending.then(() => {
        throw new Error('Publication settled before its held validation was entered')
      })
    ])
    let settled = false
    const stopped = f.coordinator.stop().then(() => {
      settled = true
    })
    expect(await pending).toMatchObject({ error: { code: 'cancelled' } })
    expect(settled).toBe(false)
    await expect(f.coordinator.publish(f.contract.request, f.caller)).rejects.toMatchObject({
      code: 'cancelled'
    })
    release()
    await stopped
    expect(settled).toBe(true)
    expect(f.native.rows()).toEqual([])
    await f.coordinator.stop()
  } finally {
    release()
    await f.coordinator.stop()
    await pending
  }
})

it('supports one bounded work slot without requiring an explicit per-publisher override', async () => {
  const f = fixture({ maximumWork: 1 })
  await expect(f.coordinator.publish(f.contract.request, f.caller)).resolves.toMatchObject({
    status: 'ready'
  })
  await f.coordinator.stop()
})

it('composes the structural store contract through a separate implementation object', async () => {
  const f = fixture()
  const store = {
    stageVerified: f.store.stageVerified.bind(f.store),
    loadVerified: f.store.loadVerified.bind(f.store),
    loadStatus: f.store.loadStatus.bind(f.store),
    markUnavailable: f.store.markUnavailable.bind(f.store),
    advance: f.store.advance.bind(f.store),
    bindVerified: f.store.bindVerified.bind(f.store)
  }
  const coordinator = new PrivatePublicationCoordinator({ ...f.options, store })
  await expect(coordinator.publish(f.contract.request, f.caller)).resolves.toMatchObject({
    status: 'ready'
  })
  expect(f.store.loadVerified(f.status.publicationId, () => '20', allow)!.binding.phase).toBe(
    'active'
  )
  await coordinator.stop()
})
