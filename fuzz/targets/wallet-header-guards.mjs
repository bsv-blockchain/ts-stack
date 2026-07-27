import blockHeaderApi from '../../packages/wallet/wallet-toolbox/out/src/services/chaintracker/chaintracks/Api/BlockHeaderApi.js'
import { invariant, utf8 } from '../lib.mjs'

const { isBaseBlockHeader, isBlockHeader, isLive, isLiveBlockHeader } = blockHeaderApi

export function fuzz(data) {
  let value
  try {
    value = JSON.parse(utf8(data, 16_384))
  } catch {
    value = utf8(data, 16_384)
  }

  const record = value !== null && typeof value === 'object' ? value : undefined
  const hasPreviousHash = record !== undefined && typeof record.previousHash === 'string'
  invariant(isBaseBlockHeader(value) === hasPreviousHash, 'Base block-header guard diverged')
  invariant(
    isBlockHeader(value) === (record !== undefined && 'height' in record && hasPreviousHash),
    'Block-header guard diverged'
  )
  invariant(
    isLive(value) === (record !== undefined && record.headerId !== undefined),
    'Live-header guard diverged'
  )
  invariant(
    isLiveBlockHeader(value) === (record !== undefined && 'chainWork' in record && hasPreviousHash),
    'Live block-header guard diverged'
  )
}
