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

import { getEventListeners } from 'node:events'
import { privatePublicationFenceAddress } from '../src/private/PrivatePublicationRecords.js'
import type { ProtectedLedgerRecord } from '../src/private/ProtectedLedgerCodec.js'

function replaceWorkFormat(
  f: ReturnType<typeof fixture>,
  id: string,
  format: ProtectedLedgerRecord['value']['format'] | undefined
) {
  const ledger = f.native.owner.ledger,
    address = privatePublicationFenceAddress(f.native.owner.identity, id),
    read = ledger.read([address], f.options.clock, allow),
    record = read.records[0]!
  expect(record).toBeDefined()
  const value = { ...record.value }
  if (format === undefined) delete value.format
  else value.format = format
  ledger.commit(
    read.revision,
    [
      {
        kind: record.kind,
        key: record.key,
        expectedRevision: record.revision,
        reservedBytes: record.reservedBytes,
        reservedUpdates: Math.max(0, record.reservedUpdates - 1),
        value
      }
    ],
    f.options.clock,
    allow
  )
  return address
}

it('does not read records for an empty actual native worker page', () => {
  const f = fixture(),
    read = jest.spyOn(f.native.owner.ledger, 'read')
  try {
    const worker = new PrivatePublicationWork(
      f.native.owner,
      f.contract.contracts,
      f.options.clock,
      () => true
    )
    expect(worker.scan(null, 1)).toEqual({ entries: [], blocked: [], next: null })
    expect(read).not.toHaveBeenCalled()
    expect(worker.resolve('99'.repeat(32))).toBeUndefined()
    expect(read).toHaveBeenCalledTimes(1)
  } finally {
    read.mockRestore()
  }
})

it('rechecks every originally installed work capability before granting currentness', () => {
  for (const name of ['read', 'enumerate'] as const) {
    const f = fixture(),
      changed = jest.spyOn(f.native.owner.ledger, name)
    try {
      expect(f.worker.isCurrent()).toBe(false)
    } finally {
      changed.mockRestore()
    }
    expect(f.worker.isCurrent()).toBe(true)
  }
  const f = fixture(),
    changed = jest.spyOn(f.contract.contracts, 'restore')
  try {
    expect(f.worker.isCurrent()).toBe(false)
  } finally {
    changed.mockRestore()
  }
  expect(f.worker.isCurrent()).toBe(true)
})

it('rejects an asynchronous worker verdict and consumes its actual rejected promise', async () => {
  const f = fixture(),
    error = new Error('private worker failure'),
    verdict = Promise.reject(error),
    caught = jest.spyOn(verdict, 'catch')
  try {
    const worker = new PrivatePublicationWork(
      f.native.owner,
      f.contract.contracts,
      f.options.clock,
      (() => verdict) as unknown as () => boolean
    )
    expect(worker.isCurrent()).toBe(false)
    expect(caught).toHaveBeenCalledWith(expect.any(Function))
    await expect(verdict).rejects.toBe(error)
  } finally {
    caught.mockRestore()
  }
})

it('rechecks cancellation after a synchronous worker authority callback returns', () => {
  const f = fixture(),
    controller = new AbortController(),
    current = jest.fn(() => {
      controller.abort()
      return true
    })
  const worker = new PrivatePublicationWork(
    f.native.owner,
    f.contract.contracts,
    f.options.clock,
    current
  )
  expect(worker.isCurrent(controller.signal)).toBe(false)
  expect(current).toHaveBeenCalledTimes(1)
  expect(worker.isCurrent(controller.signal)).toBe(false)
  expect(current).toHaveBeenCalledTimes(1)
})

it.each([undefined, null, 0, 'other-service-fence/1', 'unrelated-private-publication-fence/'])(
  'does not reinterpret another native fence format %p',
  format => {
    const f = fixture(),
      id = f.stage('foreign-format')
    replaceWorkFormat(f, id, format)
    expect(f.worker.scan(null, 16)).toEqual({ entries: [], blocked: [], next: null })
    expect(f.worker.resolve(id)).toBeUndefined()
  }
)

