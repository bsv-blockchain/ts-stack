import { expect, it, jest } from '@jest/globals'
import { PrivateKey } from '@bsv/sdk'
import { PrivatePublicationDisclosure } from '../src/private/PrivatePublicationDisclosure.js'
import { PrivatePublicationAccess } from '../src/private/PrivatePublicationAccess.js'
import { verifiedFixture } from './private-verified-publication-fixture.js'
import { allow } from './private-publication-fixture.js'
import { privatePublicationOperation } from '../src/private/PrivatePublicationProgress.js'

function fixture(observePrivateReads = false) {
  const f = verifiedFixture(),
    initial = f.stage()
  f.store.advance(initial.publicationId, '1', { kind: 'reserve-admission' }, () => '20', allow)
  const admitting = f.store.loadVerified(initial.publicationId, () => '20', allow)!
  f.store.advance(
    initial.publicationId,
    admitting.record.revision,
    {
      kind: 'admitted',
      admission: {
        operationId: privatePublicationOperation(initial),
        txid: initial.txid,
        assessmentContextId: 'original-assessment',
        steak: {
          [initial.topic]: {
            outputsToAdmit: [initial.outputIndex],
            coinsToRetain: [],
            coinsRemoved: []
          }
        }
      }
    },
    () => '20',
    allow
  )
  const binding = f.store.loadVerified(initial.publicationId, () => '20', allow)!
  f.store.bindVerified(initial.publicationId, binding.record.revision, () => '20', allow)
  let allowed = true,
    current = true,
    now = '20'
  const access = new PrivatePublicationAccess(f.native.owner, initial.topic, () => allowed)
  const privateRead = observePrivateReads ? jest.spyOn(f.store, 'loadVerified') : undefined
  const disclosure = new PrivatePublicationDisclosure(
    f.native.owner,
    f.store,
    f.contract.contracts,
    access,
    () => now
  )
  const caller = {
    publisher: initial.publisher,
    capability: f.contract.retained.selection.digest,
    profile: f.contract.retained.selection.profile.id,
    current: () => current
  }
  const status = { version: 1 as const, publicationId: initial.publicationId }
  return {
    ...f,
    disclosure,
    caller,
    status,
    access,
    privateRead,
    revoke() {
      allowed = false
    },
    disconnect() {
      current = false
    },
    time(value: string) {
      now = value
    }
  }
}
it('prepares public projection and enqueues only the exact body/selector once under the native gate', () => {
  const f = fixture(),
    send = jest.fn<(body: string, headers: Readonly<Record<string, string>>) => void>()
  const response = f.disclosure.prepare(f.status, f.caller)
  expect(JSON.parse(response.body)).toMatchObject({
    status: 'ready',
    publicationId: f.status.publicationId
  })
  expect(response.body).not.toContain('AQID')
  expect(response.headers).toEqual(f.contract.retained.selection.headers)
  response.enqueue(send)
  expect(send).toHaveBeenCalledWith(response.body, response.headers)
  expect(() => response.enqueue(send)).toThrow('already attempted')
  expect(send).toHaveBeenCalledTimes(1)
})
it('rechecks current publisher policy after signing and before actual enqueue', () => {
  const f = fixture(),
    send = jest.fn<(body: string, headers: Readonly<Record<string, string>>) => void>(),
    response = f.disclosure.prepare(f.status, f.caller)
  f.revoke()
  expect(() => response.enqueue(send)).toThrow('Private publication not found')
  expect(send).not.toHaveBeenCalled()
})
it('rechecks authenticated session and cancellation after preparation', () => {
  const f = fixture(),
    send = jest.fn<(body: string, headers: Readonly<Record<string, string>>) => void>(),
    abort = new AbortController()
  const response = f.disclosure.prepare(f.status, { ...f.caller, signal: abort.signal })
  abort.abort()
  expect(() => response.enqueue(send)).toThrow('Private publication not found')
  expect(send).not.toHaveBeenCalled()
  const second = f.disclosure.prepare(f.status, f.caller)
  f.disconnect()
  expect(() => second.enqueue(send)).toThrow('Private publication not found')
})
it('rejects stale ready response if a separate connection records readiness loss', () => {
  const f = fixture(),
    send = jest.fn<(body: string, headers: Readonly<Record<string, string>>) => void>(),
    response = f.disclosure.prepare(f.status, f.caller)
  const peer = f.reopen(),
    loaded = peer.loadVerified(f.status.publicationId, () => '20', allow)!
  peer.advance(
    f.status.publicationId,
    loaded.record.revision,
    { kind: 'unavailable', reason: 'Asset unavailable' },
    () => '21',
    allow
  )
  expect(() => response.enqueue(send)).toThrow('changed before disclosure')
  expect(send).not.toHaveBeenCalled()
  const replacement = f.disclosure.prepare(f.status, f.caller)
  expect(JSON.parse(replacement.body)).toMatchObject({ status: 'unavailable' })
})
it('preserves original selection for response recovery after manifest expiry', () => {
  const f = fixture(),
    send = jest.fn<(body: string, headers: Readonly<Record<string, string>>) => void>()
  f.time('101')
  const response = f.disclosure.prepare(f.status, f.caller)
  response.enqueue(send)
  expect(send).toHaveBeenCalledTimes(1)
})
it('rejects wrong publisher or original selector before response preparation', () => {
  const f = fixture()
  expect(() =>
    f.disclosure.prepare(f.status, {
      ...f.caller,
      publisher: new PrivateKey(64).toPublicKey().toString()
    })
  ).toThrow('Private publication not found')
  expect(() =>
    f.disclosure.prepare(f.status, { ...f.caller, capability: '99'.repeat(32) })
  ).toThrow('Original publication capability selector differs')
})

