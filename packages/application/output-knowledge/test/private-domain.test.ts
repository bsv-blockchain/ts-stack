import { afterEach, expect, it } from '@jest/globals'
import { createSecretKey } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import {
  PrivateServiceDomain,
  type PrivateServiceDomainConfiguration
} from '../src/private/PrivateServiceDomain.js'
import { NodeProtectedPayloadCodec } from '../src/private/NodeProtectedPayloadCodec.js'

const config = (): PrivateServiceDomainConfiguration => ({
  identity: {
    seller: new PrivateKey(1).toPublicKey().toString(),
    chain: { network: 'main', genesisHash: '11'.repeat(32) }
  },
  indexKeyId: 'index',
  capacity: {
    storeId: '22'.repeat(32),
    maximumRecords: 16,
    maximumRecordBytes: 1024,
    maximumReservedBytes: 8192
  },
  application: { profile: 'synthetic-private-service/1' }
})
const indexKey = createSecretKey(Buffer.alloc(32, 81)),
  payloadKey = createSecretKey(Buffer.alloc(32, 82))
const custody = { resolve: () => indexKey }
const payloads = () => new NodeProtectedPayloadCodec({ resolve: () => payloadKey }, 'payload')
const cleanup = new Set<() => void>()
afterEach(() => {
  for (const close of cleanup) close()
  cleanup.clear()
})
function location() {
  const directory = mkdtempSync(join(tmpdir(), 'private-domain-test-')),
    path = join(directory, 'private.db')
  const owners: PrivateServiceDomain[] = []
  cleanup.add(() => {
    for (const owner of owners) owner.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    path,
    create() {
      const owner = PrivateServiceDomain.create(path, config(), custody, payloads())
      owners.push(owner)
      return owner
    },
    open() {
      const owner = PrivateServiceDomain.open(path, config(), custody, payloads())
      owners.push(owner)
      return owner
    }
  }
}
const clock = () => '100',
  allow = () => {}

it('closes the physical ledger capability, including repeated close', () => {
  const f = location(),
    owner = f.create(),
    address = reserve(owner)
  owner.close()
  owner.close()
  expect(() => owner.ledger.read([address], clock, allow)).toThrow()
  expect(f.open().ledger.read([address], clock, allow).records[0]?.value).toEqual({ id: 'one' })
})

it('bounds raw domain configuration before resolving custody or creating a file', () => {
  const f = location()
  let calls = 0
  const guardedCustody = {
    resolve() {
      calls++
      return indexKey
    }
  }
  expect(() =>
    PrivateServiceDomain.create(
      f.path,
      { ...config(), padding: 'x'.repeat(32768) } as PrivateServiceDomainConfiguration,
      guardedCustody,
      payloads()
    )
  ).toThrow(expect.objectContaining({ code: 'limited' }))
  expect(calls).toBe(0)
  expect(existsSync(f.path)).toBe(false)
})

function reserve(owner: PrivateServiceDomain, id = 'one') {
  const address = owner.identity.address('funding-fence', { acquisition: id })
  owner.ledger.commit(
    '0',
    [{ ...address, expectedRevision: null, reservedBytes: 128, reservedUpdates: 4, value: { id } }],
    clock,
    allow
  )
  return address
}
it('reopens the same physical namespace and permanent fences through the bound factory', () => {
  const f = location(),
    owner = f.create(),
    address = reserve(owner)
  owner.close()
  const restored = f.open()
  expect(restored.identity.address('funding-fence', { acquisition: 'one' })).toEqual(address)
  expect(restored.ledger.read([address], clock, allow).records[0]?.value).toEqual({ id: 'one' })
  expect(() => f.create()).toThrow()
})
it('does not create a missing database while opening an existing service identity', () => {
  const f = location()
  expect(() => f.open()).toThrow()
  expect(existsSync(f.path)).toBe(false)
})
it.each(['seller', 'chain', 'index key', 'label', 'application', 'store'] as const)(
  'rejects a changed %s at explicit open without rewriting the old state',
  field => {
    const f = location(),
      owner = f.create(),
      address = reserve(owner),
      next = config()
    if (field === 'seller') next.identity.seller = new PrivateKey(2).toPublicKey().toString()
    if (field === 'chain') next.identity.chain.genesisHash = '33'.repeat(32)
    if (field === 'label') next.indexKeyId = 'new-index'
    if (field === 'application') next.application.profile = 'other'
    if (field === 'store') next.capacity.storeId = '44'.repeat(32)
    const changedCustody =
      field === 'index key' ? { resolve: () => createSecretKey(Buffer.alloc(32, 83)) } : custody
    expect(() => PrivateServiceDomain.open(f.path, next, changedCustody, payloads())).toThrow()
    expect(f.open().ledger.read([address], clock, allow).records[0]?.value).toEqual({ id: 'one' })
  }
)
it('enforces cross-owner native compare-and-swap in one authoritative database', () => {
  const f = location(),
    first = f.create(),
    second = f.open(),
    address = reserve(first)
  expect(() => reserve(second, 'two')).toThrow(expect.objectContaining({ code: 'conflict' }))
  expect(second.ledger.read([address], clock, allow).records[0]?.revision).toBe('1')
})
it('owns configuration before an indexing custody callback can alter the caller input', () => {
  const f = location(),
    input = config()
  const owner = PrivateServiceDomain.create(
    f.path,
    input,
    {
      resolve() {
        input.capacity.maximumRecords = 1
        input.application.profile = 'changed'
        input.identity.chain.genesisHash = 'ff'.repeat(32)
        return indexKey
      }
    },
    payloads()
  )
  try {
    reserve(owner)
    expect(
      f
        .open()
        .ledger.read(
          [owner.identity.address('funding-fence', { acquisition: 'one' })],
          clock,
          allow
        ).revision
    ).toBe('1')
  } finally {
    owner.close()
  }
})
it('rejects accessor configuration before custody callbacks or file creation', () => {
  const f = location(),
    input = config()
  let getters = 0,
    resolves = 0
  Object.defineProperty(input, 'application', {
    enumerable: true,
    get() {
      getters++
      return {}
    }
  })
  expect(() =>
    PrivateServiceDomain.create(
      f.path,
      input,
      {
        resolve() {
          resolves++
          return indexKey
        }
      },
      payloads()
    )
  ).toThrow()
  expect(getters).toBe(0)
  expect(resolves).toBe(0)
  expect(existsSync(f.path)).toBe(false)
})
it('does not create replacement state when indexing custody is absent', () => {
  const f = location()
  expect(() =>
    PrivateServiceDomain.create(
      f.path,
      config(),
      {
        resolve() {
          throw new Error('private custody details')
        }
      },
      payloads()
    )
  ).toThrow('Private identity custody is unavailable')
  expect(existsSync(f.path)).toBe(false)
})
