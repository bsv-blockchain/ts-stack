import { expect, it } from '@jest/globals'
import { DatabaseSync } from 'node:sqlite'
import { outputRootAdvertisementDigest } from '@bsv/sdk'
import { SQLiteRootEvictionMaintenance } from '../src/root-eviction/SQLiteRootEvictionMaintenance.js'
import { SQLiteRootEvictionStore } from '../src/root-eviction/SQLiteRootEvictionStore.js'
import type { RootEvictionMaintenanceGuard } from '../src/root-eviction/RootEvictionMaintenanceStorage.js'
import { clock, fixture, policy, request, requester, signed } from './root-eviction-fixture.js'
import {
  coordinatedFixture,
  coordinatedRequest,
  contractSelection,
  coordinationGuard
} from './root-eviction-coordination-fixture.js'

const guard = (now = '150'): RootEvictionMaintenanceGuard => ({
  clock: () => now,
  authorize: () => true
})
const error = (code: string) => ({ code, message: expect.stringMatching(/\S/) })

it('scans bounded immutable digests, skips terminal requests and wraps to earlier new work', async () => {
  const f = await fixture(),
    worker = SQLiteRootEvictionMaintenance.open(f.path, f.configuration)
  try {
    const retained = []
    for (let i = 0; i < 4; i++)
      retained.push(
        await f.store.retain(signed(request(`maintenance_page_${i}`)), requester, clock)
      )
    retained.sort((a, b) => a.digest.localeCompare(b.digest))
    await worker.expirePending(retained[1].digest, guard('200'))
    const first = await worker.pendingPage({ maximum: 1 }, guard())
    expect(first.value).toEqual({ digests: [retained[0].digest], next: retained[0].digest })
    expect(first.head).toEqual(await f.store.head())
    expect(first.observedAt).toBe('150')
    const second = await worker.pendingPage({ maximum: 2, after: first.value.next }, guard())
    expect(second.value).toEqual({ digests: [retained[2].digest, retained[3].digest] })
    expect(
      (await worker.pendingPage({ maximum: 64, after: retained[3].digest }, guard())).value
    ).toEqual({ digests: [] })
    expect((await worker.pendingPage({ maximum: 64 }, guard())).value.digests).toEqual([
      retained[0].digest,
      retained[2].digest,
      retained[3].digest
    ])
    // A cursor can be lost or can precede concurrent insertion: only complete
    // wraparound promises to revisit every retained pending request.
    const later = await f.store.retain(signed(request('maintenance_later_work')), requester, clock)
    const restarted = SQLiteRootEvictionMaintenance.open(f.path, f.configuration)
    try {
      expect((await restarted.pendingPage({ maximum: 64 }, guard())).value.digests).toEqual(
        [retained[0].digest, retained[2].digest, retained[3].digest, later.digest].sort()
      )
    } finally {
      await restarted.close()
    }
    first.value.digests[0] = 'ff'.repeat(32)
    expect((await worker.pendingPage({ maximum: 1 }, guard())).value.digests[0]).toBe(
      retained[0].digest
    )
  } finally {
    await worker.close()
    await f.cleanup()
  }
})

