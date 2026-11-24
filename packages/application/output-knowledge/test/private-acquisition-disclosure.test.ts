import { expect, it } from '@jest/globals'
import { PrivateKey } from '@bsv/sdk'
import { PrivateAcquisitionDisclosure } from '../src/private/PrivateAcquisitionDisclosure.js'
import { acquisitionCoordinatorFixture } from './private-acquisition-coordinator.fixture.js'
async function fixture() {
  const f = await acquisitionCoordinatorFixture()
  let control = true
  const disclosure = new PrivateAcquisitionDisclosure(
    f.f.owner.domain,
    f.f.owner.store,
    f.f.f.contracts,
    f.options.access,
    f.f.clock,
    () => control
  )
  await f.quote()
  return {
    ...f,
    disclosure,
    setControl: (value: boolean) => {
      control = value
    }
  }
}
it('prepares the exact original selection and privately delivers the current body once', async () => {
  const f = await fixture()
  await f.pay()
  const prepared = f.disclosure.prepare(f.f.id, f.caller),
    sent: string[] = []
  expect(JSON.parse(prepared.body)).toMatchObject({
    status: 'delivered',
    result: { context: 'AQID' }
  })
  expect(Object.isFrozen(prepared.headers)).toBe(true)
  prepared.enqueue((body, headers) => {
    expect(headers).toEqual(prepared.headers)
    sent.push(body)
  })
  expect(sent).toEqual([prepared.body])
  expect(() =>
    prepared.enqueue(body => {
      sent.push(body)
    })
  ).toThrow('already attempted')
})
it('refuses stale state after signing without enqueueing its earlier status', async () => {
  const f = await fixture(),
    prepared = f.disclosure.prepare(f.f.id, f.caller)
  await f.pay()
  let sent = false
  expect(() =>
    prepared.enqueue(() => {
      sent = true
    })
  ).toThrow()
  expect(sent).toBe(false)
  expect(JSON.parse(f.disclosure.prepare(f.f.id, f.caller).body).status).toBe('delivered')
})
it('enforces current access, cancellation and installed port identities at the send boundary', async () => {
  const f = await fixture(),
    first = f.disclosure.prepare(f.f.id, f.caller)
  f.setAccess(false)
  expect(() => first.enqueue(() => {})).toThrow()
  f.setAccess(true)
  const abort = new AbortController(),
    second = f.disclosure.prepare(f.f.id, { ...f.caller, signal: abort.signal })
  abort.abort()
  expect(() => second.enqueue(() => {})).toThrow()
  const third = f.disclosure.prepare(f.f.id, f.caller)
  f.options.access.guard = () => () => {}
  expect(() => third.enqueue(() => {})).toThrow()
})
it('preserves fixed missing-buyer behavior and rejects changed capability selectors', async () => {
  const f = await fixture()
  expect(() =>
    f.disclosure.prepare(f.f.id, {
      ...f.caller,
      buyer: new PrivateKey(90).toPublicKey().toString()
    })
  ).toThrow('not found')
  expect(() => f.disclosure.prepare(f.f.id, { ...f.caller, capability: '99'.repeat(32) })).toThrow(
    'selection differs'
  )
})
it('refuses asynchronous enqueue before its body starts', async () => {
  const f = await fixture(),
    prepared = f.disclosure.prepare(f.f.id, f.caller)
  let sent = false
  expect(() =>
    prepared.enqueue(async () => {
      sent = true
    })
  ).toThrow('synchronous')
  expect(sent).toBe(false)
})
it('sends only fixed public control diagnostics under current native authority', async () => {
  const f = await fixture(),
    packet = {
      version: 1,
      error: {
        code: 'not-found',
        message: 'Private acquisition request not-found',
        retryable: false
      }
    }
  let sent = 0
  f.disclosure.enqueueControl(packet, f.caller, () => {
    sent++
  })
  expect(sent).toBe(1)
  expect(() =>
    f.disclosure.enqueueControl(
      { ...packet, error: { ...packet.error, message: 'private detail' } },
      f.caller,
      () => {
        sent++
      }
    )
  ).toThrow('fixed public')
  f.setControl(false)
  expect(() =>
    f.disclosure.enqueueControl(packet, f.caller, () => {
      sent++
    })
  ).toThrow('authority changed')
  expect(sent).toBe(1)
})
it('binds every BRC-105 header to the original challenge and permits it only before construction expiry', async () => {
  const f = await fixture(),
    prepared = f.disclosure.prepare(f.f.id, f.caller, { challenge: true })
  expect(prepared.statusCode).toBe(402)
  expect(JSON.parse(prepared.body)).toEqual(f.current()!.original.challenge)
  expect(prepared.headers).toMatchObject({
    'x-bsv-payment-version': '1.0',
    'x-bsv-payment-satoshis-required': '100',
    'x-bsv-payment-derivation-prefix': f.current()!.original.challenge.derivationPrefix
  })
  f.f.setNow('100')
  let sent = false
  expect(() =>
    prepared.enqueue(() => {
      sent = true
    })
  ).toThrow('construction deadline')
  expect(sent).toBe(false)
  const expired = f.disclosure.prepare(f.f.id, f.caller, { challenge: true })
  expect(expired.statusCode).toBe(200)
  expect(JSON.parse(expired.body)).toMatchObject({ status: 'quoted' })
  expect(expired.headers).not.toHaveProperty('x-bsv-payment-version')
})
it('does not issue another payment challenge for pinned work or an uncharged recovery', async () => {
  const f = await fixture()
  expect(f.disclosure.prepare(f.f.id, f.caller).statusCode).toBe(200)
  f.setRelease(false)
  await f.pay()
  const pending = f.disclosure.prepare(f.f.id, f.caller, { challenge: true })
  expect(pending.statusCode).toBe(200)
  expect(JSON.parse(pending.body)).toMatchObject({ status: 'quoted' })
})

