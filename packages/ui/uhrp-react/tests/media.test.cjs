const assert = require('node:assert/strict')
const { test } = require('node:test')
const React = require('react')
const { create, act } = require('react-test-renderer')
const {
  LookupResolver,
  PrivateKey,
  ProtoWallet,
  PushDrop,
  StorageDownloader,
  StorageUtils,
  Transaction,
  Utils
} = require('@bsv/sdk')

const storage = new Map()
Object.defineProperty(globalThis, 'sessionStorage', {
  value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key)
  }
})
const { Img, Source } = require('..')
const { useStore } = require('../dist/store.js')
const resolve = url => useStore.getState().setResolvedURL(url)

test('passes plain image and media URLs through and preserves their attributes', async () => {
  const src = 'https://cdn.example/picture.png'
  await resolve(src)
  const image = create(React.createElement(Img, { src, alt: 'Wallet badge' }))
  const source = create(React.createElement(Source, { src, type: 'image/png' }))
  assert.deepEqual(image.toJSON().props, { src, alt: 'Wallet badge' })
  assert.deepEqual(source.toJSON().props, { src, type: 'image/png' })
  image.unmount()
  source.unmount()
})

test('shows fallbacks, retries unavailable UHRP content and shares each lookup', async t => {
  const src = StorageUtils.getURLForHash(new Array(32).fill(3))
  const resolved = 'https://cdn.example/content'
  const fallback = React.createElement('span', null, 'Loading media')
  let attempts = 0
  const lookup = t.mock.method(StorageDownloader.prototype, 'resolve', async url => {
    assert.equal(url, src)
    attempts++
    if (attempts === 1) throw new Error('provider unavailable')
    if (attempts === 2) return []
    return [resolved]
  })
  t.mock.method(console, 'error', () => {})
  let image
  let source
  await act(async () => {
    image = create(React.createElement(Img, { src, fallback }))
    source = create(React.createElement(Source, { src, loading: fallback }))
  })
  assert.equal(attempts, 1)
  assert.deepEqual(image.toJSON().children, ['Loading media'])
  assert.deepEqual(source.toJSON().children, ['Loading media'])
  await act(async () => resolve(src))
  assert.deepEqual(image.toJSON().children, ['Loading media'])
  await act(async () => Promise.all([resolve(src), resolve(src)]))
  await resolve(src)
  assert.equal(lookup.mock.callCount(), 3)
  assert.equal(image.toJSON().props.src, resolved)
  assert.equal(source.toJSON().props.src, resolved)
  assert.equal(JSON.parse(storage.get('uhrp-react-session')).state.urls[src], resolved)
  image.unmount()
  source.unmount()
})

test('renders the SDK-resolved URL from a signed advertisement', async t => {
  const contentHash = Array.from({ length: 32 }, (_, i) => i)
  const src = StorageUtils.getURLForHash(contentHash)
  const advertisedUrl = 'https://cdn.example/signed-content.png'
  const wallet = new ProtoWallet(new PrivateKey(11))
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  const compactSize = value => new Utils.Writer().writeVarIntNum(value).toArray()
  const lockingScript = await new PushDrop(wallet).lock(
    [
      Utils.toArray(publicKey, 'hex'),
      contentHash,
      Utils.toArray(advertisedUrl, 'utf8'),
      compactSize(Math.floor(Date.now() / 1000) + 600),
      compactSize(29)
    ],
    [2, 'uhrp advertisement'],
    '1',
    'anyone',
    true
  )
  const transaction = new Transaction()
  transaction.addOutput({ satoshis: 1, lockingScript })
  const lookup = t.mock.method(LookupResolver.prototype, 'query', async ({ service, query }) => {
    assert.equal(service, 'ls_uhrp')
    assert.equal(StorageUtils.normalizeURL(query.uhrpUrl), StorageUtils.normalizeURL(src))
    return { type: 'output-list', outputs: [{ beef: transaction.toBEEF(), outputIndex: 0 }] }
  })
  let image
  await act(async () => {
    image = create(React.createElement(Img, { src, alt: 'Catalog badge' }))
  })
  assert.equal(lookup.mock.callCount(), 1)
  assert.equal(image.toJSON().props.src, advertisedUrl)
  assert.equal(image.toJSON().props.alt, 'Catalog badge')
  image.unmount()
})

test('exposes the same named exports to CommonJS and ESM consumers', async () => {
  const esm = await import('@bsv/uhrp-react')
  assert.equal(esm.Img, Img)
  assert.equal(esm.Source, Source)
})
