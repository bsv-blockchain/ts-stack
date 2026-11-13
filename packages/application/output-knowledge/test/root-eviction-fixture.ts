import {
  PrivateKey,
  signOutputPacket,
  outputRootAdvertisementDigest,
  type OutputRootEvictionRequest
} from '@bsv/sdk'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLiteRootEvictionStore } from '../src/root-eviction/SQLiteRootEvictionStore.js'
import type {
  RootEvictionConfiguration,
  RootEvictionServingTarget
} from '../src/root-eviction/RootEvictionStorage.js'

export const requesterKey = new PrivateKey(81)
export const rootKey = new PrivateKey(82)
export const requester = requesterKey.toPublicKey().toString()
export const root = rootKey.toPublicKey().toString()
export const chain = { network: 'mock', genesisHash: '00'.repeat(32) }
export const policy = '55'.repeat(32)
export const clock = { now: '150', maximumLifetimeSeconds: '86400', futureClockSeconds: '5' }
export function request(id = 'fixture_request_one'): OutputRootEvictionRequest {
  const outpoint = { chain, txid: '11'.repeat(32), outputIndex: 0 }
  return {
    version: 1,
    requestId: id,
    requester,
    recipient: root,
    chain,
    issuedAt: '100',
    expiresAt: '200',
    action: 'suppress',
    reason: 'fixture-reviewed',
    targets: [
      {
        service: 'ls_ship',
        outpoint,
        advertisementDigest: outputRootAdvertisementDigest({
          service: 'ls_ship',
          outpoint,
          lockingScript: 'UQ=='
        }),
        advertisement: { txid: outpoint.txid, outputIndex: outpoint.outputIndex, beef: 'AA==' },
        evidence: { kind: 'operator-policy', policy: 'fixture', detailDigest: '22'.repeat(32) }
      }
    ]
  }
}
export const signed = (body = request()) =>
  signOutputPacket('root-eviction-request', body, requesterKey)
export const selected = (body = request()): RootEvictionServingTarget => ({
  service: body.targets[0].service,
  outpoint: body.targets[0].outpoint,
  advertisementDigest: body.targets[0].advertisementDigest
})
/** Drain every owned resource in order, retaining every cleanup failure. */
export async function closeRootFixtureResources(
  actions: (() => void | Promise<void>)[]
): Promise<void> {
  const failures: unknown[] = []
  await actions.reduce(
    (closed, action) =>
      closed.then(async () => {
        try {
          await action()
        } catch (error) {
          failures.push(error)
        }
      }),
    Promise.resolve()
  )
  if (failures.length > 0) throw new AggregateError(failures, 'Root fixture cleanup failed')
}

export async function fixture(options: Partial<RootEvictionConfiguration> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'root-eviction-'))
  const path = join(directory, 'root.db')
  const configuration = { root, chain, ...options }
  const store = SQLiteRootEvictionStore.create(path, configuration, policy)
  const stores = [store]
  return {
    store,
    path,
    directory,
    configuration,
    reopen() {
      const next = SQLiteRootEvictionStore.open(path, configuration)
      stores.push(next)
      return next
    },
    async cleanup() {
      await closeRootFixtureResources([
        ...stores.map(value => () => value.close()),
        () => rm(directory, { recursive: true, force: true })
      ])
    }
  }
}
export async function apply(
  store: SQLiteRootEvictionStore,
  body = request(),
  disposition: 'accept' | 'reject' = 'accept'
) {
  const retained = await store.retain(signed(body), requester, clock)
  await store.evaluate({
    requestDigest: retained.digest,
    expectedRevision: (await store.head()).revision,
    now: clock.now,
    targets: body.targets.map((_, index) => ({
      index,
      disposition,
      reasonCode: 'reviewed',
      eligible: true
    }))
  })
  return store.result(requester, body.requestId, clock.now)
}
export function restore(id: string, basis: string): OutputRootEvictionRequest {
  const body = request(id)
  body.action = 'restore'
  body.targets[0].restores = basis
  return body
}
