import { expect, it } from '@jest/globals'
import { canonicalOutputJSON } from '@bsv/sdk'
import {
  PrivatePublicationVerificationLeases,
  type PrivatePublicationVerificationReference
} from '../src/private/PrivatePublicationVerificationLeases.js'
import { contractFixture } from './private-publication-service-fixture.js'

function fixture(maximum = 2) {
  const f = contractFixture(),
    controller = new AbortController()
  const state = { allowed: true, session: true, originalCalls: 0 }
  const leases = new PrivatePublicationVerificationLeases(
    (request, publisher, original) => {
      state.originalCalls++
      expect(request).toEqual(f.request)
      expect(publisher).toBe(f.prepared.fence.state.publisher)
      expect(original).toEqual(f.record.verificationContext)
      return state.allowed
    },
    { maximum }
  )
  const run = <T>(operation: (reference: PrivatePublicationVerificationReference) => Promise<T>) =>
    leases.run(
      f.request,
      f.prepared.fence.state.publisher,
      f.record.verificationContext,
      controller.signal,
      () => state.session,
      operation
    )
  return { f, state, controller, leases, run }
}
it('uses the complete retained verification context and forgets the local reference after settlement', async () => {
  const f = fixture()
  let saved: PrivatePublicationVerificationReference
  expect(
    await f.run(async reference => {
      saved = reference
      expect(f.leases.isCurrent(structuredClone(reference))).toBe(true)
      expect(reference.id).toMatch(/^private-publication-verification-lease\/1:/)
      return 'retained admission'
    })
  ).toBe('retained admission')
  expect(f.state.originalCalls).toBe(3)
  expect(f.leases.isCurrent(saved!)).toBe(false)
})
it('owns the full context and request before calling installed policy', async () => {
  const f = fixture()
  const request = structuredClone(f.f.request),
    original = structuredClone(f.f.record.verificationContext)
  let calls = 0
  const leases = new PrivatePublicationVerificationLeases((owned, publisher, context) => {
    expect(publisher).toBe(f.f.prepared.fence.state.publisher)
    expect(owned).toEqual(f.f.request)
    expect(context).toEqual(f.f.record.verificationContext)
    owned.privateValues = 'BA=='
    context.view.id = 'policy-mutated'
    calls++
    return true
  })
  await leases.run(
    request,
    f.f.prepared.fence.state.publisher,
    original,
    f.controller.signal,
    () => true,
    async reference => {
      request.privateValues = 'BQ=='
      original.view.id = 'caller-mutated'
      expect(leases.isCurrent(reference)).toBe(true)
    }
  )
  expect(calls).toBe(3)
})
it.each(['id', 'publisher', 'requestDigest', 'chain'] as const)(
  'refuses changed %s on an active reference',
  async field => {
    const f = fixture()
    await f.run(async reference => {
      const changed = structuredClone(reference)
      if (field === 'id') changed.id += '-unissued'
      if (field === 'publisher') changed.publisher = f.f.installation.seller
      if (field === 'requestDigest') changed.requestDigest = 'ff'.repeat(32)
      if (field === 'chain') changed.view.chain.genesisHash = 'ff'.repeat(32)
      expect(f.leases.isCurrent(changed)).toBe(false)
      expect(f.leases.isCurrent(reference)).toBe(true)
    })
  }
)
it.each(['allowed', 'session'] as const)(
  'checks current %s policy at every lookup and on return',
  async field => {
    const f = fixture()
    let saved: PrivatePublicationVerificationReference
    await expect(
      f.run(async reference => {
        saved = reference
        f.state[field] = false
        expect(f.leases.isCurrent(reference)).toBe(false)
        return 'late outcome'
      })
    ).rejects.toMatchObject({ code: 'context-changed' })
    f.state[field] = true
    expect(f.leases.isCurrent(saved!)).toBe(false)
  }
)
it('retains physical capacity after cancellation until the underlying call actually settles', async () => {
  const f = fixture(1)
  let release!: () => void, saved!: PrivatePublicationVerificationReference
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const first = f.run(async reference => {
    saved = reference
    await held
  })
  const settled = Promise.allSettled([first])
  f.controller.abort()
  try {
    expect(f.leases.isCurrent(saved)).toBe(false)
    await expect(
      f.leases.run(
        f.f.request,
        f.f.prepared.fence.state.publisher,
        f.f.record.verificationContext,
        new AbortController().signal,
        () => true,
        async () => 'second'
      )
    ).rejects.toMatchObject({ code: 'limited' })
  } finally {
    release()
  }
  expect(await settled).toEqual([
    { status: 'rejected', reason: expect.objectContaining({ code: 'context-changed' }) }
  ])
  await expect(
    f.leases.run(
      f.f.request,
      f.f.prepared.fence.state.publisher,
      f.f.record.verificationContext,
      new AbortController().signal,
      () => true,
      async () => 'next'
    )
  ).resolves.toBe('next')
})
it('isolates concurrent calls so cancelling one reference cannot borrow another session guard', async () => {
  const f = fixture(2),
    secondSignal = new AbortController()
  let release!: () => void, firstReference!: PrivatePublicationVerificationReference
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const first = f.run(async reference => {
    firstReference = reference
    await held
  })
  const settled = Promise.allSettled([first])
  try {
    await f.leases.run(
      f.f.request,
      f.f.prepared.fence.state.publisher,
      f.f.record.verificationContext,
      secondSignal.signal,
      () => true,
      async secondReference => {
        expect(secondReference.id).not.toBe(firstReference.id)
        f.controller.abort()
        expect(f.leases.isCurrent(firstReference)).toBe(false)
        expect(f.leases.isCurrent(secondReference)).toBe(true)
      }
    )
  } finally {
    release()
  }
  expect((await settled)[0].status).toBe('rejected')
})
it('releases a lease after an admission exception without asserting that no effect occurred', async () => {
  const f = fixture(1)
  await expect(
    f.run(async () => {
      throw new Error('reply lost after effect')
    })
  ).rejects.toThrow('reply lost after effect')
  await expect(f.run(async () => 'recovered original')).resolves.toBe('recovered original')
})
it('refuses already cancelled work before invoking admission', async () => {
  const f = fixture()
  f.controller.abort()
  await expect(
    f.run(async () => {
      throw new Error('must not run')
    })
  ).rejects.toMatchObject({ code: 'cancelled' })
  expect(f.state.originalCalls).toBe(0)
})
it.each([0, 65, 1.5, Number.NaN])('bounds physical lease capacity %s', maximum => {
  expect(() => new PrivatePublicationVerificationLeases(() => true, { maximum })).toThrow()
})
it('does not accept an asynchronous installed authority or per-call current guard', async () => {
  const f = fixture()
  expect(
    () => new PrivatePublicationVerificationLeases((async () => true) as unknown as () => boolean)
  ).toThrow()
  await expect(
    f.leases.run(
      f.f.request,
      f.f.prepared.fence.state.publisher,
      f.f.record.verificationContext,
      f.controller.signal,
      (async () => true) as unknown as () => boolean,
      async () => undefined
    )
  ).rejects.toThrow()
})
it('fails closed and observes an incorrectly returned rejected policy promise', async () => {
  const f = fixture()
  const leases = new PrivatePublicationVerificationLeases((() =>
    Promise.reject(new Error('invalid async policy'))) as unknown as () => boolean)
  await expect(
    leases.run(
      f.f.request,
      f.f.prepared.fence.state.publisher,
      f.f.record.verificationContext,
      f.controller.signal,
      () => true,
      async () => undefined
    )
  ).rejects.toMatchObject({ code: 'context-changed' })
  await new Promise<void>(resolve => setImmediate(resolve))
})
it('rechecks cancellation caused by a synchronous policy callback', async () => {
  const f = fixture()
  const leases = new PrivatePublicationVerificationLeases(() => {
    f.controller.abort()
    return true
  })
  await expect(
    leases.run(
      f.f.request,
      f.f.prepared.fence.state.publisher,
      f.f.record.verificationContext,
      f.controller.signal,
      () => true,
      async () => undefined
    )
  ).rejects.toMatchObject({ code: 'context-changed' })
})

