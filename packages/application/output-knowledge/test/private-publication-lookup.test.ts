import { expect, it, jest } from '@jest/globals'
import { Beef, OutputProtocolError, PrivateKey, Utils } from '@bsv/sdk'
import { PrivatePublicationLookupContext } from '../src/private/PrivatePublicationLookupContext.js'
import { publicationLookupFixture } from './private-publication-lookup.fixture.js'
import { allow } from './private-publication-fixture.js'

it('maps a distinct authorized recipient to exact legacy formula/context and physical native disclosure once', () => {
  const f = publicationLookupFixture(),
    prepared = f.reader.prepare(f.initial.publicationId, f.caller)
  expect(f.recipient).not.toBe(f.initial.publisher)
  expect(prepared.formula()).toEqual([{ txid: f.initial.txid, outputIndex: 0, context: [1, 2, 3] }])
  const formula = prepared.formula()
  formula[0].context[0] = 9
  expect(prepared.formula()[0].context).toEqual([1, 2, 3])
  const answer = f.answer(),
    bound = prepared.bind(answer),
    send = jest.fn<(body: string, headers: Readonly<Record<string, string>>) => void>()
  answer.outputs[0].context[0] = 9
  bound.enqueue(send)
  expect(send).toHaveBeenCalledWith(bound.body, bound.headers)
  expect(JSON.parse(bound.body).outputs[0].context).toEqual([1, 2, 3])
  expect(bound.headers['cache-control']).toBe('private, no-store')
  expect(() => bound.enqueue(send)).toThrow('already attempted')
  expect(() => prepared.bind(f.answer())).toThrow('already bound')
  expect(send).toHaveBeenCalledTimes(1)
})
it('authorizes recipient before private mapping and returns the same missing error without record disclosure', () => {
  const f = publicationLookupFixture()
  expect(() =>
    f.reader.prepare(f.initial.publicationId, {
      ...f.caller,
      recipient: new PrivateKey(65).toPublicKey().toString()
    })
  ).toThrow('Private lookup unavailable')
  expect(f.maps).toBe(0)
  f.revoke()
  expect(() => f.reader.prepare(f.initial.publicationId, f.caller)).toThrow(
    'Private lookup unavailable'
  )
  expect(() => f.reader.prepare('99'.repeat(32), f.caller)).toThrow('Private lookup unavailable')
  expect(f.maps).toBe(0)
})
it.each(['revoke', 'disconnect'] as const)(
  'rechecks %s after hydration/signing and refuses physical enqueue',
  change => {
    const f = publicationLookupFixture(),
      bound = f.reader.prepare(f.initial.publicationId, f.caller).bind(f.answer()),
      send = jest.fn<() => void>()
    f[change]()
    expect(() => bound.enqueue(send)).toThrow('Private lookup unavailable')
    expect(send).not.toHaveBeenCalled()
  }
)
it('rechecks cancellation and installed store/ledger ownership at native enqueue', () => {
  const f = publicationLookupFixture(),
    signal = new AbortController(),
    send = jest.fn<() => void>()
  const bound = f.reader
    .prepare(f.initial.publicationId, { ...f.caller, signal: signal.signal })
    .bind(f.answer())
  signal.abort()
  expect(() => bound.enqueue(send)).toThrow('Private lookup unavailable')
  const next = f.reader.prepare(f.initial.publicationId, f.caller).bind(f.answer())
  f.store.loadVerified = () => undefined
  expect(() => next.enqueue(send)).toThrow('Private lookup unavailable')
  expect(send).not.toHaveBeenCalled()
})
it('refuses readiness loss committed from a separate native connection and recovers unchanged context after reopen', () => {
  const f = publicationLookupFixture(),
    prepared = f.reader.prepare(f.initial.publicationId, f.caller),
    reopened = f.reopenReader()
  const recovered = reopened.prepare(f.initial.publicationId, f.caller).bind(f.answer())
  let sends = 0
  recovered.enqueue(() => {
    sends++
  })
  expect(sends).toBe(1)
  const peer = f.reopen(),
    snapshot = peer.loadVerified(f.initial.publicationId, () => '20', allow)!
  peer.markUnavailable(f.initial.publicationId, snapshot.record.revision, () => '21', allow)
  const stale = prepared.bind(f.answer())
  expect(() =>
    stale.enqueue(() => {
      sends++
    })
  ).toThrow('Private lookup unavailable')
  expect(() => reopened.prepare(f.initial.publicationId, f.caller)).toThrow(
    'Private lookup unavailable'
  )
  expect(sends).toBe(1)
})
it('disposes prepared private buffers and rejects later formula, bind and enqueue use', () => {
  const f = publicationLookupFixture(),
    prepared = f.reader.prepare(f.initial.publicationId, f.caller),
    bound = prepared.bind(f.answer())
  prepared.dispose()
  expect(() => prepared.formula()).toThrow('disposed')
  expect(() => prepared.bind(f.answer())).toThrow('disposed')
  expect(() => bound.enqueue(() => undefined)).toThrow('disposed')
})
it('rejects unbounded/async mapping, invalid capacities and noncurrent authenticated context', () => {
  const f = publicationLookupFixture()
  for (const maximumContextBytes of [0, -1, 1.5, 1048577])
    expect(
      () => new PrivatePublicationLookupContext({ ...f.options, maximumContextBytes })
    ).toThrow('byte capacity')
  for (const maximumResponseBytes of [0, 4194305])
    expect(
      () => new PrivatePublicationLookupContext({ ...f.options, maximumResponseBytes })
    ).toThrow('byte capacity')
  expect(
    () =>
      new PrivatePublicationLookupContext({
        ...f.options,
        mapContext: async () => new Uint8Array()
      } as unknown as typeof f.options)
  ).toThrow('must be synchronous')
  const reader = new PrivatePublicationLookupContext({
    ...f.options,
    mapContext: () => new Uint8Array(65)
  })
  expect(() => reader.prepare(f.initial.publicationId, f.caller)).toThrow('mapping exceeds')
  expect(() =>
    f.reader.prepare(f.initial.publicationId, {
      ...f.caller,
      current: async () => true
    } as unknown as typeof f.caller)
  ).toThrow('authenticated context')
  expect(() =>
    new PrivatePublicationLookupContext({
      ...f.options,
      authorize: () => Promise.resolve(true)
    } as unknown as typeof f.options).prepare(f.initial.publicationId, f.caller)
  ).toThrow('Private lookup unavailable')
})
it('requires the original lookup installation and ownership without re-admitting or changing stored material', () => {
  const f = publicationLookupFixture(),
    before = f.store.loadVerified(f.initial.publicationId, () => '20', allow)
  expect(() =>
    new PrivatePublicationLookupContext({
      ...f.options,
      lookup: { ...f.options.lookup, rulesDigest: '22'.repeat(32) }
    }).prepare(f.initial.publicationId, f.caller)
  ).toThrow('installation differs')
  expect(() =>
    new PrivatePublicationLookupContext({ ...f.options, topic: 'tm_other' }).prepare(
      f.initial.publicationId,
      f.caller
    )
  ).toThrow('retained binding differs')
  expect(f.store.loadVerified(f.initial.publicationId, () => '20', allow)).toEqual(before)
})
it('binds only exact complete hydrated raw output and mapped context, preserving declared plain subjects', () => {
  const f = publicationLookupFixture(),
    plain = f.answer(),
    beef = Beef.fromBinary(plain.outputs[0].beef)
  plain.outputs[0].beef = beef.toBinary()
  f.reader
    .prepare(f.initial.publicationId, f.caller)
    .bind(plain)
    .enqueue(() => undefined)
  const variations: unknown[] = [
    { type: 'freeform', outputs: [] },
    { type: 'output-list', outputs: [] },
    { ...f.answer(), unexpected: true },
    { type: 'output-list', outputs: [f.answer().outputs[0], f.answer().outputs[0]] },
    { type: 'output-list', outputs: [{ ...f.answer().outputs[0], outputIndex: 1 }] },
    { type: 'output-list', outputs: [{ ...f.answer().outputs[0], txid: '99'.repeat(32) }] },
    { type: 'output-list', outputs: [{ ...f.answer().outputs[0], context: [1, 2] }] },
    { type: 'output-list', outputs: [{ ...f.answer().outputs[0], context: [1, 2, 4] }] },
    { type: 'output-list', outputs: [{ ...f.answer().outputs[0], context: [1, 2, 256] }] },
    { type: 'output-list', outputs: [{ ...f.answer().outputs[0], context: [1, 2, 1.5] }] },
    { type: 'output-list', outputs: [{ ...f.answer().outputs[0], beef: 'AA==' }] },
    {
      type: 'output-list',
      outputs: [{ ...f.answer().outputs[0], beef: Utils.toArray(new Beef().toBinary()) }]
    }
  ]
  for (const answer of variations)
    expect(() => f.reader.prepare(f.initial.publicationId, f.caller).bind(answer)).toThrow()
})
it('rejects async/repeated physical send, preserves transport exceptions and requires returned undefined', () => {
  const f = publicationLookupFixture(),
    prepared = f.reader.prepare(f.initial.publicationId, f.caller),
    bound = prepared.bind(f.answer())
  let calls = 0
  expect(() =>
    bound.enqueue(async () => {
      calls++
    })
  ).toThrow('must be synchronous')
  expect(calls).toBe(0)
  expect(() =>
    bound.enqueue(() => {
      throw new Error('Late transport exception')
    })
  ).toThrow('Late transport exception')
  expect(() => bound.enqueue(() => undefined)).toThrow('already attempted')
  const other = f.reader.prepare(f.initial.publicationId, f.caller).bind(f.answer())
  expect(() => other.enqueue((() => true) as unknown as () => void)).toThrow(
    'complete synchronously'
  )
})

