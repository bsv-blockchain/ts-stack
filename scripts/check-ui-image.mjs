import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'

const image = process.argv[2]
assert.ok(image, 'Provide the built frontend image')
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim()

const container = docker(
  'run',
  '-d',
  '--platform',
  'linux/amd64',
  '--read-only',
  '--tmpfs',
  '/tmp:rw,nosuid,nodev,size=16m',
  '--publish',
  '127.0.0.1::8080',
  image
)

try {
  const binding = docker('port', container, '8080/tcp')
  const port = binding.match(/^127\.0\.0\.1:(\d{1,5})$/)?.[1]
  assert.ok(port, 'The candidate must bind to local loopback only')
  const request = path =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(5_000)
    })

  let readiness = ''
  for (let attempt = 0; attempt < 40 && readiness !== 'ok'; attempt++) {
    try {
      const health = await request('/health')
      if (health.ok) readiness = (await health.text()).trim()
    } catch {
      // The listener may still be starting.
    }
    if (readiness !== 'ok') await setTimeout(250)
  }
  assert.equal(readiness, 'ok', 'The candidate did not become ready')
  assert.notEqual(docker('exec', container, 'id', '-u'), '0')

  const root = await request('/')
  assert.equal(root.status, 200)
  assert.equal(root.headers.get('cache-control'), 'no-cache')
  const html = await root.text()
  const deepLink = await request('/browser-route/example')
  assert.equal(deepLink.status, 200)
  assert.equal(await deepLink.text(), html)

  const assetPath = html.match(/src="(\/assets\/[\w.-]{1,200}\.js)"/)?.[1]
  assert.ok(assetPath, 'The application must reference a bundled entry script')
  const asset = await request(assetPath)
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type') ?? '', /^(?:application|text)\/javascript\b/)
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.ok((await asset.arrayBuffer()).byteLength > 0)

  const missingAsset = await request('/assets/absent.js')
  assert.equal(missingAsset.status, 404)
  console.log(`Verified the HTTP contract for ${image}`)
} catch (error) {
  console.error(docker('logs', container))
  throw error
} finally {
  docker('rm', '-f', container)
}