it.each(['capability', 'profile'] as const)(
  'refuses the wrong original %s before reading protected publication material',
  selector => {
    const f = fixture(true)
    try {
      expect(() =>
        f.disclosure.prepare(f.status, {
          ...f.caller,
          ...(selector === 'capability'
            ? { capability: '99'.repeat(32) }
            : { profile: 'other-profile' })
        })
      ).toThrow(
        expect.objectContaining({
          code: 'context-changed',
          message: 'Original publication capability selector differs'
        })
      )
      expect(f.privateRead).not.toHaveBeenCalled()
      expect(JSON.parse(f.disclosure.prepare(f.status, f.caller).body).status).toBe('ready')
      expect(f.privateRead).toHaveBeenCalled()
    } finally {
      f.privateRead?.mockRestore()
    }
  }
)
it('does not retry or claim rollback after enqueue itself throws', () => {
  const f = fixture(),
    send = jest.fn(() => {
      throw new Error('Late transport error')
    })
  const response = f.disclosure.prepare(f.status, f.caller)
  expect(() => response.enqueue(send)).toThrow('Late transport error')
  expect(() => response.enqueue(send)).toThrow('already attempted')
  expect(send).toHaveBeenCalledTimes(1)
})
it('requires a synchronous physical enqueue and does not execute an async function', () => {
  const f = fixture(),
    send = jest.fn(async () => {})
  const response = f.disclosure.prepare(f.status, f.caller)
  // The native async function identity remains visible without a mock wrapper.
  let calls = 0
  expect(() =>
    response.enqueue(async () => {
      calls++
    })
  ).toThrow('must be synchronous')
  expect(calls).toBe(0)
  expect(send).not.toHaveBeenCalled()
})
it('detects replacement of installed current access at the final gate', () => {
  const f = fixture(),
    send = jest.fn<(body: string, headers: Readonly<Record<string, string>>) => void>(),
    response = f.disclosure.prepare(f.status, f.caller)
  f.access.guard = () => allow
  expect(() => response.enqueue(send)).toThrow('Private publication not found')
  expect(send).not.toHaveBeenCalled()
})

it.each(['read', 'disclose'] as const)(
  'refuses replacement of installed native %s after preparing a response',
  method => {
    const f = fixture(),
      prepared = f.disclosure.prepare(f.status, f.caller),
      changed = jest.spyOn(f.native.owner.ledger, method),
      send = jest.fn<() => void>()
    try {
      expect(() => prepared.enqueue(send)).toThrow(
        expect.objectContaining({ code: 'not-found', message: 'Private publication not found' })
      )
      expect(send).not.toHaveBeenCalled()
    } finally {
      changed.mockRestore()
    }
  }
)