it.each(['private-publication-fence/1', 'private-publication-fence/21'])(
  'retains unsupported historical work format %s as a blocked native record',
  format => {
    const f = fixture(),
      id = f.stage('historical-format'),
      address = replaceWorkFormat(f, id, format)
    expect(f.worker.scan(null, 16)).toEqual({
      entries: [],
      blocked: [{ key: address.key, status: 'unsupported' }],
      next: null
    })
    expect(() => f.worker.resolve(id)).toThrow(
      expect.objectContaining({
        code: 'unsupported',
        message: 'Publication work requires its original verified contract'
      })
    )
    expect(f.native.rows()).toHaveLength(3)
  }
)

it('skips a missing enumerated record without inventing work or replacing its native owner', () => {
  const f = fixture()
  f.stage('missing-read')
  const ledger = f.native.owner.ledger,
    actual = ledger.read.bind(ledger),
    read = jest.spyOn(ledger, 'read').mockImplementation((...args) => {
      const result = actual(...args)
      return { ...result, records: result.records.map(() => undefined) }
    })
  try {
    const worker = new PrivatePublicationWork(
      f.native.owner,
      f.contract.contracts,
      f.options.clock,
      () => true
    )
    expect(worker.scan(null, 16)).toEqual({ entries: [], blocked: [], next: null })
    expect(read).toHaveBeenCalledTimes(1)
    expect(f.native.rows()).toHaveLength(3)
  } finally {
    read.mockRestore()
  }
})

it('redacts a non-protocol restore failure after actual native record validation', () => {
  const f = fixture(),
    id = f.stage('restore-failure'),
    restore = f.contract.contracts.restore.bind(f.contract.contracts),
    changed = jest.spyOn(f.contract.contracts, 'restore').mockImplementation(capability => {
      restore(capability)
      throw new Error('protected restore diagnostic')
    })
  try {
    const worker = new PrivatePublicationWork(
        f.native.owner,
        f.contract.contracts,
        f.options.clock,
        () => true
      ),
      page = worker.scan(null, 16)
    expect(page).toEqual({
      entries: [],
      blocked: [
        {
          key: privatePublicationFenceAddress(f.native.owner.identity, id).key,
          status: 'unavailable'
        }
      ],
      next: null
    })
    expect(JSON.stringify(page)).not.toContain('protected restore diagnostic')
  } finally {
    changed.mockRestore()
  }
})

it('rejects replacement of each actual coordinator method before reconciliation begins', async () => {
  for (const name of ['scanWork', 'reconcile', 'drainReconciliation'] as const) {
    const f = fixture(),
      reconciler = new PrivatePublicationReconciler(f.coordinator),
      changed = jest.spyOn(f.coordinator, name)
    try {
      await expect(reconciler.runOnce()).rejects.toMatchObject({
        code: 'context-changed',
        message: 'Private publication reconciler stopped or changed'
      })
    } finally {
      changed.mockRestore()
    }
    expect((await reconciler.runOnce()).outcomes).toEqual([])
  }
})

it('cancels after a real scan before starting any admission from that page', async () => {
  const f = fixture(),
    controller = new AbortController()
  f.stage('cancel-after-scan')
  const scan = f.coordinator.scanWork.bind(f.coordinator),
    changed = jest.spyOn(f.coordinator, 'scanWork').mockImplementation((...args) => {
      const page = scan(...args)
      controller.abort()
      return page
    })
  try {
    await expect(
      new PrivatePublicationReconciler(f.coordinator).runOnce(controller.signal)
    ).rejects.toMatchObject({
      code: 'cancelled',
      message: 'Private publication reconciliation cancelled'
    })
    expect(f.calls).toEqual([])
  } finally {
    changed.mockRestore()
  }
})

it('reports unavailable without exposing an ordinary admission failure', async () => {
  const f = fixture(),
    id = f.stage('unavailable')
  const coordinator = new PrivatePublicationCoordinator({
    ...f.options,
    worker: f.worker,
    admission: {
      ...f.admission,
      async recover() {
        throw new Error('protected admission diagnostic')
      }
    }
  })
  const result = await new PrivatePublicationReconciler(coordinator).runOnce()
  expect(result.outcomes).toEqual([{ publicationId: id, status: 'unavailable' }])
  expect(JSON.stringify(result)).not.toContain('protected admission diagnostic')
})

