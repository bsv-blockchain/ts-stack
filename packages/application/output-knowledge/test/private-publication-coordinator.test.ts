import { expect, it, jest } from '@jest/globals'
import {
  canonicalOutputJSON,
  outputPacketDigest,
  signOutputPacket,
  PrivateKey,
  Utils
} from '@bsv/sdk'
import { PrivatePublicationCoordinator } from '../src/private/PrivatePublicationCoordinator.js'
import { PrivatePublicationWork } from '../src/private/PrivatePublicationWork.js'
import { transactions } from './evidence-fixture.js'
import { allow } from './private-publication-fixture.js'
import type { PrivatePublicationAdmission } from '../src/private/PrivatePublicationPorts.js'

import { coordinatorFixture as fixture } from './private-publication-coordinator-fixture.js'

it.each(['validate', 'manifest', 'clock'] as const)(
  'requires an installed %s callback before any protected operation',
  callback => {
    const f = fixture()
    expect(
      () => new PrivatePublicationCoordinator({ ...f.options, [callback]: undefined! })
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Publication installation callback is required'
      })
    )
    expect(f.native.rows()).toEqual([])
  }
)

it.each(['0', '86401'])('rejects the out-of-contract staging lifetime %s', stagingSeconds => {
  const f = fixture()
  expect(() => new PrivatePublicationCoordinator({ ...f.options, stagingSeconds })).toThrow(
    expect.objectContaining({ code: 'invalid', message: 'Invalid publication staging lifetime' })
  )
})

it('accepts the exact staging and extension ceilings while rejecting excess or malformed extension installations', () => {
  const f = fixture(),
    extensions = Array.from({ length: 32 }, (_, i) => 'urn:test:extension:' + i)
  expect(
    () =>
      new PrivatePublicationCoordinator({
        ...f.options,
        stagingSeconds: '86400',
        supportedExtensions: extensions
      })
  ).not.toThrow()
  for (const supportedExtensions of [[...extensions, 'urn:test:extension:33'], 'not-an-array'])
    expect(
      () =>
        new PrivatePublicationCoordinator({ ...f.options, supportedExtensions } as typeof f.options)
    ).toThrow(
      expect.objectContaining({ code: 'invalid', message: 'Invalid publication extensions' })
    )
  expect(
    () => new PrivatePublicationCoordinator({ ...f.options, supportedExtensions: [''] })
  ).toThrow()
})

it.each([127, 65537, 128.5, Number.NaN])(
  'rejects the admission result capacity %p',
  maximumOutcomeBytes => {
    const f = fixture()
    expect(
      () =>
        new PrivatePublicationCoordinator({
          ...f.options,
          admission: { ...f.admission, maximumOutcomeBytes }
        })
    ).toThrow(
      expect.objectContaining({ code: 'invalid', message: 'Invalid admission result bound' })
    )
  }
)

it('accepts both exact admission result bounds and rejects insufficient or fractional private capacity', () => {
  const f = fixture(),
    minimum = f.contract.installation.maximumPrivateBytes
  for (const maximumOutcomeBytes of [128, 65536])
    expect(
      () =>
        new PrivatePublicationCoordinator({
          ...f.options,
          admission: { ...f.admission, maximumOutcomeBytes, maximumPrivateBytes: minimum }
        })
    ).not.toThrow()
  for (const maximumPrivateBytes of [minimum - 1, minimum + 0.5, Number.NaN])
    expect(
      () =>
        new PrivatePublicationCoordinator({
          ...f.options,
          admission: { ...f.admission, maximumPrivateBytes }
        })
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Installed private capacity exceeds admission capacity'
      })
    )
})

it.each(['maximumWork', 'perPublisherWork', 'timeoutMs'] as const)(
  'refuses a zero %s without defaulting it into an enabled installation',
  field => {
    const f = fixture()
    expect(() => new PrivatePublicationCoordinator({ ...f.options, [field]: 0 })).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Invalid private publication work limits'
      })
    )
  }
)