it.each(['loadVerified', 'loadStatus', 'markUnavailable'] as const)(
  'refuses replacement of installed store %s after preparing a response',
  method => {
    const f = fixture(),
      prepared = f.disclosure.prepare(f.status, f.caller),
      changed = jest.spyOn(f.store, method),
      send = jest.fn<() => void>()
    try {
      expect(() => prepared.enqueue(send)).toThrow(
        expect.objectContaining({ code: 'not-found', message: 'Private publication not found' })
      )
      expect(send).not.toHaveBeenCalled()
    } finally {
      changed.mockRestore()
    }
  }
)

it.each([
  {
    name: 'contract restoration',
    replace: (f: ReturnType<typeof fixture>) => jest.spyOn(f.contract.contracts, 'restore')
  },
  {
    name: 'native identity addressing',
    replace: (f: ReturnType<typeof fixture>) => jest.spyOn(f.native.owner.identity, 'address')
  }
])('refuses changed installed $name at physical response enqueue', ({ replace }) => {
  const f = fixture(),
    prepared = f.disclosure.prepare(f.status, f.caller),
    changed = replace(f),
    send = jest.fn<() => void>()
  try {
    expect(() => prepared.enqueue(send)).toThrow(
      expect.objectContaining({ code: 'not-found', message: 'Private publication not found' })
    )
    expect(send).not.toHaveBeenCalled()
  } finally {
    changed.mockRestore()
  }
})

it('requires every installed authority to remain current before control disclosure', () => {
  const f = fixture(),
    disclosure = new PrivatePublicationDisclosure(
      f.native.owner,
      f.store,
      f.contract.contracts,
      f.access,
      () => '20',
      () => true
    ),
    changed = jest.spyOn(f.contract.contracts, 'restore'),
    send = jest.fn<() => void>()
  try {
    expect(() =>
      disclosure.enqueueControl(
        {
          version: 1,
          error: {
            code: 'not-found',
            message: 'Private publication request not-found',
            retryable: false
          }
        },
        f.caller,
        send
      )
    ).toThrow(
      expect.objectContaining({
        code: 'unauthorized',
        message: 'Private publication control authority changed'
      })
    )
    expect(send).not.toHaveBeenCalled()
  } finally {
    changed.mockRestore()
  }
})

it.each([null, 0, false, 'clock'])(
  'requires a callable disclosure clock at installation: %p',
  clock => {
    const f = fixture()
    expect(
      () =>
        new PrivatePublicationDisclosure(
          f.native.owner,
          f.store,
          f.contract.contracts,
          f.access,
          clock as unknown as () => string
        )
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Publication disclosure clock is required'
      })
    )
  }
)

it.each([null, false, 0, 'current', async () => true])(
  'refuses a non-synchronous authenticated caller before preparing response bytes: %p',
  current => {
    const f = fixture()
    expect(() =>
      f.disclosure.prepare(f.status, { ...f.caller, current: current as unknown as () => boolean })
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Publication disclosure requires current authenticated context'
      })
    )
  }
)

it.each([null, false, 0, 'enqueue'])(
  'refuses a non-callable physical enqueue without spending the prepared response: %p',
  invalid => {
    const f = fixture(),
      prepared = f.disclosure.prepare(f.status, f.caller),
      send = jest.fn<() => void>()
    expect(() => prepared.enqueue(invalid as unknown as () => void)).toThrow('must be synchronous')
    prepared.enqueue(send)
    expect(send).toHaveBeenCalledTimes(1)
  }
)

it('requires installed current control authority and accepts only fixed bounded public errors', () => {
  const f = fixture(),
    send = jest.fn<() => void>()
  const packet = {
    version: 1,
    error: { code: 'not-found', message: 'Private publication request not-found', retryable: false }
  }
  expect(() => f.disclosure.enqueueControl(packet, f.caller, send)).toThrow(
    'authority must be installed'
  )
  let allowed = true
  const disclosure = new PrivatePublicationDisclosure(
    f.native.owner,
    f.store,
    f.contract.contracts,
    f.access,
    () => '20',
    () => allowed
  )
  expect(() =>
    disclosure.enqueueControl(
      { ...packet, error: { ...packet.error, message: 'Secret row diagnostic' } },
      f.caller,
      send
    )
  ).toThrow('fixed public diagnostics')
  disclosure.enqueueControl(packet, f.caller, send)
  expect(send).toHaveBeenCalledTimes(1)
  allowed = false
  expect(() => disclosure.enqueueControl(packet, f.caller, send)).toThrow(
    'control authority changed'
  )
  expect(send).toHaveBeenCalledTimes(1)
})

