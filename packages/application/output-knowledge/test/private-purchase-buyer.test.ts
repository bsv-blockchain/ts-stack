import { expect, it, jest } from '@jest/globals'
import {
  canonicalOutputJSON,
  outputPacketDigest,
  type OutputPurchaseEnvelope,
  type OutputPurchaseTransport
} from '@bsv/sdk'
import { signPurchaseFixturePacket } from './private-purchase-signing.fixture.js'
import {
  PrivatePurchaseBuyer,
  privatePurchaseBuyerBinding
} from '../src/private/PrivatePurchaseBuyer.js'
import { purchaseBuyerFixture } from './private-purchase-buyer.fixture.js'

it.each(['signature', 'request', 'domain'] as const)(
  'rechecks changed %s bytes through repeated original terms validation',
  async kind => {
    const f = purchaseBuyerFixture()
    let changed = false
    const owner = await f.open(true, {}, ports => {
      const read = ports.objects.read.bind(ports.objects)
      jest.spyOn(ports.objects, 'read').mockImplementation(async (id, binding) => {
        const saved = await read(id, binding)
        if (!changed || binding.role !== 'terms' || saved.state !== 'stored') return saved
        const original = JSON.parse(new TextDecoder().decode(saved.bytes))
        saved.bytes.fill(0)
        if (kind === 'signature') original.signature = 'AA=='
        else {
          if (kind === 'request') original.body.requestDigest = 'c3'.repeat(32)
          else original.body.domainProfile = 'urn:test:unsupported-domain'
          original.signature = signPurchaseFixturePacket(
            'purchase-terms',
            original.body,
            f.server.f.f.f.key
          ).signature
        }
        return { ...saved, bytes: new TextEncoder().encode(canonicalOutputJSON(original)) }
      })
    })
    const result = await owner.buyer.advance()
    expect(await owner.buyer.recover()).toEqual(result)
    changed = true
    await expect(owner.buyer.recover()).rejects.toThrow()
    changed = false
    expect(await owner.buyer.recover()).toEqual(result)
    expect(f.counts.finish).toBe(1)
    expect(f.server.counts.issue).toBe(1)
    f.setAccess(false)
    await expect(owner.buyer.recover()).rejects.toThrow('access')
  }
)

it('reserves commitment custody before preparation, retains the verified identity once and reopens historical rights', async () => {
  const f = purchaseBuyerFixture('full-purchase-commitment-v1'),
    verified = jest.spyOn(f.partial.validation, 'candidateBinding'),
    owner = await f.open(true)
  expect(f.reservations).toEqual([
    'request',
    'contract',
    'terms',
    'plan',
    'candidate',
    'result',
    'commitment'
  ])
  expect(f.calls).toEqual([])
  expect(f.counts.finish).toBe(0)
  const result = await owner.buyer.advance()
  expect(result).toHaveProperty('result.purchaseCommitment', f.server.f.purchaseCommitment)
  expect(verified).toHaveBeenCalledTimes(1)
  expect(verified.mock.calls[0][2]).toEqual(f.server.f.candidate)
  expect(await owner.buyer.validate()).toBe('usable')
  await f.close(owner)
  f.setNow('100000')
  const reopened = await f.open()
  // Retained identity is immutable evidence, not a new current-chain assessment.
  verified.mockImplementation(async () => {
    throw new Error('No new chain gate')
  })
  expect(await reopened.buyer.recover()).toEqual(result)
  expect(await reopened.buyer.usableResult()).toEqual(result)
  expect(f.counts.finish).toBe(1)
  expect(f.server.counts.issue).toBe(1)
  expect(f.bindingChecks()).toBe(1)
})

it('recovers a lost protected identity write without replacing the funded candidate or verifying it again', async () => {
  const f = purchaseBuyerFixture('full-purchase-commitment-v1')
  let cut = true
  const first = await f.open(true, {}, ports => {
    const put = ports.objects.put.bind(ports.objects)
    jest.spyOn(ports.objects, 'put').mockImplementation(async (id, binding, bytes) => {
      const result = await put(id, binding, bytes)
      if (cut && binding.role === 'commitment') {
        cut = false
        throw new Error('Lost committed identity reply')
      }
      return result
    })
  })
  await expect(first.buyer.advance()).rejects.toThrow('Lost committed identity reply')
  await f.close(first)
  const next = await f.open()
  await next.buyer.recover()
  expect((await next.buyer.advance()).result.status).toBe('delivered')
  expect(f.bindingChecks()).toBe(1)
  expect(f.counts.finish).toBe(1)
})

