import { afterEach, expect, it, jest } from '@jest/globals'
import {
  canonicalOutputJSON,
  parseOutputJSON,
  PrivateKey,
  signOutputPacket,
  verifyOutputRootEvictionResult
} from '@bsv/sdk'
import {
  rootServiceFixture,
  rootDeferred,
  rootAwaitStart
} from './root-eviction-service-fixture.js'
import {
  rootContractKey,
  rootContractManifest,
  rootContractPacket
} from './root-contract-fixture.js'
import { policy, requester, signed } from './root-eviction-fixture.js'
import { coordinatedRequest } from './root-eviction-coordination-fixture.js'
import { RootEvictionService } from '../src/root-eviction/RootEvictionService.js'
import type { RootEvictionCommitGuard } from '../src/root-eviction/RootEvictionCommitContext.js'

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

it('retains before signing and leaves advisory requests pending without applying a decision', async () => {
  const f = await rootServiceFixture()
  try {
    f.sign.mockImplementation(async body => {
      expect(await f.store.get(requester, f.body.requestId)).toBeDefined()
      return signOutputPacket('root-eviction-result', body, rootContractKey)
    })
    const result = await f.service().submit(f.text, f.caller, f.selection.manifest)
    const packet = verifyOutputRootEvictionResult(
      parseOutputJSON(result.body),
      signed(f.body),
      policy
    )
    expect(packet.body.outcomes[0]).toMatchObject({
      actionStatus: 'pending',
      serving: { state: 'unresolved' }
    })
    expect(result.head).toEqual({ revision: '0', policyDigest: policy })
    expect(result.observedAt).toBe('150')
    expect(result.access).toEqual({
      operation: 'submit',
      principal: requester,
      requester,
      requestId: f.body.requestId
    })
    expect(result.headers).toEqual({
      ...f.contracts.retain(f.selection.manifest, f.selection.selector, '150').selection.headers,
      'content-type': 'application/json',
      'cache-control': 'private, no-store'
    })
    expect(await f.store.projections(64)).toEqual([])
    const status = await f.service().status(f.statusText, f.caller)
    expect(
      verifyOutputRootEvictionResult(parseOutputJSON(status.body), signed(f.body), policy).body
    ).toEqual(packet.body)
    expect(status.access.operation).toBe('status')
  } finally {
    await f.cleanup()
  }
})

it('recovers the original contract after expiry and policy rotation without current discovery', async () => {
  const f = await rootServiceFixture()
  try {
    await f.service().submit(f.text, f.caller, f.selection.manifest)
    f.state.now = '1000'
    f.state.policy = 'aa'.repeat(32)
    await f.store.changePolicy(f.state.policy)
    const service = f.service({ journal: f.reopen() })
    const retry = await service.submit(f.text, f.caller, undefined)
    const result = verifyOutputRootEvictionResult(
      parseOutputJSON(retry.body),
      signed(f.body),
      policy
    )
    expect(result.body.outcomes[0]).toMatchObject({
      actionStatus: 'rejected',
      reasonCode: 'policy-changed'
    })
    expect(retry.head.policyDigest).toBe(f.state.policy)
    expect(
      verifyOutputRootEvictionResult(
        parseOutputJSON((await service.status(f.statusText, f.caller)).body),
        signed(f.body),
        policy
      ).body
    ).toEqual(result.body)
    await expect(
      service.submit(f.text, { ...f.caller, capabilityDigest: 'ff'.repeat(32) }, undefined)
    ).rejects.toMatchObject({ code: 'context-changed' })
  } finally {
    await f.cleanup()
  }
})