const publicControl = {
  version: 1,
  error: { code: 'not-found', message: 'Private acquisition request not-found', retryable: false }
}
it.each([undefined, 0])(
  'requires an installed disclosure clock (%s)',
  async clock => {
    const f = await fixture()
    try {
      expect(
        () =>
          new PrivateAcquisitionDisclosure(
            f.f.owner.domain,
            f.f.owner.store,
            f.f.f.contracts,
            f.options.access,
            clock as unknown as () => string,
            () => true
          )
      ).toThrow('Acquisition disclosure clock is required')
    } finally {
      await f.dispose()
    }
  },
  30000
)
it.each([undefined, 0, async () => true])(
  'requires synchronous control authority (%s)',
  async authority => {
    const f = await fixture()
    try {
      expect(
        () =>
          new PrivateAcquisitionDisclosure(
            f.f.owner.domain,
            f.f.owner.store,
            f.f.f.contracts,
            f.options.access,
            f.f.clock,
            authority as unknown as () => boolean
          )
      ).toThrow('Acquisition control authority must be synchronous')
    } finally {
      await f.dispose()
    }
  },
  30000
)
it.each([undefined, async () => true])(
  'requires synchronous current authentication (%s)',
  async current => {
    const f = await fixture()
    try {
      expect(() =>
        f.disclosure.prepare(f.f.id, { ...f.caller, current: current as unknown as () => boolean })
      ).toThrow('Acquisition disclosure requires current authentication')
    } finally {
      await f.dispose()
    }
  },
  30000
)
it('refuses a profile selector different from the original retained contract', async () => {
  const f = await fixture()
  try {
    expect(() =>
      f.disclosure.prepare(f.f.id, { ...f.caller, profile: 'urn:other:profile' })
    ).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: 'Original acquisition selection differs'
      })
    )
  } finally {
    await f.dispose()
  }
}, 30000)
it.each(['caller', 'control'] as const)(
  'refuses rejected promised %s authority without sending diagnostics or leaking a rejection',
  async authority => {
    const f = await fixture()
    let sent = false
    try {
      const promised = (() =>
        Promise.reject(
          new Error('synthetic-private-authority-failure')
        )) as unknown as () => boolean
      const disclosure = new PrivateAcquisitionDisclosure(
        f.f.owner.domain,
        f.f.owner.store,
        f.f.f.contracts,
        f.options.access,
        f.f.clock,
        authority === 'control' ? promised : () => true
      )
      expect(() =>
        disclosure.enqueueControl(
          publicControl,
          authority === 'caller' ? { ...f.caller, current: promised } : f.caller,
          () => {
            sent = true
          }
        )
      ).toThrow(expect.objectContaining({ code: 'unauthorized' }))
      await Promise.resolve()
      expect(sent).toBe(false)
    } finally {
      await f.dispose()
    }
  },
  30000
)
it.each(['number', 'promise'] as const)(
  'consumes one body enqueue attempt when a synchronous callback violates its result contract (%s)',
  async result => {
    const f = await fixture()
    let sent = 0
    try {
      const prepared = f.disclosure.prepare(f.f.id, f.caller)
      expect(() =>
        prepared.enqueue(() => {
          sent++
          return result === 'number' ? 1 : Promise.reject(new Error('synthetic-send-failed'))
        })
      ).toThrow('Acquisition response enqueue must finish synchronously')
      await Promise.resolve()
      expect(() =>
        prepared.enqueue(() => {
          sent++
        })
      ).toThrow('already attempted')
      expect(sent).toBe(1)
    } finally {
      await f.dispose()
    }
  },
  30000
)
it.each(['number', 'promise'] as const)(
  'rejects an invalid control send result while retaining its observable failure (%s)',
  async result => {
    const f = await fixture()
    let sent = 0
    try {
      expect(() =>
        f.disclosure.enqueueControl(publicControl, f.caller, () => {
          sent++
          return result === 'number' ? 1 : Promise.reject(new Error('synthetic-send-failed'))
        })
      ).toThrow('Acquisition control enqueue must finish synchronously')
      await Promise.resolve()
      expect(sent).toBe(1)
    } finally {
      await f.dispose()
    }
  },
  30000
)
it('refuses an asynchronous control callback before it starts', async () => {
  const f = await fixture()
  let sent = false
  try {
    expect(() =>
      f.disclosure.enqueueControl(publicControl, f.caller, async () => {
        sent = true
      })
    ).toThrow('Acquisition control enqueue must be synchronous')
    expect(sent).toBe(false)
  } finally {
    await f.dispose()
  }
}, 30000)
it.each([
  'ledger',
  'identity',
  'address',
  'read',
  'ledger-disclose',
  'load',
  'store-disclose',
  'restore',
  'guard'
] as const)(
  'refuses prepared disclosure after its pinned %s ownership changes',
  async name => {
    const f = await fixture(),
      prepared = f.disclosure.prepare(f.f.id, f.caller)
    const key = name === 'ledger-disclose' || name === 'store-disclose' ? 'disclose' : name
    const owners = {
      ledger: f.f.owner.domain,
      identity: f.f.owner.domain,
      address: f.f.owner.domain.identity,
      read: f.f.owner.domain.ledger,
      'ledger-disclose': f.f.owner.domain.ledger,
      load: f.f.owner.store,
      'store-disclose': f.f.owner.store,
      restore: f.f.f.contracts,
      guard: f.options.access
    }
    const owner = owners[name]
    const descriptor = Object.getOwnPropertyDescriptor(owner, key),
      original: unknown = Reflect.get(owner, key)
    let sent = false
    try {
      Object.defineProperty(owner, key, {
        configurable: true,
        writable: true,
        value:
          typeof original === 'function' ? original.bind(owner) : new Proxy(original as object, {})
      })
      expect(() =>
        prepared.enqueue(() => {
          sent = true
        })
      ).toThrow()
      expect(sent).toBe(false)
    } finally {
      if (descriptor) Object.defineProperty(owner, key, descriptor)
      else Reflect.deleteProperty(owner, key)
      await f.dispose()
    }
  },
  30000
)
it('refuses a projection that does not supply a prepared response', async () => {
  const f = await fixture()
  try {
    const disclosure = new PrivateAcquisitionDisclosure(
      f.f.owner.domain,
      { load: f.f.owner.store.load.bind(f.f.owner.store), disclose() {} },
      f.f.f.contracts,
      f.options.access,
      f.f.clock,
      () => true
    )
    expect(() => disclosure.prepare(f.f.id, f.caller)).toThrow(
      expect.objectContaining({
        code: 'unavailable',
        message: 'Acquisition response is unavailable'
      })
    )
  } finally {
    await f.dispose()
  }
}, 30000)