it.each(['missing', 'inherited', 'accessor', 'mutable', 'promise'] as const)(
  'refuses a %s candidate identity before submitting retained financial bytes',
  async kind => {
    const f = purchaseBuyerFixture('full-purchase-commitment-v1')
    f.partial.validation.candidateBinding = async () => {
      const purchaseCommitment = f.server.f.purchaseCommitment!
      if (kind === 'missing') return { checkCurrent: () => {} } as never
      if (kind === 'inherited')
        return Object.assign(Object.create({ purchaseCommitment }), { checkCurrent: () => {} })
      if (kind === 'accessor')
        return {
          get purchaseCommitment() {
            return purchaseCommitment
          },
          checkCurrent: () => {}
        }
      const result = { purchaseCommitment, checkCurrent: () => {} }
      result.checkCurrent =
        kind === 'promise'
          ? ((() => Promise.reject(new Error('Deferred identity guard'))) as never)
          : () => {
              result.purchaseCommitment = 'b4'.repeat(32)
            }
      return result
    }
    const owner = await f.open(true)
    await expect(owner.buyer.advance()).rejects.toThrow()
    expect(f.calls).toEqual(['prepare'])
    expect(f.counts.finish).toBe(1)
    expect(f.server.counts.issue).toBe(0)
  }
)

it('checks the saved domain and identity before retaining an authenticated response', async () => {
  const f = purchaseBuyerFixture('full-purchase-commitment-v1'),
    send = f.wire.getMockImplementation()!
  f.wire.mockImplementation(async function (this: OutputPurchaseTransport<'prepare'>, ...args) {
    const packet = (await send.apply(this, args)) as unknown as OutputPurchaseEnvelope
    if ('result' in packet && packet.result.status === 'delivered')
      packet.result.purchaseCommitment = 'b4'.repeat(32)
    return packet as never
  })
  const owner = await f.open(true)
  await expect(owner.buyer.advance()).rejects.toThrow()
  expect(await owner.buyer.status()).toBe('funded')
  expect(f.counts.finish).toBe(1)
})

it('leaves independent released-subject verification mandatory for a signed alias representation', async () => {
  const f = purchaseBuyerFixture('full-purchase-commitment-v1'),
    send = f.wire.getMockImplementation()!,
    aliasTxid = 'cd'.repeat(32),
    verify = jest
      .spyOn(f.partial.validation, 'verify')
      .mockRejectedValue(new Error('Released Script unresolved'))
  // Controlled representation only; no claim of Bitcoin alias validity.
  f.wire.mockImplementation(async function (this: OutputPurchaseTransport<'prepare'>, ...args) {
    const packet = (await send.apply(this, args)) as unknown as OutputPurchaseEnvelope
    if ('result' in packet && packet.result.status === 'delivered') {
      packet.result.txid = aliasTxid
      packet.releaseEvidence!.txid = aliasTxid
      packet.result.potatoes = signPurchaseFixturePacket(
        'potatoes',
        {
          ...packet.result.potatoes.body,
          txid: aliasTxid,
          evidenceDigest: outputPacketDigest('release-evidence', packet.releaseEvidence)
        },
        f.server.f.f.f.key
      )
    }
    return packet as never
  })
  const owner = await f.open(true),
    received = await owner.buyer.advance()
  expect(received).toHaveProperty('result.txid', aliasTxid)
  await expect(owner.buyer.validate()).rejects.toThrow('Released Script unresolved')
  expect(verify.mock.calls[0][2]).toEqual(f.server.f.candidate)
  expect(verify.mock.calls[0][3]).toEqual(received)
  expect(await owner.buyer.status()).toBe('received')
  await expect(owner.buyer.usableResult()).rejects.toThrow('not usable')
  expect(f.counts.finish).toBe(1)
})

