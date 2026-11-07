import { expect, it, jest } from '@jest/globals'
import { createSecretKey, type KeyObject } from 'node:crypto'
import { OutputProtocolError, PrivateKey, type OutputJSONObject } from '@bsv/sdk'
import { NodeProtectedPayloadCodec } from '../src/private/NodeProtectedPayloadCodec.js'
import { PrivatePublicationDisclosure } from '../src/private/PrivatePublicationDisclosure.js'
import { parsePrivatePublicationFenceMetadata } from '../src/private/PrivatePublicationRecords.js'
import { coordinatorFixture } from './private-publication-coordinator-fixture.js'
import { allow } from './private-publication-fixture.js'
import { readCurrentPrivatePublicationStatus } from '../src/private/PrivatePublicationPorts.js'

class SeparateRecordKeys extends NodeProtectedPayloadCodec {
  private readonly material: NodeProtectedPayloadCodec
  constructor(keys: Map<string, KeyObject>) {
    const custody = {
      resolve(id: string) {
        const key = keys.get(id)
        if (!key) throw new Error('Synthetic missing custody key')
        return key
      }
    }
    super(custody, 'metadata')
    this.material = new NodeProtectedPayloadCodec(custody, 'material')
  }
  override seal(binding: OutputJSONObject, bytes: Uint8Array) {
    return binding.recordKind === 'publication'
      ? this.material.seal(binding, bytes)
      : super.seal(binding, bytes)
  }
}
async function fixture() {
  const material = createSecretKey(Buffer.alloc(32, 76))
  const keys = new Map([
    ['metadata', createSecretKey(Buffer.alloc(32, 75))],
    ['material', material]
  ])
  const f = coordinatorFixture({}, new SeparateRecordKeys(keys))
  await f.coordinator.publish(f.contract.request, f.caller)
  const disclosure = new PrivatePublicationDisclosure(
    f.native.owner,
    f.store,
    f.contract.contracts,
    f.options.access,
    f.options.clock,
    () => true
  )
  return { ...f, keys, material, disclosure }
}
it('durably records material key loss without decrypting or recreating the missing material', async () => {
  const f = await fixture(),
    original = f.store.loadVerified(f.status.publicationId, () => '20', allow)!
  f.keys.delete('material')
  expect(() => f.store.loadVerified(f.status.publicationId, () => '20', allow)).toThrow('custody')
  const status = await f.coordinator.status(f.status, f.caller)
  expect(status).toMatchObject({ status: 'unavailable', publicationId: f.status.publicationId })
  const metadata = f.store.loadStatus(f.status.publicationId, () => '20', allow)!
  expect(metadata.availability).toBe('unchecked')
  expect(metadata.fence.state.progress.phase).toBe('unavailable')
  expect(metadata.original).toEqual(original.original)
  expect(metadata.fence.state.requestDigest).toBe(original.fence.state.requestDigest)
  const send = jest.fn<(body: string, headers: Readonly<Record<string, string>>) => void>()
  const prepared = f.disclosure.prepare(f.status, f.caller)
  prepared.enqueue(send)
  expect(JSON.parse(prepared.body)).toEqual(status)
  expect(send).toHaveBeenCalledTimes(1)
  expect(f.native.rows()).toHaveLength(3)
  expect(f.calls).toHaveLength(1)
})
it('requires verified original restoration and keeps loss durable until that explicit step', async () => {
  const f = await fixture()
  f.keys.delete('material')
  await expect(f.coordinator.status(f.status, f.caller)).resolves.toMatchObject({
    status: 'unavailable'
  })
  const unavailable = f.store.loadStatus(f.status.publicationId, () => '20', allow)!
  expect(() =>
    f.store.bindVerified(f.status.publicationId, unavailable.record.revision, () => '20', allow)
  ).toThrow('custody')
  f.keys.set('material', f.material)
  await expect(f.coordinator.status(f.status, f.caller)).resolves.toMatchObject({
    status: 'unavailable'
  })
  f.store.bindVerified(f.status.publicationId, unavailable.record.revision, () => '21', allow)
  f.time('21')
  await expect(f.coordinator.status(f.status, f.caller)).resolves.toMatchObject({ status: 'ready' })
  expect(f.calls).toHaveLength(1)
})
it('never discloses stale ready bytes if custody is lost after preparation', async () => {
  const f = await fixture(),
    prepared = f.disclosure.prepare(f.status, f.caller)
  f.keys.delete('material')
  const send = jest.fn<() => void>()
  expect(() => prepared.enqueue(send)).toThrow('custody')
  expect(send).not.toHaveBeenCalled()
  const replacement = f.disclosure.prepare(f.status, f.caller)
  expect(JSON.parse(replacement.body).status).toBe('unavailable')
  replacement.enqueue(send)
  expect(send).toHaveBeenCalledTimes(1)
})
it('checks publisher ownership before revealing missing-material diagnostics or recording a loss', async () => {
  const f = await fixture(),
    initial = f.store.loadStatus(f.status.publicationId, () => '20', allow)!
  f.keys.delete('material')
  await expect(
    f.coordinator.status(f.status, {
      ...f.caller,
      publisher: new PrivateKey(64).toPublicKey().toString()
    })
  ).rejects.toMatchObject({ code: 'not-found', message: 'Private publication not found' })
  expect(f.store.loadStatus(f.status.publicationId, () => '20', allow)!.record.revision).toBe(
    initial.record.revision
  )
  f.revokeAccess()
  await expect(f.coordinator.status(f.status, f.caller)).rejects.toMatchObject({
    code: 'not-found'
  })
})
it('rejects a stale or revoked loss writer without overwriting the winning record', async () => {
  const f = await fixture(),
    loaded = f.store.loadStatus(f.status.publicationId, () => '20', allow)!
  const deny = () => {
    throw new Error('Current native policy denied')
  }
  expect(() =>
    f.store.markUnavailable(f.status.publicationId, loaded.record.revision, () => '20', deny)
  ).toThrow('policy denied')
  expect(f.store.loadStatus(f.status.publicationId, () => '20', allow)!.record.revision).toBe(
    loaded.record.revision
  )
  f.store.markUnavailable(f.status.publicationId, loaded.record.revision, () => '20', allow)
  expect(() =>
    f.store.markUnavailable(f.status.publicationId, loaded.record.revision, () => '20', allow)
  ).toThrow('changed')
})
it('does not fabricate record status when metadata custody is also unavailable', async () => {
  const f = await fixture()
  f.keys.clear()
  await expect(f.coordinator.status(f.status, f.caller)).rejects.toMatchObject({
    code: 'unavailable'
  })
  expect(() => f.disclosure.prepare(f.status, f.caller)).toThrow('custody')
})
it('keeps metadata parsing bound to the original public reference and native address', async () => {
  const f = await fixture(),
    retained = f.store.loadStatus(f.status.publicationId, () => '20', allow)!
  for (const change of [
    { topic: 'another-topic' },
    { requestId: 'another-publication-request' },
    { assetId: '77'.repeat(32) }
  ]) {
    expect(() =>
      parsePrivatePublicationFenceMetadata(
        { ...retained.fence, reference: { ...retained.fence.reference, ...change } },
        f.native.owner.identity
      )
    ).toThrow('binding differs')
  }
  expect(() =>
    parsePrivatePublicationFenceMetadata(
      { ...retained.fence, reference: { ...retained.fence.reference, privateValues: 'AQID' } },
      f.native.owner.identity
    )
  ).toThrow()
})

