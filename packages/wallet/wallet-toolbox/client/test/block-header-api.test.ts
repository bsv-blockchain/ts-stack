import { describe, expect, it } from 'vitest'
import {
  isBaseBlockHeader,
  isBlockHeader,
  isLive,
  isLiveBlockHeader,
  type AnyBlockHeader,
  type BaseBlockHeader,
  type BlockHeader,
  type LiveBlockHeader
} from '../../src/index.client'

const baseHeader: BaseBlockHeader = {
  version: 1,
  previousHash: '00'.repeat(32),
  merkleRoot: '11'.repeat(32),
  time: 1_234_567_890,
  bits: 0x1d00ffff,
  nonce: 1
}

const blockHeader: BlockHeader = {
  ...baseHeader,
  height: 1,
  hash: '22'.repeat(32)
}

const liveHeader: LiveBlockHeader = {
  ...blockHeader,
  chainWork: '33'.repeat(32),
  isChainTip: true,
  isActive: true,
  headerId: 1,
  previousHeaderId: null
}

const asHeader = (value: object): AnyBlockHeader => value as AnyBlockHeader

describe('block-header type guards', () => {
  it('distinguishes live headers by headerId', () => {
    expect(isLive(blockHeader)).toBe(false)
    expect(isLive(liveHeader)).toBe(true)
  })

  it('requires a string previousHash for base headers', () => {
    expect(isBaseBlockHeader(baseHeader)).toBe(true)
    expect(isBaseBlockHeader(asHeader({ previousHash: 1 }))).toBe(false)
  })

  it('requires height and a string previousHash for block headers', () => {
    expect(isBlockHeader(blockHeader)).toBe(true)
    expect(isBlockHeader(baseHeader)).toBe(false)
    expect(isBlockHeader(asHeader({ height: 1, previousHash: 1 }))).toBe(false)
  })

  it('recognizes the declared chainWork field on live headers', () => {
    expect(isLiveBlockHeader(liveHeader)).toBe(true)
    expect(isLiveBlockHeader(blockHeader)).toBe(false)
    expect(isLiveBlockHeader(asHeader({ chainWork: '1', previousHash: 1 }))).toBe(false)
    expect(isLiveBlockHeader(asHeader({ chainwork: '1', previousHash: baseHeader.previousHash }))).toBe(false)
  })
})
