import { expect, it } from '@jest/globals'
import { DatabaseSync } from 'node:sqlite'
import { canonicalOutputJSON, outputPacketDigest, signOutputPacket } from '@bsv/sdk'
import { RootEvictionContracts } from '../src/root-eviction/RootEvictionContracts.js'
import {
  rootContractManifest,
  rootContractPacket,
  rootContractTrust
} from './root-contract-fixture.js'
import { clock, requester, requesterKey, signed } from './root-eviction-fixture.js'
import {
  coordinatedFixture,
  coordinatedRequest,
  contractSelection,
  coordinationGuard
} from './root-eviction-coordination-fixture.js'

const error = (code: string) => ({ code, message: expect.stringMatching(/\S/) })
function inventory(path: string) {
  const db = new DatabaseSync(path)
  try {
    return db
      .prepare(
        `SELECT
      (SELECT count(*) FROM root_requests) AS requests,
      (SELECT count(*) FROM root_contracts) AS contracts,
      (SELECT coalesce(sum(bytes),0) FROM root_contracts) AS bytes`
      )
      .get()!
  } finally {
    db.close()
  }
}

it('retains an owned original selection atomically and recovers it after expiry and discovery rotation', async () => {
  const f = await coordinatedFixture()
  try {
    const body = coordinatedRequest(),
      selection = contractSelection()
    const first = await f.store.retainCoordinated(
      signed(body),
      requester,
      selection,
      f.contracts,
      coordinationGuard()
    )
    expect(first.observedAt).toBe('150')
    expect(first.value.contract.selection.digest).toBe(selection.selector)
    expect(first.value.contract.limits).toEqual({
      maximumTargets: 64,
      maximumLifetimeSeconds: '86400',
      maximumRequestBytes: 1048576,
      maximumResponseBytes: 1048576
    })
    expect(inventory(f.path)).toMatchObject({ requests: 1, contracts: 1 })
    first.value.contract.selection.manifest.body.baseURL = 'https://modified.example.test'
    first.value.request.body.reason = 'modified'
    const reopened = f.reopen()
    const retry = await reopened.retainCoordinated(
      signed(body),
      requester,
      { ...selection, manifest: null },
      f.contracts,
      coordinationGuard('201')
    )
    expect(retry.value.request.body).toEqual(body)
    expect(retry.value.contract.selection.manifest.body.baseURL).toBe(rootContractTrust().baseURL)
    const status = await reopened.resultCoordinated(
      requester,
      body.requestId,
      selection.selector,
      f.contracts,
      coordinationGuard('201')
    )
    expect(status.value.result.outcomes[0]).toMatchObject({
      actionStatus: 'rejected',
      reasonCode: 'request-expired'
    })
    expect(status.value.retained).toEqual(retry.value)
    const rotated = rootContractManifest()
    rotated.issuedAt = '150'
    rotated.expiresAt = '300'
    const replacement = rootContractPacket(rotated)
    await expect(
      reopened.retainCoordinated(
        signed(body),
        requester,
        { ...selection, manifest: replacement.packet, selector: replacement.selector },
        f.contracts,
        coordinationGuard('201')
      )
    ).rejects.toMatchObject(error('context-changed'))
    expect(inventory(f.path)).toMatchObject({ requests: 1, contracts: 1 })
  } finally {
    await f.cleanup()
  }
})

it('preserves original meaning before consulting a new selector or current discovery', async () => {
  const f = await coordinatedFixture()
  try {
    const body = coordinatedRequest(),
      selection = contractSelection()
    await f.store.retainCoordinated(
      signed(body),
      requester,
      selection,
      f.contracts,
      coordinationGuard()
    )
    for (const change of ['reason', 'proof', 'recipient'] as const) {
      const altered = structuredClone(body)
      if (change === 'reason') altered.reason += '-changed'
      if (change === 'proof') altered.targets[0].advertisement.beef = 'AQ=='
      if (change === 'recipient') altered.recipient = requester
      await expect(
        f.store.retainCoordinated(
          signed(altered),
          requester,
          { ...selection, selector: 'ff'.repeat(32), manifest: null },
          f.contracts,
          coordinationGuard()
        )
      ).rejects.toMatchObject(error('conflict'))
    }
    const denied = { ...coordinationGuard(), authorize: () => false }
    for (const id of [body.requestId, 'missing_coordinated_request'])
      await expect(
        f.store.resultCoordinated(requester, id, selection.selector, f.contracts, denied)
      ).rejects.toMatchObject(error('not-found'))
    await expect(
      f.store.retainCoordinated(signed(body), requester, selection, f.contracts, denied)
    ).rejects.toMatchObject(error('not-found'))
    expect(inventory(f.path)).toMatchObject({ requests: 1, contracts: 1 })
  } finally {
    await f.cleanup()
  }
})

