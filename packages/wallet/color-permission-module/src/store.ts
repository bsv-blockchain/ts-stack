import type { ColorModuleStore } from './types.js'

/** Every key the module writes starts with this prefix. */
export const STORE_PREFIX = 'color.v1.'

const TXID = /^[0-9a-f]{64}$/
/** The value of a settled record. */
const SETTLED = '1'

/**
 * Typed records over the host's `ColorModuleStore`, all under `color.v1.`. Only constructed
 * when profiles are registered. The layout is `color.v1.deploy.<assetId>` (the cached deploy
 * transaction, verified by hash on read) and `color.v1.settled.<txid>` (written by
 * `markSettled`), and nothing else writes the store.
 *
 * Reads fail safe: a settled record whose value is not exactly the settled marker reads as
 * absent, so a torn write shows the transaction's outputs as pending again.
 */
export class ColorStore {
  constructor(protected readonly store: ColorModuleStore) {}

  /** The cached deploy transaction of an asset, as raw hex; the caller verifies it by hash. */
  async getDeploy(assetId: string): Promise<string | undefined> {
    return await this.store.get(deployKey(assetId))
  }

  async putDeploy(assetId: string, hex: string): Promise<void> {
    await this.store.set(deployKey(assetId), hex)
  }

  async deleteDeploy(assetId: string): Promise<void> {
    await this.store.delete(deployKey(assetId))
  }

  /** True when `markSettled` recorded `txid`. */
  async settled(txid: string): Promise<boolean> {
    return (await this.store.get(settledKey(txid))) === SETTLED
  }

  /** Records `txid` as settled; an existing record is not rewritten. */
  async markSettled(txid: string): Promise<void> {
    if (await this.settled(txid)) return
    await this.store.set(settledKey(txid), SETTLED)
  }

  /** The txids with a readable settled record. A torn record does not count (fail safe). */
  async settledSet(): Promise<Set<string>> {
    const prefix = `${STORE_PREFIX}settled.`
    const ids = (await this.store.keys(prefix))
      .filter(key => key.startsWith(prefix))
      .map(key => key.slice(prefix.length))
      .filter(id => TXID.test(id))
    const values = await Promise.all(ids.map(async txid => await this.settled(txid)))
    return new Set(ids.filter((_, index) => values[index]))
  }
}

function deployKey(assetId: string): string {
  return `${STORE_PREFIX}deploy.${assetId}`
}

function settledKey(txid: string): string {
  if (typeof txid !== 'string' || !TXID.test(txid)) {
    throw new TypeError('BRC-207: a store record is keyed by a lowercase hex txid')
  }
  return `${STORE_PREFIX}settled.${txid}`
}
