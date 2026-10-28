import { test, expect } from '@jest/globals'
import { PrivateKey, outputAssert, OutputProtocolError } from '@bsv/sdk'
import { purchaseCoordinatorFixture as fixture } from './private-purchase-coordinator.fixture.js'
import { PrivatePurchaseCoordinator } from '../src/private/PrivatePurchaseCoordinator.js'
import { ownPrivatePurchaseAdmissionOutcome } from '../src/private/PrivatePurchasePorts.js'

test('passes owned complete retained candidate bytes to issuance and preserves the native original', async () => {
  const f = fixture()
  let retained: unknown
  const prior = f.owner.domain.issue
  f.owner.domain.issue = async (...args) => {
    retained = structuredClone(args[4])
    if (args[4]) args[4].beef = 'AA=='
    return prior(...args)
  }
  await f.reopen()
  try {
    await f.prepare()
    await f.submit()
    expect(retained).toEqual(f.f.candidate)
    expect(f.current()!.candidate).toEqual(f.f.candidate)
    expect(f.current()!.progress.status).toBe('delivered')
  } finally {
    await f.dispose()
  }
})

test('reconciles another native writer completing the exact admission while this call is outstanding', async () => {
  let f: ReturnType<typeof fixture>
  f = fixture({
    admission: {
      recover: async (job, _signal, context) => {
        context.checkCurrent()
        const current = f.current()!
        f.owner.store.advance(
          f.f.id,
          f.caller.buyer,
          current.row.revision,
          {
            type: 'admitted',
            steak: f.f.f.steak,
            acceptedAt: '20',
            assessmentContextId: 'other-writer'
          },
          f.f.clock,
          f.f.guard
        )
        return {
          status: 'admitted',
          operationId: job.operationId,
          txid: job.candidate.txid,
          steak: f.f.f.steak,
          acceptedAt: '20',
          assessmentContextId: 'other-writer'
        }
      }
    }
  })
  try {
    await f.prepare()
    await f.submit()
    expect(f.current()!.progress).toMatchObject({
      status: 'delivered',
      admission: { assessmentContextId: 'other-writer' }
    })
    expect(f.counts.issue).toBe(1)
    expect(f.counts.potatoes).toBe(1)
  } finally {
    await f.dispose()
  }
})

test('drains returned authority promises without treating them as synchronous permission', async () => {
  const f = fixture(),
    caller = {
      ...f.caller,
      current: (() => Promise.reject(new Error('async authentication'))) as never
    }
  try {
    await expect(f.coordinator.prepare(f.f.f.f.request, caller)).rejects.toMatchObject({
      code: 'context-changed'
    })
    expect(f.current()).toBeUndefined()
  } finally {
    await f.dispose()
  }
})

test('reopens actual native preparation, unknown admission and exact immutable delivered bytes', async () => {
  const f = fixture()
  await f.prepare()
  const original = f.current()!.custody.original
  await f.reopen()
  await f.prepare()
  expect(f.current()!.custody.original).toEqual(original)
  expect(f.counts.prepare).toBe(1)
  f.setAdmitted(false)
  await f.submit()
  const operation = f.current()!.progress.operationId
  await f.reopen()
  f.setAdmitted(true)
  await f.recover()
  const delivered = f.projected()
  await f.reopen()
  f.setRelease(false)
  f.setAvailable(false)
  await f.recover()
  expect(f.projected()).toEqual(delivered)
  expect(f.current()!.progress.operationId).toBe(operation)
  expect(f.counts.issue).toBe(1)
  await f.dispose()
})

test.each(['prepare', 'pin', 'complete'] as const)(
  'lost native %s reply retains the original operation and result',
  async method => {
    const f = fixture()
    const native = f.owner.store[method].bind(f.owner.store)
    let lost = false
    f.owner.store[method] = ((...args: unknown[]) => {
      const result = (native as (...values: unknown[]) => unknown)(...args)
      if (!lost) {
        lost = true
        throw new Error('Lost native reply')
      }
      return result
    }) as never
    const coordinator = new PrivatePurchaseCoordinator(f.owner)
    if (method === 'prepare') {
      await expect(coordinator.prepare(f.f.f.f.request, f.caller)).rejects.toThrow(
        'Lost native reply'
      )
      await coordinator.prepare(f.f.f.f.request, f.caller)
      expect(f.counts.prepare).toBe(1)
    } else {
      await coordinator.prepare(f.f.f.f.request, f.caller)
      await expect(coordinator.submit(f.f.candidate, f.caller)).rejects.toThrow('Lost native reply')
      const signatureCount = f.counts.potatoes
      await coordinator.recover(f.f.id, f.caller)
      if (method === 'complete') expect(f.counts.potatoes).toBe(signatureCount)
      expect(f.current()!.progress.status).toBe('delivered')
      expect(f.counts.admission).toBe(1)
    }
    await coordinator.stop()
  }
)

