import { expect, it } from '@jest/globals'
import { createHmac, createSecretKey, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalOutputJSON, PrivateKey, type OutputJSONObject } from '@bsv/sdk'
import { PrivateServiceIdentity } from '../src/private/PrivateServiceIdentity.js'
import { SQLiteProtectedLedger } from '../src/private/SQLiteProtectedLedger.js'
import { NodeProtectedPayloadCodec } from '../src/private/NodeProtectedPayloadCodec.js'
import {
  protectedLedgerKinds,
  type ProtectedLedgerKind
} from '../src/private/ProtectedLedgerCodec.js'

const key = createSecretKey(Buffer.alloc(32, 71))
const other = createSecretKey(Buffer.alloc(32, 72))
const scope = {
  chain: { network: 'main' as const, genesisHash: '11'.repeat(32) },
  seller: new PrivateKey(1).toPublicKey().toString()
}
const identity = () => new PrivateServiceIdentity(scope, { resolve: () => key }, 'index-key')
const capacity = {
  storeId: 'ab'.repeat(32),
  maximumRecords: 16,
  maximumReservedBytes: 8192,
  maximumRecordBytes: 1024
}
const application = { profile: 'synthetic-service/1' }

it('matches independent HMAC framing and gives the same permanent address after restart', () => {
  const descriptor = { publicationId: 'cd'.repeat(32) }
  const expected = createHmac('sha256', key)
    .update(
      canonicalOutputJSON({
        format: 'output-private-service-identity/1',
        purpose: 'record-address',
        ...scope,
        kind: 'request-fence',
        descriptor
      })
    )
    .digest('hex')
  expect(identity().address('request-fence', descriptor)).toEqual({
    kind: 'request-fence',
    key: expected
  })
  expect(identity().address('request-fence', descriptor)).toEqual(
    identity().address('request-fence', descriptor)
  )
  expect(identity().address('request-fence', { publicationId: 'ef'.repeat(32) }).key).not.toBe(
    expected
  )
})
it('separates every ledger purpose and seller, chain and indexing key', () => {
  const descriptor = { id: 'one' },
    owner = identity()
  const addresses = protectedLedgerKinds.map(kind => owner.address(kind, descriptor).key)
  expect(new Set(addresses).size).toBe(protectedLedgerKinds.length)
  const first = owner.address('funding-fence', descriptor)
  for (const next of [
    new PrivateServiceIdentity(
      { ...scope, seller: new PrivateKey(2).toPublicKey().toString() },
      { resolve: () => key },
      'index-key'
    ),
    new PrivateServiceIdentity(
      { ...scope, chain: { ...scope.chain, genesisHash: '22'.repeat(32) } },
      { resolve: () => key },
      'index-key'
    ),
    new PrivateServiceIdentity(
      { ...scope, chain: { ...scope.chain, network: 'test' } },
      { resolve: () => key },
      'index-key'
    ),
    new PrivateServiceIdentity(scope, { resolve: () => other }, 'index-key')
  ])
    expect(next.address('funding-fence', descriptor).key).not.toBe(first.key)
})
it('owns constructor scope and all returned configuration', () => {
  const input = structuredClone(scope),
    owner = new PrivateServiceIdentity(input, { resolve: () => key }, 'index-key')
  input.chain.genesisHash = 'ff'.repeat(32)
  expect(owner.address('publication', { id: 1 })).toEqual(
    identity().address('publication', { id: 1 })
  )
  const output = owner.configuration(capacity, application)
  output.binding.identity = { changed: true }
  output.binding.application = { changed: true }
  expect(owner.configuration(capacity, application)).toEqual(
    identity().configuration(capacity, application)
  )
})
it.each(['', 'bad key', '../key', 'x'.repeat(129)])('rejects invalid custody label %s', label => {
  expect(() => new PrivateServiceIdentity(scope, { resolve: () => key }, label)).toThrow()
})
it('fails closed on missing or wrong type/size custody without leaking provider errors', () => {
  for (const value of [
    createSecretKey(Buffer.alloc(31)),
    generateKeyPairSync('ed25519').privateKey,
    undefined
  ]) {
    expect(() => new PrivateServiceIdentity(scope, { resolve: () => value! }, 'index-key')).toThrow(
      'Private identity custody is unavailable'
    )
  }
  expect(
    () =>
      new PrivateServiceIdentity(
        scope,
        {
          resolve() {
            throw new Error('private provider details')
          }
        },
        'index-key'
      )
  ).toThrow('Private identity custody is unavailable')
})
it('detects custody changing after construction before returning addresses or configuration', () => {
  let current = key
  const owner = new PrivateServiceIdentity(scope, { resolve: () => current }, 'index-key')
  current = other
  expect(() => owner.address('request-fence', { id: 'one' })).toThrow('custody changed')
  expect(() => owner.configuration(capacity, application)).toThrow('custody changed')
})
it('owns the descriptor before a custody resolver can alter the caller input', () => {
  const descriptor = { id: 'one' }
  let mutate = false
  const owner = new PrivateServiceIdentity(
    scope,
    {
      resolve() {
        if (mutate) descriptor.id = 'two'
        return key
      }
    },
    'index-key'
  )
  mutate = true
  expect(owner.address('quote', descriptor)).toEqual(identity().address('quote', { id: 'one' }))
  expect(descriptor.id).toBe('two')
})
it('rejects hostile descriptor or capacity accessors without executing them', () => {
  let calls = 0
  const hostile = Object.defineProperty({}, 'id', {
    enumerable: true,
    get() {
      calls++
      return 'secret'
    }
  })
  expect(() => identity().address('quote', hostile)).toThrow()
  expect(() =>
    identity().configuration(
      Object.defineProperty({ ...capacity }, 'maximumRecords', {
        get() {
          calls++
          return 1
        }
      }),
      application
    )
  ).toThrow()
  expect(calls).toBe(0)
})
it.each([null, [], 'one', 1])('rejects nonobject descriptors: %p', descriptor => {
  expect(() => identity().address('quote', descriptor as unknown as OutputJSONObject)).toThrow(
    'must be an object'
  )
})
it('rejects unsupported record purposes and bounded oversized descriptors', () => {
  expect(() => identity().address('other' as ProtectedLedgerKind, {})).toThrow()
  expect(() => identity().address('quote', { id: 'x'.repeat(16384) })).toThrow()
  expect(() =>
    identity().configuration({ ...capacity, binding: {} } as typeof capacity, application)
  ).toThrow()
})
it('preserves encrypted permanent fences across encryption rotation but rejects new indexing namespaces on open', () => {
  const directory = mkdtempSync(join(tmpdir(), 'private-identity-test-')),
    path = join(directory, 'ledger.db')
  const payloadKeys = new Map([
    ['first', createSecretKey(Buffer.alloc(32, 31))],
    ['second', createSecretKey(Buffer.alloc(32, 32))]
  ])
  const payloads = (id: string) =>
    new NodeProtectedPayloadCodec(
      {
        resolve(name) {
          const found = payloadKeys.get(name)
          if (!found) throw new Error('missing')
          return found
        }
      },
      id
    )
  const owner = identity(),
    config = owner.configuration(capacity, application)
  let ledger: SQLiteProtectedLedger | undefined
  try {
    ledger = SQLiteProtectedLedger.create(path, config, payloads('first'))
    const address = owner.address('funding-fence', { txid: 'ef'.repeat(32), outputIndex: 0 })
    ledger.commit(
      '0',
      [
        {
          ...address,
          expectedRevision: null,
          reservedBytes: 256,
          reservedUpdates: 1,
          value: { original: 'acquisition' }
        }
      ],
      () => '10',
      () => {}
    )
    ledger.close()
    ledger = SQLiteProtectedLedger.open(
      path,
      identity().configuration(capacity, application),
      payloads('second')
    )
    expect(
      ledger.read(
        [address],
        () => '11',
        () => {}
      ).records[0]!.value
    ).toEqual({ original: 'acquisition' })
    ledger.close()
    const changed = new PrivateServiceIdentity(scope, { resolve: () => other }, 'index-key')
    expect(() =>
      SQLiteProtectedLedger.open(
        path,
        changed.configuration(capacity, application),
        payloads('second')
      )
    ).toThrow()
    const relabeled = new PrivateServiceIdentity(scope, { resolve: () => key }, 'renamed-key')
    expect(() =>
      SQLiteProtectedLedger.open(
        path,
        relabeled.configuration(capacity, application),
        payloads('second')
      )
    ).toThrow()
    ledger = SQLiteProtectedLedger.open(path, config, payloads('second'))
    expect(
      ledger.read(
        [address],
        () => '12',
        () => {}
      ).records[0]!.value
    ).toEqual({ original: 'acquisition' })
  } finally {
    ledger?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('rejects nonobject application bindings and owns them before resolving custody', () => {
  expect(() => identity().configuration(capacity, [] as unknown as OutputJSONObject)).toThrow()
  const input = { profile: 'original' },
    sizes = { ...capacity }
  let mutate = false
  const owner = new PrivateServiceIdentity(
    scope,
    {
      resolve() {
        if (mutate) {
          input.profile = 'changed'
          sizes.maximumRecords = 1
        }
        return key
      }
    },
    'index-key'
  )
  mutate = true
  const config = owner.configuration(sizes, input)
  expect(config.binding.application).toEqual({ profile: 'original' })
  expect(config.maximumRecords).toBe(16)
})

it('retains the complete chain and independent indexing-key commitment in the sealed configuration', () => {
  const commitment = createHmac('sha256', key)
    .update(
      canonicalOutputJSON({
        format: 'output-private-service-identity/1',
        purpose: 'key-commitment',
        ...scope
      })
    )
    .digest('hex')
  expect(identity().configuration(capacity, application)).toEqual({
    ...capacity,
    binding: {
      identity: {
        format: 'output-private-service-identity/1',
        chain: scope.chain,
        seller: scope.seller,
        keyId: 'index-key',
        keyCommitment: commitment
      },
      application
    }
  })
})

it('preserves typed client decisions for invalid labels, descriptors and unavailable custody', () => {
  expect(() => new PrivateServiceIdentity(scope, { resolve: () => key }, 'bad key')).toThrow(
    expect.objectContaining({ code: 'invalid', message: 'Invalid private identity key label' })
  )
  expect(() => identity().address('quote', null as unknown as OutputJSONObject)).toThrow(
    expect.objectContaining({
      code: 'invalid',
      message: 'Private identity descriptor must be an object'
    })
  )
  const missing = {
    resolve() {
      throw new Error('synthetic provider details')
    }
  }
  expect(() => new PrivateServiceIdentity(scope, missing, 'index-key')).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Private identity custody is unavailable'
    })
  )
  let selected = key
  const owner = new PrivateServiceIdentity(scope, { resolve: () => selected }, 'index-key')
  selected = other
  expect(() => owner.configuration(capacity, application)).toThrow(
    expect.objectContaining({ code: 'unavailable', message: 'Private identity custody changed' })
  )
})

