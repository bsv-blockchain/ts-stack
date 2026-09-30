import {
  snapshotArchiveCapabilities,
  snapshotArchiveMethods,
  snapshotArchiveResponseBytes,
  parseSnapshotArchiveRpcInput,
  validateSnapshotArchiveCapabilities,
  validateSnapshotArchiveOffer,
  validateSnapshotArchiveRequestReceipt
} from './SnapshotArchiveProtocol'
import { snapshotArchiveRequestId } from './SnapshotArchiveRequest'
import { verifySnapshotArchiveDirectory } from './SnapshotArchiveDirectory'
import { stringifyJsonRpc } from '../../remoting/BinaryJson'
import { fixture, expected, now, rehash } from '../../../../test/utils/snapshotArchiveDirectoryFixtures'

const identityKey = '02' + 'ab'.repeat(32)
const fields = { version: 1 as const, nonce: 'a'.repeat(64), notAfter: now + 300000, maxBytes: 32768 }
const request = { ...fields, requestId: snapshotArchiveRequestId(fields) }
const offer = { version: 1, serverTime: now, sourceStorageIdentityKey: 'source', sourceSchema: 'schema', chain: 'test' }
const receipt = { version: 1, requestId: request.requestId, expiresAt: request.notAfter, state: 'building' }
const wire = (value: unknown) =>
  Buffer.byteLength(
    stringifyJsonRpc({ jsonrpc: '2.0', id: Number.MAX_SAFE_INTEGER, result: value }, true).replace(/[<>&]/g, '\\u003c')
  )

test('detaches and freezes validated capability, offer and all exact receipt states', () => {
  expect(validateSnapshotArchiveCapabilities({ ...snapshotArchiveCapabilities })).toBe(snapshotArchiveCapabilities)
  expect(snapshotArchiveCapabilities).toEqual({
    version: 1,
    encoding: 'wallet-snapshot-rows/1',
    maxResponseBytes: 2097152,
    maxArchiveBytes: 33554432,
    maxPageBytes: 1048576,
    maxPages: 4096,
    maxLifetimeMs: 3600000
  })
  expect(Object.isFrozen(snapshotArchiveCapabilities)).toBe(true)
  const validated = validateSnapshotArchiveOffer(offer, 'source', 'test')
  expect(validated).toEqual(offer)
  expect(validated).not.toBe(offer)
  expect(Object.isFrozen(validated)).toBe(true)
  for (const state of ['building', 'closed', 'failed', 'expired', 'resource-limited', 'ready']) {
    const input = {
      ...receipt,
      state,
      ...(state === 'ready' ? { archiveId: 'b'.repeat(64), digest: 'c'.repeat(64) } : {})
    }
    const accepted = validateSnapshotArchiveRequestReceipt(input, request)
    expect(accepted).toEqual(input)
    expect(accepted).not.toBe(input)
    expect(Object.isFrozen(accepted)).toBe(true)
  }
})

test.each([null, undefined, 1, [], 'protocol'])('rejects non-record protocol values %p', value => {
  expect(() => validateSnapshotArchiveCapabilities(value)).toThrow('Invalid snapshot archive protocol')
  expect(() => validateSnapshotArchiveOffer(value, 'source', 'test')).toThrow()
  expect(() => validateSnapshotArchiveRequestReceipt(value, request)).toThrow()
})

test('capability fields are exact, own enumerable data and immutable version-one limits', () => {
  for (const field of Object.keys(snapshotArchiveCapabilities)) {
    expect(() => validateSnapshotArchiveCapabilities({ ...snapshotArchiveCapabilities, [field]: 'wrong' })).toThrow()
    const missing = { ...snapshotArchiveCapabilities } as Record<string, unknown>
    delete missing[field]
    expect(() => validateSnapshotArchiveCapabilities(missing)).toThrow()
    Object.defineProperty(missing, field, { value: Reflect.get(snapshotArchiveCapabilities, field) })
    expect(() => validateSnapshotArchiveCapabilities(missing)).toThrow()
  }
  const accessor = { ...snapshotArchiveCapabilities }
  Object.defineProperty(accessor, 'version', {
    get: () => {
      throw new Error('Getter must not run')
    }
  })
  expect(() => validateSnapshotArchiveCapabilities(accessor)).toThrow('Invalid snapshot archive protocol')
  expect(() =>
    validateSnapshotArchiveCapabilities({ ...snapshotArchiveCapabilities, [Symbol('extra')]: true })
  ).toThrow()
  const inherited = Object.create(snapshotArchiveCapabilities)
  Object.defineProperty(inherited, 'placeholder', { value: true })
  expect(() => validateSnapshotArchiveCapabilities(inherited)).toThrow()
  expect(() => validateSnapshotArchiveCapabilities({ ...snapshotArchiveCapabilities, extra: true })).toThrow()
})