it('checks actual received bytes before new intake and retains the same bound for exact retries', async () => {
  const f = await rootServiceFixture()
  try {
    const manifest = rootContractManifest()
    manifest.services[0].profiles[0].maxRequestBytes = Buffer.byteLength(f.text) + 2
    const selection = rootContractPacket(manifest)
    const who = { ...f.caller, capabilityDigest: selection.selector }
    const service = f.service()
    await expect(service.submit(`   ${f.text}`, who, selection.packet)).rejects.toMatchObject({
      code: 'limited'
    })
    expect(await f.store.get(requester, f.body.requestId)).toBeUndefined()
    expect((await f.store.head()).revision).toBe('0')
    await service.submit(`  ${f.text}`, who, selection.packet)
    f.state.now = '1000'
    await expect(service.submit(`   ${f.text}`, who, undefined)).rejects.toMatchObject({
      code: 'limited'
    })
    expect((await f.store.head()).revision).toBe('0')
    const retry = await service.submit(f.text, who, undefined)
    expect(parseOutputJSON(retry.body)).toMatchObject({
      body: { outcomes: [{ actionStatus: 'rejected', reasonCode: 'request-expired' }] }
    })
    await expect(
      service.status(
        ' '.repeat(manifest.services[0].profiles[0].maxRequestBytes) + f.statusText,
        who
      )
    ).rejects.toMatchObject({ code: 'limited' })
  } finally {
    await f.cleanup()
  }
})

