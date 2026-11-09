import { StorageDownloader } from '../StorageDownloader.js'
import { StorageDownloadError } from '../index.js'
import { StorageUtils } from '../index.js'
import { LookupResolver } from '../../overlay-tools/index.js'
import Transaction from '../../transaction/Transaction.js'
import PushDrop from '../../script/templates/PushDrop.js'
import { PrivateKey } from '../../primitives/index.js'
import { Utils } from '../../primitives/index.js'
import ProtoWallet from '../../wallet/ProtoWallet.js'
import type { WalletInterface } from '../../wallet/Wallet.interfaces.js'
import { ReadableStream } from 'node:stream/web'

const RESOLVE_HASH = Array.from({ length: 32 }, (_, index) => index)
const RESOLVE_URL = StorageUtils.getURLForHash(RESOLVE_HASH)

async function advertisementBeef(
  hostedFileLocation: string,
  expiryTime: number,
  hash = RESOLVE_HASH,
  atomic = true
): Promise<{ beef: number[]; txid: string }> {
  const wallet = new ProtoWallet(PrivateKey.fromRandom())
  const script = await new PushDrop(wallet as unknown as WalletInterface).lock(
    [
      Utils.toArray((await wallet.getPublicKey({ identityKey: true })).publicKey, 'hex'),
      hash,
      Utils.toArray(hostedFileLocation, 'utf8'),
      new Utils.Writer().writeVarIntNum(expiryTime).toArray(),
      new Utils.Writer().writeVarIntNum(1024).toArray()
    ],
    [2, 'uhrp advertisement'],
    '1',
    'anyone',
    true
  )
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: script })
  return { beef: atomic ? tx.toAtomicBEEF(true) : tx.toBEEF(), txid: tx.id('hex') }
}

beforeEach(() => {
  jest.restoreAllMocks()
})

