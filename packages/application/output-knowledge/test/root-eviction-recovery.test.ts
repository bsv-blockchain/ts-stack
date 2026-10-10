import { expect, it, jest } from '@jest/globals'
import { DatabaseSync } from 'node:sqlite'
import { SQLiteRootEvictionMaintenance } from '../src/root-eviction/SQLiteRootEvictionMaintenance.js'
import { fixture, clock, requester, signed } from './root-eviction-fixture.js'
import {
  coordinatedFixture,
  coordinatedRequest,
  contractSelection,
  coordinationGuard
} from './root-eviction-coordination-fixture.js'

const error = (code: string) => ({ code, message: expect.stringMatching(/\S/) })

it('recovers original signed selection and complete status by durable digest without discovery or requester impersonation', async () => {
  const f = await coordinatedFixture()
  try {
    const body = coordinatedRequest(),
      selection = contractSelection()
    const first = await f.store.retainCoordinated(
      signed(body),
      requester,
      selection,
      f.contracts,
      coordinationGuard()
    )
    const discovery = jest.spyOn(f.contracts, 'retain').mockImplementation(() => {
      throw new Error('Current discovery is unavailable')
    })
    const current = f.reopen()
    const observed = await current.recoverCoordinated(
      first.value.digest,
      f.contracts,
      coordinationGuard('300')
    )
    expect(discovery).not.toHaveBeenCalled()
    expect(observed.value.retained).toEqual(first.value)
    expect(observed.head.revision).toBe('1')
    expect(observed.observedAt).toBe('300')
    expect(observed.value.result.outcomes[0]).toMatchObject({
      actionStatus: 'rejected',
      reasonCode: 'request-expired',
      revision: '1'
    })
    expect(observed).toEqual(
      await current.resultCoordinated(
        requester,
        body.requestId,
        selection.selector,
        f.contracts,
        coordinationGuard('300')
      )
    )
    observed.value.retained.request.body.reason = 'modified'
    observed.value.retained.contract.selection.manifest.body.baseURL =
      'https://modified.example.test'
    expect(
      (await current.recoverCoordinated(first.value.digest, f.contracts, coordinationGuard('301')))
        .value.retained
    ).toEqual(first.value)
  } finally {
    await f.cleanup()
  }
})

it('checks current local recovery authority before record identity and does not let context failure starve independent expiry', async () => {
  const f = await coordinatedFixture()
  const maintenance = SQLiteRootEvictionMaintenance.open(f.path, f.configuration)
  try {
    const first = await f.store.retainCoordinated(
      signed(coordinatedRequest()),
      requester,
      contractSelection(),
      f.contracts,
      coordinationGuard()
    )
    const denied = { ...coordinationGuard('200'), authorize: () => false }
    for (const digest of [first.value.digest, 'ff'.repeat(32), 'invalid'])
      await expect(f.store.recoverCoordinated(digest, f.contracts, denied)).rejects.toMatchObject(
        error('not-found')
      )
    await expect(
      f.store.recoverCoordinated('ff'.repeat(32), f.contracts, coordinationGuard())
    ).rejects.toMatchObject(error('not-found'))
    await expect(
      f.store.recoverCoordinated('invalid', f.contracts, coordinationGuard())
    ).rejects.toMatchObject(error('invalid'))
    const unavailableContext = { ...coordinationGuard('200'), contextCurrent: () => false }
    await expect(
      f.store.recoverCoordinated(first.value.digest, f.contracts, unavailableContext)
    ).rejects.toMatchObject(error('context-changed'))
    expect((await f.store.head()).revision).toBe('0')
    await maintenance.expirePending(first.value.digest, {
      clock: () => '200',
      authorize: () => true
    })
    expect((await f.store.head()).revision).toBe('1')
    await expect(
      f.store.recoverCoordinated(first.value.digest, f.contracts, unavailableContext)
    ).rejects.toMatchObject(error('context-changed'))
    expect(
      (await f.store.recoverCoordinated(first.value.digest, f.contracts, coordinationGuard('201')))
        .value.result.outcomes[0].reasonCode
    ).toBe('request-expired')
  } finally {
    await maintenance.close()
    await f.cleanup()
  }
})

it('never adopts an unselected legacy request using current discovery', async () => {
  for (const coordinated of [false, true]) {
    const f = coordinated ? await coordinatedFixture() : await fixture()
    try {
      const body = coordinated ? coordinatedRequest() : undefined
      const retained = await f.store.retain(signed(body), requester, clock)
      const c = await coordinatedFixture()
      try {
        await expect(
          f.store.recoverCoordinated(retained.digest, c.contracts, coordinationGuard())
        ).rejects.toMatchObject(error('unavailable'))
        expect(await f.store.get(requester, retained.request.body.requestId)).toEqual(retained)
        expect((await f.store.head()).revision).toBe('0')
      } finally {
        await c.cleanup()
      }
    } finally {
      await f.cleanup()
    }
  }
})

it('requires the saved selector to authenticate the same original capability and preserves completed actions after policy changes', async () => {
  const f = await coordinatedFixture()
  try {
    const body = coordinatedRequest(),
      selection = contractSelection()
    const first = await f.store.retainCoordinated(
      signed(body),
      requester,
      selection,
      f.contracts,
      coordinationGuard()
    )
    await f.store.evaluate({
      requestDigest: first.value.digest,
      expectedRevision: '0',
      now: '150',
      targets: [{ index: 0, disposition: 'reject', eligible: false, reasonCode: 'manual-refusal' }]
    })
    const before = await f.store.recoverCoordinated(
      first.value.digest,
      f.contracts,
      coordinationGuard()
    )
    await f.store.changePolicy('77'.repeat(32))
    await expect(
      f.store.recoverCoordinated(first.value.digest, f.contracts, coordinationGuard())
    ).rejects.toMatchObject(error('context-changed'))
    const now = await f.store.recoverCoordinated(first.value.digest, f.contracts, {
      ...coordinationGuard('201'),
      expectedPolicyDigest: '77'.repeat(32)
    })
    expect(now.value.retained).toEqual(before.value.retained)
    expect(now.value.result.policyDigest).toBe(before.value.result.policyDigest)
    expect(now.value.result.outcomes[0]).toMatchObject({
      actionStatus: 'rejected',
      reasonCode: 'manual-refusal',
      revision: '1'
    })
    expect(now.head.revision).toBe('2')
    const db = new DatabaseSync(f.path)
    try {
      db.prepare('UPDATE root_contracts SET selector=?').run('ff'.repeat(32))
    } finally {
      db.close()
    }
    await expect(
      f.store.recoverCoordinated(first.value.digest, f.contracts, {
        ...coordinationGuard(),
        expectedPolicyDigest: '77'.repeat(32)
      })
    ).rejects.toMatchObject(error('context-changed'))
    expect((await f.store.head()).revision).toBe('2')
  } finally {
    await f.cleanup()
  }
})