it('keeps strict parsing, authenticated attribution, manifest validity and global limits before intake', async () => {
  const f = await rootServiceFixture()
  try {
    const service = f.service()
    for (const text of ['{"body":null,' + f.text.slice(1), ' '.repeat(1048577), '{}'])
      await expect(service.submit(text, f.caller, f.selection.manifest)).rejects.toBeDefined()
    await expect(service.submit(f.text, f.caller, undefined)).rejects.toBeDefined()
    await expect(
      service.submit(
        f.text,
        { ...f.caller, principal: new PrivateKey(900).toPublicKey().toString() },
        f.selection.manifest
      )
    ).rejects.toMatchObject({ code: 'not-found' })
    f.guard.mockImplementation(async () => ({
      expectedPolicyDigest: policy,
      clock: () => '150',
      authorize: () => true,
      contextCurrent: () => true
    }))
    await expect(
      service.submit(
        f.text,
        { ...f.caller, principal: new PrivateKey(900).toPublicKey().toString() },
        f.selection.manifest
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    f.state.now = '1000'
    f.guard.mockImplementation(async () => ({
      expectedPolicyDigest: policy,
      clock: () => f.state.now,
      authorize: () => true,
      contextCurrent: () => true
    }))
    await expect(service.submit(f.text, f.caller, f.selection.manifest)).rejects.toBeDefined()
    expect(await f.store.get(requester, f.body.requestId)).toBeUndefined()
    expect(f.sign).not.toHaveBeenCalled()
  } finally {
    await f.cleanup()
  }
})

it('requires current requester or separately installed auditor access before status lookup', async () => {
  const f = await rootServiceFixture()
  try {
    const service = f.service()
    await service.submit(f.text, f.caller, f.selection.manifest)
    f.state.access = false
    const missing = canonicalOutputJSON({
      version: 1,
      requester,
      requestId: 'missing_request_identity'
    })
    for (const text of [f.statusText, missing])
      await expect(service.status(text, f.caller)).rejects.toMatchObject({
        code: 'not-found',
        message: 'Root operation unavailable'
      })
    const auditor = new PrivateKey(901).toPublicKey().toString()
    const audit = f.service({
      guard: async access => ({
        expectedPolicyDigest: policy,
        clock: () => '150',
        authorize: () =>
          access.operation === 'status' &&
          access.principal === auditor &&
          access.requester === requester,
        contextCurrent: () => true
      })
    })
    expect(
      (await audit.status(f.statusText, { ...f.caller, principal: auditor })).access.principal
    ).toBe(auditor)
    await expect(
      audit.submit(f.text, { ...f.caller, principal: auditor }, undefined)
    ).rejects.toMatchObject({ code: 'not-found' })
  } finally {
    await f.cleanup()
  }
})

it('requires the exact observed body as well as an authentic root signature', async () => {
  const f = await rootServiceFixture()
  try {
    f.sign.mockImplementation(async body => {
      body.outcomes[0].reasonCode = 'different-observation'
      return signOutputPacket('root-eviction-result', body, rootContractKey)
    })
    await expect(f.service().submit(f.text, f.caller, f.selection.manifest)).rejects.toThrow(
      'changed the observed result'
    )
    expect(
      (await f.store.result(requester, f.body.requestId, '150')).outcomes[0].reasonCode
    ).not.toBe('different-observation')
    f.sign.mockImplementation(async body =>
      signOutputPacket('root-eviction-result', body, new PrivateKey(902))
    )
    await expect(f.service().status(f.statusText, f.caller)).rejects.toMatchObject({
      code: 'unauthorized'
    })
    f.sign.mockImplementation(async () => {
      throw new Error('signer unavailable')
    })
    await expect(f.service().status(f.statusText, f.caller)).rejects.toThrow('signer unavailable')
    f.sign.mockImplementation(async body =>
      signOutputPacket('root-eviction-result', body, rootContractKey)
    )
    const retry = await f.service().submit(f.text, f.caller, undefined)
    const status = await f.service().status(f.statusText, f.caller)
    expect(
      verifyOutputRootEvictionResult(parseOutputJSON(retry.body), signed(f.body), policy).body
    ).toEqual(
      verifyOutputRootEvictionResult(parseOutputJSON(status.body), signed(f.body), policy).body
    )
  } finally {
    await f.cleanup()
  }
})

it('holds cancelled signer capacity until physical settlement, preserving retained work for recovery', async () => {
  const f = await rootServiceFixture()
  const started = rootDeferred<void>(),
    physical = rootDeferred<void>(),
    abort = new AbortController()
  try {
    f.sign.mockImplementation(async body => {
      started.resolve()
      await physical.promise
      return signOutputPacket('root-eviction-result', body, rootContractKey)
    })
    const service = f.service({ work: { maximum: 1, perPrincipal: 1 } })
    const task = service.submit(f.text, f.caller, f.selection.manifest, abort.signal)
    void task.catch(() => {})
    await rootAwaitStart(started.promise, task)
    abort.abort()
    await expect(task).rejects.toMatchObject({
      code: 'cancelled',
      message: 'Root request cancelled'
    })
    await expect(service.status(f.statusText, f.caller)).rejects.toMatchObject({ code: 'limited' })
    expect(await f.store.get(requester, f.body.requestId)).toBeDefined()
    physical.resolve()
    for (let step = 0; step < 20; step++) await Promise.resolve()
    expect((await service.status(f.statusText, f.caller)).access.operation).toBe('status')
  } finally {
    physical.resolve()
    await f.cleanup()
  }
})

it('does not commit after cancellation during installed authority work', async () => {
  const f = await rootServiceFixture()
  const started = rootDeferred<void>(),
    physical = rootDeferred<void>(),
    abort = new AbortController()
  try {
    const service = f.service({
      guard: async (access, signal) => {
        started.resolve()
        await physical.promise
        return f.guard(access, signal)
      }
    })
    const task = service.submit(f.text, f.caller, f.selection.manifest, abort.signal)
    void task.catch(() => {})
    await rootAwaitStart(started.promise, task)
    abort.abort()
    await expect(task).rejects.toMatchObject({ code: 'cancelled' })
    physical.resolve()
    for (let step = 0; step < 20; step++) await Promise.resolve()
    expect(await f.store.get(requester, f.body.requestId)).toBeUndefined()
    expect(f.sign).not.toHaveBeenCalled()
    await expect(
      service.submit(f.text, f.caller, f.selection.manifest, AbortSignal.abort())
    ).rejects.toMatchObject({ code: 'cancelled' })
  } finally {
    physical.resolve()
    await f.cleanup()
  }
})

it('checks access and coherent context again at each journal gate', async () => {
  const f = await rootServiceFixture()
  try {
    let authorizations = 0
    const service = f.service({
      guard: async () => ({
        expectedPolicyDigest: policy,
        clock: () => '150',
        authorize: () => ++authorizations === 1,
        contextCurrent: () => true
      })
    })
    await expect(service.submit(f.text, f.caller, f.selection.manifest)).rejects.toMatchObject({
      code: 'not-found'
    })
    expect(authorizations).toBe(2)
    expect(await f.store.get(requester, f.body.requestId)).toBeDefined()
    expect(f.sign).not.toHaveBeenCalled()
    f.state.context = false
    await expect(f.service().status(f.statusText, f.caller)).rejects.toMatchObject({
      code: 'context-changed'
    })
    f.state.context = true
    const changed = coordinatedRequest()
    changed.reason = 'new-body'
    await expect(
      f.service().submit(canonicalOutputJSON(signed(changed)), f.caller, undefined)
    ).rejects.toMatchObject({ code: 'conflict' })
  } finally {
    await f.cleanup()
  }
})

it('validates durable installation, capacity, trusted clock policy and caller shape', async () => {
  const f = await rootServiceFixture()
  try {
    expect(() => f.service({ futureClockSeconds: '-1' })).toThrow()
    expect(() => f.service({ work: { maximum: 0 } })).toThrow('Invalid root work')
    expect(
      () =>
        new RootEvictionService({
          ...f.options,
          journal: { ...f.store, durability: 'volatile' } as never
        })
    ).toThrow('must be durable')
    await expect(
      f.service().status(f.statusText, { ...f.caller, principal: 'bad' })
    ).rejects.toThrow()
    await expect(
      f.service().status(f.statusText, { ...f.caller, capabilityDigest: 'bad' })
    ).rejects.toThrow()
    await expect(
      f.service().status(f.statusText, { ...f.caller, extra: true } as never)
    ).rejects.toThrow()
    expect(f.guard).not.toHaveBeenCalled()
  } finally {
    await f.cleanup()
  }
})

it.each(['clock', 'authorize', 'contextCurrent'] as const)(
  'cancels without intake when the installed %s callback observes cancellation',
  async callback => {
    const f = await rootServiceFixture(),
      abort = new AbortController()
    try {
      const guard: RootEvictionCommitGuard = {
        expectedPolicyDigest: policy,
        clock: () => '150',
        authorize: () => true,
        contextCurrent: () => true
      }
      if (callback === 'clock')
        guard.clock = () => {
          abort.abort()
          return '150'
        }
      else
        guard[callback] = () => {
          abort.abort()
          return true
        }
      await expect(
        f
          .service({ guard: async () => guard })
          .submit(f.text, f.caller, f.selection.manifest, abort.signal)
      ).rejects.toMatchObject({ code: 'cancelled' })
      expect(await f.store.get(requester, f.body.requestId)).toBeUndefined()
      expect(f.sign).not.toHaveBeenCalled()
    } finally {
      await f.cleanup()
    }
  }
)

it.each(['clock', 'authorize', 'contextCurrent'] as const)(
  'does not hide asynchronous %s callbacks behind its cancellation wrapper',
  async callback => {
    const f = await rootServiceFixture()
    try {
      const guard = {
        expectedPolicyDigest: policy,
        clock: () => '150',
        authorize: () => true,
        contextCurrent: () => true
      }
      Object.assign(guard, { [callback]: async () => true })
      await expect(
        f.service({ guard: async () => guard }).submit(f.text, f.caller, f.selection.manifest)
      ).rejects.toThrow('must be synchronous')
      expect(await f.store.get(requester, f.body.requestId)).toBeUndefined()
    } finally {
      await f.cleanup()
    }
  }
)

it('bounds caller time with root diagnostics while retaining physical signer occupancy', async () => {
  const f = await rootServiceFixture(),
    started = rootDeferred<void>(),
    physical = rootDeferred<void>()
  try {
    jest.useFakeTimers()
    f.sign.mockImplementation(async body => {
      started.resolve()
      await physical.promise
      return signOutputPacket('root-eviction-result', body, rootContractKey)
    })
    const service = f.service({ work: { maximum: 1, perPrincipal: 1, timeoutMs: 20 } })
    const task = service.submit(f.text, f.caller, f.selection.manifest)
    void task.catch(() => {})
    await rootAwaitStart(started.promise, task)
    await jest.advanceTimersByTimeAsync(20)
    await expect(task).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Root request deadline reached',
      retryable: true
    })
    await expect(service.status(f.statusText, f.caller)).rejects.toMatchObject({ code: 'limited' })
    physical.resolve()
    await jest.advanceTimersByTimeAsync(0)
    expect((await service.status(f.statusText, f.caller)).head.revision).toBe('0')
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    physical.resolve()
    await f.cleanup()
  }
})