it('requires a native secret KeyObject rather than key-like custody metadata', () => {
  // Node accepts key option records for HMAC, but this installed custody contract
  // promises an actual KeyObject and must not silently broaden that capability.
  const keyLike = { key: Buffer.alloc(32, 71), type: 'secret', symmetricKeySize: 32 }
  expect(
    () =>
      new PrivateServiceIdentity(
        scope,
        { resolve: () => keyLike as unknown as ReturnType<typeof createSecretKey> },
        'index-key'
      )
  ).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Private identity custody is unavailable'
    })
  )
})

it('enforces scope and capacity framing limits before custody or persistence work', () => {
  let calls = 0
  const custody = {
    resolve() {
      calls++
      return key
    }
  }
  expect(
    () =>
      new PrivateServiceIdentity(
        { ...scope, padding: 'x'.repeat(4096) } as typeof scope,
        custody,
        'index-key'
      )
  ).toThrow(expect.objectContaining({ code: 'limited' }))
  expect(calls).toBe(0)
  const owner = new PrivateServiceIdentity(scope, custody, 'index-key')
  const before = calls
  expect(() =>
    owner.configuration({ ...capacity, padding: 'x'.repeat(4096) } as typeof capacity, application)
  ).toThrow(expect.objectContaining({ code: 'limited' }))
  expect(calls).toBe(before)
})
