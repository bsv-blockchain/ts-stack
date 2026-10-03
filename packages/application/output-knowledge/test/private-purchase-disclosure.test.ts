import { expect, it, jest } from '@jest/globals'
import { PrivateKey } from '@bsv/sdk'
import { PrivatePurchaseAccess } from '../src/private/PrivatePurchaseAccess.js'
import { PrivatePurchaseDisclosure } from '../src/private/PrivatePurchaseDisclosure.js'
import type { ProtectedLedgerView } from '../src/private/ProtectedLedgerCodec.js'
import { purchaseDisclosureFixture as fixture } from './private-purchase-disclosure.fixture.js'

it('refuses and drains a control authority that returns a promise', () => {
  const f = fixture(),
    send = jest.fn()
  const disclosure = new PrivatePurchaseDisclosure(
    f.f.owner.domain,
    f.f.owner.store,
    f.f.f.f.contracts,
    f.access,
    f.f.clock,
    (() => Promise.reject(new Error('async control'))) as never
  )
  expect(() =>
    disclosure.enqueueControl(
      {
        version: 1,
        error: {
          code: 'not-found',
          message: 'Private purchase request not-found',
          retryable: false
        }
      },
      f.caller,
      send
    )
  ).toThrow(expect.objectContaining({ code: 'unauthorized' }))
  expect(send).not.toHaveBeenCalled()
})

it('authorizes initial and retained access from the exact original request', () => {
  const f = fixture(),
    initial = f.access.guard(f.f.id, f.caller.buyer, f.caller.current, f.f.f.original.request)
  const loaded = f.f.owner.store.prepare(f.f.custody, f.f.clock, initial)
  expect(loaded.progress.status).toBe('prepared')
  const retained = f.f.owner.store.load(
    f.f.id,
    f.caller.buyer,
    f.f.clock,
    f.access.guard(f.f.id, f.caller.buyer, f.caller.current)
  )!
  expect(retained.custody.original).toEqual(loaded.custody.original)
  expect(f.decisions.some(item => item.mode === 'initial')).toBe(true)
  expect(f.decisions.at(-1)).toEqual({ mode: 'retained', request: f.f.f.original.request })
})

it('prepares original signed terms and enqueues exactly once without payment headers', () => {
  const f = fixture()
  f.f.prepare()
  const result = f.disclosure.prepare(f.f.id, f.caller, { terms: true }),
    send = jest.fn((_body: string, _headers: unknown) => {})
  expect(JSON.parse(result.body)).toEqual(f.f.custody.original.terms)
  expect(result.statusCode).toBe(200)
  expect(Object.keys(result.headers)).toEqual(['x-bsv-overlay-capability', 'x-bsv-overlay-profile'])
  result.enqueue(send)
  expect(send).toHaveBeenCalledWith(result.body, result.headers)
  expect(() => result.enqueue(send)).toThrow(expect.objectContaining({ code: 'conflict' }))
  expect(send).toHaveBeenCalledTimes(1)
})

it('checks the exclusive construction cutoff again after HTTP signing', () => {
  const f = fixture()
  f.f.prepare()
  const result = f.disclosure.prepare(f.f.id, f.caller, { terms: true }),
    send = jest.fn()
  f.f.setNow('100')
  expect(() => result.enqueue(send)).toThrow(expect.objectContaining({ code: 'expired' }))
  expect(send).not.toHaveBeenCalled()
})

it.each(['recipient', 'authentication', 'policy'])(
  'refuses revoked %s at the physical private enqueue boundary',
  kind => {
    const f = fixture()
    f.f.deliver()
    const result = f.disclosure.prepare(f.f.id, f.caller),
      send = jest.fn()
    if (kind === 'recipient') f.caller.buyer = new PrivateKey(45).toPublicKey().toString()
    if (kind === 'authentication') f.setAuthenticated(false)
    if (kind === 'policy') f.setPermitted(false)
    // The prepared caller is an owned snapshot; mutating the caller object cannot
    // change its recipient. Revocation comes from the installed current policy.
    if (kind === 'recipient') f.setPermitted(false)
    expect(() => result.enqueue(send)).toThrow(expect.objectContaining({ code: 'not-found' }))
    expect(send).not.toHaveBeenCalled()
  }
)

