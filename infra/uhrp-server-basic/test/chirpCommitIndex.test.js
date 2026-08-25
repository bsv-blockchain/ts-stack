const { ChirpCommitIndex } = require('../out/src/chirp/commitIndex.js')

function record(rootIdentifier, closure, expiryTime = Math.floor(Date.now() / 1000) + 60) {
  return {
    rootIdentifier,
    identityFingerprint: 'identity',
    expiryTime,
    rootLength: 1,
    logicalLength: '1',
    closure,
    nodeIdentifiers: [rootIdentifier],
    state: 'active',
    preparedAt: Math.floor(Date.now() / 1000)
  }
}

test('coalesces commit loads and provides bounded constant-time membership sets', async () => {
  const index = new ChirpCommitIndex(2, 3, 30)
  let loads = 0
  const load = async () => {
    loads += 1
    await Promise.resolve()
    return record('root-a', ['root-a', 'blob-a'])
  }
  const [first, second] = await Promise.all([index.get('root-a', load), index.get('root-a', load)])
  expect(loads).toBe(1)
  expect(first).toBe(second)
  expect(first.closure.has('blob-a')).toBe(true)
  expect(first.nodeIdentifiers.has('root-a')).toBe(true)

  await index.get('root-a', load)
  expect(loads).toBe(1)
  index.invalidate('root-a')
  await index.get('root-a', load)
  expect(loads).toBe(2)
})

test('bounds roots, aggregate membership, malformed records, and negative entries', async () => {
  const index = new ChirpCommitIndex(2, 3, 30)
  index.set(record('root-a', ['root-a', 'blob-a']))
  index.set(record('root-b', ['root-b', 'blob-b']))

  let reloads = 0
  await index.get('root-a', async () => {
    reloads += 1
    return record('root-a', ['root-a'])
  })
  expect(reloads).toBe(1)

  let missingLoads = 0
  const missing = async () => {
    missingLoads += 1
    return null
  }
  await index.get('missing', missing)
  await index.get('missing', missing)
  expect(missingLoads).toBe(1)

  expect(() => index.set(record('too-large', ['a', 'b', 'c', 'd']))).toThrow('membership exceeds')
})

test('does not let an in-flight stale load overwrite a durable renewal', async () => {
  const index = new ChirpCommitIndex(2, 10, 30)
  let release
  const stale = index.get(
    'root-a',
    async () =>
      await new Promise(resolve => {
        release = resolve
      })
  )

  const renewed = record('root-a', ['root-a', 'blob-new'])
  index.set(renewed)
  release(record('root-a', ['root-a', 'blob-old']))
  await stale

  let reloads = 0
  const current = await index.get('root-a', async () => {
    reloads += 1
    return renewed
  })
  expect(reloads).toBe(0)
  expect(current.closure.has('blob-new')).toBe(true)
  expect(current.closure.has('blob-old')).toBe(false)
})