it.each(['topic', 'schema', 'private-capacity'] as const)(
  'refuses uninstalled %s before independent evidence or domain work',
  async mode => {
    const f = fixture(),
      request = structuredClone(f.contract.request),
      maximum = f.contract.retained.selection.profile.parameters.maxPrivateBytes as number
    if (mode === 'topic') request.topic = 'tm_uninstalled'
    if (mode === 'schema') request.schema = 'urn:test:uninstalled'
    if (mode === 'private-capacity')
      request.privateValues = Utils.toBase64(new Uint8Array(maximum + 1))
    const verify = jest.spyOn(f.evidence, 'verify')
    // Install the observation before constructing the owner whose identities it pins.
    const coordinator = new PrivatePublicationCoordinator(f.options)
    try {
      await expect(coordinator.publish(request, f.caller)).rejects.toMatchObject({
        code: mode === 'private-capacity' ? 'limited' : 'unsupported',
        message: {
          topic: 'Private publication topic is not installed',
          schema: 'Publication schema is not installed',
          'private-capacity': 'Publication private capacity exceeded'
        }[mode]
      })
      expect(verify).not.toHaveBeenCalled()
      expect(f.validate).not.toHaveBeenCalled()
      expect(f.native.rows()).toEqual([])
    } finally {
      await coordinator.stop()
      verify.mockRestore()
    }
  }
)

it.each(['publisher', 'digest'] as const)(
  'binds an independent evidence-port %s result to this original request',
  async field => {
    const native = fixture(),
      f = fixture({
        evidence: {
          async verify(...args) {
            const verified = await native.evidence.verify(...args)
            return {
              ...verified,
              ...(field === 'publisher'
                ? { publisher: new PrivateKey(64).toPublicKey().toString() }
                : { requestDigest: '99'.repeat(32) })
            }
          }
        }
      })
    await expect(f.coordinator.publish(f.contract.request, f.caller)).rejects.toMatchObject({
      code: 'context-changed',
      message: 'Publication evidence port returned another request'
    })
    expect(f.validate).not.toHaveBeenCalled()
    expect(f.native.rows()).toEqual([])
  }
)

it('rejects a replacement decision from the installed validator before staging', async () => {
  const f = fixture({
    validate: (() => Promise.resolve(true)) as unknown as NonNullable<
      Parameters<typeof fixture>[0]
    >['validate']
  })
  await expect(f.coordinator.publish(f.contract.request, f.caller)).rejects.toMatchObject({
    code: 'invalid',
    message: 'Publication validator must complete without a replacement decision'
  })
  expect(f.native.rows()).toEqual([])
})

it('observes a rejected promise from a synchronous publication authentication wrapper before private work', async () => {
  const f = fixture(),
    current = (() =>
      Promise.reject(
        new Error('Controlled publication authentication rejection')
      )) as unknown as typeof f.caller.current
  await expect(
    f.coordinator.publish(f.contract.request, { ...f.caller, current })
  ).rejects.toMatchObject({
    code: 'not-found',
    message: 'Private publication not found'
  })
  expect(f.validate).not.toHaveBeenCalled()
  expect(f.native.rows()).toEqual([])
  await Promise.resolve()
})

it.each([
  'operation',
  'txid',
  'status',
  'context',
  'null',
  'array',
  'boolean',
  'unresolved-extra'
] as const)(
  'retains an admitting obligation after a malformed %s outcome without binding private data',
  async mode => {
    const f = fixture(),
      original = f.admission.recover
    const recover = (async (...args: Parameters<PrivatePublicationAdmission['recover']>) => {
      const value = await original(...args)
      if (mode === 'null') return null
      if (mode === 'array') return []
      if (mode === 'boolean') return true
      if (mode === 'operation') return { ...value, operationId: '99'.repeat(32) }
      if (mode === 'txid') return { ...value, txid: '99'.repeat(32) }
      if (mode === 'status') return { ...value, status: 'unexpected' }
      if (mode === 'context') return { ...value, context: 'unrelated' }
      return { ...value, status: 'unresolved' }
    }) as unknown as PrivatePublicationAdmission['recover']
    const coordinator = new PrivatePublicationCoordinator({
      ...f.options,
      admission: { ...f.admission, recover }
    })
    try {
      const binding = { code: 'conflict', message: 'Private admission outcome binding differs' },
        shape = { code: 'invalid', message: 'Invalid private admission outcome' },
        decision = { code: 'invalid', message: 'Invalid private admission decision' },
        errors = {
          operation: binding,
          txid: binding,
          status: decision,
          context: decision,
          null: shape,
          array: shape,
          boolean: shape,
          'unresolved-extra': { code: 'invalid' }
        }
      await expect(coordinator.publish(f.contract.request, f.caller)).rejects.toMatchObject(
        errors[mode]
      )
      const saved = f.store.loadVerified(f.status.publicationId, () => '20', allow)!
      expect(saved.fence.state.progress.phase).toBe('admitting')
      expect(saved.binding.phase).toBe('reserved')
      expect(f.calls).toHaveLength(1)
    } finally {
      await coordinator.stop()
    }
  }
)