test('retains original preparation and performs one staged admission before one private result', async () => {
  const f = fixture()
  expect(await f.prepare()).toBe(f.f.id)
  const first = f.current()!.custody.original
  await f.prepare()
  expect(f.current()!.custody.original).toEqual(first)
  expect(f.counts.prepare).toBe(1)
  expect(f.counts.terms).toBe(1)
  expect(f.counts.admission).toBe(0)
  expect(await f.submit()).toBe(f.f.id)
  expect(f.projected()).toMatchObject({
    result: {
      status: 'delivered',
      steak: f.f.f.steak,
      potatoes: { body: { secret: f.f.custody.material } }
    },
    releaseEvidence: { acceptedAt: '20' }
  })
  const exact = f.projected()
  await f.recover()
  expect(f.projected()).toEqual(exact)
  expect(f.counts.admission).toBe(1)
  expect(f.counts.issue).toBe(1)
  expect(f.current()!.custody.original).toEqual(first)
  await f.coordinator.stop()
})

test('refuses missing readiness, changed request and wrong selected host before effects', async () => {
  const f = fixture()
  f.setAvailable(false)
  await expect(f.prepare()).rejects.toMatchObject({ code: 'unavailable' })
  expect(f.current()).toBeUndefined()
  f.setAvailable(true)
  await f.prepare()
  await expect(
    f.coordinator.prepare({ ...f.f.f.f.request, request: 'AQ==' }, f.caller)
  ).rejects.toMatchObject({ code: 'conflict' })
  await expect(
    f.coordinator.recover(f.f.id, { ...f.caller, capability: '77'.repeat(32) })
  ).rejects.toMatchObject({ code: 'context-changed' })
  expect(f.counts.admission).toBe(0)
  expect(f.counts.issue).toBe(0)
})

test('invalid candidate leaves the acquisition unpinned and permits a corrected candidate', async () => {
  const f = fixture()
  await f.prepare()
  f.setValidation(false)
  await expect(f.submit()).rejects.toMatchObject({ code: 'invalid' })
  expect(f.current()!.progress).toMatchObject({ status: 'prepared', txid: null })
  expect(f.counts.admission).toBe(0)
  f.setValidation(true)
  await f.submit()
  expect(f.current()!.progress.status).toBe('delivered')
})