it('retains one original purchase in protected native custody and reopens usable rights after expiry', async () => {
  const f = purchaseBuyerFixture(),
    owner = await f.open(true)
  expect(await owner.buyer.status()).toBe('ready')
  const result = await owner.buyer.advance()
  expect(result.result.status).toBe('delivered')
  expect(await owner.buyer.status()).toBe('received')
  expect(await owner.buyer.validate()).toBe('usable')
  await owner.buyer.stop()
  await owner.state.close()
  await owner.objects.close()
  f.setNow('200')
  const reopened = await f.open()
  expect(await reopened.buyer.recover()).toEqual(result)
  expect(await reopened.buyer.usableResult()).toEqual(result)
  expect(f.counts.finish).toBe(1)
  expect(f.server.counts.issue).toBe(1)
  expect(f.calls).toEqual(['prepare', 'submit'])
})
it.each(['prepare', 'finish', 'submit'] as const)(
  'recovers a lost %s reply without a replacement financial action',
  async lost => {
    const f = purchaseBuyerFixture(),
      first = await f.open(true)
    f.lose(lost)
    await expect(first.buyer.advance()).rejects.toThrow('Lost original')
    const second = await f.open()
    const prior = f.counts.finish
    await second.buyer.recover()
    expect(f.counts.finish).toBe(prior)
    const result = await second.buyer.advance()
    expect(result.result.status).toBe('delivered')
    expect(f.counts.finish).toBe(1)
    expect(f.server.counts.issue).toBe(1)
    expect(await second.buyer.validate()).toBe('usable')
  }
)
it('allows an already finalized retained transaction after cutoff but refuses new funding', async () => {
  const f = purchaseBuyerFixture(),
    owner = await f.open(true)
  f.lose('finish')
  await expect(owner.buyer.advance()).rejects.toThrow('wallet reply')
  f.setNow('200')
  expect((await owner.buyer.advance()).result.status).toBe('delivered')
  expect(f.counts.finish).toBe(1)
  const g = purchaseBuyerFixture(),
    other = await g.open(true)
  g.setNow('200')
  await expect(other.buyer.advance()).rejects.toThrow()
  expect(g.counts.finish).toBe(0)
})
it('separates retained delivered bytes, independent validation and current usability', async () => {
  const f = purchaseBuyerFixture(),
    owner = await f.open(true)
  await owner.buyer.advance()
  f.setValid(false)
  await expect(owner.buyer.validate()).rejects.toThrow('material')
  expect(await owner.buyer.status()).toBe('received')
  f.setValid(true)
  f.setUsable(false)
  expect(await owner.buyer.validate()).toBe('validated')
  await expect(owner.buyer.usableResult()).rejects.toThrow('not usable')
  f.setUsable(true)
  expect(await owner.buyer.validate()).toBe('usable')
  f.setAccess(false)
  await expect(owner.buyer.usableResult()).rejects.toThrow('access changed')
  expect(f.counts.finish).toBe(1)
})
it('refuses changed owners, original requests and missing future capacity before money', async () => {
  const f = purchaseBuyerFixture(),
    owner = await f.open(true)
  for (const partial of [
    {
      ...f.partial,
      original: {
        ...f.partial.original,
        request: { ...f.partial.original.request, request: 'AQ==' }
      }
    },
    { ...f.partial, payment: { ...f.partial.payment, configuration: { replaced: true } } }
  ]) {
    expect(canonicalOutputJSON(privatePurchaseBuyerBinding(partial))).not.toBe(
      canonicalOutputJSON(f.binding)
    )
    await expect(PrivatePurchaseBuyer.open({ ...owner.ports, ...partial })).rejects.toThrow(
      'binding'
    )
  }
  await expect(
    PrivatePurchaseBuyer.open({
      ...owner.ports,
      objects: {
        ...owner.objects,
        configuration: { ...owner.objects.configuration, maximumObjects: 5 }
      }
    } as never)
  ).rejects.toThrow('capacity')
  Object.defineProperty(f.partial.validation, 'id', { value: 'changed' })
  await expect(owner.buyer.advance()).rejects.toThrow('capability changed')
  expect(f.counts.finish).toBe(0)
})
it('read-only recovery never starts preparation and backward clocks refuse new effects', async () => {
  const f = purchaseBuyerFixture(),
    owner = await f.open(true)
  expect(await owner.buyer.recover()).toBeUndefined()
  expect(f.calls).toEqual([])
  f.setNow('19')
  await expect(owner.buyer.advance()).rejects.toThrow('clock moved')
  expect(f.counts.finish).toBe(0)
})
it.each(['terms', 'plan', 'candidate', 'result'] as const)(
  'reconciles a committed %s object after its local reply is lost',
  async role => {
    const f = purchaseBuyerFixture(),
      first = await f.open(true),
      put = first.objects.put.bind(first.objects)
    let cut = true
    jest.spyOn(first.objects, 'put').mockImplementation(async (id, binding, bytes) => {
      const result = await put(id, binding, bytes)
      if (cut && binding.role === role) {
        cut = false
        throw new Error('Lost committed object reply')
      }
      return result
    })
    const interrupted = await PrivatePurchaseBuyer.open(first.ports)
    await expect(interrupted.advance()).rejects.toThrow('Lost committed object')
    await interrupted.stop()
    const next = await f.open(),
      financialWork = f.counts.finish
    await next.buyer.recover()
    expect(f.counts.finish).toBe(financialWork)
    expect((await next.buyer.advance()).result.status).toBe('delivered')
    expect(await next.buyer.validate()).toBe('usable')
    expect(f.counts.finish).toBe(1)
    expect(f.server.counts.issue).toBe(1)
  }
)
it.each(['prepared', 'funding', 'funded', 'received'] as const)(
  'reconciles native %s control commit without another financial action',
  async phase => {
    const f = purchaseBuyerFixture(),
      first = await f.open(true),
      cas = first.state.compareAndSwap.bind(first.state)
    let cut = true
    jest.spyOn(first.state, 'compareAndSwap').mockImplementation(async (revision, value) => {
      const result = await cas(revision, value)
      if (cut && value.phase === phase) {
        cut = false
        throw new Error('Lost committed control reply')
      }
      return result
    })
    const interrupted = await PrivatePurchaseBuyer.open(first.ports)
    await expect(interrupted.advance()).rejects.toThrow('Lost committed control')
    await interrupted.stop()
    const next = await f.open(),
      financialWork = f.counts.finish
    await next.buyer.recover()
    expect(f.counts.finish).toBe(financialWork)
    expect((await next.buyer.advance()).result.status).toBe('delivered')
    expect(f.counts.finish).toBe(1)
    expect(f.server.counts.issue).toBe(1)
  }
)
it('drains physical preparation after cancellation and rejects overlap while it is still active', async () => {
  const f = purchaseBuyerFixture(),
    first = await f.open(true),
    original = f.partial.validation.preflight
  let release = () => {},
    entered = () => {}
  const begun = new Promise<void>(resolve => {
      entered = resolve
    }),
    pending = new Promise<void>(resolve => {
      release = resolve
    })
  f.partial.validation.preflight = async (...args) => {
    entered()
    await pending
    await original(...args)
  }
  const buyer = await PrivatePurchaseBuyer.open(first.ports),
    abort = new AbortController(),
    attempt = buyer.advance(abort.signal),
    stopped = expect(attempt).rejects.toThrow('cancelled')
  await begun
  abort.abort()
  await stopped
  await expect(buyer.advance()).rejects.toThrow('still active')
  let drained = false
  const stopping = buyer.stop().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  release()
  await stopping
  expect(drained).toBe(true)
  expect(f.calls).toEqual([])
  expect(f.counts.finish).toBe(0)
})
it('refuses Promise-valued access guards before disclosure or financial work', async () => {
  const f = purchaseBuyerFixture(),
    first = await f.open(true)
  await expect(
    PrivatePurchaseBuyer.open({ ...first.ports, current: async () => true } as never)
  ).rejects.toThrow('synchronous')
  const buyer = await PrivatePurchaseBuyer.open({
    ...first.ports,
    current: (() =>
      Promise.reject(new Error('Deferred access refusal'))) as unknown as () => boolean
  })
  await expect(buyer.advance()).rejects.toThrow('access changed')
  expect(f.calls).toEqual([])
  expect(f.counts.finish).toBe(0)
})
it('retains completed rights when the original wallet cannot be queried any longer', async () => {
  const f = purchaseBuyerFixture(),
    first = await f.open(true),
    result = await first.buyer.advance()
  await first.buyer.validate()
  f.partial.payment.recover = async () => {
    throw new Error('Original wallet is offline')
  }
  const second = await PrivatePurchaseBuyer.open(first.ports)
  expect(await second.recover()).toEqual(result)
  expect(await second.usableResult()).toEqual(result)
  expect(f.counts.finish).toBe(1)
})
it('observes rights completed by another native owner during original wallet recovery', async () => {
  const f = purchaseBuyerFixture(),
    first = await f.open(true)
  f.lose('finish')
  await expect(first.buyer.advance()).rejects.toThrow('Lost original wallet')
  const recover = f.partial.payment.recover
  let other: PrivatePurchaseBuyer,
    entered = false,
    delivered: unknown
  f.partial.payment.recover = async (...args) => {
    if (!entered) {
      entered = true
      delivered = await other.advance()
    }
    return recover(...args)
  }
  const reader = await f.open(),
    writer = await f.open()
  other = writer.buyer
  expect(await reader.buyer.recover()).toEqual(delivered)
  expect((await reader.buyer.recover())?.result.status).toBe('delivered')
  expect(f.counts.finish).toBe(1)
  expect(f.server.counts.issue).toBe(1)
  expect(f.calls).toEqual(['prepare', 'recover', 'submit'])
})
it('idempotent initialization preserves the completed original obligation', async () => {
  const f = purchaseBuyerFixture(),
    first = await f.open(true),
    delivered = await first.buyer.advance()
  await first.buyer.validate()
  const again = await PrivatePurchaseBuyer.initialize(first.ports)
  expect(await again.status()).toBe('usable')
  expect(await again.usableResult()).toEqual(delivered)
  expect(f.counts.finish).toBe(1)
  expect(f.server.counts.issue).toBe(1)
  await again.stop()
})
it.each([null, undefined, { state: 'unknown' }] as const)(
  'preserves uncertain original funding when its owner returns an unsupported outcome %p',
  async outcome => {
    const f = purchaseBuyerFixture(),
      first = await f.open(true)
    f.lose('finish')
    await expect(first.buyer.advance()).rejects.toThrow('Lost original wallet')
    f.partial.payment.recover = async () => outcome as never
    const next = await f.open()
    await expect(next.buyer.recover()).rejects.toThrow('outcome is unresolved')
    await expect(next.buyer.advance()).rejects.toThrow('outcome is unresolved')
    expect(f.counts.finish).toBe(1)
    expect(f.calls).toEqual(['prepare'])
  }
)

