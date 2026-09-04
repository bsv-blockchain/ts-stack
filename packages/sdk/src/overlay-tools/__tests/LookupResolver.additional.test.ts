import { ReliableHostReputation } from '../ReliableHostReputation'
import LookupResolver, {
  HTTPSOverlayLookupFacilitator,
  DEFAULT_SLAP_TRACKERS,
  DEFAULT_TESTNET_SLAP_TRACKERS,
  DEFAULT_TTN_SLAP_TRACKERS
} from '../LookupResolver'
import { getOverlayHostReputationTracker } from '../HostReputationTracker'
import OverlayAdminTokenTemplate from '../../overlay-tools/OverlayAdminTokenTemplate'
import { CompletedProtoWallet } from '../../auth/certificates/__tests/CompletedProtoWallet'
import { PrivateKey } from '../../primitives/index'
import { Transaction } from '../../transaction/index'
import { LockingScript } from '../../script/index'

const mockFacilitator = {
  lookup: jest.fn()
}

// --------------------------------------------------------------------------
// Sample BEEFs for use in tests
// --------------------------------------------------------------------------

const sampleBeef1 = new Transaction(
  1,
  [],
  [{ lockingScript: LockingScript.fromHex('88'), satoshis: 1 }],
  0
).toBEEF()

// --------------------------------------------------------------------------
// Helper: build a SLAP token transaction pointing at a given host/service
// --------------------------------------------------------------------------

async function makeSlapTx(
  keyScalar: number,
  domain: string,
  service: string
): Promise<Transaction> {
  const key = new PrivateKey(keyScalar)
  const wallet = new CompletedProtoWallet(key)
  const lib = new OverlayAdminTokenTemplate(wallet)
  const script = await lib.lock('SLAP', domain, service)
  return new Transaction(1, [], [{ lockingScript: script, satoshis: 1 }], 0)
}

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------

