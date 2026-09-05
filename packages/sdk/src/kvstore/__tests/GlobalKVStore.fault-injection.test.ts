import { createServer, type Server } from 'node:http'
import GlobalKVStore from '../ReliableGlobalKVStore'
import LookupResolver from '../../overlay-tools/ReliableLookupResolver'
import { fixture, chainTracker } from './fixtures/reliableKV'

// Real loopback HTTP, real JSON/BEEF parsing, real signatures and local header roots.
// No wallet or live overlay calls.
describe('isolated HTTP fault injection', () => {
  const servers: Server[] = []
  const timers: ReturnType<typeof setTimeout>[] = []
  afterEach(async () => {
    timers.splice(0).forEach(clearTimeout)
    await Promise.all(
      servers.splice(0).map(async server => {
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
      })
    )
  })
  async function host(body: unknown, delay = 0, status = 200): Promise<string> {
    const server = createServer((_req, res) => {
      const respond = () => {
        if (!res.destroyed) {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(typeof body === 'string' ? body : JSON.stringify(body))
        }
      }
      if (delay) timers.push(setTimeout(respond, delay))
      else respond()
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing listener')
    return `http://127.0.0.1:${address.port}`
  }
  it.each(['disabled', 'delayed', 'corrupt', 'stale', 'empty'])(
    '%s peer cannot hide a valid reachable state',
    async fault => {
      const old = await fixture('old')
      const current = await fixture('current', old.tx)
      const answer = { type: 'output-list', outputs: [current.output] }
      const good = await host(answer)
      const body =
        fault === 'corrupt'
          ? '{bad json'
          : { type: 'output-list', outputs: fault === 'stale' ? [old.output] : [] }
      const bad = await host(
        body,
        fault === 'delayed' ? 10000 : 0,
        fault === 'disabled' ? 503 : 200
      )
      const resolver = new LookupResolver({
        networkPreset: 'local',
        hostOverrides: { ls_kvstore: [bad, good] }
      })
      const store = new GlobalKVStore({
        lookupResolver: resolver,
        reliability: {
          chainTracker,
          authoritativeHosts: [good, bad],
          deadlineMs: 1000,
          hostTimeoutMs: 300
        }
      })
      const result = await store.getResult(current.query)
      expect(result).toMatchObject({ kind: 'data', entries: [{ value: 'current' }] })
      expect(result.evidence.durationMs).toBeLessThan(1000)
    }
  )
})