it('binds first intake to the journal root and chain and the clock sampled inside its gate', async () => {
  const f = await coordinatedFixture()
  try {
    const body = coordinatedRequest(),
      selection = contractSelection()
    await expect(
      f.store.retainCoordinated(
        signed(body),
        requester,
        selection,
        f.contracts,
        coordinationGuard('200')
      )
    ).rejects.toMatchObject(error('expired'))
    const currentManifest = rootContractManifest()
    currentManifest.expiresAt = '300'
    const current = rootContractPacket(currentManifest)
    await expect(
      f.store.retainCoordinated(
        signed(body),
        requester,
        { ...selection, manifest: current.packet, selector: current.selector },
        f.contracts,
        coordinationGuard('200')
      )
    ).rejects.toMatchObject(error('invalid'))
    const wrongTrust = rootContractTrust()
    wrongTrust.chain = { ...wrongTrust.chain, genesisHash: 'bb'.repeat(32) }
    const wrongManifest = rootContractManifest()
    wrongManifest.chain = wrongTrust.chain
    const wrong = rootContractPacket(wrongManifest)
    await expect(
      f.store.retainCoordinated(
        signed(body),
        requester,
        { ...selection, manifest: wrong.packet, selector: wrong.selector },
        new RootEvictionContracts(wrongTrust),
        coordinationGuard()
      )
    ).rejects.toMatchObject(error('context-changed'))
    const otherRootTrust = { ...rootContractTrust(), identity: requester }
    const otherRootManifest = { ...rootContractManifest(), identity: requester }
    await expect(
      f.store.retainCoordinated(
        signed(body),
        requester,
        {
          ...selection,
          manifest: signOutputPacket('capabilities', otherRootManifest, requesterKey),
          selector: outputPacketDigest('capabilities', otherRootManifest)
        },
        new RootEvictionContracts(otherRootTrust),
        coordinationGuard()
      )
    ).rejects.toMatchObject(error('context-changed'))
    expect(inventory(f.path)).toMatchObject({ requests: 0, contracts: 0 })
  } finally {
    await f.cleanup()
  }
})

it('enforces every selected request, target, lifetime and complete future-result bound before retaining obligations', async () => {
  for (const field of ['request', 'target', 'lifetime', 'response'] as const) {
    const f = await coordinatedFixture()
    try {
      const body = coordinatedRequest(),
        manifest = rootContractManifest(),
        profile = manifest.services[0].profiles[0]
      if (field === 'request') profile.maxRequestBytes = 1
      if (field === 'response') profile.maxResponseBytes = 1024
      if (field === 'lifetime') profile.parameters.maxLifetimeSeconds = '99'
      if (field === 'target') {
        profile.parameters.maxTargets = 1
        const another = structuredClone(body.targets[0])
        another.outpoint.outputIndex = 1
        another.advertisement.outputIndex = 1
        body.targets.push(another)
      }
      const cap = rootContractPacket(manifest)
      await expect(
        f.store.retainCoordinated(
          signed(body),
          requester,
          { manifest: cap.packet, selector: cap.selector, futureClockSeconds: '5' },
          f.contracts,
          coordinationGuard()
        )
      ).rejects.toMatchObject(error(field === 'lifetime' ? 'invalid' : 'limited'))
      expect(inventory(f.path)).toMatchObject({ requests: 0, contracts: 0 })
    } finally {
      await f.cleanup()
    }
  }
})

it('reserves exact original-contract capacity and resolves simultaneous first intake only once', async () => {
  const selection = contractSelection(),
    contracts = new RootEvictionContracts(rootContractTrust())
  const bytes = Buffer.byteLength(
    canonicalOutputJSON(contracts.retain(selection.manifest, selection.selector, '150').record)
  )
  const f = await coordinatedFixture({ coordination: { contractBytes: bytes } })
  try {
    const other = f.reopen(),
      body = coordinatedRequest()
    const results = await Promise.all(
      [f.store, other].map(store =>
        store.retainCoordinated(signed(body), requester, selection, contracts, coordinationGuard())
      )
    )
    expect(results[1]).toEqual(results[0])
    expect(inventory(f.path)).toEqual({ requests: 1, contracts: 1, bytes })
    await expect(
      other.retainCoordinated(
        signed(coordinatedRequest('second_coordinated_request')),
        requester,
        selection,
        contracts,
        coordinationGuard()
      )
    ).rejects.toMatchObject(error('limited'))
    expect(inventory(f.path)).toEqual({ requests: 1, contracts: 1, bytes })
    const damaged = new DatabaseSync(f.path)
    damaged.exec('UPDATE root_contracts SET bytes=-1')
    damaged.close()
    await expect(
      other.retainCoordinated(
        signed(coordinatedRequest('third_coordinated_request')),
        requester,
        selection,
        contracts,
        coordinationGuard()
      )
    ).rejects.toMatchObject(error('limited'))
    expect(inventory(f.path)).toEqual({ requests: 1, contracts: 1, bytes: -1 })
  } finally {
    await f.cleanup()
  }
})