it.each(['matching-private-values', 'public'] as const)(
  'accepts the explicitly installed %s admission context',
  async context => {
    const f = fixture(),
      original = f.admission.recover,
      coordinator = new PrivatePublicationCoordinator({
        ...f.options,
        admission: {
          ...f.admission,
          recover: async (...args) => ({ ...(await original(...args)), context })
        }
      })
    try {
      await expect(coordinator.publish(f.contract.request, f.caller)).resolves.toMatchObject({
        status: 'ready'
      })
      expect(f.calls).toHaveLength(1)
    } finally {
      await coordinator.stop()
    }
  }
)

it('enforces the installed admission-result byte bound before accepting a large well-formed result', async () => {
  const f = fixture(),
    original = f.admission.recover,
    coordinator = new PrivatePublicationCoordinator({
      ...f.options,
      admission: {
        ...f.admission,
        maximumOutcomeBytes: 1024,
        recover: async (...args) => ({
          ...(await original(...args)),
          assessmentContextId: 'x'.repeat(2048)
        })
      }
    })
  try {
    await expect(coordinator.publish(f.contract.request, f.caller)).rejects.toMatchObject({
      code: 'limited'
    })
    const saved = f.store.loadVerified(f.status.publicationId, () => '20', allow)!
    expect(saved.fence.state.progress.phase).toBe('admitting')
    expect(saved.binding.phase).toBe('reserved')
  } finally {
    await coordinator.stop()
  }
})

it.each(['maximumPrivateBytes', 'maximumOutcomeBytes'] as const)(
  'checks the original admission %s value before any private work',
  async key => {
    const f = fixture(),
      original = f.admission[key]
    Object.defineProperty(f.admission, key, { value: original + 1 })
    try {
      await expect(f.coordinator.publish(f.contract.request, f.caller)).rejects.toMatchObject({
        code: 'not-found',
        message: 'Private publication not found'
      })
      expect(f.validate).not.toHaveBeenCalled()
      expect(f.calls).toEqual([])
      expect(f.native.rows()).toEqual([])
    } finally {
      Object.defineProperty(f.admission, key, { value: original })
    }
  }
)

it.each(['resolve', 'scan', 'isCurrent'] as const)(
  'keeps the installed worker %s method pinned during ordinary publication',
  async method => {
    const f = fixture(),
      worker = new PrivatePublicationWork(
        f.native.owner,
        f.contract.contracts,
        f.options.clock,
        () => true
      ),
      coordinator = new PrivatePublicationCoordinator({ ...f.options, worker }),
      changed = jest.spyOn(worker, method)
    try {
      await expect(coordinator.publish(f.contract.request, f.caller)).rejects.toMatchObject({
        code: 'not-found',
        message: 'Private publication not found'
      })
      expect(f.validate).not.toHaveBeenCalled()
      expect(f.native.rows()).toEqual([])
    } finally {
      changed.mockRestore()
      await coordinator.stop()
    }
  }
)

it('bounds the complete owned installation before constructing its callback owners', () => {
  const f = fixture()
  expect(
    () =>
      new PrivatePublicationCoordinator({
        ...f.options,
        supportedExtensions: Array.from({ length: 32 }, (_, i) => 'x'.repeat(600) + i)
      })
  ).toThrow(expect.objectContaining({ code: 'limited' }))
  expect(f.native.rows()).toEqual([])
})

