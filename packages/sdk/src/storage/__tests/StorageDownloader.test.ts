import { StorageDownloader } from '../StorageDownloader.js'
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
})