it('reports no pending work after another actual reconciliation completes the enumerated item', async () => {
  const f = fixture(),
    id = f.stage('already-completed'),
    original = f.coordinator.reconcile.bind(f.coordinator),
    changed = jest.spyOn(f.coordinator, 'reconcile').mockImplementation(async (...args) => {
      await original(...args)
      expect(await original(...args)).toBeUndefined()
      return undefined
    })
  try {
    expect((await new PrivatePublicationReconciler(f.coordinator).runOnce()).outcomes).toEqual([
      { publicationId: id, status: 'no-pending-work' }
    ])
    expect(f.calls).toHaveLength(1)
    expect(f.worker.resolve(id)).toBeUndefined()
  } finally {
    changed.mockRestore()
  }
})

it('requires a synchronous report function before starting its loop', () => {
  const f = fixture()
  for (const observer of [undefined, null, {}, 'observer', async () => {}]) {
    expect(() =>
      new PrivatePublicationReconciler(f.coordinator).start(100, observer as unknown as () => void)
    ).toThrow('Publication reconciler requires a synchronous report observer')
  }
})

it('rejects a non-undefined observer result while preserving observable settlement', async () => {
  const f = fixture(),
    reconciler = new PrivatePublicationReconciler(f.coordinator),
    loop = reconciler.start(100, () => true)
  await expect(loop.done).rejects.toThrow(
    'Publication reconciliation observer must finish synchronously'
  )
  await expect(loop.stop()).rejects.toThrow(
    'Publication reconciliation observer must finish synchronously'
  )
})

it('consumes a rejected observer promise while refusing asynchronous observer completion', async () => {
  const f = fixture(),
    error = new Error('private observer failure'),
    promises: Promise<never>[] = []
  const loop = new PrivatePublicationReconciler(f.coordinator).start(100, () => {
    const value = Promise.reject(error)
    promises.push(value)
    return value
  })
  await expect(loop.done).rejects.toThrow(
    'Publication reconciliation observer must finish synchronously'
  )
  await expect(promises[0]).rejects.toBe(error)
  await expect(loop.stop()).rejects.toThrow(
    'Publication reconciliation observer must finish synchronously'
  )
})

it('propagates the original observer failure after draining the actual coordinator', async () => {
  const f = fixture(),
    error = new Error('original observer failure'),
    drain = jest.spyOn(f.coordinator, 'drainReconciliation')
  try {
    const loop = new PrivatePublicationReconciler(f.coordinator).start(100, () => {
      throw error
    })
    await expect(loop.done).rejects.toBe(error)
    await expect(loop.stop()).rejects.toBe(error)
    expect(drain).toHaveBeenCalledTimes(2)
  } finally {
    drain.mockRestore()
  }
})

it('starts one finite pass per interval and removes each actual abort listener before the next delay', async () => {
  const f = fixture(),
    scan = jest.spyOn(f.coordinator, 'scanWork'),
    report = jest.fn<(result: unknown) => void>()
  jest.useFakeTimers()
  let loop: ReturnType<PrivatePublicationReconciler['start']> | undefined
  try {
    const reconciler = new PrivatePublicationReconciler(f.coordinator)
    loop = reconciler.start(100, report)
    expect(() => reconciler.start(100, report)).toThrow(
      'Private publication reconciler already started or stopped'
    )
    await jest.advanceTimersByTimeAsync(0)
    expect(report).toHaveBeenCalledTimes(1)
    const signal = scan.mock.calls[0][2]!
    expect(getEventListeners(signal, 'abort')).toHaveLength(1)
    await jest.advanceTimersByTimeAsync(100)
    expect(report).toHaveBeenCalledTimes(2)
    expect(getEventListeners(signal, 'abort')).toHaveLength(1)
    await loop.stop()
    await loop.done
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    if (loop) await loop.stop()
    jest.useRealTimers()
    scan.mockRestore()
  }
})