it.each([undefined, 'full-purchase-commitment-v1'] as const)(
  'authenticates the retained %s result on each recovery without writing it again',
  async profile => {
    const f = purchaseBuyerFixture(profile)
    let resultWrites = () => 0
    const owner = await f.open(true, {}, ports => {
        const put = jest.spyOn(ports.objects, 'put')
        resultWrites = () =>
          put.mock.calls.filter(([, binding]) => binding.role === 'result').length
      }),
      delivered = await owner.buyer.advance()
    expect(resultWrites()).toBe(1)
    expect(await owner.buyer.recover()).toEqual(delivered)
    expect(await owner.buyer.advance()).toEqual(delivered)
    expect(await owner.buyer.validate()).toBe('usable')
    expect(await owner.buyer.usableResult()).toEqual(delivered)
    expect(resultWrites()).toBe(1)
    await f.close(owner)
    let changed = false,
      repeatedWrites = () => 0
    const reopened = await f.open(false, {}, ports => {
      const put = jest.spyOn(ports.objects, 'put'),
        read = ports.objects.read.bind(ports.objects)
      repeatedWrites = () => put.mock.calls.length
      jest.spyOn(ports.objects, 'read').mockImplementation(async (id, binding) => {
        const saved = await read(id, binding)
        if (!changed || binding.role !== 'result' || saved.state !== 'stored') return saved
        const packet = JSON.parse(new TextDecoder().decode(saved.bytes))
        saved.bytes.fill(0)
        packet.result.potatoes.signature = 'AA=='
        return { ...saved, bytes: new TextEncoder().encode(canonicalOutputJSON(packet)) }
      })
    })
    expect(await reopened.buyer.recover()).toEqual(delivered)
    changed = true
    await expect(reopened.buyer.recover()).rejects.toThrow()
    changed = false
    expect(await reopened.buyer.recover()).toEqual(delivered)
    expect(await reopened.buyer.usableResult()).toEqual(delivered)
    expect(repeatedWrites()).toBe(0)
    expect(f.counts.finish).toBe(1)
    expect(f.server.counts.issue).toBe(1)
    expect(f.calls).toEqual(['prepare', 'submit'])
  }
)