it('expires partial work at the exact deadline without changing terminal actions or contracts', async () => {
  const f = await coordinatedFixture(),
    worker = SQLiteRootEvictionMaintenance.open(f.path, f.configuration)
  try {
    const body = coordinatedRequest('maintenance_partial')
    const other = structuredClone(body.targets[0])
    other.outpoint.outputIndex = 1
    other.advertisement.outputIndex = 1
    other.advertisementDigest = outputRootAdvertisementDigest({
      service: other.service,
      outpoint: other.outpoint,
      lockingScript: 'UQ=='
    })
    body.targets.push(other)
    const selection = contractSelection()
    const retained = await f.store.retainCoordinated(
      signed(body),
      requester,
      selection,
      f.contracts,
      coordinationGuard()
    )
    await f.store.evaluate({
      requestDigest: retained.value.digest,
      expectedRevision: '0',
      now: '150',
      targets: [{ index: 0, disposition: 'reject', reasonCode: 'manual-refusal', eligible: false }]
    })
    expect((await worker.expirePending(retained.value.digest, guard('199'))).value).toEqual({
      expiredTargets: [],
      pendingTargets: [1]
    })
    const expired = await worker.expirePending(retained.value.digest, guard('200'))
    expect(expired).toEqual({
      value: { expiredTargets: [1], pendingTargets: [] },
      head: { policyDigest: policy, revision: '2' },
      observedAt: '200'
    })
    const repeated = await worker.expirePending(retained.value.digest, guard('300'))
    expect(repeated.value).toEqual({ expiredTargets: [], pendingTargets: [] })
    expect(repeated.head.revision).toBe('2')
    const status = await f.store.resultCoordinated(
      requester,
      body.requestId,
      selection.selector,
      f.contracts,
      coordinationGuard('300')
    )
    expect(status.value.retained).toEqual(retained.value)
    expect(
      status.value.result.outcomes.map(({ actionStatus, reasonCode, revision }) => ({
        actionStatus,
        reasonCode,
        revision
      }))
    ).toEqual([
      { actionStatus: 'rejected', reasonCode: 'manual-refusal', revision: '1' },
      { actionStatus: 'rejected', reasonCode: 'request-expired', revision: '2' }
    ])
    expect((await worker.pendingPage({ maximum: 1 }, guard('300'))).value).toEqual({ digests: [] })
  } finally {
    await worker.close()
    await f.cleanup()
  }
})

it('uses installed maintenance authority independently of revoked requester access and unavailable chain context', async () => {
  const f = await fixture(),
    worker = SQLiteRootEvictionMaintenance.open(f.path, f.configuration)
  try {
    const body = request(),
      retained = await f.store.retain(signed(body), requester, clock)
    await expect(
      f.store.resultChecked(requester, body.requestId, {
        expectedPolicyDigest: policy,
        clock: () => '200',
        authorize: () => false,
        contextCurrent: () => false
      })
    ).rejects.toMatchObject(error('not-found'))
    let observed = false
    const expired = await worker.expirePending(retained.digest, {
      clock: () => '200',
      authorize: (head, now) => {
        expect(Object.isFrozen(head)).toBe(true)
        expect(head).toEqual({ policyDigest: policy, revision: '0' })
        expect(now).toBe('200')
        observed = true
        return true
      }
    })
    expect(observed).toBe(true)
    expect(expired.value.expiredTargets).toEqual([0])
    await expect(
      f.store.resultChecked(requester, body.requestId, {
        expectedPolicyDigest: policy,
        clock: () => '200',
        authorize: () => false,
        contextCurrent: () => false
      })
    ).rejects.toMatchObject(error('not-found'))
    await f.store.changePolicy('66'.repeat(32))
    expect((await worker.pendingPage({ maximum: 1 }, guard())).head.policyDigest).toBe(
      '66'.repeat(32)
    )
  } finally {
    await worker.close()
    await f.cleanup()
  }
})

it('checks maintenance authority before request existence or page validation', async () => {
  const f = await fixture(),
    worker = SQLiteRootEvictionMaintenance.open(f.path, f.configuration)
  try {
    const retained = await f.store.retain(signed(), requester, clock)
    for (const result of [false, undefined, 'true', 1, Promise.resolve(true)]) {
      const denied = { ...guard('200'), authorize: () => result as boolean }
      for (const digest of [retained.digest, 'ff'.repeat(32), 'malformed'])
        await expect(worker.expirePending(digest, denied)).rejects.toMatchObject(error('not-found'))
      await expect(worker.pendingPage({ maximum: 0 }, denied)).rejects.toMatchObject(
        error('not-found')
      )
    }
    expect((await f.store.head()).revision).toBe('0')
    await expect(worker.expirePending('ff'.repeat(32), guard())).rejects.toMatchObject(
      error('not-found')
    )
    await expect(worker.expirePending('bad', guard())).rejects.toMatchObject(error('invalid'))
  } finally {
    await worker.close()
    await f.cleanup()
  }
})