test.each([
  { version: 2 },
  { sourceStorageIdentityKey: 'changed' },
  { chain: 'main' },
  { sourceSchema: '' },
  { sourceSchema: 'x'.repeat(257) },
  { sourceSchema: null },
  { serverTime: -1 },
  { serverTime: 0.1 },
  { serverTime: NaN },
  { serverTime: Infinity },
  { serverTime: Number.MAX_SAFE_INTEGER + 1 },
  { serverTime: '123' }
])('refuses changed or malformed offer %p', changes => {
  expect(() => validateSnapshotArchiveOffer({ ...offer, ...changes }, 'source', 'test')).toThrow()
})

test('offer integer and schema boundaries are inclusive', () => {
  expect(
    validateSnapshotArchiveOffer({ ...offer, serverTime: 0, sourceSchema: 'x' }, 'source', 'test').serverTime
  ).toBe(0)
  expect(
    validateSnapshotArchiveOffer(
      { ...offer, serverTime: Number.MAX_SAFE_INTEGER, sourceSchema: 'x'.repeat(256) },
      'source',
      'test'
    ).sourceSchema
  ).toHaveLength(256)
})

test.each([
  { version: 0 },
  { requestId: 'b'.repeat(64) },
  { expiresAt: request.notAfter + 1 },
  { state: 'other' },
  { state: null },
  { claimToken: 'internal' },
  { archiveId: 'a'.repeat(64) }
])('receipt is bound to exact request and fields %p', changes => {
  expect(() => validateSnapshotArchiveRequestReceipt({ ...receipt, ...changes }, request)).toThrow()
})

test.each(['archiveId', 'digest'])('ready receipt requires a canonical %s', field => {
  for (const value of [undefined, '', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 1]) {
    expect(() =>
      validateSnapshotArchiveRequestReceipt(
        { ...receipt, state: 'ready', archiveId: 'b'.repeat(64), digest: 'c'.repeat(64), [field]: value },
        request
      )
    ).toThrow()
  }
})

test('every RPC has exact typed arguments and no ownership-token parameter', () => {
  for (const method of snapshotArchiveMethods) {
    const extra =
      method === 'startSnapshotArchive'
        ? { request }
        : method === 'getSnapshotArchiveStatus' || method === 'cancelSnapshotArchive'
          ? { requestId: request.requestId }
          : method === 'getSnapshotArchiveDirectory'
            ? { archiveId: 'b'.repeat(64) }
            : method === 'readSnapshotArchivePage'
              ? { archiveId: 'b'.repeat(64), sequence: 0 }
              : {}
    const input = { version: 1, identityKey, ...extra }
    expect(parseSnapshotArchiveRpcInput(method, [input])).toEqual({ method, identityKey, ...extra })
    for (const params of [
      [],
      [input, input],
      [null],
      [{ ...input, writerToken: 'x' }],
      [{ ...input, version: 2 }],
      [{ ...input, identityKey: '' }],
      [{ ...input, identityKey: 1 }]
    ]) {
      expect(() => parseSnapshotArchiveRpcInput(method, params)).toThrow()
    }
  }
})

test.each([-1, 0.1, 4096, Infinity, NaN, '0', null])('rejects page sequence %p before dispatch', sequence => {
  expect(() =>
    parseSnapshotArchiveRpcInput('readSnapshotArchivePage', [
      { version: 1, identityKey, archiveId: 'b'.repeat(64), sequence }
    ])
  ).toThrow()
})

test('a maximum valid directory and maximum binary page fit the escaped RPC response ceiling', () => {
  const { directory, binding } = fixture(4083)
  binding.sourceStorage.storageName = '<>&'.repeat(85)
  binding.sourceSchema = '<>&'.repeat(85)
  directory.bindingJson = JSON.stringify(binding)
  rehash(directory)
  expect(verifySnapshotArchiveDirectory(directory, expected, now).receipts).toHaveLength(4096)
  expect(wire(directory)).toBeLessThan(snapshotArchiveResponseBytes)
  expect(wire({ ...directory.receipts[0], bytes: new Uint8Array(1024 * 1024) })).toBeLessThan(
    snapshotArchiveResponseBytes
  )
  expect(
    parseSnapshotArchiveRpcInput('readSnapshotArchivePage', [
      { version: 1, identityKey, archiveId: 'b'.repeat(64), sequence: 4095 }
    ])
  ).toMatchObject({ sequence: 4095 })
})

test('identity matching anchors the complete string, and schema values cannot coerce from objects', () => {
  for (const value of ['prefix' + identityKey, identityKey + 'suffix', Object(identityKey)]) {
    expect(() => parseSnapshotArchiveRpcInput('getSnapshotArchiveOffer', [{ version: 1, identityKey: value }])).toThrow(
      'Invalid snapshot archive protocol'
    )
  }
  expect(() => validateSnapshotArchiveOffer({ ...offer, sourceSchema: { length: 12 } }, 'source', 'test')).toThrow(
    'Invalid snapshot archive protocol'
  )
  const missing = { ...snapshotArchiveCapabilities } as Record<string, unknown>
  delete missing.version
  missing.placeholder = 1
  expect(() => validateSnapshotArchiveCapabilities(missing)).toThrow('Invalid snapshot archive protocol')
})