it('keeps ordinary single-read behavior when the joint companion is not selected', async () => {
  const f = purchaseBuyerFixture()
  let consulted = false
  const owner = await f.open(true, {}, ports => {
    Object.defineProperty(ports.objects, 'readMany', {
      get: () => {
        consulted = true
        throw Error('Unselected companion must be inert')
      }
    })
  })
  await owner.buyer.advance()
  expect(await owner.buyer.validate()).toBe('usable')
  await owner.buyer.usableResult()
  expect(consulted).toBe(false)
  expect(f.counts.finish).toBe(1)
})

it('selects bounded joint custody explicitly while retaining original rights and one financial action', async () => {
  const f = purchaseBuyerFixture('full-purchase-commitment-v1')
  let joint!: jest.SpiedFunction<
    NonNullable<
      import('../src/operations/ProtectedOperationObjectStore.js').ProtectedOperationObjectStore['readMany']
    >
  >
  const owner = await f.open(true, {}, ports => {
    joint = jest.spyOn(ports.objects, 'readMany')
  })
  expect(joint).toHaveBeenCalledTimes(1)
  expect(joint.mock.calls[0][0]).toHaveLength(7)
  const delivered = await owner.buyer.advance()
  expect(await owner.buyer.validate()).toBe('usable')
  expect(await owner.buyer.usableResult()).toEqual(delivered)
  expect(joint.mock.calls.some(([requests]) => requests.length === 3)).toBe(true)
  f.setAccess(false)
  await expect(owner.buyer.usableResult()).rejects.toThrow('access')
  f.setAccess(true)
  expect(await owner.buyer.usableResult()).toEqual(delivered)
  expect(f.counts.finish).toBe(1)
  expect(f.bindingChecks()).toBe(1)
})