it('wrong recipients and a missing original have identical not-found behavior before policy sees private request data', () => {
  const f = fixture()
  const stranger = { ...f.caller, buyer: new PrivateKey(45).toPublicKey().toString() }
  expect(() => f.disclosure.prepare(f.f.id, stranger)).toThrow(
    expect.objectContaining({ code: 'not-found' })
  )
  f.f.deliver()
  const prior = f.decisions.length
  expect(() => f.disclosure.prepare(f.f.id, stranger)).toThrow(
    expect.objectContaining({ code: 'not-found' })
  )
  expect(f.decisions).toHaveLength(prior)
})

it('returns immutable delivered bytes after catalogue expiry and refuses a new selected contract', () => {
  const f = fixture()
  f.f.deliver()
  f.f.setNow('100000')
  const result = f.disclosure.prepare(f.f.id, f.caller),
    send = jest.fn((_body: string, _headers: unknown) => {})
  result.enqueue(send)
  expect(JSON.parse(result.body)).toEqual(f.f.f.envelope())
  expect(() => f.disclosure.prepare(f.f.id, { ...f.caller, capability: 'ab'.repeat(32) })).toThrow(
    expect.objectContaining({ code: 'context-changed' })
  )
})

it('a native head change between HTTP signing and enqueue refuses the old snapshot', () => {
  const f = fixture()
  f.f.prepare()
  const result = f.disclosure.prepare(f.f.id, f.caller),
    send = jest.fn()
  f.f.pin()
  // A stale private snapshot uses the same public not-found response as missing
  // custody; it must not disclose the new protected state through an error.
  expect(() => result.enqueue(send)).toThrow(expect.objectContaining({ code: 'not-found' }))
  expect(send).not.toHaveBeenCalled()
})

it('declared async and returned promises are refused and a rejected enqueue promise is drained', () => {
  const f = fixture()
  f.f.prepare()
  const first = f.disclosure.prepare(f.f.id, f.caller)
  expect(() => first.enqueue(async () => {})).toThrow(expect.objectContaining({ code: 'invalid' }))
  const next = f.disclosure.prepare(f.f.id, f.caller)
  expect(() => next.enqueue((() => Promise.reject(new Error('async enqueue'))) as never)).toThrow(
    expect.objectContaining({ code: 'invalid' })
  )
  const asyncPolicy = new PrivatePurchaseAccess(
    f.f.owner.domain,
    f.f.f.original.request.topic,
    (() => Promise.reject(new Error('async permission'))) as never
  )
  expect(() =>
    f.f.owner.store.load(
      f.f.id,
      f.caller.buyer,
      f.f.clock,
      asyncPolicy.guard(f.f.id, f.caller.buyer, f.caller.current)
    )
  ).toThrow(expect.objectContaining({ code: 'not-found' }))
})

it('only fixed public control diagnostics can be authenticated and enqueued', () => {
  const f = fixture(),
    send = jest.fn()
  const packet = {
    version: 1,
    error: { code: 'not-found', message: 'Private purchase request not-found', retryable: false }
  }
  f.disclosure.enqueueControl(packet, f.caller, send)
  expect(send).toHaveBeenCalledTimes(1)
  expect(() =>
    f.disclosure.enqueueControl(
      { ...packet, error: { ...packet.error, message: 'private key detail' } },
      f.caller,
      send
    )
  ).toThrow(expect.objectContaining({ code: 'invalid' }))
  f.setControl(false)
  expect(() => f.disclosure.enqueueControl(packet, f.caller, send)).toThrow(
    expect.objectContaining({ code: 'unauthorized' })
  )
  expect(send).toHaveBeenCalledTimes(1)
})

it('initial recipient/topic/id binding cannot be substituted by a policy accepting everything', () => {
  const f = fixture()
  for (const request of [
    { ...f.f.f.original.request, topic: 'other' },
    { ...f.f.f.original.request, requestId: 'ab'.repeat(16) },
    { ...f.f.f.original.request, recipient: new PrivateKey(45).toPublicKey().toString() }
  ])
    expect(() => f.access.guard(f.f.id, f.caller.buyer, f.caller.current, request)).toThrow(
      expect.objectContaining({ code: 'unavailable' })
    )
  expect(
    () =>
      new PrivatePurchaseAccess(
        f.f.owner.domain,
        f.f.f.original.request.topic,
        (async () => true) as never
      )
  ).toThrow(expect.objectContaining({ code: 'invalid' }))
})