it('reads durable recipient entitlement inside the same native guard and refuses a separate-owner revocation before enqueue', () => {
  const f = publicationLookupFixture(),
    address = f.native.owner.identity.address('rules', {
      purpose: 'lookup-entitlement',
      recipient: f.recipient
    })
  const initial = f.native.owner.ledger.read([address], () => '20', allow)
  f.native.owner.ledger.commit(
    initial.revision,
    [
      {
        ...address,
        expectedRevision: null,
        reservedBytes: 1024,
        reservedUpdates: 2,
        value: { allowed: true }
      }
    ],
    () => '20',
    allow
  )
  const reader = new PrivatePublicationLookupContext({
    ...f.options,
    authorize: (_reference, recipient, _publisher, view) =>
      recipient === f.recipient && view.get(address)?.value.allowed === true,
    mapContext: (bytes, _reference, recipient) => {
      expect(recipient).toBe(f.recipient)
      return bytes
    }
  })
  const bound = reader.prepare(f.initial.publicationId, f.caller).bind(f.answer()),
    peer = f.reopenWithDomain(),
    before = peer.owner.ledger.read([address], () => '20', allow)
  peer.owner.ledger.commit(
    before.revision,
    [
      {
        ...address,
        expectedRevision: before.records[0]!.revision,
        reservedBytes: 1024,
        reservedUpdates: 1,
        value: { allowed: false }
      }
    ],
    () => '21',
    allow
  )
  const send = jest.fn<() => void>()
  expect(() => bound.enqueue(send)).toThrow('Private lookup unavailable')
  expect(send).not.toHaveBeenCalled()
  expect(() => reader.prepare(f.initial.publicationId, f.caller)).toThrow(
    'Private lookup unavailable'
  )
})
it('does not accept promise-returning mapping or transport wrappers and never repeats an uncertain enqueue', async () => {
  const f = publicationLookupFixture()
  const mapper = new PrivatePublicationLookupContext({
    ...f.options,
    mapContext: () => Promise.reject(new Error('Rejected mapping'))
  } as unknown as typeof f.options)
  expect(() => mapper.prepare(f.initial.publicationId, f.caller)).toThrow('mapping exceeds')
  const bound = f.reader.prepare(f.initial.publicationId, f.caller).bind(f.answer())
  let attempts = 0
  const send = (() => {
    attempts++
    return Promise.reject(new Error('Rejected transport'))
  }) as unknown as () => void
  expect(() => bound.enqueue(send)).toThrow('complete synchronously')
  expect(() => bound.enqueue(send)).toThrow('already attempted')
  expect(attempts).toBe(1)
  expect(() =>
    new PrivatePublicationLookupContext({
      ...f.options,
      authorize: () => Promise.reject(new Error('Rejected policy'))
    } as unknown as typeof f.options).prepare(f.initial.publicationId, f.caller)
  ).toThrow('Private lookup unavailable')
  await Promise.resolve()
})