it('refuses a selected joint-custody capability changed after installation before further effects', async () => {
  const f = purchaseBuyerFixture('full-purchase-commitment-v1'),
    owner = await f.open(true)
  const original = owner.objects.readMany
  owner.objects.readMany = async () => []
  await expect(owner.buyer.advance()).rejects.toThrow('capability changed')
  owner.objects.readMany = original
  owner.ports.objectReadProfile = undefined
  await expect(owner.buyer.advance()).rejects.toThrow('capability changed')
  expect(f.counts.finish).toBe(0)
  expect(f.calls).toEqual([])
})

it('refuses altered first-result bytes from a selected joint read without another payment or write', async () => {
  const f = purchaseBuyerFixture('full-purchase-commitment-v1')
  let corrupt = false
  const owner = await f.open(true, {}, ports => {
    const read = ports.objects.readMany!.bind(ports.objects)
    jest.spyOn(ports.objects, 'readMany').mockImplementation(async requests => {
      const values = await read(requests)
      if (corrupt)
        requests.forEach((request, index) => {
          const saved = values[index]
          if (request.originalBinding.role === 'result' && saved.state === 'stored') {
            const packet = JSON.parse(new TextDecoder().decode(saved.bytes))
            saved.bytes.fill(0)
            packet.result.potatoes.signature = 'AA=='
            values[index] = {
              ...saved,
              bytes: new TextEncoder().encode(canonicalOutputJSON(packet))
            }
          }
        })
      return values
    })
  })
  await owner.buyer.advance()
  expect(await owner.buyer.validate()).toBe('usable')
  corrupt = true
  await expect(owner.buyer.usableResult()).rejects.toThrow()
  corrupt = false
  expect(await owner.buyer.usableResult()).toHaveProperty('result.status', 'delivered')
  expect(f.counts.finish).toBe(1)
  expect(f.server.counts.issue).toBe(1)
})