const controlPacket = {
  version: 1,
  error: { code: 'not-found', message: 'Private purchase request not-found', retryable: false }
}

function disclosureWith(f: ReturnType<typeof fixture>, change: Record<string, unknown>) {
  const options = {
    clock: f.f.clock,
    authorize: () => true,
    ...change
  }
  return new PrivatePurchaseDisclosure(
    f.f.owner.domain,
    f.f.owner.store,
    f.f.f.f.contracts,
    f.access,
    options.clock as never,
    options.authorize as never
  )
}

it.each([null, async () => true])(
  'refuses an invalid control callback before reading custody',
  authority => {
    const f = fixture()
    expect(() => disclosureWith(f, { authorize: authority })).toThrow(
      'Purchase control authority must be synchronous'
    )
    expect(f.decisions).toHaveLength(0)
  }
)

it('requires a disclosure clock and synchronous request-context callbacks at intake', () => {
  const f = fixture()
  expect(() => disclosureWith(f, { clock: null })).toThrow('Purchase disclosure clock is required')
  for (const current of [null, async () => true]) {
    expect(() => f.disclosure.prepare(f.f.id, { ...f.caller, current: current as never })).toThrow(
      'Purchase disclosure requires current authentication'
    )
    expect(() => f.access.guard(f.f.id, f.caller.buyer, current as never)).toThrow(
      'Purchase request context must be synchronous'
    )
  }
})

it.each([null, async () => true])('requires a synchronous initial access policy', policy => {
  const f = fixture()
  expect(
    () => new PrivatePurchaseAccess(f.f.owner.domain, f.f.f.original.request.topic, policy as never)
  ).toThrow('Purchase access policy must be synchronous')
})

it('checks the initial selected chain without modifying the stored manifest or installation', () => {
  const f = fixture(),
    request = structuredClone(f.f.f.original.request)
  request.listing.chain.network = 'another-chain'
  expect(() => f.access.guard(f.f.id, f.caller.buyer, f.caller.current, request)).toThrow(
    'Purchase access request binding differs'
  )
})

it.each(['format', 'acquisition', 'purpose'])(
  'rejects an inconsistent retained access %s before reading private chunks',
  field => {
    const f = fixture()
    f.f.prepare()
    const address = f.f.owner.domain.identity.address('acquisition', {
        purpose: 'private-purchase-state',
        acquisitionId: f.f.id
      }),
      guard = f.access.guard(f.f.id, f.caller.buyer, f.caller.current)
    f.f.owner.domain.ledger.read([address], f.f.clock, view => {
      const original = view.get(address)!,
        row = structuredClone(original),
        descriptor = row.value.original as Record<string, unknown>
      if (field === 'format') row.value.format = 'another-state'
      if (field === 'acquisition') descriptor.acquisitionId = 'ee'.repeat(32)
      if (field === 'purpose') descriptor.purpose = 'result'
      const inconsistent: ProtectedLedgerView = {
        ...view,
        get: item => (item.kind === address.kind && item.key === address.key ? row : view.get(item))
      }
      const decisions = f.decisions.length
      expect(() => guard(inconsistent)).toThrow(
        field === 'format'
          ? 'Purchase access state differs'
          : 'Purchase original access binding differs'
      )
      expect(f.decisions).toHaveLength(decisions)
    })
  }
)

function replaceMethod(owner: object, key: string): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key),
    method = Reflect.get(owner, key) as (...args: unknown[]) => unknown
  Object.defineProperty(owner, key, {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => Reflect.apply(method, owner, args)
  })
  return () => {
    if (descriptor) Object.defineProperty(owner, key, descriptor)
    else Reflect.deleteProperty(owner, key)
  }
}

it.each([
  'identity.address',
  'ledger.read',
  'ledger.disclose',
  'store.load',
  'store.disclose',
  'store.discloseTerms',
  'contracts.restore',
  'access.guard'
])('refuses replacement of the installed %s before physical enqueue', boundary => {
  const f = fixture()
  f.f.prepare()
  const result = f.disclosure.prepare(f.f.id, f.caller),
    owners = {
      identity: f.f.owner.domain.identity,
      ledger: f.f.owner.domain.ledger,
      store: f.f.owner.store,
      contracts: f.f.f.f.contracts,
      access: f.access
    },
    [kind, method] = boundary.split('.'),
    undo = replaceMethod(owners[kind as keyof typeof owners], method),
    send = jest.fn()
  try {
    expect(() => result.enqueue(send)).toThrow(expect.objectContaining({ code: 'not-found' }))
    expect(send).not.toHaveBeenCalled()
  } finally {
    undo()
  }
})

