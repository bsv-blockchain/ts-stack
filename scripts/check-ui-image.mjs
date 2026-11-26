import assert from 'node:assert/strict'

const binding = process.argv[2] ?? ''
const port = /^127\.0\.0\.1:(\d{1,5})$/.exec(binding)?.[1]
assert.ok(port, 'The candidate must bind to local loopback only')
const request = path =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(5_000)
  })

const health = await request('/health')
assert.equal(health.status, 200)
assert.equal((await health.text()).trim(), 'ok')
const root = await request('/')
assert.equal(root.status, 200)
assert.equal(root.headers.get('cache-control'), 'no-cache')
const html = await root.text()
const deepLink = await request('/browser-route/example')
assert.equal(deepLink.status, 200)
assert.equal(await deepLink.text(), html)

const assetPath = /src="(\/assets\/[\w.-]{1,200}\.js)"/.exec(html)?.[1]
assert.ok(assetPath, 'The application must reference a bundled entry script')
const asset = await request(assetPath)
assert.equal(asset.status, 200)
assert.match(asset.headers.get('content-type') ?? '', /^(?:application|text)\/javascript\b/)
assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')
assert.ok((await asset.arrayBuffer()).byteLength > 0)

const missingAsset = await request('/assets/absent.js')
assert.equal(missingAsset.status, 404)
console.log('Verified the frontend image HTTP contract')