it('rejects a wrong original selector before recording custody loss', async () => {
  const f = await fixture(),
    retained = f.store.loadStatus(f.status.publicationId, () => '20', allow)!
  f.keys.delete('material')
  const caller = { ...f.caller, capability: 'ab'.repeat(32) }
  await expect(f.coordinator.status(f.status, caller)).rejects.toMatchObject({
    code: 'context-changed'
  })
  expect(() => f.disclosure.prepare(f.status, caller)).toThrow('selector differs')
  expect(f.store.loadStatus(f.status.publicationId, () => '20', allow)!.record.revision).toBe(
    retained.record.revision
  )
})

it('returns no status for an absent native publication without invoking selection or loss writes', () => {
  const f = coordinatorFixture(),
    validate = jest.fn<() => void>(),
    mark = jest.spyOn(f.store, 'markUnavailable'),
    verified = jest.spyOn(f.store, 'loadVerified')
  try {
    expect(
      readCurrentPrivatePublicationStatus(
        f.store,
        f.status.publicationId,
        f.options.clock,
        allow,
        validate
      )
    ).toBeUndefined()
    expect(validate).not.toHaveBeenCalled()
    expect(mark).not.toHaveBeenCalled()
    expect(verified).not.toHaveBeenCalled()
  } finally {
    mark.mockRestore()
    verified.mockRestore()
  }
})

it.each([null, false, 0, 'validator', async () => {}])(
  'refuses a non-synchronous metadata validator before reading private material: %p',
  invalid => {
    const f = coordinatorFixture()
    f.stage()
    const verified = jest.spyOn(f.store, 'loadVerified')
    try {
      expect(() =>
        readCurrentPrivatePublicationStatus(
          f.store,
          f.status.publicationId,
          f.options.clock,
          allow,
          invalid as unknown as () => void
        )
      ).toThrow(
        expect.objectContaining({
          code: 'invalid',
          message: 'Publication metadata selection validation must be synchronous'
        })
      )
      expect(verified).not.toHaveBeenCalled()
    } finally {
      verified.mockRestore()
    }
  }
)