it.each([false, 'truthy', Promise.resolve(true)])(
  'refuses non-true live authentication before disclosure',
  current => {
    const f = fixture()
    f.f.prepare()
    expect(() =>
      f.disclosure.prepare(f.f.id, { ...f.caller, current: (() => current) as never })
    ).toThrow(expect.objectContaining({ code: 'not-found' }))
  }
)

it('rechecks abort after authentication and owns the original current callback', () => {
  const f = fixture(),
    controller = new AbortController(),
    current = () => true,
    supplied = { ...f.caller, current, signal: controller.signal }
  f.f.prepare()
  const result = f.disclosure.prepare(f.f.id, supplied),
    send = jest.fn()
  supplied.current = () => false
  result.enqueue(send)
  expect(send).toHaveBeenCalledTimes(1)
  const next = f.disclosure.prepare(f.f.id, { ...f.caller, signal: controller.signal })
  controller.abort()
  expect(() => next.enqueue(send)).toThrow(expect.objectContaining({ code: 'not-found' }))
  expect(send).toHaveBeenCalledTimes(1)
  const during = new AbortController()
  expect(() =>
    f.disclosure.prepare(f.f.id, {
      ...f.caller,
      signal: during.signal,
      current: () => {
        during.abort()
        return true
      }
    })
  ).toThrow(expect.objectContaining({ code: 'not-found' }))
})

it('bounds prepared bytes and rejects an absent response or a changed original profile', () => {
  const f = fixture()
  f.f.prepare()
  expect(() => f.disclosure.prepare(f.f.id, { ...f.caller, profile: 'urn:test:other' })).toThrow(
    'Original purchase selection differs'
  )
  const absent = { ...f.f.owner.store, load: f.f.owner.store.load.bind(f.f.owner.store) }
  const store = {
    ...absent,
    disclose: () => {},
    discloseTerms: () => {}
  }
  const disclosure = new PrivatePurchaseDisclosure(
    f.f.owner.domain,
    store,
    f.f.f.f.contracts,
    f.access,
    f.f.clock,
    () => true
  )
  expect(() => disclosure.prepare(f.f.id, f.caller)).toThrow(
    'Original purchase response unavailable'
  )
})

it('requires synchronous control enqueue and drains its rejected result', () => {
  const f = fixture(),
    body = jest.fn()
  expect(() => f.disclosure.enqueueControl(controlPacket, f.caller, null as never)).toThrow(
    'Purchase control enqueue must be synchronous'
  )
  expect(() => f.disclosure.enqueueControl(controlPacket, f.caller, async () => body())).toThrow(
    'Purchase control enqueue must be synchronous'
  )
  expect(body).not.toHaveBeenCalled()
  expect(() =>
    f.disclosure.enqueueControl(controlPacket, f.caller, (() =>
      Promise.reject(new Error('deferred control enqueue'))) as never)
  ).toThrow('Purchase control enqueue must finish synchronously')
})

it.each([false, 'truthy', Promise.resolve(true)])(
  'refuses non-true control permission',
  authority => {
    const f = fixture(),
      send = jest.fn(),
      disclosure = disclosureWith(f, { authorize: () => authority })
    expect(() => disclosure.enqueueControl(controlPacket, f.caller, send)).toThrow(
      'Purchase control authority changed'
    )
    expect(send).not.toHaveBeenCalled()
  }
)

it('refuses an invalid enqueue before its body runs and fences a reentrant second attempt', () => {
  const f = fixture()
  f.f.prepare()
  const result = f.disclosure.prepare(f.f.id, f.caller),
    second = jest.fn()
  expect(Object.isFrozen(result)).toBe(true)
  expect(Object.isFrozen(result.headers)).toBe(true)
  expect(() => result.enqueue(null as never)).toThrow(
    'Purchase response enqueue must be synchronous'
  )
  expect(() => result.enqueue(async () => second())).toThrow(
    'Purchase response enqueue must be synchronous'
  )
  expect(second).not.toHaveBeenCalled()
  result.enqueue(() => {
    expect(() => result.enqueue(second)).toThrow('Purchase disclosure was already attempted')
  })
  expect(second).not.toHaveBeenCalled()
})

