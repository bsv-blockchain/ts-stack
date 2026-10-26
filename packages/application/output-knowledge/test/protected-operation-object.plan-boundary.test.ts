import { expect, it } from '@jest/globals'
import { createHash } from 'node:crypto'
import { canonicalOutputJSON, type OutputJSONObject } from '@bsv/sdk'
import {
  ProtectedOperationObjectPlan,
  operationObjectCapacity,
  operationObjectConfiguration,
  operationObjectDigest,
  chunkCapacity
} from '../src/operations/ProtectedOperationObjectPlan.js'

const recipient = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const config = () => ({
  storeId: '11'.repeat(32),
  recipient,
  binding: { installation: 'original' },
  maximumObjects: 2,
  maximumObjectBytes: 4194304
})
const id = '22'.repeat(32)
const binding = { operation: 'original', role: 'result' }
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const error = (code: string) =>
  expect.objectContaining({ code, message: expect.stringMatching(/\S/) })

it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 4194305])(
  'rejects invalid object capacity %s before allocating slots',
  maximum => {
    expect(() => operationObjectCapacity(maximum)).toThrow()
    expect(() =>
      operationObjectConfiguration({ ...config(), maximumObjectBytes: maximum })
    ).toThrow()
  }
)
it.each([0, -1, 0.5, Number.NaN, 1025])('rejects invalid object count %s', maximumObjects => {
  expect(() => operationObjectConfiguration({ ...config(), maximumObjects })).toThrow()
})
it('reserves every installed object and enforces the combined record and byte limits', () => {
  expect(() => operationObjectConfiguration({ ...config(), maximumObjects: 1024 })).toThrow(
    error('limited')
  )
  expect(
    operationObjectConfiguration({ ...config(), maximumObjectBytes: 1, maximumObjects: 1024 })
      .maximumObjects
  ).toBe(1024)
  for (const maximum of [1, 786432, 786433, 4194304]) {
    const length = Math.ceil(maximum / 786432)
    let bytes = 32768
    for (let index = 0; index < length; index++) {
      const actual = Math.min(786432, maximum - index * 786432)
      const reserved = Buffer.alloc(actual).toString('base64').length + 4096
      expect(chunkCapacity(maximum, index)).toBe(reserved)
      bytes += reserved
    }
    expect(operationObjectCapacity(maximum)).toEqual({ records: length + 1, bytes })
  }
})
it.each([-1, 1.5, 6, Number.NaN])('rejects an invalid chunk address %s', index => {
  const plan = new ProtectedOperationObjectPlan(config())
  expect(() => plan.address(id, index)).toThrow(error('invalid'))
  expect(() => chunkCapacity(4194304, index)).toThrow(error('invalid'))
})
it('separates installations, roles, headers and chunks with stable independent digests', () => {
  const original = config(),
    plan = new ProtectedOperationObjectPlan(original)
  original.binding.installation = 'changed'
  const exposed = plan.configuration
  exposed.binding.installation = 'also-changed'
  expect(plan.configuration).toEqual(config())
  const header = plan.reservation(id, binding, 4)
  const format = 'output-protected-operation-object/1'
  expect(header.bindingDigest).toBe(hash(format + '\0' + canonicalOutputJSON(binding)))
  const configuration = hash(format + '\0' + canonicalOutputJSON(config()))
  expect(plan.address(id, null)).toBe(
    hash(format + '\0' + canonicalOutputJSON({ configuration, id, index: null }))
  )
  expect(
    new Set([plan.address(id, null), ...Array.from({ length: 6 }, (_, i) => plan.address(id, i))])
      .size
  ).toBe(7)
  expect(
    new ProtectedOperationObjectPlan({ ...config(), storeId: '33'.repeat(32) }).address(id, null)
  ).not.toBe(plan.address(id, null))
  expect(plan.reservation(id, { ...binding, role: 'request' }, 4).bindingDigest).not.toBe(
    header.bindingDigest
  )
  expect(operationObjectDigest('é')).toBe(hash('é'))
  expect(operationObjectDigest(Uint8Array.of(0, 255))).toBe(hash(Uint8Array.of(0, 255)))
})
it('owns original bindings and rejects invalid configuration and binding shapes', () => {
  const plan = new ProtectedOperationObjectPlan(config())
  const original = { ...binding },
    header = plan.reservation(id, original, 4)
  original.role = 'changed'
  expect(header.originalBinding).toEqual(binding)
  for (const value of [null, [], 1, 'not-object']) {
    expect(() => plan.reservation(id, value as unknown as OutputJSONObject, 4)).toThrow()
    expect(() =>
      operationObjectConfiguration({ ...config(), binding: value as unknown as OutputJSONObject })
    ).toThrow()
  }
  expect(() =>
    operationObjectConfiguration({ ...config(), extra: true } as ReturnType<typeof config>)
  ).toThrow()
  expect(() => plan.reservation(id, { huge: 'x'.repeat(16384) }, 4)).toThrow(error('limited'))
  expect(() => plan.reservation('invalid', binding, 4)).toThrow()
})
it('preserves the exact first empty or nonempty result and fixed installed chunk count', () => {
  const plan = new ProtectedOperationObjectPlan(config()),
    header = plan.reservation(id, binding, 4)
  expect(plan.slots(header)).toHaveLength(6)
  expect(
    plan.restore(
      header,
      plan.slots(header).map(slot => slot.value)
    )
  ).toBeNull()
  for (const bytes of [new Uint8Array(), Uint8Array.of(0, 127, 128, 255)]) {
    const complete = plan.complete(header, bytes)
    expect(complete.receipt).toEqual({
      id,
      bindingDigest: header.bindingDigest,
      maximumBytes: 4,
      bytes: bytes.length,
      digest: hash(bytes)
    })
    expect(plan.parse(plan.frame(complete), id, binding)).toEqual(complete)
    expect(plan.complete(complete, bytes)).toEqual(complete)
    expect(
      plan.restore(
        complete,
        plan.slots(complete, bytes).map(slot => slot.value)
      )
    ).toEqual(bytes)
    expect(() => plan.complete(complete, Uint8Array.of(1))).toThrow(error('conflict'))
  }
  expect(() => plan.complete(header, new Uint8Array(5))).toThrow(error('limited'))
  expect(() => plan.slots(header, new Uint8Array())).toThrow(error('invalid'))
  expect(() => plan.slots(plan.complete(header, new Uint8Array()))).toThrow(error('invalid'))
})
it.each(['format', 'id', 'bindingDigest', 'originalBinding'] as const)(
  'refuses a changed retained header %s',
  field => {
    const plan = new ProtectedOperationObjectPlan(config()),
      header = plan.reservation(id, binding, 4),
      frame = plan.frame(header)
    frame[field] = field === 'originalBinding' ? { changed: true } : '33'.repeat(32)
    expect(() => plan.parse(frame, id, binding)).toThrow(error('context-changed'))
  }
)
it.each(['id', 'bindingDigest', 'maximumBytes', 'bytes', 'digest'] as const)(
  'validates retained receipt field %s independently',
  field => {
    const plan = new ProtectedOperationObjectPlan(config()),
      header = plan.complete(plan.reservation(id, binding, 4), Uint8Array.of(1))
    const frame = plan.frame(header),
      receipt = frame.receipt as OutputJSONObject
    receipt[field] =
      field === 'bytes'
        ? 5
        : field === 'maximumBytes'
          ? 3
          : field === 'digest'
            ? 'invalid'
            : '33'.repeat(32)
    expect(() => plan.parse(frame, id, binding)).toThrow()
  }
)
it.each([-1, 0.5, '1'])('refuses an invalid retained receipt byte count %s', bytes => {
  const plan = new ProtectedOperationObjectPlan(config()),
    frame = plan.frame(plan.complete(plan.reservation(id, binding, 4), Uint8Array.of(1)))
  ;(frame.receipt as OutputJSONObject).bytes = bytes
  expect(() => plan.parse(frame, id, binding)).toThrow(
    error(bytes === 0.5 ? 'invalid' : 'unavailable')
  )
})
it.each(['format', 'id', 'bindingDigest', 'index', 'digest'] as const)(
  'rejects mixed retained chunk %s',
  field => {
    const plan = new ProtectedOperationObjectPlan(config()),
      bytes = Uint8Array.of(0, 255),
      header = plan.complete(plan.reservation(id, binding, 4), bytes)
    const chunks = plan.slots(header, bytes).map(slot => slot.value)
    chunks[0][field] = field === 'index' ? 1 : '33'.repeat(32)
    expect(() => plan.restore(header, chunks)).toThrow(error('unavailable'))
  }
)
it('requires every chunk, exact decoded lengths and complete digest before returning first bytes', () => {
  const plan = new ProtectedOperationObjectPlan(config()),
    bytes = Uint8Array.of(0, 255),
    reserved = plan.reservation(id, binding, 4),
    header = plan.complete(reserved, bytes)
  const chunks = () => plan.slots(header, bytes).map(slot => slot.value)
  expect(() => plan.restore(header, chunks().slice(1))).toThrow(error('unavailable'))
  const short = chunks()
  short[0].data = Buffer.from([0]).toString('base64')
  expect(() => plan.restore(header, short)).toThrow(error('unavailable'))
  const altered = chunks()
  altered[0].data = Buffer.from([1, 255]).toString('base64')
  expect(() => plan.restore(header, altered)).toThrow(error('unavailable'))
  const extra = chunks()
  extra[1].data = Buffer.from([0]).toString('base64')
  expect(() => plan.restore(header, extra)).toThrow(error('unavailable'))
  const unbound = plan.slots(reserved).map(slot => slot.value)
  unbound[0].data = ''
  expect(() => plan.restore(reserved, unbound)).toThrow(error('unavailable'))
})