function lookupRefusal(action: () => unknown, code: string, message: string) {
  expect(action).toThrow(expect.objectContaining({ code, message }))
}

it.each(['clock', 'authorize', 'mapContext'] as const)(
  'rejects a non-function installed %s before accessing protected records',
  callback => {
    const f = publicationLookupFixture()
    lookupRefusal(
      () => new PrivatePublicationLookupContext({ ...f.options, [callback]: undefined }),
      'invalid',
      'Private lookup callbacks must be synchronous'
    )
    expect(f.maps).toBe(0)
  }
)

it('accepts both declared capacity ceilings and an exactly full mapped context', () => {
  const f = publicationLookupFixture()
  expect(
    () =>
      new PrivatePublicationLookupContext({
        ...f.options,
        maximumContextBytes: 1048576,
        maximumResponseBytes: 4194304
      })
  ).not.toThrow()
  const reader = new PrivatePublicationLookupContext({
    ...f.options,
    maximumContextBytes: 3
  })
  const prepared = reader.prepare(f.initial.publicationId, f.caller)
  expect(prepared.formula()[0].context).toEqual([1, 2, 3])
  prepared.bind(f.answer()).enqueue(() => undefined)
})

it.each([false, true])('erases the borrowed private bytes after mapping (refused=%p)', refused => {
  const f = publicationLookupFixture()
  let borrowed: Uint8Array | undefined
  const reader = new PrivatePublicationLookupContext({
    ...f.options,
    maximumContextBytes: 3,
    mapContext: bytes => {
      borrowed = bytes
      expect(Array.from(bytes)).toEqual([1, 2, 3])
      return refused ? new Uint8Array(4) : bytes
    }
  })
  if (refused)
    lookupRefusal(
      () => reader.prepare(f.initial.publicationId, f.caller),
      'limited',
      'Private lookup context mapping exceeds its contract'
    )
  else
    expect(reader.prepare(f.initial.publicationId, f.caller).formula()[0].context).toEqual([
      1, 2, 3
    ])
  expect(Array.from(borrowed!)).toEqual([0, 0, 0])
})