it.each(['cancelled', 'disconnected'] as const)(
  'does not enqueue a public control response after its session becomes %s',
  mode => {
    const f = fixture(),
      abort = new AbortController(),
      current = jest.fn(() => mode !== 'disconnected'),
      send = jest.fn<() => void>(),
      disclosure = new PrivatePublicationDisclosure(
        f.native.owner,
        f.store,
        f.contract.contracts,
        f.access,
        () => '20',
        () => true
      )
    if (mode === 'cancelled') abort.abort()
    expect(() =>
      disclosure.enqueueControl(
        {
          version: 1,
          error: {
            code: 'not-found',
            message: 'Private publication request not-found',
            retryable: false
          }
        },
        { ...f.caller, signal: abort.signal, current },
        send
      )
    ).toThrow(
      expect.objectContaining({
        code: 'unauthorized',
        message: 'Private publication control authority changed'
      })
    )
    expect(send).not.toHaveBeenCalled()
    if (mode === 'cancelled') expect(current).not.toHaveBeenCalled()
  }
)

it.each([null, false, 0, 'authority', async () => true])(
  'requires installed synchronous control authority before native control disclosure: %p',
  authority => {
    const f = fixture(),
      send = jest.fn<() => void>(),
      disclosure = new PrivatePublicationDisclosure(
        f.native.owner,
        f.store,
        f.contract.contracts,
        f.access,
        () => '20',
        authority as unknown as () => boolean
      )
    expect(() =>
      disclosure.enqueueControl(
        {
          version: 1,
          error: {
            code: 'not-found',
            message: 'Private publication request not-found',
            retryable: false
          }
        },
        f.caller,
        send
      )
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Private publication control authority must be installed and synchronous'
      })
    )
    expect(send).not.toHaveBeenCalled()
  }
)

it.each([null, false, 0, 'current', async () => true])(
  'requires a synchronous authenticated control session before native disclosure: %p',
  current => {
    const f = fixture(),
      send = jest.fn<() => void>(),
      disclosure = new PrivatePublicationDisclosure(
        f.native.owner,
        f.store,
        f.contract.contracts,
        f.access,
        () => '20',
        () => true
      )
    expect(() =>
      disclosure.enqueueControl(
        {
          version: 1,
          error: {
            code: 'not-found',
            message: 'Private publication request not-found',
            retryable: false
          }
        },
        { ...f.caller, current: current as unknown as () => boolean },
        send
      )
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Private publication control authority must be installed and synchronous'
      })
    )
    expect(send).not.toHaveBeenCalled()
  }
)

it.each([null, false, 0, 'enqueue'])(
  'refuses a non-callable physical control enqueue before native disclosure: %p',
  invalid => {
    const f = fixture(),
      disclosure = new PrivatePublicationDisclosure(
        f.native.owner,
        f.store,
        f.contract.contracts,
        f.access,
        () => '20',
        () => true
      )
    expect(() =>
      disclosure.enqueueControl(
        {
          version: 1,
          error: {
            code: 'not-found',
            message: 'Private publication request not-found',
            retryable: false
          }
        },
        f.caller,
        invalid as unknown as () => void
      )
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Publication control enqueue must be synchronous'
      })
    )
  }
)

it('does not invoke an asynchronous physical control enqueue', () => {
  const f = fixture(),
    disclosure = new PrivatePublicationDisclosure(
      f.native.owner,
      f.store,
      f.contract.contracts,
      f.access,
      () => '20',
      () => true
    )
  let calls = 0
  expect(() =>
    disclosure.enqueueControl(
      {
        version: 1,
        error: {
          code: 'not-found',
          message: 'Private publication request not-found',
          retryable: false
        }
      },
      f.caller,
      async () => {
        calls++
      }
    )
  ).toThrow(
    expect.objectContaining({
      code: 'invalid',
      message: 'Publication control enqueue must be synchronous'
    })
  )
  expect(calls).toBe(0)
})