it('rejects a changed raw subject from proof augmentation without replacing the original native contract', async () => {
  const native = fixture()
  let proofs = 0
  const f = fixture({
    evidence: {
      async verify(...args) {
        const verified = await native.evidence.verify(...args)
        proofs++
        return proofs === 1 ? verified : { ...verified, rawTransaction: '00' }
      }
    }
  })
  await f.coordinator.publish(f.contract.request, f.caller)
  const before = f.store.loadVerified(f.status.publicationId, () => '20', allow)!
  await expect(f.coordinator.publish(f.contract.request, f.caller)).rejects.toMatchObject({
    code: 'conflict',
    message: 'Publication proof variant changes the original transaction'
  })
  expect(f.store.loadVerified(f.status.publicationId, () => '20', allow)).toEqual(before)
  expect(f.calls).toHaveLength(1)
})

it.each(['request', 'response'] as const)(
  'honors an independently signed exact %s capacity and rejects one byte below it',
  async field => {
    for (const below of [false, true]) {
      const f = fixture(),
        ready = {
          version: 1,
          publicationId: f.status.publicationId,
          txid: f.contract.request.evidence.txid,
          status: 'ready',
          updatedAt: '20'
        },
        body = structuredClone(f.contract.body),
        profile = body.services[0].profiles[0],
        maximum = Buffer.byteLength(
          canonicalOutputJSON(field === 'request' ? f.contract.request : ready)
        )
      if (field === 'request') profile.maxRequestBytes = maximum - Number(below)
      else profile.maxResponseBytes = maximum - Number(below)
      const manifest = signOutputPacket('capabilities', body, f.contract.key),
        caller = { ...f.caller, capability: outputPacketDigest('capabilities', body) },
        verify = jest.spyOn(f.evidence, 'verify'),
        coordinator = new PrivatePublicationCoordinator({ ...f.options, manifest: () => manifest })
      try {
        const pending = coordinator.publish(f.contract.request, caller)
        if (below) await expect(pending).rejects.toMatchObject({ code: 'limited' })
        else await expect(pending).resolves.toEqual(ready)
        if (field === 'request' && below) {
          expect(verify).not.toHaveBeenCalled()
          expect(f.native.rows()).toEqual([])
        }
      } finally {
        await coordinator.stop()
        verify.mockRestore()
      }
    }
  }
)

it.each([undefined, async () => true])(
  'requires a synchronous authenticated current callback (%p)',
  current => {
    const f = fixture()
    expect(() =>
      f.coordinator.publish(f.contract.request, {
        ...f.caller,
        current
      } as unknown as typeof f.caller)
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Current authenticated publication context is required'
      })
    )
    expect(f.native.rows()).toEqual([])
  }
)

it.each(['capability', 'profile'] as const)(
  'preserves the exact refusal for an original %s selector mismatch',
  async field => {
    const f = fixture(),
      caller = {
        ...f.caller,
        [field]: field === 'capability' ? '99'.repeat(32) : 'urn:test:unselected-profile'
      }
    await expect(f.coordinator.publish(f.contract.request, caller)).rejects.toMatchObject({
      code: 'context-changed',
      message: 'Original publication capability selector differs'
    })
    expect(f.validate).not.toHaveBeenCalled()
    expect(f.native.rows()).toEqual([])
  }
)

it.each(['evidence', 'validation'] as const)(
  'checks cancellation after physical %s settlement before entering the next owner',
  async phase => {
    const native = fixture(),
      abort = new AbortController()
    let validations = 0,
      leases = 0
    const f = fixture({
      evidence: {
        async verify(...args) {
          const verified = await native.evidence.verify(...args)
          if (phase === 'evidence') abort.abort()
          return verified
        }
      },
      async validate(...args) {
        validations++
        await native.validate(...args)
        if (phase === 'validation') abort.abort()
      },
      leases: {
        run(...args) {
          leases++
          return native.leases.run(...args)
        },
        isCurrent: reference => native.leases.isCurrent(reference)
      }
    })
    try {
      await expect(
        f.coordinator.publish(f.contract.request, { ...f.caller, signal: abort.signal })
      ).rejects.toMatchObject({ code: 'cancelled' })
    } finally {
      await f.coordinator.stop()
    }
    expect(validations).toBe(phase === 'evidence' ? 0 : 1)
    expect(leases).toBe(0)
    expect(f.native.rows()).toEqual([])
  }
)

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