test('unknown admission stays pinned; another transaction never invokes admission', async () => {
  const f = fixture()
  await f.prepare()
  f.setAdmitted(false)
  await f.submit()
  expect(f.current()!.progress).toMatchObject({
    status: 'admission-pending',
    txid: f.f.candidate.txid
  })
  const beforeConflict = f.current(),
    verified = f.counts.verify
  await expect(
    f.coordinator.submit({ ...f.f.candidate, txid: 'aa'.repeat(32) }, f.caller)
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(f.counts.verify).toBe(verified)
  expect(f.current()).toEqual(beforeConflict)
  expect(f.counts.admission).toBe(1)
  expect(f.counts.issue).toBe(0)
  f.setAdmitted(true)
  await f.recover()
  expect(f.current()!.progress.status).toBe('delivered')
})

test('retains STEAK while release is delayed and preserves an obligation after its deadline', async () => {
  const f = fixture()
  await f.prepare()
  f.setRelease(false)
  await f.submit()
  expect(f.projected()).toMatchObject({
    result: { status: 'admitted-delivery-pending', steak: f.f.f.steak }
  })
  expect(JSON.stringify(f.projected())).not.toContain('secret')
  expect(f.counts.issue).toBe(0)
  f.f.setNow('100000')
  f.setAvailable(false)
  f.setRelease(true)
  await f.recover()
  expect(f.current()!.progress.status).toBe('delivered')
  expect(f.counts.prepare).toBe(1)
  expect(f.counts.admission).toBe(1)
})

test('issuer failure after admission leaves its original recoverable private intent', async () => {
  const f = fixture()
  await f.prepare()
  f.setIssue(false)
  await expect(f.submit()).rejects.toThrow('issuer unavailable')
  expect(f.current()!.progress.status).toBe('admitted-delivery-pending')
  f.setIssue(true)
  await f.recover()
  expect(f.counts.admission).toBe(1)
  expect(f.current()!.progress.status).toBe('delivered')
})

test('unconstructed expiry has no transaction and never charges or admits', async () => {
  const f = fixture()
  await f.prepare()
  f.f.setNow(f.current()!.progress.recoveryUntil)
  await f.recover()
  expect(f.current()!.progress).toMatchObject({ status: 'expired', txid: null })
  expect(f.counts.admission).toBe(0)
  expect(f.counts.issue).toBe(0)
})

test('wrong recipient and current authority refusal yield no downstream effect', async () => {
  const f = fixture()
  await f.prepare()
  await expect(
    f.coordinator.recover(f.f.id, {
      ...f.caller,
      buyer: new PrivateKey(45).toPublicKey().toString()
    })
  ).rejects.toMatchObject({ code: 'not-found' })
  f.setAuthorized(false)
  await expect(f.submit()).rejects.toMatchObject({ code: 'context-changed' })
  f.setAuthorized(true)
  f.setDomainCurrent(false)
  await expect(f.submit()).rejects.toMatchObject({ code: 'context-changed' })
  expect(f.current()!.progress.status).toBe('prepared')
  expect(f.counts.admission).toBe(0)
})

test('same-context guards run inside the final native commit', async () => {
  const f = fixture()
  await f.prepare()
  const sign = f.owner.sign
  const coordinator = new PrivatePurchaseCoordinator({
    ...f.owner,
    sign: async (type, body, signal) => {
      const result = await sign(type, body, signal)
      if (type === 'potatoes') f.setReleaseCurrent(false)
      return result
    }
  })
  await expect(coordinator.submit(f.f.candidate, f.caller)).rejects.toMatchObject({
    code: 'context-changed'
  })
  expect(f.current()!.progress.status).toBe('admitted-delivery-pending')
  expect(JSON.stringify(f.projected())).not.toContain('secret')
})

test('ports cannot mutate the original contract or replace installed methods mid-work', async () => {
  const f = fixture()
  const sign = f.owner.sign
  const coordinator = new PrivatePurchaseCoordinator({
    ...f.owner,
    sign: async (type, body, signal) => {
      if (type === 'purchase-terms') body.assetId = 'ab'.repeat(32)
      return sign(type, body, signal)
    }
  })
  await expect(coordinator.prepare(f.f.f.f.request, f.caller)).rejects.toMatchObject({
    code: 'invalid'
  })
  expect(f.current()).toBeUndefined()
  await f.prepare()
  f.domain.verify = async () => ({ checkCurrent: () => {} })
  await expect(f.submit()).rejects.toMatchObject({ code: 'context-changed' })
  expect(f.counts.admission).toBe(0)
})

test('a mismatched admission or release cannot be retained as this purchase', async () => {
  const f = fixture()
  const coordinator = new PrivatePurchaseCoordinator({
    ...f.owner,
    admission: {
      recover: async job => ({
        status: 'unresolved',
        operationId: job.operationId,
        txid: 'ab'.repeat(32)
      })
    }
  })
  await f.prepare()
  await expect(coordinator.submit(f.f.candidate, f.caller)).rejects.toMatchObject({
    code: 'context-changed'
  })
  expect(f.current()!.progress.status).toBe('admission-pending')
  expect(f.counts.issue).toBe(0)
})

test('retains a definitive local rejection without establishing a global Bitcoin outcome', async () => {
  const f = fixture()
  const coordinator = new PrivatePurchaseCoordinator({
    ...f.owner,
    admission: {
      recover: async job => ({
        status: 'rejected',
        operationId: job.operationId,
        txid: job.candidate.txid,
        reason: 'local topic rule declined',
        evidence: 'AQ=='
      })
    }
  })
  await f.prepare()
  await coordinator.submit(f.f.candidate, f.caller)
  expect(f.projected()).toMatchObject({
    result: { status: 'admission-rejected', decision: { globalOutcome: 'unknown' } }
  })
  expect(f.counts.issue).toBe(0)
})

test('logical cancellation retains physical capacity until the started call settles', async () => {
  const f = fixture()
  let finish: (() => void) | undefined, entered: (() => void) | undefined
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const pending = new Promise<void>(resolve => {
    finish = resolve
  })
  const domain = {
    ...f.domain,
    prepare: async (...args: Parameters<typeof f.domain.prepare>) => {
      entered!()
      await pending
      return f.domain.prepare(...args)
    }
  }
  const coordinator = new PrivatePurchaseCoordinator({
    ...f.owner,
    domain,
    maximumWork: 1,
    perBuyerWork: 1
  })
  const cancelled = new AbortController()
  const first = coordinator.prepare(f.f.f.f.request, { ...f.caller, signal: cancelled.signal })
  await started
  cancelled.abort()
  await expect(first).rejects.toMatchObject({ code: 'cancelled' })
  await expect(coordinator.prepare(f.f.f.f.request, f.caller)).rejects.toMatchObject({
    code: 'limited'
  })
  let drained = false
  const stop = coordinator.stop().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  finish!()
  await stop
  expect(drained).toBe(true)
  expect(f.current()).toBeUndefined()
})

test('current validation is synchronous even for a function returning a Promise', async () => {
  const f = fixture()
  const domain = {
    ...f.domain,
    prepare: async (...args: Parameters<typeof f.domain.prepare>) => {
      const result = await f.domain.prepare(...args)
      return {
        ...result,
        validation: { checkCurrent: (() => Promise.reject(new Error('async guard'))) as never }
      }
    }
  }
  const coordinator = new PrivatePurchaseCoordinator({ ...f.owner, domain })
  await expect(coordinator.prepare(f.f.f.f.request, f.caller)).rejects.toMatchObject({
    code: 'context-changed'
  })
  expect(f.current()).toBeUndefined()
  expect(() => new PrivatePurchaseCoordinator({ ...f.owner, maximumWork: 0 })).toThrow(
    OutputProtocolError
  )
  outputAssert(f.counts.admission === 0, 'No admission on invalid guard')
})

test.each([
  'missing',
  'null',
  'missing-method',
  'async-method',
  'nonvoid',
  'method-change'
] as const)('refuses %s preparation validation before retaining financial intent', async fault => {
  const f = fixture(),
    prepare = f.domain.prepare
  f.domain.prepare = async (...args) => {
    const result = await prepare(...args)
    if (fault === 'missing') result.validation = undefined as never
    if (fault === 'null') result.validation = null as never
    if (fault === 'missing-method') result.validation = {} as never
    if (fault === 'async-method') result.validation = { checkCurrent: async () => {} }
    if (fault === 'nonvoid') result.validation = { checkCurrent: (() => true) as never }
    if (fault === 'method-change') {
      const validation = {
        checkCurrent: () => {
          validation.checkCurrent = () => undefined
        }
      }
      result.validation = validation
    }
    return result
  }
  const coordinator = new PrivatePurchaseCoordinator(f.owner)
  try {
    const malformed = ['missing', 'null', 'missing-method', 'async-method'].includes(fault)
    await expect(coordinator.prepare(f.f.f.f.request, f.caller)).rejects.toMatchObject({
      code: malformed ? 'invalid' : 'context-changed',
      message: malformed
        ? 'Purchase validation guard must be synchronous'
        : fault === 'nonvoid'
          ? 'Purchase validation guard must finish synchronously'
          : 'Purchase validation guard changed'
    })
    expect(f.current()).toBeUndefined()
    expect(f.counts.admission).toBe(0)
    expect(f.counts.issue).toBe(0)
  } finally {
    await coordinator.stop()
    await f.dispose()
  }
})

test.each(['missing', 'async'] as const)(
  'requires synchronous authentication instead of a %s callback',
  async fault => {
    const f = fixture(),
      caller = {
        ...f.caller,
        current: fault === 'missing' ? (undefined as never) : ((async () => true) as never)
      }
    try {
      expect(() => f.coordinator.prepare(f.f.f.f.request, caller)).toThrow(
        expect.objectContaining({
          code: 'invalid',
          message: 'Current purchase authentication is required'
        })
      )
      expect(f.current()).toBeUndefined()
      expect(f.counts.prepare).toBe(0)
    } finally {
      await f.dispose()
    }
  }
)

test.each(['capability', 'profile'] as const)(
  'binds preparation to the selected %s before private material is requested',
  async field => {
    const f = fixture(),
      caller = {
        ...f.caller,
        [field]: field === 'capability' ? 'ab'.repeat(32) : 'urn:another-profile'
      }
    try {
      await expect(f.coordinator.prepare(f.f.f.f.request, caller)).rejects.toMatchObject({
        code: 'context-changed',
        message: 'Original purchase selection differs'
      })
      expect(f.current()).toBeUndefined()
      expect(f.counts.prepare).toBe(0)
    } finally {
      await f.dispose()
    }
  }
)

test.each(['unknown-status', 'array-evidence', 'missing-evidence'] as const)(
  'refuses %s rejection data instead of converting it into an admission verdict',
  fault => {
    const input = {
      status: 'rejected',
      operationId: 'ab'.repeat(32),
      txid: 'ac'.repeat(32),
      reason: 'controlled rejection',
      evidence: fault === 'array-evidence' ? [] : fault === 'missing-evidence' ? undefined : ''
    }
    if (fault === 'unknown-status') input.status = 'unknown'
    expect(() => ownPrivatePurchaseAdmissionOutcome(input)).toThrow(
      expect.objectContaining({
        code: fault === 'unknown-status' ? 'unsupported' : 'invalid',
        message:
          fault === 'unknown-status'
            ? 'Unsupported purchase admission outcome'
            : fault === 'missing-evidence'
              ? 'Expected a JSON value'
              : 'Purchase rejection evidence must be encoded bytes'
      })
    )
  }
)
