import { expect, it, jest } from '@jest/globals'
import { outputPacketDigest, outputPrivatePublicationRequestDigest } from '@bsv/sdk'
import { coordinatorFixture } from './private-publication-coordinator-fixture.js'
import { PrivatePublicationCoordinator } from '../src/private/PrivatePublicationCoordinator.js'
import { PrivatePublicationWork } from '../src/private/PrivatePublicationWork.js'
import { PrivatePublicationReconciler } from '../src/private/PrivatePublicationReconciler.js'
import { allow } from './private-publication-fixture.js'

function fixture() {
  const f = coordinatorFixture()
  let allowed = true
  const worker = new PrivatePublicationWork(
    f.native.owner,
    f.contract.contracts,
    f.options.clock,
    () => allowed
  )
  const coordinator = new PrivatePublicationCoordinator({ ...f.options, worker })
  const stage = (requestId: string) => {
    requestId = 'reconcile-request-' + requestId
    const request = { ...f.contract.request, requestId }
    const id = outputPacketDigest('private-publication', {
      chain: f.contract.installation.chain,
      publisher: f.caller.publisher,
      topic: request.topic,
      requestId
    })
    f.store.stageVerified(
      request,
      f.selected,
      '30',
      {
        ...f.contract.record,
        publicationId: id,
        requestDigest: outputPrivatePublicationRequestDigest(request)
      },
      () => '20',
      allow
    )
    return id
  }
  return {
    ...f,
    worker,
    coordinator,
    stage,
    revokeWorker() {
      allowed = false
    }
  }
}
it('enumerates one bounded current page and preserves cursor wrapping across shared request fences', () => {
  const f = fixture(),
    ids = ['one', 'two', 'three'].map(f.stage)
  const first = f.worker.scan(null, 2)
  expect(first.entries).toHaveLength(2)
  expect(first.next).not.toBeNull()
  const second = f.worker.scan(first.next, 2)
  expect(second.entries).toHaveLength(1)
  expect(second.next).toBeNull()
  expect([...first.entries, ...second.entries].map(item => item.publicationId).sort()).toEqual(
    ids.sort()
  )
  expect(JSON.stringify(first)).not.toContain('AQID')
  expect(first.entries[0]).toMatchObject({
    phase: 'staged',
    publisher: f.caller.publisher,
    capability: f.caller.capability,
    profile: f.caller.profile
  })
})
it('reconciles using retained publishers and selectors without an HTTP session or fresh discovery', async () => {
  const f = fixture(),
    ids = ['one', 'two', 'three'].map(f.stage)
  const reconciler = new PrivatePublicationReconciler(f.coordinator, 2)
  const first = await reconciler.runOnce(),
    second = await reconciler.runOnce()
  expect(first.wrapped).toBe(false)
  expect(second.wrapped).toBe(true)
  expect([...first.outcomes, ...second.outcomes].map(item => item.status)).toEqual([
    'ready',
    'ready',
    'ready'
  ])
  expect(f.calls).toHaveLength(3)
  expect(f.manifest).not.toHaveBeenCalled()
  expect((await reconciler.runOnce()).outcomes).toEqual([])
  for (const id of ids) expect(f.worker.resolve(id)).toBeUndefined()
})
it('rechecks the current publisher policy independently of internal worker authority', async () => {
  const f = fixture()
  f.stage('one')
  f.revokeAccess()
  const result = await new PrivatePublicationReconciler(f.coordinator).runOnce()
  expect(result.outcomes).toEqual([{ publicationId: expect.any(String), status: 'not-found' }])
  expect(f.calls).toEqual([])
})
it('stops enumerating when the installed internal worker authority is revoked', async () => {
  const f = fixture()
  f.stage('one')
  f.revokeWorker()
  await expect(new PrivatePublicationReconciler(f.coordinator).runOnce()).rejects.toMatchObject({
    code: 'context-changed'
  })
  expect(f.calls).toEqual([])
})
it('retains pending work and finite passes for an unresolved admission', async () => {
  const f = fixture(),
    id = f.stage('one')
  const recover = jest.fn<typeof f.admission.recover>(async job => ({
    status: 'unresolved',
    operationId: job.operationId,
    txid: job.request.evidence.txid
  }))
  const coordinator = new PrivatePublicationCoordinator({
    ...f.options,
    worker: f.worker,
    admission: { ...f.admission, recover }
  })
  const reconciler = new PrivatePublicationReconciler(coordinator, 1)
  expect((await reconciler.runOnce()).outcomes).toEqual([{ publicationId: id, status: 'pending' }])
  expect((await reconciler.runOnce()).outcomes).toEqual([{ publicationId: id, status: 'pending' }])
  expect(recover).toHaveBeenCalledTimes(2)
})
it('waits for physical settlement on loop stop and refuses an overlapping pass', async () => {
  const f = fixture()
  f.stage('one')
  let release: () => void = () => {},
    entered: () => void = () => {}
  const entry = new Promise<void>(resolve => {
    entered = resolve
  })
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const original = f.admission.recover
  const coordinator = new PrivatePublicationCoordinator({
    ...f.options,
    worker: f.worker,
    admission: {
      ...f.admission,
      async recover(...args) {
        entered()
        await held
        return original(...args)
      }
    }
  })
  const reconciler = new PrivatePublicationReconciler(coordinator)
  let completedPass: () => void = () => {}
  const unexpectedPass = new Promise<never>((_resolve, reject) => {
    completedPass = () => reject(new Error('Reconciliation pass completed before held admission'))
  })
  const loop = reconciler.start(100, completedPass)
  try {
    await Promise.race([
      entry,
      unexpectedPass,
      loop.done.then(() => {
        throw new Error('Reconciliation loop settled before held admission')
      })
    ])
    await expect(reconciler.runOnce()).rejects.toMatchObject({ code: 'limited' })
    let stopped = false
    const closing = loop.stop().then(() => {
      stopped = true
    })
    await new Promise(resolve => setImmediate(resolve))
    expect(stopped).toBe(false)
    release()
    await closing
    await loop.done
    expect(stopped).toBe(true)
  } finally {
    release()
    await loop.stop()
    await loop.done
    await coordinator.stop()
  }
  expect(
    f.store.loadVerified(f.worker.scan(null, 1).entries[0].publicationId, () => '20', allow)!.fence
      .state.progress.phase
  ).toBe('admitting')
  expect(() => reconciler.start(100, () => {})).toThrow('already started or stopped')
})
it('expires only unreserved staged work after restart and preserves permanent fences', async () => {
  const f = fixture(),
    id = f.stage('one')
  f.time('31')
  const result = await new PrivatePublicationReconciler(f.coordinator).runOnce()
  expect(result.outcomes).toEqual([{ publicationId: id, status: 'expired' }])
  expect(f.native.rows()).toHaveLength(3)
  expect(f.calls).toEqual([])
})
it('requires explicit worker installation and validates finite page and interval bounds', async () => {
  const f = coordinatorFixture()
  expect(() => f.coordinator.scanWork(null, 1)).toThrow('worker is not installed')
  expect(() => f.coordinator.reconcile(f.status.publicationId)).toThrow('worker is not installed')
  for (const size of [0, 65, 1.5])
    expect(() => new PrivatePublicationReconciler(f.coordinator, size)).toThrow('page capacity')
  for (const interval of [0, 99, 60001, 100.5])
    expect(() => new PrivatePublicationReconciler(f.coordinator).start(interval, () => {})).toThrow(
      'interval'
    )
})
