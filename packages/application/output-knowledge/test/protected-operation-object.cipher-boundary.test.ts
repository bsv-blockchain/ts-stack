import { expect, it } from '@jest/globals'
import { type OutputJSONObject } from '@bsv/sdk'
import { ProtectedOperationObjectPlan } from '../src/operations/ProtectedOperationObjectPlan.js'
import { ProtectedOperationObjectCipher } from '../src/operations/ProtectedOperationObjectCipher.js'
import { custody } from './protected-operation-object.fixture.js'

const id = '22'.repeat(32)
const configuration = () => ({
  storeId: '11'.repeat(32),
  recipient: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  binding: {},
  maximumObjects: 2,
  maximumObjectBytes: 100
})
function fixture() {
  const codec = custody(),
    plan = new ProtectedOperationObjectPlan(configuration())
  const cipher = new ProtectedOperationObjectCipher(plan, codec)
  return { cipher, codec, plan }
}
const error = (code: string) =>
  expect.objectContaining({ code, message: expect.stringMatching(/\S/) })
it.each([
  ['id', ''],
  ['id', 'x'.repeat(129)],
  ['maximumPlaintextBytes', 32767],
  ['maximumPlaintextBytes', 2097153],
  ['maximumPlaintextBytes', 32768.5],
  ['maximumSealedBytes', 0],
  ['maximumSealedBytes', 4194305],
  ['maximumSealedBytes', 0.5]
])('rejects incomplete declared custody capacity %s=%s', (field, value) => {
  const codec = custody()
  Object.assign(codec, { [String(field)]: value })
  expect(
    () =>
      new ProtectedOperationObjectCipher(new ProtectedOperationObjectPlan(configuration()), codec)
  ).toThrow(error('limited'))
})
it('accepts exactly complete declared framing and bounds aggregate sealed reservation', () => {
  const codec = custody()
  Object.assign(codec, {
    maximumPlaintextBytes: 32768,
    maximumSealedBytes: 65536,
    id: 'x'.repeat(128)
  })
  const cipher = new ProtectedOperationObjectCipher(
    new ProtectedOperationObjectPlan(configuration()),
    codec
  )
  expect(cipher.maximumRows).toBe(5)
  expect(cipher.headBytes).toBe(1808)
  expect(
    () =>
      new ProtectedOperationObjectCipher(
        new ProtectedOperationObjectPlan({ ...configuration(), maximumObjects: 1024 }),
        custody()
      )
  ).toThrow(error('limited'))
})
it.each(['id', 'maximumPlaintextBytes', 'maximumSealedBytes', 'seal', 'open'] as const)(
  'pins the installed %s capability',
  field => {
    const { cipher, codec } = fixture()
    if (field === 'seal' || field === 'open')
      Object.assign(codec, { [field]: async () => undefined })
    else Object.assign(codec, { [field]: field === 'id' ? 'changed' : 1 })
    expect(() => cipher.current()).toThrow(error('context-changed'))
  }
)
it.each(['seal', 'open'] as const)('requires a callable %s capability at installation', field => {
  const codec = custody()
  Object.assign(codec, { [field]: null })
  expect(
    () =>
      new ProtectedOperationObjectCipher(new ProtectedOperationObjectPlan(configuration()), codec)
  ).toThrow(error('context-changed'))
})
it('binds exact row address and revision, owns returned envelopes and rejects extended rows', async () => {
  const { cipher } = fixture()
  const row = await cipher.seal(id, '1', { retained: true }, 100)
  expect(await cipher.open(row, id, '1', 100)).toEqual({ retained: true })
  for (const [key, revision] of [
    ['33'.repeat(32), '1'],
    [id, '2']
  ])
    await expect(cipher.open(row, key, revision, 100)).rejects.toThrow(error('unavailable'))
  for (const changed of [
    { ...row, key: 'invalid' },
    { ...row, revision: '01' },
    { ...row, payload: [] },
    { ...row, extra: true }
  ])
    expect(() => cipher.envelope(changed)).toThrow()
  const copied = cipher.envelope(row)
  copied.payload.tag = 'changed'
  expect(cipher.envelopeDigest(row)).not.toBe(cipher.envelopeDigest(copied))
  expect(row.payload.tag).not.toBe('changed')
})
it('clears decrypted bytes even when reserved capacity or custody changed during open', async () => {
  for (const change of ['oversized', 'identity', 'malformed']) {
    const { cipher, codec } = fixture(),
      original = codec.open
    let supplied: Uint8Array | undefined
    // Install the wrapper before constructing the owner so its identity is original.
    codec.open = async (...args) => {
      supplied =
        change === 'oversized'
          ? new Uint8Array(101).fill(65)
          : change === 'malformed'
            ? new TextEncoder().encode('{broken')
            : await original.apply(codec, args)
      if (change === 'identity') Object.assign(codec, { id: 'changed-after-open' })
      return supplied
    }
    const owner = new ProtectedOperationObjectCipher(cipher.plan, codec)
    const row = await owner.seal(id, '1', { retained: true }, 100)
    await expect(owner.open(row, id, '1', 100)).rejects.toThrow()
    expect(supplied).toBeDefined()
    expect(supplied!.every(byte => byte === 0)).toBe(true)
  }
})
it('clears outgoing plaintext on success and failure without changing the supplied value', async () => {
  for (const failing of [false, true]) {
    const codec = custody(),
      original = codec.seal
    let supplied: Uint8Array | undefined
    codec.seal = async (...args) => {
      supplied = args[1]
      if (failing) throw new Error('synthetic custody failure')
      return await original.apply(codec, args)
    }
    const owner = new ProtectedOperationObjectCipher(
        new ProtectedOperationObjectPlan(configuration()),
        codec
      ),
      value = { retained: 'private value' }
    if (failing)
      await expect(owner.seal(id, '1', value, 100)).rejects.toThrow('synthetic custody failure')
    else expect((await owner.seal(id, '1', value, 100)).key).toBe(id)
    expect(supplied!.every(byte => byte === 0)).toBe(true)
    expect(value).toEqual({ retained: 'private value' })
  }
})
it('authenticates the complete sorted inventory and the sum of reservation and completion phases', async () => {
  const { cipher } = fixture(),
    second = '33'.repeat(32)
  const inventory = {
    revision: '3',
    entries: [
      { id, complete: false, digests: ['44'.repeat(32), '55'.repeat(32)] },
      { id: second, complete: true, digests: ['66'.repeat(32), '77'.repeat(32)] }
    ]
  }
  const keys = ['head', ...cipher.addresses(id), ...cipher.addresses(second)]
  const row = await cipher.sealInventory(inventory)
  expect(await cipher.inventory(row, [...keys].reverse())).toEqual(inventory)
  await expect(cipher.inventory(row, keys.slice(1))).rejects.toThrow(error('unavailable'))
  await expect(cipher.inventory(row, [...keys, 'unexpected'])).rejects.toThrow(error('unavailable'))
  await expect(
    cipher.inventory(
      row,
      keys.map((value, index) => (index === 1 ? '88'.repeat(32) : value))
    )
  ).rejects.toThrow(error('unavailable'))
  for (const altered of [
    { ...inventory, revision: '2' },
    { ...inventory, entries: [...inventory.entries].reverse() },
    { ...inventory, entries: [inventory.entries[0], inventory.entries[0]] },
    {
      ...inventory,
      entries: [...inventory.entries, { ...inventory.entries[1], id: '88'.repeat(32) }]
    },
    { ...inventory, entries: [{ ...inventory.entries[0], digests: [] }, inventory.entries[1]] }
  ])
    await expect(cipher.sealInventory(altered)).rejects.toThrow()
})
it.each(['format', 'revision', 'entries', 'complete', 'digests'] as const)(
  'rejects malformed authenticated inventory %s before accepting rows',
  async field => {
    const { cipher } = fixture()
    const inventory: OutputJSONObject = {
      format: 'output-indexeddb-operation-objects/1',
      revision: '1',
      entries: [{ id, complete: false, digests: ['44'.repeat(32), '55'.repeat(32)] }]
    }
    const entry = (inventory.entries as OutputJSONObject[])[0]
    if (field === 'format') inventory.format = 'wrong-format'
    if (field === 'revision') inventory.revision = '2'
    if (field === 'entries') inventory.entries = {}
    if (field === 'complete') entry.complete = 'no'
    if (field === 'digests') entry.digests = 'invalid'
    const row = await cipher.seal('head', '1', inventory, cipher.headBytes)
    await expect(cipher.inventory(row, ['head', ...cipher.addresses(id)])).rejects.toThrow(
      error('unavailable')
    )
  }
)
it('refuses ciphertext or restored JSON beyond the original exact capacity', async () => {
  const codec = custody(),
    original = codec.seal
  codec.seal = async (...args) => ({
    ...(await original.apply(codec, args)),
    excess: 'x'.repeat(codec.maximumSealedBytes)
  })
  const cipher = new ProtectedOperationObjectCipher(
    new ProtectedOperationObjectPlan(configuration()),
    codec
  )
  await expect(cipher.seal(id, '1', { private: true }, 100)).rejects.toThrow(error('limited'))
})
