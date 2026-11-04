import { expect, it } from '@jest/globals'
import { DatabaseSync } from 'node:sqlite'
import { canonicalOutputJSON } from '@bsv/sdk'
import { RootEvictionContracts } from '../src/root-eviction/RootEvictionContracts.js'
import { rootContractTrust } from './root-contract-fixture.js'
import {
  coordinatedFixture,
  coordinatedRequest,
  contractSelection,
  coordinationGuard
} from './root-eviction-coordination-fixture.js'
import { requester, signed } from './root-eviction-fixture.js'

it('opens a coordinated journal at its exact retained contract count and byte capacities', async () => {
  const selection = contractSelection(),
    contracts = new RootEvictionContracts(rootContractTrust())
  const text = canonicalOutputJSON(
    contracts.retain(selection.manifest, selection.selector, '150').record
  )
  const f = await coordinatedFixture({
    capacity: { requests: 1 },
    coordination: { contractBytes: Buffer.byteLength(text) }
  })
  try {
    const body = coordinatedRequest()
    const retained = await f.store.retainCoordinated(
      signed(body),
      requester,
      selection,
      contracts,
      coordinationGuard()
    )
    const recovered = await f
      .reopen()
      .recoverCoordinated(retained.value.digest, contracts, coordinationGuard())
    expect(recovered.value.retained).toEqual(retained.value)
    expect(recovered.value.result.outcomes[0].actionStatus).toBe('pending')
  } finally {
    await f.cleanup()
  }
})

it.each([
  'aggregate-over-capacity',
  'negative-bytes',
  'inconsistent-row-bytes',
  'wrong-selector-width'
] as const)('refuses a damaged retained contract inventory on reopen: %s', async fault => {
  const selection = contractSelection(),
    contracts = new RootEvictionContracts(rootContractTrust())
  const text = canonicalOutputJSON(
    contracts.retain(selection.manifest, selection.selector, '150').record
  )
  const length = Buffer.byteLength(text)
  const f = await coordinatedFixture({ coordination: { contractBytes: length } })
  try {
    const retained = await f.store.retainCoordinated(
      signed(coordinatedRequest()),
      requester,
      selection,
      contracts,
      coordinationGuard()
    )
    const db = new DatabaseSync(f.path)
    try {
      if (fault === 'aggregate-over-capacity')
        db.prepare('UPDATE root_contracts SET record=?, bytes=?').run(text + ' ', length + 1)
      else if (fault === 'negative-bytes') db.exec('UPDATE root_contracts SET bytes=-1')
      else if (fault === 'inconsistent-row-bytes')
        db.prepare('UPDATE root_contracts SET bytes=?').run(length - 1)
      else db.exec("UPDATE root_contracts SET selector='abc'")
    } finally {
      db.close()
    }
    const capacity = fault === 'aggregate-over-capacity' || fault === 'negative-bytes'
    expect(() => f.reopen()).toThrow(
      expect.objectContaining({
        code: 'unavailable',
        message: capacity
          ? 'Root original-contract capacity failed'
          : 'Root original-contract accounting failed'
      })
    )
    // Recovery is rejected, not repaired by discarding the retained operation.
    const inspection = new DatabaseSync(f.path)
    try {
      expect(inspection.prepare('SELECT digest FROM root_requests').get()!.digest).toBe(
        retained.value.digest
      )
    } finally {
      inspection.close()
    }
  } finally {
    await f.cleanup()
  }
})