describe('StorageDownloader', () => {
  let downloader: StorageDownloader

  beforeEach(() => {
    // Create a fresh instance
    downloader = new StorageDownloader({
      fetchClient: async (input, init) => await fetch(input, init)
    })
  })

  describe('resolve()', () => {
    it('throws if the lookup response is not "output-list"', async () => {
      // Mock the LookupResolver to return something invalid
      jest.spyOn(LookupResolver.prototype, 'query').mockResolvedValue({
        type: 'something-else',
        outputs: []
      } as any)

      await expect(downloader.resolve(RESOLVE_URL)).rejects.toThrow(
        'Lookup answer must be an output list'
      )
    })

    it('authenticates returned advertisements and deduplicates host URLs', async () => {
      const first = await advertisementBeef(
        'https://files.example/a.bin',
        Math.floor(Date.now() / 1000) + 3600
      )
      const second = await advertisementBeef(
        'https://files.example/a.bin',
        Math.floor(Date.now() / 1000) + 3600
      )
      jest.spyOn(LookupResolver.prototype, 'query').mockResolvedValue({
        type: 'output-list',
        outputs: [
          { beef: first.beef, outputIndex: 0, txid: first.txid },
          { beef: second.beef, outputIndex: 0, txid: second.txid }
        ]
      } as any)

      const resolved = await downloader.resolve(RESOLVE_URL)
      expect(resolved).toEqual(['https://files.example/a.bin'])
    })

    it('accepts legacy ordinary BEEF while binding an advertised txid to its exact output', async () => {
      const ordinary = await advertisementBeef(
        'https://files.example/ordinary.bin',
        Math.floor(Date.now() / 1000) + 3600,
        RESOLVE_HASH,
        false
      )
      jest.spyOn(LookupResolver.prototype, 'query').mockResolvedValue({
        type: 'output-list',
        outputs: [
          { beef: ordinary.beef, outputIndex: 0, txid: '11'.repeat(32) },
          { beef: ordinary.beef, outputIndex: 0, txid: ordinary.txid }
        ]
      } as any)

      await expect(downloader.resolve(RESOLVE_URL)).resolves.toEqual([
        'https://files.example/ordinary.bin'
      ])
    })

    it('accepts legacy ordinary BEEF without an additive txid hint', async () => {
      const ordinary = await advertisementBeef(
        'https://files.example/no-hint.bin',
        Math.floor(Date.now() / 1000) + 3600,
        RESOLVE_HASH,
        false
      )
      jest.spyOn(LookupResolver.prototype, 'query').mockResolvedValue({
        type: 'output-list',
        outputs: [{ beef: ordinary.beef, outputIndex: 0 }]
      } as any)

      await expect(downloader.resolve(RESOLVE_URL)).resolves.toEqual([
        'https://files.example/no-hint.bin'
      ])
    })
  })

  describe('download()', () => {
    it('throws if UHRP URL is invalid', async () => {
      jest.spyOn(StorageUtils, 'isValidURL').mockReturnValue(false)

      await expect(downloader.download('invalidUrl')).rejects.toThrow('Invalid parameter UHRP url')
    })

    it('throws if no hosts are found', async () => {
      // Valid UHRP URL
      jest.spyOn(StorageUtils, 'isValidURL').mockReturnValue(true)
      // Return some random 32-byte hash so we can pass the check
      jest.spyOn(StorageUtils, 'getHashFromURL').mockReturnValue(Array.from({ length: 32 }).fill(0))

      // Force resolve() to return an empty array
      jest.spyOn(downloader, 'resolve').mockResolvedValue([])

      await expect(downloader.download('validButUnhostedUrl')).rejects.toThrow(
        'No one currently hosts this file!'
      )
    })

    it('downloads successfully from the first working host', async () => {
      jest.spyOn(StorageUtils, 'isValidURL').mockReturnValue(true)
      const knownHash = [
        102, 104, 122, 173, 248, 98, 189, 119, 108, 143, 193, 139, 142, 159, 142, 32, 8, 151, 20,
        133, 110, 226, 51, 179, 144, 42, 89, 29, 13, 95, 41, 37
      ]
      jest.spyOn(StorageUtils, 'getHashFromURL').mockReturnValue(knownHash)

      // Suppose two possible download URLs
      jest.spyOn(downloader, 'resolve').mockResolvedValue(['http://host1/404', 'http://host2/ok'])

      // The first fetch -> 404, second fetch -> success
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(
          new Response(new Uint8Array(32).fill(0), {
            status: 200,
            headers: { 'Content-Type': 'application/test' }
          })
        )

      const result = await downloader.download('validUrl')
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(result).toEqual({
        data: new Uint8Array(32).fill(0),
        mimeType: 'application/test'
      })
    })

    it('throws if content hash mismatches the UHRP hash', async () => {
      jest.spyOn(StorageUtils, 'isValidURL').mockReturnValue(true)
      // The expected hash is all zeros
      jest.spyOn(StorageUtils, 'getHashFromURL').mockReturnValue(Array.from({ length: 32 }).fill(0))

      // One potential host
      jest.spyOn(downloader, 'resolve').mockResolvedValue(['http://bad-content.test'])

      // The fetch returns 32 bytes of all 1's => hash mismatch
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(new Uint8Array(32).fill(1), { status: 200 }))

      await expect(downloader.download('validButBadHashUrl')).rejects.toThrow()
    })

    it('throws if all hosts fail or mismatch', async () => {
      jest.spyOn(StorageUtils, 'isValidURL').mockReturnValue(true)
      jest.spyOn(StorageUtils, 'getHashFromURL').mockReturnValue(Array.from({ length: 32 }).fill(0))

      jest
        .spyOn(downloader, 'resolve')
        .mockResolvedValue(['http://host1.test', 'http://host2.test'])

      // Both fetches fail with 500 or something >=400
      jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 500 }))

      await expect(downloader.download('validButNoGoodHostUrl')).rejects.toThrow(
        'Unable to download content from validButNoGoodHostUrl'
      )
    })

    it('throws if all entries are expired', async () => {
      const currentTime = Math.floor(Date.now() / 1000)
      const expired = await advertisementBeef('https://expired.example/file', currentTime - 100)

      jest.spyOn(LookupResolver.prototype, 'query').mockResolvedValue({
        type: 'output-list',
        outputs: [{ beef: expired.beef, outputIndex: 0, txid: expired.txid }]
      } as any)

      await expect(downloader.resolve(RESOLVE_URL)).resolves.toEqual([])
    })

    it('downloads and verifies large streamed content', async () => {
      const size = 5 * 1024 * 1024
      const data = new Uint8Array(size)
      for (let i = 0; i < size; i++) data[i] = i % 256
      const uhrpUrl = StorageUtils.getURLForFile(data)

      jest.spyOn(downloader, 'resolve').mockResolvedValue(['http://large-file'])

      const chunkSize = 64 * 1024
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < data.length; offset += chunkSize) {
            controller.enqueue(data.subarray(offset, offset + chunkSize))
          }
          controller.close()
        }
      })

      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(stream as any, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' }
        })
      )

      const result = await downloader.download(uhrpUrl)
      expect(result.mimeType).toBe('application/octet-stream')
      expect(result.data).toHaveLength(size)
      expect(result.data).toEqual(data)
    })

    it('cancels an oversized streamed response before buffering it', async () => {
      const limited = new StorageDownloader({
        maxDownloadBytes: 4,
        fetchClient: async () => new Response(new Uint8Array(5), { status: 200 })
      })
      jest.spyOn(StorageUtils, 'isValidURL').mockReturnValue(true)
      jest.spyOn(StorageUtils, 'getHashFromURL').mockReturnValue(Array(32).fill(0))
      jest.spyOn(limited, 'resolve').mockResolvedValue(['https://public.example/file'])

      await expect(limited.download('validUrl')).rejects.toThrow('Unable to download')
    })
  })

  describe('download() failure detail, deadline and body fallback', () => {
    const content = new Uint8Array([1, 2, 3, 4])
    const uhrpUrl = StorageUtils.getURLForFile(content)

    function hosted(
      fetchClient: typeof fetch,
      config: { timeoutMs?: number } = {}
    ): StorageDownloader {
      const instance = new StorageDownloader({ fetchClient, ...config })
      jest
        .spyOn(instance, 'resolve')
        .mockResolvedValue(['https://a.example/f', 'https://b.example/f', 'https://c.example/f'])
      return instance
    }

    it('reports why each advertised host failed', async () => {
      const responses: Record<string, () => Promise<Response>> = {
        'https://a.example/f': async () => new Response(null, { status: 404 }),
        'https://b.example/f': async () =>
          new Response(new Uint8Array([9, 9, 9, 9]), { status: 200 }),
        'https://c.example/f': async () => {
          throw new TypeError('fetch failed')
        }
      }
      const instance = hosted(async input => await responses[String(input)]())

      const error = await instance.download(uhrpUrl).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(StorageDownloadError)
      expect(error).toBeInstanceOf(Error)
      expect(error).toMatchObject({
        name: 'StorageDownloadError',
        message: `Unable to download content from ${uhrpUrl}`,
        attempts: [
          { url: 'https://a.example/f', reason: 'http', status: 404 },
          { url: 'https://b.example/f', reason: 'integrity' },
          { url: 'https://c.example/f', reason: 'network' }
        ]
      })
    })

    it('reports size refusals and a response with no readable body', async () => {
      const responses: Record<string, () => Response> = {
        'https://a.example/f': () =>
          new Response(content, { status: 200, headers: { 'Content-Length': 'abc' } }),
        'https://b.example/f': () => new Response(new Uint8Array(5), { status: 200 }),
        'https://c.example/f': () => ({ ok: true, status: 200, headers: new Headers() }) as Response
      }
      const instance = new StorageDownloader({
        maxDownloadBytes: 4,
        fetchClient: async input => responses[String(input)]()
      })
      jest.spyOn(instance, 'resolve').mockResolvedValue(Object.keys(responses))

      await expect(instance.download(uhrpUrl)).rejects.toMatchObject({
        attempts: [
          { url: 'https://a.example/f', reason: 'size' },
          { url: 'https://b.example/f', reason: 'size' },
          { url: 'https://c.example/f', reason: 'empty' }
        ]
      })
    })

    it('reports an oversized declared length and a body that breaks mid-read', async () => {
      const broken = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('connection reset'))
        }
      })
      const responses: Record<string, () => Response> = {
        'https://a.example/f': () =>
          new Response(content, { status: 200, headers: { 'Content-Length': '10' } }),
        'https://b.example/f': () => new Response(broken as any, { status: 200 })
      }
      const instance = new StorageDownloader({
        maxDownloadBytes: 4,
        fetchClient: async input => responses[String(input)]()
      })
      jest.spyOn(instance, 'resolve').mockResolvedValue(Object.keys(responses))

      await expect(instance.download(uhrpUrl)).rejects.toMatchObject({
        attempts: [
          { url: 'https://a.example/f', reason: 'size' },
          { url: 'https://b.example/f', reason: 'network' }
        ]
      })
    })

    it('reports an unhosted file with no attempts', async () => {
      const instance = new StorageDownloader({ fetchClient: jest.fn<typeof fetch>() })
      jest.spyOn(instance, 'resolve').mockResolvedValue([])
      const error = await instance.download(uhrpUrl).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(StorageDownloadError)
      expect(error).toMatchObject({ message: 'No one currently hosts this file!', attempts: [] })
    })

    it('reads a response without a body stream through arrayBuffer()', async () => {
      const streamless = {
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/test' }),
        body: null,
        arrayBuffer: async () => content.slice().buffer
      } as unknown as Response
      const instance = hosted(async () => streamless)
      await expect(instance.download(uhrpUrl)).resolves.toEqual({
        data: content,
        mimeType: 'application/test'
      })
    })

    it('bounds and verifies a response without a body stream', async () => {
      const streamless = (bytes: Uint8Array): Response =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: async () => bytes.slice().buffer
        }) as unknown as Response
      const responses: Record<string, Response> = {
        'https://a.example/f': streamless(new Uint8Array(5)),
        'https://b.example/f': streamless(new Uint8Array([4, 3, 2, 1]))
      }
      const instance = new StorageDownloader({
        maxDownloadBytes: 4,
        fetchClient: async input => responses[String(input)]
      })
      jest.spyOn(instance, 'resolve').mockResolvedValue(Object.keys(responses))
      await expect(instance.download(uhrpUrl)).rejects.toMatchObject({
        attempts: [
          { url: 'https://a.example/f', reason: 'size' },
          { url: 'https://b.example/f', reason: 'integrity' }
        ]
      })
    })

    it('moves to the next host when one stalls past the deadline', async () => {
      let stalledSignal: AbortSignal | undefined
      const fetchClient = jest.fn<typeof fetch>(async (input, init) => {
        if (String(input) === 'https://a.example/f') {
          stalledSignal = init?.signal ?? undefined
          // Never settles and ignores the signal, like a host that accepts the
          // connection and never answers.
          return await new Promise<Response>(() => {})
        }
        return new Response(content, { status: 200 })
      })
      const instance = hosted(fetchClient, { timeoutMs: 20 })
      await expect(instance.download(uhrpUrl)).resolves.toMatchObject({ data: content })
      expect(stalledSignal?.aborted).toBe(true)
      expect(fetchClient).toHaveBeenCalledTimes(2)
    })

    it('reports a host whose body stalls past the deadline', async () => {
      const stalled = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]))
        }
      })
      const instance = new StorageDownloader({
        timeoutMs: 20,
        fetchClient: async () => new Response(stalled as any, { status: 200 })
      })
      jest.spyOn(instance, 'resolve').mockResolvedValue(['https://a.example/f'])
      await expect(instance.download(uhrpUrl)).rejects.toMatchObject({
        attempts: [{ url: 'https://a.example/f', reason: 'timeout' }]
      })
    })

    it('keeps the request shape and has no deadline unless one is configured', async () => {
      const fetchClient = jest.fn<typeof fetch>(async () => new Response(content, { status: 200 }))
      await hosted(fetchClient).download(uhrpUrl)
      expect(fetchClient).toHaveBeenCalledWith('https://a.example/f', {
        method: 'GET',
        redirect: 'error'
      })
    })

    it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects timeoutMs %p', timeoutMs => {
      expect(() => new StorageDownloader({ timeoutMs })).toThrow(
        'timeoutMs must be a positive safe integer'
      )
    })
  })
})
