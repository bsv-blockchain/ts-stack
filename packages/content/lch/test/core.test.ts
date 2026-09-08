import { describe, expect, it } from '@jest/globals'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  LCHPublisher,
  LCHReader,
  MemoryContentSink,
  WalletBRC77Signer,
  frameLCH,
  objectId,
  parseLCH,
  toHex
} from '../src/index.js'

describe('publisher and reader reference flow', () => {
  it('publishes detached verified content and decrypts it', async () => {
    const signer = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(1)),
      random: length => new Uint8Array(length).fill(7)
    })
    const storage = new MemoryContentSink()
    const publisher = new LCHPublisher(signer)
    const plaintext = new TextEncoder().encode('reference implementation')
    const protectedAsset = await publisher.protect(plaintext, {
      mediaType: 'text/plain',
      name: 'reference.txt',
      rights: [
        { interest: 'text', holder: { name: 'Ty Everett' }, controller: signer.identityKey }
      ],
      sink: storage,
      segmentSize: 8,
      random: length => new Uint8Array(length).fill(length)
    })
    const published = await publisher.publish(
      protectedAsset,
      [
        {
          mode: 'discover',
          usageProfile: 'test',
          seller: signer.identityKey,
          endpoint: 'https://example.com/lch'
        }
      ],
      false
    )
    const reader = new LCHReader(storage)
    const inspected = await reader.inspect(published.bytes)
    expect(toHex(inspected.assetId)).toBe(toHex(await objectId('asset', protectedAsset.asset)))
    expect(await reader.decrypt(inspected, protectedAsset.keys)).toEqual(plaintext)
  })

  it('rejects framing with trailing invalid header data', () => {
    const bytes = frameLCH({ lch: 1, asset: {}, acquisition: [], signatures: [] })
    const parsed = parseLCH(bytes)
    expect(parsed.header.lch).toBe(1)
  })

  it('rejects an unauthorized header mutation and a signed wrong plaintext digest', async () => {
    const signer = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(2)),
      random: length => new Uint8Array(length).fill(8)
    })
    const storage = new MemoryContentSink()
    const publisher = new LCHPublisher(signer)
    const protectedAsset = await publisher.protect(new TextEncoder().encode('authentic'), {
      mediaType: 'text/plain',
      name: 'authentic.txt',
      rights: [
        {
          interest: 'text',
          holder: { name: 'Creator' },
          controller: signer.identityKey
        }
      ],
      sink: storage,
      random: length => new Uint8Array(length).fill(length + 1)
    })
    const published = await publisher.publish(
      protectedAsset,
      [
        {
          mode: 'discover',
          usageProfile: 'test',
          seller: signer.identityKey,
          endpoint: 'https://example.com/lch'
        }
      ],
      false
    )
    const parsed = parseLCH(published.bytes)
    const tamperedAsset = {
      ...(parsed.header.asset as Record<string, never>),
      name: 'tampered.txt'
    }
    const reader = new LCHReader(storage)
    await expect(
      reader.inspect(frameLCH({ ...parsed.header, asset: tamperedAsset }))
    ).rejects.toMatchObject({ code: 'ERR_LCH_AUTHORITY' })

    const representation = protectedAsset.asset.representation as Record<string, unknown>
    representation.plaintextDigest = new Uint8Array(32)
    const wrongDigest = await publisher.publish(
      protectedAsset,
      [
        {
          mode: 'discover',
          usageProfile: 'test',
          seller: signer.identityKey,
          endpoint: 'https://example.com/lch'
        }
      ],
      false
    )
    const inspected = await reader.inspect(wrongDigest.bytes)
    await expect(reader.decrypt(inspected, protectedAsset.keys)).rejects.toMatchObject({
      code: 'ERR_LCH_CONTENT_DIGEST'
    })
  })
})
