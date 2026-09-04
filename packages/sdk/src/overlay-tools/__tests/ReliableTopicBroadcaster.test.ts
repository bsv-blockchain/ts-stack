import { ReliableTopicBroadcaster } from '../ReliableTopicBroadcaster'
import OverlayAdminTokenTemplate from '../OverlayAdminTokenTemplate'
import Transaction from '../../transaction/Transaction'
import { fixture, author } from '../../kvstore/__tests/fixtures/reliableKV'

const good = 'https://good.example'
const bad = 'https://bad.example'
const ack = { tm_kvstore: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [] } }
async function resolverFor(hosts: string[]) {
  const ads = await Promise.all(
    hosts.map(async host => {
      const script = await new OverlayAdminTokenTemplate(author as any).lock(
        'SHIP',
        host,
        'tm_kvstore'
      )
      return {
        beef: new Transaction(1, [], [{ lockingScript: script, satoshis: 1 }], 0).toBEEF(),
        outputIndex: 0
      }
    })
  )
  return {
    queryReliable: jest.fn(async (_question, options) => ({
      hosts: [
        {
          host: 'https://tracker.example',
          kind: 'answer',
          values: await options.validate({ type: 'output-list', outputs: ads })
        }
      ],
      discoveryComplete: true,
      durationMs: 0
    }))
  }
}
describe('bounded submission adapter', () => {
  afterEach(() => jest.useRealTimers())
  it('submits concurrently, aborts the dead host and preserves canonical topics encoding', async () => {
    const f = await fixture('submission')
    const resolver = await resolverFor([bad, good])
    jest.useFakeTimers()
    const signals: AbortSignal[] = []
    const fetch = jest.fn(async (url, init) => {
      signals.push(init.signal)
      expect(init.headers['X-Topics']).toBe('tm_kvstore')
      if (url.startsWith(bad)) return await new Promise<Response>(() => {})
      return new Response(JSON.stringify(ack))
    })
    const broadcaster = new ReliableTopicBroadcaster(['tm_kvstore'], resolver as any, false, fetch)
    const pending = broadcaster.broadcast(f.tx)
    await jest.advanceTimersByTimeAsync(2100)
    expect(await pending).toMatchObject({ status: 'success', txid: f.tx.id('hex') })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(signals.every(signal => signal.aborted)).toBe(true)
  })
  it.each([{}, { status: 'error' }, { tm_kvstore: { outputsToAdmit: [500] } }])(
    'rejects malformed or explicit error acknowledgment %j',
    async response => {
      const f = await fixture('rejected')
      const resolver = await resolverFor([good])
      const broadcaster = new ReliableTopicBroadcaster(
        ['tm_kvstore'],
        resolver as any,
        false,
        jest.fn(async () => new Response(JSON.stringify(response)))
      )
      expect(await broadcaster.broadcast(f.tx)).toMatchObject({ status: 'error' })
    }
  )
  it('rediscovers after failure instead of persisting a stale submission host', async () => {
    const f = await fixture('recovery')
    const resolver = await resolverFor([good])
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(ack)))
    const broadcaster = new ReliableTopicBroadcaster(['tm_kvstore'], resolver as any, false, fetch)
    expect((await broadcaster.broadcast(f.tx)).status).toBe('error')
    expect((await broadcaster.broadcast(f.tx)).status).toBe('success')
    expect(resolver.queryReliable).toHaveBeenCalledTimes(2)
  })
})
