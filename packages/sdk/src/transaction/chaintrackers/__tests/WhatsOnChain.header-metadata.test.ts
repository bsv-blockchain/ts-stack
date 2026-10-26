import WhatsOnChain from '../WhatsOnChain'
import { MerklePath, Script, Transaction } from '../../../../mod'

const root = 'a'.repeat(64)
const height = 123456

function fullHeader(merkleroot = root): Record<string, unknown> {
  return {
    hash: 'b'.repeat(64),
    confirmations: 3,
    height,
    version: 536870912,
    versionHex: '20000000',
    merkleroot,
    time: 1700000000,
    mediantime: 1699999000,
    nonce: 1,
    bits: '180f2b74',
    difficulty: 1,
    chainwork: 'c'.repeat(64),
    previousblockhash: 'd'.repeat(64),
    nextblockhash: 'e'.repeat(64),
    size: 1024,
    nTx: 1,
    num_tx: 1
  }
}

function tracker(data: unknown): WhatsOnChain {
  return new WhatsOnChain('main', {
    httpClient: {
      request: jest.fn().mockImplementation(async (url: string) => ({
        ok: true,
        status: 200,
        data: url.endsWith('/block/headers') ? [{ height: height + 101 }] : data
      }))
    }
  })
}

function boundedHeader(properties: number): Record<string, unknown> {
  return {
    merkleroot: root,
    ...Object.fromEntries(Array.from({ length: properties - 1 }, (_, i) => [`metadata${i}`, i]))
  }
}

describe('WhatsOnChain header metadata compatibility', () => {
  it('verifies a full 17-field provider header while still rejecting a different root', async () => {
    const header = fullHeader()
    expect(Object.keys(header)).toHaveLength(17)
    await expect(tracker(header).isValidRootForHeight(root, height)).resolves.toBe(true)
    await expect(tracker(header).isValidRootForHeight('f'.repeat(64), height)).resolves.toBe(false)
  })

  it('preserves case-insensitive root matching with provider metadata', async () => {
    await expect(
      tracker(fullHeader(root.toUpperCase())).isValidRootForHeight(root, height)
    ).resolves.toBe(true)
  })

  it('accepts the finite 64-property header boundary and rejects 65 properties', async () => {
    await expect(tracker(boundedHeader(64)).isValidRootForHeight(root, height)).resolves.toBe(true)
    await expect(tracker(boundedHeader(65)).isValidRootForHeight(root, height)).resolves.toBe(false)
  })

  it('accepts plain null-prototype headers within the bound', async () => {
    const header = Object.assign(Object.create(null), fullHeader())
    await expect(tracker(header).isValidRootForHeight(root, height)).resolves.toBe(true)
  })

  it.each(['merkleroot', 'metadata'])('rejects a %s accessor without invoking it', async key => {
    const read = jest.fn(() => root)
    const header = fullHeader()
    Object.defineProperty(header, key, { enumerable: true, get: read })
    await expect(tracker(header).isValidRootForHeight(root, height)).resolves.toBe(false)
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects symbol properties and inherited provider objects', async () => {
    const header = fullHeader()
    Object.defineProperty(header, Symbol('metadata'), { value: 1 })
    await expect(tracker(header).isValidRootForHeight(root, height)).resolves.toBe(false)
    await expect(
      tracker(Object.assign(Object.create({ metadata: 1 }), fullHeader())).isValidRootForHeight(
        root,
        height
      )
    ).resolves.toBe(false)
  })

  it.each([undefined, null, [], {}, { merkleroot: 1 }, { merkleroot: 'invalid' }])(
    'rejects malformed header %p',
    async header => {
      await expect(tracker(header).isValidRootForHeight(root, height)).resolves.toBe(false)
    }
  )

  it('verifies a transaction proof against a full header and rejects a mismatched root', async () => {
    const tx = new Transaction()
    tx.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })
    const txid = tx.id('hex')
    tx.merklePath = new MerklePath(height, [[{ offset: 0, hash: txid, txid: true }]])
    await expect(tx.verify(tracker(fullHeader(tx.merklePath.computeRoot(txid))))).resolves.toBe(
      true
    )
    await expect(tx.verify(tracker(fullHeader(root)))).rejects.toThrow('Invalid merkle path')
  })
})