it.each(['changed', 'oversized'])('refuses %s bytes returned at final native disclosure', mode => {
  const f = fixture()
  f.f.prepare()
  const native = f.f.owner.store.disclose.bind(f.f.owner.store)
  let substitute = false
  const store = {
    load: f.f.owner.store.load.bind(f.f.owner.store),
    discloseTerms: f.f.owner.store.discloseTerms.bind(f.f.owner.store),
    disclose: (...args: Parameters<typeof native>) => {
      const [loaded, buyer, clock, guard, send] = args
      native(loaded, buyer, clock, guard, current => {
        const changed = {
          ...current,
          extra:
            mode === 'oversized'
              ? 'x'.repeat(f.f.f.f.body.services[0].profiles[0].maxResponseBytes + 1)
              : 'changed'
        }
        send(substitute ? changed : current)
      })
    }
  }
  const disclosure = new PrivatePurchaseDisclosure(
      f.f.owner.domain,
      store,
      f.f.f.f.contracts,
      f.access,
      f.f.clock,
      () => true
    ),
    result = disclosure.prepare(f.f.id, f.caller),
    send = jest.fn()
  substitute = true
  expect(() => result.enqueue(send)).toThrow(
    expect.objectContaining({ code: mode === 'oversized' ? 'limited' : 'conflict' })
  )
  expect(send).not.toHaveBeenCalled()
})

it('bounds the prepared response before exposing signing bytes', () => {
  const f = fixture()
  f.f.prepare()
  const native = f.f.owner.store.disclose.bind(f.f.owner.store),
    store = {
      load: f.f.owner.store.load.bind(f.f.owner.store),
      discloseTerms: f.f.owner.store.discloseTerms.bind(f.f.owner.store),
      disclose: (...args: Parameters<typeof native>) => {
        const [loaded, buyer, clock, guard, send] = args
        native(loaded, buyer, clock, guard, current => {
          const oversized = {
            ...current,
            extra: 'x'.repeat(f.f.f.f.body.services[0].profiles[0].maxResponseBytes + 1)
          }
          send(oversized)
        })
      }
    }
  const disclosure = new PrivatePurchaseDisclosure(
    f.f.owner.domain,
    store,
    f.f.f.f.contracts,
    f.access,
    f.f.clock,
    () => true
  )
  expect(() => disclosure.prepare(f.f.id, f.caller)).toThrow(
    expect.objectContaining({ code: 'limited' })
  )
})

it('rechecks authentication after control authorization changes it', () => {
  const f = fixture(),
    send = jest.fn(),
    disclosure = disclosureWith(f, {
      authorize: () => {
        f.setAuthenticated(false)
        return true
      }
    })
  expect(() => disclosure.enqueueControl(controlPacket, f.caller, send)).toThrow(
    'Purchase control authority changed'
  )
  expect(send).not.toHaveBeenCalled()
})

it.each([false, 'truthy', Promise.resolve(true)])(
  'requires true current access permission',
  permission => {
    const f = fixture(),
      access = new PrivatePurchaseAccess(
        f.f.owner.domain,
        f.f.f.original.request.topic,
        (() => permission) as never
      ),
      guard = access.guard(f.f.id, f.caller.buyer, f.caller.current, f.f.f.original.request)
    expect(() => f.f.owner.store.prepare(f.f.custody, f.f.clock, guard)).toThrow(
      'Purchase not found'
    )
    expect(f.f.owner.store.load(f.f.id, f.caller.buyer, f.f.clock, f.f.guard)).toBeUndefined()
  }
)

it.each(['ledger', 'identity'] as const)(
  'refuses a replaced domain %s at final disclosure',
  key => {
    const f = fixture()
    f.f.prepare()
    const result = f.disclosure.prepare(f.f.id, f.caller),
      domain = f.f.owner.domain,
      descriptor = Object.getOwnPropertyDescriptor(domain, key)!,
      original = domain[key],
      replacement = new Proxy(original, {
        get(target, property) {
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }),
      send = jest.fn()
    Object.defineProperty(domain, key, { ...descriptor, value: replacement })
    try {
      expect(() => result.enqueue(send)).toThrow(expect.objectContaining({ code: 'not-found' }))
      expect(send).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(domain, key, descriptor)
    }
  }
)