it('rejects invalid page bounds, cursors and asynchronous or invalid trusted clocks', async () => {
  const f = await fixture(),
    worker = SQLiteRootEvictionMaintenance.open(f.path, f.configuration)
  try {
    for (const maximum of [0, -1, 65, 1.5, NaN, Infinity, '1' as unknown as number])
      await expect(worker.pendingPage({ maximum }, guard())).rejects.toMatchObject(error('invalid'))
    await expect(worker.pendingPage({ maximum: 1, after: 'bad' }, guard())).rejects.toMatchObject(
      error('invalid')
    )
    await expect(
      worker.pendingPage({ maximum: 1, extra: true } as { maximum: number }, guard())
    ).rejects.toMatchObject(error('invalid'))
    for (const name of ['clock', 'authorize'] as const) {
      const invalid = guard()
      let called = false
      Reflect.set(invalid, name, async () => {
        called = true
        return true
      })
      await expect(worker.pendingPage({ maximum: 1 }, invalid)).rejects.toMatchObject(
        error('invalid')
      )
      expect(called).toBe(false)
    }
    await expect(worker.pendingPage({ maximum: 1 }, guard('01'))).rejects.toMatchObject(
      error('invalid')
    )
    expect(
      (await worker.pendingPage({ maximum: 64 }, guard('18446744073709551615'))).value
    ).toEqual({ digests: [] })
  } finally {
    await worker.close()
    await f.cleanup()
  }
})

it('does not need a legacy or readable original contract to expire an authenticated retained request', async () => {
  const f = await coordinatedFixture(),
    worker = SQLiteRootEvictionMaintenance.open(f.path, f.configuration)
  try {
    const retained = await f.store.retain(signed(coordinatedRequest()), requester, clock)
    const db = new DatabaseSync(f.path)
    try {
      db.exec('DROP TABLE root_contracts')
    } finally {
      db.close()
    }
    // The maintenance path does not load or invent a selection. A real protocol
    // coordinator still cannot recover this legacy operation as selected intake.
    expect((await worker.pendingPage({ maximum: 1 }, guard())).value.digests).toEqual([
      retained.digest
    ])
    expect(
      (await worker.expirePending(retained.digest, guard('200'))).value.expiredTargets
    ).toEqual([0])
    expect(
      (await f.store.result(requester, retained.request.body.requestId, '200')).outcomes[0]
        .reasonCode
    ).toBe('request-expired')
  } finally {
    await worker.close()
    await f.cleanup()
  }
})

it('fences an already-open old maintenance connection after explicit coordination migration', async () => {
  const f = await fixture(),
    worker = SQLiteRootEvictionMaintenance.open(f.path, f.configuration)
  try {
    const retained = await f.store.retain(signed(), requester, clock)
    const upgraded = SQLiteRootEvictionStore.upgradeCoordination(f.path, {
      ...f.configuration,
      coordination: {}
    })
    try {
      await expect(worker.pendingPage({ maximum: 1 }, guard())).rejects.toMatchObject(
        error('context-changed')
      )
      await expect(worker.expirePending(retained.digest, guard('200'))).rejects.toMatchObject(
        error('context-changed')
      )
      expect((await upgraded.head()).revision).toBe('0')
      const current = SQLiteRootEvictionMaintenance.open(f.path, {
        ...f.configuration,
        coordination: {}
      })
      try {
        expect(
          (await current.expirePending(retained.digest, guard('200'))).value.expiredTargets
        ).toEqual([0])
      } finally {
        await current.close()
      }
    } finally {
      await upgraded.close()
    }
  } finally {
    await worker.close()
    await f.cleanup()
  }
})

it('never creates missing storage and owns its connection lifetime', async () => {
  const f = await fixture()
  try {
    expect(() => SQLiteRootEvictionMaintenance.open(f.path + '.missing', f.configuration)).toThrow()
    const worker = SQLiteRootEvictionMaintenance.open(f.path, f.configuration)
    expect(worker.durability).toBe('durable')
    await worker.close()
    await worker.close()
    await expect(worker.pendingPage({ maximum: 1 }, guard())).rejects.toMatchObject(
      error('unavailable')
    )
    expect((await f.store.head()).revision).toBe('0')
  } finally {
    await f.cleanup()
  }
})
