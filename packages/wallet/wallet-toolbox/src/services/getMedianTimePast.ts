import type { WalletServices } from '../sdk/WalletServices.interfaces'
import { deserializeBaseBlockHeader } from './chaintracker/chaintracks/util/blockHeaderUtilities'

const GENESIS_PREVIOUS_HASH = '00'.repeat(32)

/**
 * Median time past (BIP113) of the chain tip and its ten predecessors: the time a
 * time-based nLockTime must be below for the transaction to be mined in the next block.
 *
 * Headers are walked back from the tip by `previousHash`, so they come from one chain
 * provided `hashToHeader` returns the header with the requested hash, as
 * `Services.hashToHeader` checks. The walk stops early at genesis, whose `previousHash`
 * is all zeros.
 *
 * A failure to read a header propagates, so a header-service outage is reported as such
 * rather than as a non-final transaction.
 */
export async function getMedianTimePast(
  services: Pick<WalletServices, 'getHeight' | 'getHeaderForHeight' | 'hashToHeader'>
): Promise<number> {
  const tip = deserializeBaseBlockHeader(await services.getHeaderForHeight(await services.getHeight()))
  const times = await collectAncestorTimes(services, tip.previousHash, [tip.time])
  times.sort((a, b) => a - b)
  return times[Math.floor(times.length / 2)]
}

/**
 * Each header's hash comes from its successor, so the walk is inherently sequential.
 */
async function collectAncestorTimes(
  services: Pick<WalletServices, 'hashToHeader'>,
  previousHash: string,
  times: number[]
): Promise<number[]> {
  if (times.length >= 11 || previousHash === GENESIS_PREVIOUS_HASH) return times
  const header = await services.hashToHeader(previousHash)
  return await collectAncestorTimes(services, header.previousHash, [...times, header.time])
}