it('never retries a physical enqueue whose synchronous return violates the port contract', () => {
  const f = fixture(),
    prepared = f.disclosure.prepare(f.status, f.caller),
    first = jest.fn(() => true),
    second = jest.fn<() => void>()
  expect(() => prepared.enqueue(first)).toThrow('must finish synchronously')
  expect(first).toHaveBeenCalledTimes(1)
  expect(() => prepared.enqueue(second)).toThrow(
    expect.objectContaining({
      code: 'conflict',
      message: 'Publication disclosure was already attempted'
    })
  )
  expect(second).not.toHaveBeenCalled()
})

it('consumes a rejected asynchronous currentness verdict without disclosing native records', async () => {
  const f = fixture(),
    error = new Error('private currentness diagnostic'),
    verdict = Promise.reject(error),
    caught = jest.spyOn(verdict, 'catch')
  try {
    expect(() =>
      f.disclosure.prepare(f.status, {
        ...f.caller,
        current: (() => verdict) as unknown as () => boolean
      })
    ).toThrow('Private publication not found')
    expect(caught).toHaveBeenCalledWith(expect.any(Function))
    await expect(verdict).rejects.toBe(error)
  } finally {
    caught.mockRestore()
  }
})

it.each(['session', 'control'] as const)(
  'refuses and consumes a rejected asynchronous %s control verdict before enqueue',
  async boundary => {
    const f = fixture(),
      error = new Error('Synthetic control authority failure'),
      verdict = Promise.reject(error),
      observed = verdict.then(
        () => undefined,
        failure => failure
      ),
      caught = jest.spyOn(verdict, 'catch'),
      send = jest.fn<() => void>()
    const current = () => (boundary === 'session' ? verdict : true) as unknown as boolean
    const authorize = () => (boundary === 'control' ? verdict : true) as unknown as boolean
    const disclosure = new PrivatePublicationDisclosure(
      f.native.owner,
      f.store,
      f.contract.contracts,
      f.access,
      () => '20',
      authorize
    )
    try {
      expect(() =>
        disclosure.enqueueControl(
          {
            version: 1,
            error: {
              code: 'not-found',
              message: 'Private publication request not-found',
              retryable: false
            }
          },
          { ...f.caller, current },
          send
        )
      ).toThrow('Private publication control authority changed')
      expect(caught).toHaveBeenCalledWith(expect.any(Function))
      expect(send).not.toHaveBeenCalled()
    } finally {
      expect(await observed).toBe(error)
      caught.mockRestore()
    }
  }
)

it('consumes a rejected physical enqueue promise and never retries the attempted response', async () => {
  const f = fixture(),
    response = f.disclosure.prepare(f.status, f.caller),
    error = new Error('private enqueue diagnostic'),
    verdict = Promise.reject(error),
    caught = jest.spyOn(verdict, 'catch'),
    send = jest.fn(() => verdict)
  try {
    expect(() => response.enqueue(send)).toThrow(
      'Publication response enqueue must finish synchronously'
    )
    expect(caught).toHaveBeenCalledWith(expect.any(Function))
    expect(() => response.enqueue(send)).toThrow('Publication disclosure was already attempted')
    expect(send).toHaveBeenCalledTimes(1)
    await expect(verdict).rejects.toBe(error)
  } finally {
    caught.mockRestore()
  }
})

it('consumes a rejected control enqueue promise at the actual native disclosure boundary', async () => {
  const f = fixture(),
    disclosure = new PrivatePublicationDisclosure(
      f.native.owner,
      f.store,
      f.contract.contracts,
      f.access,
      () => '20',
      () => true
    ),
    error = new Error('private control enqueue diagnostic'),
    verdict = Promise.reject(error),
    caught = jest.spyOn(verdict, 'catch'),
    send = jest.fn(() => verdict)
  try {
    expect(() =>
      disclosure.enqueueControl(
        {
          version: 1,
          error: {
            code: 'not-found',
            message: 'Private publication request not-found',
            retryable: false
          }
        },
        f.caller,
        send
      )
    ).toThrow('Publication control enqueue must finish synchronously')
    expect(send).toHaveBeenCalledTimes(1)
    expect(caught).toHaveBeenCalledWith(expect.any(Function))
    await expect(verdict).rejects.toBe(error)
  } finally {
    caught.mockRestore()
  }
})