it.each([false, true, 0, 'verdict'])(
  'requires metadata validation to finish with void rather than a truthy or false verdict: %p',
  verdict => {
    const f = coordinatorFixture()
    f.stage()
    expect(() =>
      readCurrentPrivatePublicationStatus(
        f.store,
        f.status.publicationId,
        f.options.clock,
        allow,
        () => verdict
      )
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Publication metadata selection validation must finish synchronously'
      })
    )
  }
)

it('consumes a rejected metadata validator promise and never reads private material', async () => {
  const f = coordinatorFixture(),
    failure = new Error('Synthetic metadata failure'),
    verdict = Promise.reject(failure),
    observed = verdict.then(
      () => undefined,
      error => error
    ),
    caught = jest.spyOn(verdict, 'catch'),
    verified = jest.spyOn(f.store, 'loadVerified')
  f.stage()
  try {
    expect(() =>
      readCurrentPrivatePublicationStatus(
        f.store,
        f.status.publicationId,
        f.options.clock,
        allow,
        () => verdict
      )
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Publication metadata selection validation must finish synchronously'
      })
    )
    expect(caught).toHaveBeenCalledWith(expect.any(Function))
    expect(verified).not.toHaveBeenCalled()
    expect(await observed).toBe(failure)
  } finally {
    caught.mockRestore()
    verified.mockRestore()
  }
})

it.each([
  new Error('Synthetic driver failure'),
  new OutputProtocolError('conflict', 'Synthetic CAS failure')
])(
  'propagates non-availability failures without recording invented material loss: %p',
  async failure => {
    const f = await fixture(),
      verified = jest.spyOn(f.store, 'loadVerified').mockImplementation(() => {
        throw failure
      }),
      mark = jest.spyOn(f.store, 'markUnavailable')
    try {
      let thrown: unknown
      try {
        readCurrentPrivatePublicationStatus(
          f.store,
          f.status.publicationId,
          f.options.clock,
          allow,
          () => {}
        )
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBe(failure)
      expect(mark).not.toHaveBeenCalled()
    } finally {
      verified.mockRestore()
      mark.mockRestore()
    }
  }
)

it('requires a missing verified publication to become durably unavailable before returning status', async () => {
  const f = await fixture(),
    verified = jest.spyOn(f.store, 'loadVerified').mockReturnValue(undefined)
  try {
    const result = readCurrentPrivatePublicationStatus(
      f.store,
      f.status.publicationId,
      f.options.clock,
      allow,
      () => {}
    )
    expect(result?.verified).toBeUndefined()
    expect(result?.metadata.fence.state.progress.phase).toBe('unavailable')
    expect(
      f.store.loadStatus(f.status.publicationId, f.options.clock, allow)?.fence.state.progress.phase
    ).toBe('unavailable')
  } finally {
    verified.mockRestore()
  }
})

it.each(['unchanged', 'absent'] as const)(
  'refuses a loss writer whose readback is %s instead of durably unavailable',
  async mode => {
    const f = await fixture(),
      metadata = f.store.loadStatus(f.status.publicationId, f.options.clock, allow)!,
      verified = jest.spyOn(f.store, 'loadVerified').mockReturnValue(undefined),
      mark = jest.spyOn(f.store, 'markUnavailable').mockReturnValue(metadata.fence.state),
      status = jest.spyOn(f.store, 'loadStatus')
    status.mockReturnValueOnce(metadata).mockReturnValue(mode === 'absent' ? undefined : metadata)
    try {
      expect(() =>
        readCurrentPrivatePublicationStatus(
          f.store,
          f.status.publicationId,
          f.options.clock,
          allow,
          () => {}
        )
      ).toThrow(
        expect.objectContaining({
          code: 'unavailable',
          message: 'Private publication loss is not durably recorded'
        })
      )
      expect(mark).toHaveBeenCalledWith(
        f.status.publicationId,
        metadata.record.revision,
        f.options.clock,
        allow
      )
    } finally {
      verified.mockRestore()
      mark.mockRestore()
      status.mockRestore()
    }
  }
)

it('keeps the readiness observation separate from the original unchecked metadata projection', async () => {
  const f = await fixture(),
    result = readCurrentPrivatePublicationStatus(
      f.store,
      f.status.publicationId,
      f.options.clock,
      allow,
      () => {}
    )!
  expect(result.verified?.fence.state.progress.phase).toBe('ready')
  expect(result.metadata.availability).toBe('unchecked')
  expect(result.metadata.original).toEqual(result.verified?.original)
})