it('requires a synchronous caller function and keeps missing lookup refusals indistinguishable', () => {
  const f = publicationLookupFixture()
  lookupRefusal(
    () => f.reader.prepare(f.initial.publicationId, { ...f.caller, current: undefined! }),
    'invalid',
    'Private lookup needs current authenticated context'
  )
  for (const id of ['99'.repeat(32), f.initial.publicationId]) {
    f.revoke()
    lookupRefusal(() => f.reader.prepare(id, f.caller), 'not-found', 'Private lookup unavailable')
  }
  expect(f.maps).toBe(0)
})

it.each(['ledger', 'identity', 'address', 'read', 'disclose', 'loadVerified'] as const)(
  'refuses a replaced installed %s before mapping private bytes',
  field => {
    const f = publicationLookupFixture(),
      domain = f.native.owner,
      replace = <T, K extends keyof T>(owner: T, key: K, value: T[K]) => {
        const original = owner[key]
        owner[key] = value
        return () => {
          owner[key] = original
        }
      }
    let restore: () => void
    if (field === 'ledger') restore = replace(domain, 'ledger', f.reopenWithDomain().owner.ledger)
    else if (field === 'identity')
      restore = replace(domain, 'identity', f.reopenWithDomain().owner.identity)
    else if (field === 'address')
      restore = replace(domain.identity, 'address', domain.identity.address.bind(domain.identity))
    else if (field === 'loadVerified')
      restore = replace(f.store, 'loadVerified', f.store.loadVerified.bind(f.store))
    else restore = replace(domain.ledger, field, domain.ledger[field].bind(domain.ledger))
    try {
      lookupRefusal(
        () => f.reader.prepare(f.initial.publicationId, f.caller),
        'not-found',
        'Private lookup unavailable'
      )
      expect(f.maps).toBe(0)
    } finally {
      restore()
    }
  }
)