it.each([0, 64 * 1048576 + 1, 1.5, Number.NaN])(
  'bounds retained verification bytes %s',
  maximumBytes => {
    expect(() => new PrivatePublicationVerificationLeases(() => true, { maximumBytes })).toThrow()
  }
)
it('reserves exact request/context bytes and keeps the reservation until cancelled work settles', async () => {
  const f = fixture()
  const bytes = Buffer.byteLength(
    canonicalOutputJSON({ request: f.f.request, original: f.f.record.verificationContext })
  )
  const options = { maximum: 2, maximumBytes: bytes }
  const leases = new PrivatePublicationVerificationLeases(() => true, options)
  options.maximumBytes = bytes * 2
  const run = <T>(operation: (reference: PrivatePublicationVerificationReference) => Promise<T>) =>
    leases.run(
      f.f.request,
      f.f.prepared.fence.state.publisher,
      f.f.record.verificationContext,
      f.controller.signal,
      () => true,
      operation
    )
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const first = run(async () => {
    await held
  })
  const settled = Promise.allSettled([first])
  try {
    await expect(run(async () => undefined)).rejects.toMatchObject({
      code: 'limited',
      message: expect.stringContaining('byte capacity')
    })
    f.controller.abort()
    await expect(
      leases.run(
        f.f.request,
        f.f.prepared.fence.state.publisher,
        f.f.record.verificationContext,
        new AbortController().signal,
        () => true,
        async () => undefined
      )
    ).rejects.toMatchObject({ code: 'limited' })
  } finally {
    release()
  }
  expect((await settled)[0].status).toBe('rejected')
  await expect(
    leases.run(
      f.f.request,
      f.f.prepared.fence.state.publisher,
      f.f.record.verificationContext,
      new AbortController().signal,
      () => true,
      async () => 'after-settlement'
    )
  ).resolves.toBe('after-settlement')
  const small = new PrivatePublicationVerificationLeases(() => true, { maximumBytes: bytes - 1 })
  await expect(
    small.run(
      f.f.request,
      f.f.prepared.fence.state.publisher,
      f.f.record.verificationContext,
      new AbortController().signal,
      () => true,
      async () => undefined
    )
  ).rejects.toMatchObject({ code: 'limited' })
})