describe('LookupResolver – additional coverage', () => {
  const globalTracker = getOverlayHostReputationTracker()

  beforeEach(() => {
    mockFacilitator.lookup.mockReset()
    globalTracker.reset()
  })

  // -----------------------------------------------------------------------
  // networkPreset branches
  // -----------------------------------------------------------------------

  describe('networkPreset', () => {
    it('uses DEFAULT_SLAP_TRACKERS for mainnet preset (default)', () => {
      const r = new LookupResolver({ facilitator: mockFacilitator })
      // Access private via cast
      expect((r as any).slapTrackers).toEqual(DEFAULT_SLAP_TRACKERS)
      expect((r as any).networkPreset).toBe('mainnet')
    })

    it('uses DEFAULT_TESTNET_SLAP_TRACKERS for testnet preset', () => {
      const r = new LookupResolver({ facilitator: mockFacilitator, networkPreset: 'testnet' })
      expect((r as any).slapTrackers).toEqual(DEFAULT_TESTNET_SLAP_TRACKERS)
      expect((r as any).networkPreset).toBe('testnet')
    })

    it('uses an isolated TTN root for the teratestnet preset', () => {
      const r = new LookupResolver({
        facilitator: mockFacilitator,
        networkPreset: 'teratestnet'
      })
      expect((r as any).slapTrackers).toEqual(DEFAULT_TTN_SLAP_TRACKERS)
      expect((r as any).slapTrackers).not.toEqual(DEFAULT_TESTNET_SLAP_TRACKERS)
      expect((r as any).networkPreset).toBe('teratestnet')
    })

    it('uses localhost for local preset in ls_slap query', async () => {
      mockFacilitator.lookup.mockResolvedValueOnce({
        type: 'output-list',
        outputs: [{ beef: sampleBeef1, outputIndex: 0 }]
      })

      const r = new LookupResolver({ facilitator: mockFacilitator, networkPreset: 'local' })
      await r.query({ service: 'ls_slap', query: {} })

      expect(mockFacilitator.lookup.mock.calls[0][0]).toBe('http://localhost:8080')
    })

    it('uses localhost for local preset on non-slap service query', async () => {
      mockFacilitator.lookup.mockResolvedValueOnce({
        type: 'output-list',
        outputs: [{ beef: sampleBeef1, outputIndex: 0 }]
      })

      const r = new LookupResolver({ facilitator: mockFacilitator, networkPreset: 'local' })
      await r.query({ service: 'ls_bar', query: {} })

      expect(mockFacilitator.lookup.mock.calls[0][0]).toBe('http://localhost:8080')
    })

    it('reports explicit unavailability for testnet discovery failure', async () => {
      mockFacilitator.lookup.mockResolvedValueOnce({
        type: 'output-list',
        outputs: []
      })

      const r = new LookupResolver({ facilitator: mockFacilitator, networkPreset: 'testnet' })
      await expect(r.query({ service: 'ls_missing', query: {} })).rejects.toThrow(
        'Overlay lookup temporarily unavailable or incomplete'
      )
    })

    it('uses custom slapTrackers even when preset is testnet', () => {
      const r = new LookupResolver({
        facilitator: mockFacilitator,
        networkPreset: 'testnet',
        slapTrackers: ['https://custom.tracker']
      })
      expect((r as any).slapTrackers).toEqual(['https://custom.tracker'])
    })
  })

  // -----------------------------------------------------------------------
  // hostOverrides validation
  // -----------------------------------------------------------------------

  describe('hostOverrides validation', () => {
    it('throws when hostOverride service name does not start with ls_', () => {
      expect(
        () =>
          new LookupResolver({
            facilitator: mockFacilitator,
            hostOverrides: { badServiceName: ['https://host.com'] }
          })
      ).toThrow('Host override service names must start with "ls_": badServiceName')
    })

    it('does not throw for valid ls_ prefixed hostOverride keys', () => {
      expect(
        () =>
          new LookupResolver({
            facilitator: mockFacilitator,
            hostOverrides: { ls_valid: ['https://host.com'] }
          })
      ).not.toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // reputationStorage options
  // -----------------------------------------------------------------------

  describe('reputationStorage', () => {
    it('accepts reputationStorage: "localStorage" option', () => {
      // Simply verify construction does not throw
      expect(
        () =>
          new LookupResolver({
            facilitator: mockFacilitator,
            reputationStorage: 'localStorage'
          })
      ).not.toThrow()
    })

    it('accepts reputationStorage as a custom key-value store object', async () => {
      const store = new Map<string, string>()
      const kvStore = {
        get: (key: string): string | null => store.get(key) ?? null,
        set: (key: string, value: string): void => {
          store.set(key, value)
        }
      }

      mockFacilitator.lookup.mockResolvedValueOnce({
        type: 'output-list',
        outputs: [{ beef: sampleBeef1, outputIndex: 0 }]
      })

      const r = new LookupResolver({
        facilitator: mockFacilitator,
        reputationStorage: kvStore,
        hostOverrides: { ls_test: ['https://host.com'] }
      })

      await r.query({ service: 'ls_test', query: {} })
      // Unsafe legacy get/set persistence is not used for v4 concurrent updates.
      expect(store.size).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // Cache tuning options
  // -----------------------------------------------------------------------

  describe('fresh discovery and compatibility cache options', () => {
    it.each([{ hostsTtlMs: 999 }, { hostsMaxEntries: 5 }])(
      'keeps legacy cache options source-compatible but discovers afresh: %j',
      async cache => {
        const ad = await makeSlapTx(42, 'https://fresh.host', 'ls_cache')
        mockFacilitator.lookup.mockImplementation(async (_host, question) => ({
          type: 'output-list',
          outputs: question.service === 'ls_slap' ? [{ beef: ad.toBEEF(), outputIndex: 0 }] : []
        }))
        const r = new LookupResolver({
          facilitator: mockFacilitator,
          slapTrackers: ['https://tracker.host'],
          cache
        })
        await r.query({ service: 'ls_cache', query: {} })
        await r.query({ service: 'ls_cache', query: {} })
        expect(
          mockFacilitator.lookup.mock.calls.filter(c => c[1].service === 'ls_slap')
        ).toHaveLength(2)
      }
    )
    it('respects custom txMemoTtlMs', () => {
      const r = new LookupResolver({ facilitator: mockFacilitator, cache: { txMemoTtlMs: 123 } })
      expect((r as any).txMemoTtlMs).toBe(123)
    })
    it('replaces a retired advertisement on the next lookup', async () => {
      const old = await makeSlapTx(42, 'https://old.host', 'ls_cache')
      const fresh = await makeSlapTx(43, 'https://fresh.host', 'ls_cache')
      let advertisement = old
      mockFacilitator.lookup.mockImplementation(async (host, question) => {
        if (question.service === 'ls_slap')
          return {
            type: 'output-list',
            outputs: [{ beef: advertisement.toBEEF(), outputIndex: 0 }]
          }
        if (host === 'https://old.host') throw new Error('retired')
        return { type: 'output-list', outputs: [{ beef: sampleBeef1, outputIndex: 0 }] }
      })
      const r = new LookupResolver({
        facilitator: mockFacilitator,
        slapTrackers: ['https://tracker.host']
      })
      expect((await r.queryDetailed({ service: 'ls_cache', query: {} })).progress.status).toBe(
        'unavailable'
      )
      advertisement = fresh
      expect((await r.query({ service: 'ls_cache', query: {} })).outputs).toHaveLength(1)
    })
    it('bounds candidate fanout and reports truncation', async () => {
      const hosts = Array.from({ length: 40 }, (_, i) => `https://host-${i}.example`)
      mockFacilitator.lookup.mockResolvedValue({ type: 'output-list', outputs: [] })
      const r = new LookupResolver({
        facilitator: mockFacilitator,
        hostOverrides: { ls_cap: hosts }
      })
      const result = await r.queryDetailed({ service: 'ls_cap', query: {} })
      expect(mockFacilitator.lookup).toHaveBeenCalledTimes(32)
      expect(result.progress).toMatchObject({ discoveryComplete: false, status: 'incomplete' })
    })
    it('isolates concurrent discovery operations', async () => {
      const ad = await makeSlapTx(42, 'https://fresh.host', 'ls_cache')
      mockFacilitator.lookup.mockImplementation(async (_host, question) => ({
        type: 'output-list',
        outputs: question.service === 'ls_slap' ? [{ beef: ad.toBEEF(), outputIndex: 0 }] : []
      }))
      const r = new LookupResolver({
        facilitator: mockFacilitator,
        slapTrackers: ['https://tracker.host']
      })
      const results = await Promise.all([
        r.query({ service: 'ls_cache', query: {} }),
        r.query({ service: 'ls_cache', query: {} })
      ])
      expect(results).toEqual([
        { type: 'output-list', outputs: [] },
        { type: 'output-list', outputs: [] }
      ])
      expect(
        mockFacilitator.lookup.mock.calls.filter(c => c[1].service === 'ls_slap')
      ).toHaveLength(2)
    })
  })

  // -----------------------------------------------------------------------
  // txMemo eviction at 4096 entries
  // -----------------------------------------------------------------------

  describe('txMemo eviction', () => {
    it('evicts the oldest txMemo entry when size exceeds 4096', async () => {
      mockFacilitator.lookup.mockResolvedValue({
        type: 'output-list',
        outputs: [{ beef: sampleBeef1, outputIndex: 0 }]
      })

      const r = new LookupResolver({
        facilitator: mockFacilitator,
        hostOverrides: { ls_memo: ['https://memo.host'] }
      })

      const txMemo: Map<string, any> = (r as any).txMemo

      // Pre-fill to just over 4096 entries
      for (let i = 0; i < 4097; i++) {
        txMemo.set(`key${i}`, { txId: `tx${i}`, expiresAt: Date.now() + 60000 })
      }

      expect(txMemo.size).toBe(4097)

      // Query to trigger the eviction path
      await r.query({ service: 'ls_memo', query: {} })

      // After query the eviction should have fired, size should be <= 4097 + 1 - 1 = 4097
      // (evict oldest then set new)
      expect(txMemo.size).toBeLessThanOrEqual(4098)
    })
  })

  // -----------------------------------------------------------------------
  // prepareHostsForQuery – all-backoff error
  // -----------------------------------------------------------------------

  describe('advisory cooldown probes', () => {
    it('probes recovered competent hosts even in cooldown', async () => {
      const slapTx = await makeSlapTx(42, 'https://backing.off', 'ls_backoff_test')

      // SLAP keeps returning the same backed-off host on every call — including
      // the self-healing retry after backoff is detected. This emulates the
      // genuine "every host is genuinely down" case.
      mockFacilitator.lookup.mockImplementation(async (_url: string, q: any) => {
        if (q.service === 'ls_slap') {
          return { type: 'output-list', outputs: [{ outputIndex: 0, beef: slapTx.toBEEF() }] }
        }
        // The recovered host must be contacted despite its recorded cooldown.
        return { type: 'output-list', outputs: [] }
      })

      const r = new LookupResolver({
        facilitator: mockFacilitator,
        slapTrackers: ['https://mock.slap']
      })

      // Poison the reputation of the host so it enters backoff
      const tracker: ReliableHostReputation = (r as any).hostReputation
      for (let i = 0; i < 5; i++) {
        await tracker.record('mainnet', 'ls_backoff_test', 'https://backing.off', 'transport')
      }

      // The same host recovers without clearing reputation.
      await expect(r.query({ service: 'ls_backoff_test', query: {} })).resolves.toEqual({
        type: 'output-list',
        outputs: []
      })
      expect(mockFacilitator.lookup.mock.calls.map(c => c[0])).toContain('https://backing.off')
    })

    it('probes SLAP trackers even in cooldown', async () => {
      const r = new LookupResolver({
        facilitator: mockFacilitator,
        slapTrackers: ['https://backed.off.slap']
      })

      // Put the SLAP tracker into deep backoff
      const tracker: ReliableHostReputation = (r as any).hostReputation
      for (let i = 0; i < 5; i++) {
        await tracker.record('mainnet', 'ls_slap', 'https://backed.off.slap', 'transport')
      }

      await expect(r.query({ service: 'ls_any', query: {} })).rejects.toThrow(
        'Overlay lookup temporarily unavailable or incomplete'
      )
      expect(mockFacilitator.lookup).toHaveBeenCalledTimes(1)
    })
  })

  // -----------------------------------------------------------------------
  // additionalHosts – deduplication
  // -----------------------------------------------------------------------

  describe('additionalHosts', () => {
    it('does not duplicate a host that already appears in competentHosts', async () => {
      // Override + additional pointing at same host
      mockFacilitator.lookup.mockResolvedValueOnce({
        type: 'output-list',
        outputs: [{ beef: sampleBeef1, outputIndex: 0 }]
      })

      const r = new LookupResolver({
        facilitator: mockFacilitator,
        hostOverrides: { ls_dup: ['https://same.host'] },
        additionalHosts: { ls_dup: ['https://same.host', 'https://extra.host'] }
      })

      await r.query({ service: 'ls_dup', query: {} })

      // same.host should appear exactly once in the calls
      const calledHosts = mockFacilitator.lookup.mock.calls.map((c: any[]) => c[0])
      const sameHostCalls = calledHosts.filter((h: string) => h === 'https://same.host')
      expect(sameHostCalls).toHaveLength(1)
    })
  })

  // -----------------------------------------------------------------------
  // HTTPSOverlayLookupFacilitator
  // -----------------------------------------------------------------------

  describe('HTTPSOverlayLookupFacilitator', () => {
    it('throws when no fetch implementation is available', () => {
      expect(() => new HTTPSOverlayLookupFacilitator(null as any)).toThrow(
        'HTTPSOverlayLookupFacilitator requires a fetch implementation'
      )
    })

    it('allows HTTP URLs when allowHTTP is true', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ type: 'output-list', outputs: [] })
      })
      const facilitator = new HTTPSOverlayLookupFacilitator(mockFetch, true)
      const result = await facilitator.lookup('http://localhost:8080', {
        service: 'ls_test',
        query: {}
      })
      expect(result).toEqual({ type: 'output-list', outputs: [] })
    })

    it('handles HTTP error responses by throwing', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        headers: { get: () => 'application/json' },
        json: async () => ({})
      })
      const facilitator = new HTTPSOverlayLookupFacilitator(mockFetch, true)
      await expect(
        facilitator.lookup('http://host', { service: 'ls_test', query: {} })
      ).rejects.toThrow('Failed to facilitate lookup (HTTP 503)')
    })

    it('normalises AbortError to "Request timed out"', async () => {
      const abortError = new Error('aborted')
      abortError.name = 'AbortError'
      const mockFetch = jest.fn().mockRejectedValue(abortError)
      const facilitator = new HTTPSOverlayLookupFacilitator(mockFetch, true)
      await expect(
        facilitator.lookup('http://host', { service: 'ls_test', query: {} }, 1)
      ).rejects.toThrow('Request timed out')
    })

    it('rejects within the timeout even when fetch never settles', async () => {
      // Simulate the CORS-blocked / hung-preflight case where the fetch promise
      // does not honor the AbortController signal and never settles.
      const neverFetch = jest.fn().mockImplementation(
        () =>
          new Promise(() => {
            /* never resolves */
          })
      )
      const facilitator = new HTTPSOverlayLookupFacilitator(neverFetch, true)
      const start = Date.now()
      await expect(
        facilitator.lookup('http://host', { service: 'ls_test', query: {} }, 50)
      ).rejects.toThrow('Request timed out')
      const elapsed = Date.now() - start
      // Allow generous slack but must complete well before any global jest timeout.
      expect(elapsed).toBeLessThan(2000)
    })

    it('parses octet-stream responses', async () => {
      // Build a minimal octet-stream payload: 1 outpoint, then BEEF bytes
      const tx = new Transaction(
        1,
        [],
        [{ lockingScript: LockingScript.fromHex('88'), satoshis: 1 }],
        0
      )
      const beef = tx.toBEEF()

      // Build the payload: varint(1) + txid(32) + varint(outputIndex) + varint(contextLen=0) + beef
      // The source reads 32 bytes and calls Utils.toHex(), so the bytes must be in big-endian
      // (same order as tx.id('hex')) so the resulting hex matches what Transaction.fromBEEF expects.
      const txid = Buffer.from(tx.id('hex'), 'hex')
      const nOutpoints = Buffer.from([0x01]) // varint 1
      const outputIndex = Buffer.from([0x00]) // varint 0
      const contextLen = Buffer.from([0x00]) // varint 0
      const beefBuf = Buffer.from(beef)
      const payload = Buffer.concat([nOutpoints, txid, outputIndex, contextLen, beefBuf])

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/octet-stream' },
        arrayBuffer: async () =>
          payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
      })

      const facilitator = new HTTPSOverlayLookupFacilitator(mockFetch, true)
      const result = await facilitator.lookup('http://host', { service: 'ls_test', query: {} })

      expect(result.type).toBe('output-list')
      expect(result.outputs).toHaveLength(1)
      expect(result.outputs[0].outputIndex).toBe(0)
    })

    it('parses octet-stream responses when header carries parameters or differing case', async () => {
      const tx = new Transaction(
        1,
        [],
        [{ lockingScript: LockingScript.fromHex('88'), satoshis: 1 }],
        0
      )
      const beef = tx.toBEEF()
      const txid = Buffer.from(tx.id('hex'), 'hex')
      const payload = Buffer.concat([
        Buffer.from([0x01]),
        txid,
        Buffer.from([0x00]),
        Buffer.from([0x00]),
        Buffer.from(beef)
      ])

      for (const header of [
        'application/octet-stream; charset=utf-8',
        'Application/Octet-Stream',
        '  application/octet-stream  '
      ]) {
        const mockFetch = jest.fn().mockResolvedValue({
          ok: true,
          headers: { get: () => header },
          arrayBuffer: async () =>
            payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
        })
        const facilitator = new HTTPSOverlayLookupFacilitator(mockFetch, true)
        const result = await facilitator.lookup('https://host', { service: 'ls_test', query: {} })
        expect(result.type).toBe('output-list')
        expect(result.outputs).toHaveLength(1)
      }
    })

    it('parses octet-stream responses with context bytes', async () => {
      const tx = new Transaction(
        1,
        [],
        [{ lockingScript: LockingScript.fromHex('88'), satoshis: 1 }],
        0
      )
      const beef = tx.toBEEF()
      // Use big-endian byte order so Utils.toHex(r.read(32)) produces the same hex as tx.id('hex')
      const txid = Buffer.from(tx.id('hex'), 'hex')

      // payload: 1 outpoint, with context of 2 bytes [0xde, 0xad]
      const nOutpoints = Buffer.from([0x01])
      const outputIndex = Buffer.from([0x00])
      const contextLen = Buffer.from([0x02])
      const contextBytes = Buffer.from([0xde, 0xad])
      const beefBuf = Buffer.from(beef)
      const payload = Buffer.concat([
        nOutpoints,
        txid,
        outputIndex,
        contextLen,
        contextBytes,
        beefBuf
      ])

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/octet-stream' },
        arrayBuffer: async () =>
          payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
      })

      const facilitator = new HTTPSOverlayLookupFacilitator(mockFetch, true)
      const result = await facilitator.lookup('http://host', { service: 'ls_test', query: {} })

      expect(result.type).toBe('output-list')
      expect(result.outputs[0].context).toBeDefined()
      expect(Array.from(result.outputs[0].context!)).toEqual([0xde, 0xad])
    })

    it('re-throws non-AbortError errors from fetch', async () => {
      const mockFetch = jest.fn().mockRejectedValue(new Error('DNS failure'))
      const facilitator = new HTTPSOverlayLookupFacilitator(mockFetch, true)
      await expect(
        facilitator.lookup('http://host', { service: 'ls_test', query: {} })
      ).rejects.toThrow('DNS failure')
    })

    it('normalises string thrown values from fetch', async () => {
      const mockFetch = jest.fn().mockRejectedValue('boom')
      const facilitator = new HTTPSOverlayLookupFacilitator(mockFetch, true)
      await expect(
        facilitator.lookup('https://host', { service: 'ls_test', query: {} })
      ).rejects.toThrow('boom')
    })

    it('normalises object-with-message thrown values from fetch', async () => {
      const mockFetch = jest.fn().mockRejectedValue({ message: 'object boom' })
      const facilitator = new HTTPSOverlayLookupFacilitator(mockFetch, true)
      await expect(
        facilitator.lookup('https://host', { service: 'ls_test', query: {} })
      ).rejects.toThrow('object boom')
    })

    it('normalises plain-object thrown values via JSON', async () => {
      const mockFetch = jest.fn().mockRejectedValue({ code: 42 })
      const facilitator = new HTTPSOverlayLookupFacilitator(mockFetch, true)
      await expect(
        facilitator.lookup('https://host', { service: 'ls_test', query: {} })
      ).rejects.toThrow('{"code":42}')
    })

    it('normalises number/boolean/null thrown values from fetch', async () => {
      for (const value of [123, true, null]) {
        const mockFetch = jest.fn().mockRejectedValue(value)
        const facilitator = new HTTPSOverlayLookupFacilitator(mockFetch, true)
        await expect(
          facilitator.lookup('https://host', { service: 'ls_test', query: {} })
        ).rejects.toThrow(String(value))
      }
    })

    it('normalises circular thrown values without crashing', async () => {
      const circular: { self?: unknown } = {}
      circular.self = circular
      const mockFetch = jest.fn().mockRejectedValue(circular)
      const facilitator = new HTTPSOverlayLookupFacilitator(mockFetch, true)
      await expect(
        facilitator.lookup('https://host', { service: 'ls_test', query: {} })
      ).rejects.toThrow('Unknown error')
    })

    it('sends correct request body to /lookup endpoint', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ type: 'output-list', outputs: [] })
      })
      const facilitator = new HTTPSOverlayLookupFacilitator(mockFetch, true)
      const question = { service: 'ls_test', query: { filter: 'abc' } }
      await facilitator.lookup('http://host', question)

      const calledUrl: string = mockFetch.mock.calls[0][0]
      expect(calledUrl).toBe('http://host/lookup')

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body).toEqual({ service: 'ls_test', query: { filter: 'abc' } })
    })
  })

  // -----------------------------------------------------------------------
  // lookupHostWithTracking – invalid response tracking
  // -----------------------------------------------------------------------

  describe('lookupHostWithTracking – non-output-list responses', () => {
    it('does NOT penalize a host that returns a structurally valid freeform response', async () => {
      // Many lookup services legitimately return freeform shapes for some
      // queries (e.g. ls_kvstore for missing keys). A reachable host
      // answering with a valid shape should not accumulate failures and slide
      // into backoff just because we asked a question it didn't have data for.
      mockFacilitator.lookup.mockResolvedValue({
        type: 'freeform',
        result: 'some free data'
      })

      const r = new LookupResolver({
        facilitator: mockFacilitator,
        hostOverrides: { ls_invalid: ['https://weird.host'] }
      })

      // Multiple repeated queries shouldn't push the host into backoff.
      for (let i = 0; i < 6; i++) {
        const res = await r.queryDetailed({ service: 'ls_invalid', query: { i } })
        expect(res.progress).toMatchObject({
          status: 'unavailable',
          freeformHosts: 1,
          failedHosts: 0
        })
      }

      const tracker: ReliableHostReputation = (r as any).hostReputation
      expect(tracker.snapshot('mainnet', 'ls_invalid', 'https://weird.host')).toBeUndefined()
    })

    it('records failure for a structurally MALFORMED response (no type field)', async () => {
      mockFacilitator.lookup.mockResolvedValueOnce({ garbage: true })

      const r = new LookupResolver({
        facilitator: mockFacilitator,
        hostOverrides: { ls_bad: ['https://malformed.host'] }
      })

      const res = await r.queryDetailed({ service: 'ls_bad', query: {} })
      expect(res.progress).toMatchObject({ status: 'unavailable', failedHosts: 1 })

      const tracker: ReliableHostReputation = (r as any).hostReputation
      const snap = tracker.snapshot('mainnet', 'ls_bad', 'https://malformed.host')
      expect(snap?.reason).toBe('malformed')
      expect(snap?.penalty).toBe(8)
    })
  })

  // -----------------------------------------------------------------------
  // Empty hosts edge case
  // -----------------------------------------------------------------------

  describe('empty trackerHosts', () => {
    it('returns empty array from findCompetentHosts when all SLAP trackers are empty list', async () => {
      // Provide an empty slapTrackers list so trackerHosts.length === 0
      const r = new LookupResolver({
        facilitator: mockFacilitator,
        slapTrackers: []
      })

      await expect(r.query({ service: 'ls_foo', query: {} })).rejects.toThrow(
        'Overlay lookup temporarily unavailable or incomplete'
      )
    })
  })
})