it('preserves lookup installation errors and single-use lifecycle error identities', () => {
  const f = publicationLookupFixture()
  for (const lookup of [
    { ...f.options.lookup, service: 'ls_other' },
    { ...f.options.lookup, rulesDigest: '22'.repeat(32) }
  ])
    lookupRefusal(
      () =>
        new PrivatePublicationLookupContext({ ...f.options, lookup }).prepare(
          f.initial.publicationId,
          f.caller
        ),
      'unavailable',
      'Private lookup installation differs'
    )
  const prepared = f.reader.prepare(f.initial.publicationId, f.caller),
    bound = prepared.bind(f.answer())
  lookupRefusal(() => prepared.bind(f.answer()), 'conflict', 'Private lookup answer already bound')
  lookupRefusal(
    () => bound.enqueue(undefined!),
    'invalid',
    'Private lookup enqueue must be synchronous'
  )
  bound.enqueue(() => undefined)
  lookupRefusal(
    () => bound.enqueue(() => undefined),
    'conflict',
    'Private lookup enqueue already attempted'
  )
  prepared.dispose()
  for (const action of [
    prepared.formula,
    () => prepared.bind(f.answer()),
    () => bound.enqueue(() => undefined)
  ])
    lookupRefusal(action, 'cancelled', 'Private lookup preparation disposed')
})

it.each(['beef', 'context'] as const)(
  'validates every %s byte and its exact configured capacity',
  field => {
    const f = publicationLookupFixture()
    for (const invalid of [[-1, 2, 3], [0, 2, 256], [0, 1.5, 3], '123', { 0: 1, length: 1 }]) {
      const answer = f.answer()
      Object.assign(answer.outputs[0], { [field]: invalid })
      lookupRefusal(
        () => f.reader.prepare(f.initial.publicationId, f.caller).bind(answer),
        'invalid',
        Array.isArray(invalid) && invalid.includes(1.5)
          ? 'Protocol numbers must be safe integers'
          : 'Invalid private lookup byte array'
      )
    }
    const exact = new PrivatePublicationLookupContext({ ...f.options, maximumContextBytes: 3 })
    exact
      .prepare(f.initial.publicationId, f.caller)
      .bind(f.answer())
      .enqueue(() => undefined)
    const over = f.answer()
    over.outputs[0].context.push(0)
    lookupRefusal(
      () => exact.prepare(f.initial.publicationId, f.caller).bind(over),
      'invalid',
      'Invalid private lookup byte array'
    )
  }
)

it('bounds the complete hydrated response, accepts its explicit original txid and rejects mismatched answers', () => {
  const f = publicationLookupFixture(),
    answer = f.answer()
  Object.assign(answer.outputs[0], { txid: f.initial.txid })
  f.reader
    .prepare(f.initial.publicationId, f.caller)
    .bind(answer)
    .enqueue(() => undefined)
  const small = new PrivatePublicationLookupContext({ ...f.options, maximumResponseBytes: 1 })
  expect(() => small.prepare(f.initial.publicationId, f.caller).bind(answer)).toThrow(
    OutputProtocolError
  )
  lookupRefusal(
    () =>
      f.reader.prepare(f.initial.publicationId, f.caller).bind({ ...f.answer(), type: 'freeform' }),
    'invalid',
    'Private lookup requires one exact output'
  )
})