it.each(['missing', 'short'] as const)(
  'refuses a malformed %s joint reply before finance and clears available plaintext',
  async kind => {
    const f = purchaseBuyerFixture('full-purchase-commitment-v1')
    const disclosed: Uint8Array[] = []
    await expect(
      f.open(true, {}, ports => {
        const read = ports.objects.readMany!.bind(ports.objects)
        jest.spyOn(ports.objects, 'readMany').mockImplementation(async requests => {
          const statuses = await read(requests)
          for (const status of statuses) if (status.state === 'stored') disclosed.push(status.bytes)
          if (kind === 'short') return statuses.slice(0, 1)
          // The malformed provider discards its detached copies itself; there is no
          // reachable plaintext in the invalid reply handed to the buyer.
          for (const bytes of disclosed) bytes.fill(0)
          return null as unknown as typeof statuses
        })
      })
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(disclosed.length).toBeGreaterThan(0)
    // For the short reply, only its retained first buffer is reachable by the
    // buyer. The adapter owns all omitted buffers and clears those separately.
    expect([...disclosed[0]].every(byte => byte === 0)).toBe(true)
    for (const bytes of disclosed) bytes.fill(0)
    expect(f.counts.finish).toBe(0)
    expect(f.calls).toEqual([])
  }
)

it.each(['oversized', 'accessor', 'detached', 'revoked'] as const)(
  'bounds malformed %s joint reply ownership and cleanup to the requested roles',
  async kind => {
    const f = purchaseBuyerFixture('full-purchase-commitment-v1'),
      disposed: Uint8Array[] = []
    let requested = 0,
      inspected = 0,
      accessorCalled = false
    await expect(
      f.open(true, {}, ports => {
        const read = ports.objects.readMany!.bind(ports.objects)
        jest.spyOn(ports.objects, 'readMany').mockImplementation(async requests => {
          requested = requests.length
          const statuses = await read(requests)
          for (const status of statuses) if (status.state === 'stored') disposed.push(status.bytes)
          if (kind === 'revoked') {
            for (const bytes of disposed) bytes.fill(0)
            const revoked = Proxy.revocable(statuses, {})
            revoked.revoke()
            return revoked.proxy
          }
          if (kind === 'oversized') statuses.length = 4294967295
          else if (kind === 'accessor')
            Object.defineProperty(statuses, '0', {
              get: () => {
                accessorCalled = true
                throw Error('Reply accessor must never run')
              },
              configurable: true
            })
          else {
            for (const bytes of disposed)
              structuredClone(bytes.buffer, { transfer: [bytes.buffer] })
            statuses.length = 1
          }
          return new Proxy(statuses, {
            getOwnPropertyDescriptor: (target, key) => {
              if (typeof key === 'string' && /^[0-9]+$/.test(key)) {
                inspected++
                expect(Number(key)).toBeLessThan(requested)
              }
              return Reflect.getOwnPropertyDescriptor(target, key)
            }
          })
        })
      })
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(inspected).toBeLessThanOrEqual(requested * 2)
    expect(accessorCalled).toBe(false)
    if (kind === 'oversized')
      for (const bytes of disposed) expect([...bytes].every(byte => byte === 0)).toBe(true)
    // The companion owns omitted/accessor-inaccessible buffers; detached ones
    // have already lost their original backing storage.
    if (kind === 'accessor') for (const bytes of disposed) bytes.fill(0)
    expect(f.counts.finish).toBe(0)
    expect(f.calls).toEqual([])
  }
)