it('rolls back request insertion if contract retention cannot commit', async () => {
  const f = await coordinatedFixture()
  try {
    const db = new DatabaseSync(f.path)
    db.exec(
      "CREATE TRIGGER fixture_contract_failure BEFORE INSERT ON root_contracts BEGIN SELECT RAISE(ABORT,'fixture-storage-failure'); END"
    )
    db.close()
    const body = coordinatedRequest(),
      selection = contractSelection()
    await expect(
      f.store.retainCoordinated(
        signed(body),
        requester,
        selection,
        f.contracts,
        coordinationGuard()
      )
    ).rejects.toThrow('fixture-storage-failure')
    expect(inventory(f.path)).toMatchObject({ requests: 0, contracts: 0 })
    expect(await f.store.get(requester, body.requestId)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it('never invents an original selection for legacy raw requests', async () => {
  const f = await coordinatedFixture()
  try {
    const body = coordinatedRequest(),
      selection = contractSelection()
    const raw = await f.store.retain(signed(body), requester, clock)
    await expect(
      f.store.retainCoordinated(
        signed(body),
        requester,
        selection,
        f.contracts,
        coordinationGuard()
      )
    ).rejects.toMatchObject(error('unavailable'))
    await expect(
      f.store.resultCoordinated(
        requester,
        body.requestId,
        selection.selector,
        f.contracts,
        coordinationGuard()
      )
    ).rejects.toMatchObject(error('unavailable'))
    expect(await f.store.get(requester, body.requestId)).toEqual(raw)
    expect(inventory(f.path)).toMatchObject({ requests: 1, contracts: 0 })
  } finally {
    await f.cleanup()
  }
})

it('detects absent, noncanonical, mismatched or oversized original capability records', async () => {
  for (const corruption of ['missing', 'bytes', 'selector', 'record', 'oversized'] as const) {
    const f = await coordinatedFixture()
    try {
      const body = coordinatedRequest(),
        selection = contractSelection()
      await f.store.retainCoordinated(
        signed(body),
        requester,
        selection,
        f.contracts,
        coordinationGuard()
      )
      const db = new DatabaseSync(f.path)
      if (corruption === 'missing') db.exec('DELETE FROM root_contracts')
      if (corruption === 'bytes') db.exec('UPDATE root_contracts SET bytes=bytes+1')
      if (corruption === 'selector')
        db.prepare('UPDATE root_contracts SET selector=?').run('ff'.repeat(32))
      if (corruption === 'record')
        db.exec("UPDATE root_contracts SET record=record||' ',bytes=bytes+1")
      if (corruption === 'oversized')
        db.prepare('UPDATE root_contracts SET record=?,bytes=?').run(' '.repeat(524289), 524289)
      db.close()
      await expect(
        f.store.resultCoordinated(
          requester,
          body.requestId,
          selection.selector,
          f.contracts,
          coordinationGuard()
        )
      ).rejects.toMatchObject(error(corruption === 'selector' ? 'context-changed' : 'unavailable'))
    } finally {
      await f.cleanup()
    }
  }
})

it('requires explicitly configured original-contract storage without adopting a legacy raw request', async () => {
  const f = await coordinatedFixture({ coordination: undefined })
  try {
    const body = coordinatedRequest(),
      selection = contractSelection()
    await expect(
      f.store.retainCoordinated(
        signed(body),
        requester,
        selection,
        f.contracts,
        coordinationGuard()
      )
    ).rejects.toMatchObject(error('unavailable'))
    expect(await f.store.get(requester, body.requestId)).toBeUndefined()
    const raw = await f.store.retain(signed(body), requester, clock)
    await expect(
      f.store.resultCoordinated(
        requester,
        body.requestId,
        selection.selector,
        f.contracts,
        coordinationGuard()
      )
    ).rejects.toMatchObject(error('unavailable'))
    expect(await f.store.get(requester, body.requestId)).toEqual(raw)
  } finally {
    await f.cleanup()
  }
})

it('accepts the exact narrower target, request-byte and lifetime boundaries', async () => {
  const f = await coordinatedFixture()
  try {
    const body = coordinatedRequest(),
      packet = signed(body),
      manifest = rootContractManifest()
    const profile = manifest.services[0].profiles[0]
    profile.parameters.maxTargets = 1
    profile.parameters.maxLifetimeSeconds = '100'
    profile.maxRequestBytes = Buffer.byteLength(canonicalOutputJSON(packet))
    profile.maxResponseBytes = 20000
    const cap = rootContractPacket(manifest)
    const retained = await f.store.retainCoordinated(
      packet,
      requester,
      { manifest: cap.packet, selector: cap.selector, futureClockSeconds: '5' },
      f.contracts,
      coordinationGuard()
    )
    expect(retained.value.request).toEqual(packet)
    expect(retained.value.contract.limits).toEqual({
      maximumTargets: 1,
      maximumLifetimeSeconds: '100',
      maximumRequestBytes: profile.maxRequestBytes,
      maximumResponseBytes: 20000
    })
    const result = await f.store.resultCoordinated(
      requester,
      body.requestId,
      cap.selector,
      f.contracts,
      coordinationGuard()
    )
    expect(result.value.result.outcomes).toHaveLength(1)
    expect(result.value.result.outcomes[0].actionStatus).toBe('pending')
  } finally {
    await f.cleanup()
  }
})
