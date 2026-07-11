import { describe, it, expect } from '@jest/globals'
import {
  decodeMessage,
  tryDecodeMessage,
  type BlockMessage,
  type NodeStatusMessage
} from '../src/messages.js'

const textEncoder = new TextEncoder()

/**
 * Build a raw GossipSub frame exactly the way the message bus does:
 * inner payload JSON -> base64 -> { name, data } envelope JSON -> UTF-8 bytes.
 *
 * Encoding here uses Node's Buffer (Go-compatible standard base64) so the read
 * side genuinely exercises the package's own hand-rolled base64 decoder rather
 * than round-tripping through the same implementation.
 */
function frame (sender: string, payload: unknown): Uint8Array {
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  return textEncoder.encode(JSON.stringify({ name: sender, data }))
}

const blockPayload: BlockMessage = {
  PeerID: '12D3KooWBlockPeer',
  ClientName: 'GorillaPool-mainnet-1',
  DataHubURL: 'https://datahub.example/mainnet',
  Hash: '0000000000000000041f0a9c2b3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f',
  Height: 866000,
  Header: 'deadbeef',
  Coinbase: 'cafebabe'
}

const nodeStatusPayload: NodeStatusMessage = {
  peer_id: '12D3KooWStatusPeer',
  client_name: 'TeraNode-Ünïcode-miner',
  type: 'node_status',
  base_url: 'https://node.example',
  version: '0.5.1',
  commit_hash: 'abc1234',
  best_block_hash: '0000000000000000abc',
  best_height: 866001,
  fsm_state: 'RUNNING',
  start_time: 1751000000,
  uptime: 12345,
  miner_name: 'TeraMiner',
  listen_mode: 'full',
  chain_work: '00000000000000000000000000000001',
  fee_policy: {
    miningFee: { satoshis: 1, bytes: 1000 },
    maxscriptsizepolicy: 100000000,
    maxtxsizepolicy: 1000000000,
    maxtxsigopscountspolicy: 4294967295
  }
}

describe('decodeMessage', () => {
  it('decodes a PascalCase block message into sender + typed payload', () => {
    const decoded = decodeMessage<BlockMessage>(frame('miner-A', blockPayload))
    expect(decoded.sender).toBe('miner-A')
    expect(decoded.payload).toEqual(blockPayload)
    expect(decoded.payload.Height).toBe(866000)
  })

  it('decodes a snake_case node_status message including the nested fee_policy', () => {
    const decoded = decodeMessage<NodeStatusMessage>(frame('miner-B', nodeStatusPayload))
    expect(decoded.sender).toBe('miner-B')
    expect(decoded.payload).toEqual(nodeStatusPayload)
    expect(decoded.payload.fee_policy?.miningFee.satoshis).toBe(1)
  })

  it('preserves multi-byte UTF-8 content through the base64 and utf8 round trip', () => {
    const decoded = decodeMessage<NodeStatusMessage>(frame('miner-B', nodeStatusPayload))
    expect(decoded.payload.client_name).toBe('TeraNode-Ünïcode-miner')
  })

  it('decodes correctly across all base64 padding lengths', () => {
    // Stepping the inner length by one byte each time walks the byte length
    // through every value mod 3, so the encoder emits 0, 1 and 2 trailing '='
    // chars. This directly exercises the trailing-padding scan in base64ToBytes.
    const paddingsSeen = new Set<number>()
    for (let n = 0; n < 6; n++) {
      const payload = {
        PeerID: 'p',
        ClientName: 'c',
        DataHubURL: 'd',
        Hash: 'x'.repeat(n),
        Height: n,
        Header: '',
        Coinbase: ''
      }
      const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
      paddingsSeen.add(data.length - data.replace(/=/g, '').length)
      const decoded = decodeMessage<BlockMessage>(frame('len-' + n, payload))
      expect(decoded.payload).toEqual(payload)
    }
    expect(paddingsSeen.has(0)).toBe(true)
    expect(paddingsSeen.has(1)).toBe(true)
    expect(paddingsSeen.has(2)).toBe(true)
  })

  it('throws on a malformed outer envelope', () => {
    const notJson = textEncoder.encode('this is not json {')
    expect(() => decodeMessage(notJson)).toThrow()
  })
})

describe('tryDecodeMessage', () => {
  it('returns the same result as decodeMessage for a valid frame', () => {
    const bytes = frame('miner-A', blockPayload)
    expect(tryDecodeMessage<BlockMessage>(bytes)).toEqual(decodeMessage<BlockMessage>(bytes))
  })

  it('returns null instead of throwing on a non-JSON control frame', () => {
    const controlFrame = Uint8Array.from([0x13, 0x37, 0x00, 0xff, 0x42])
    expect(tryDecodeMessage(controlFrame)).toBeNull()
  })

  it('returns null when the envelope carries an empty data payload', () => {
    const emptyData = textEncoder.encode(JSON.stringify({ name: 'x', data: '' }))
    expect(tryDecodeMessage(emptyData)).toBeNull()
  })
})
