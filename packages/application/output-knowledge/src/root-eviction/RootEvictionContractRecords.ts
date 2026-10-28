import {
  canonicalOutputJSON,
  outputAssert,
  outputHex32,
  outputPacketDigest,
  parseOutputJSON,
  parseOutputRootEvictionRequest,
  verifyOutputRootEvictionRequest
} from '@bsv/sdk'
import { rootBytes } from './RootEvictionCodec.js'
import type {
  RootEvictionContracts,
  RootEvictionSelectedContract
} from './RootEvictionContracts.js'
import type { RootEvictionCoordinatedRequest } from './RootEvictionCoordinatedStorage.js'
import type { RootEvictionRetainedRequest } from './RootEvictionStorage.js'
import type { RootEvictionRequests } from './RootEvictionRequests.js'
import type { SQLiteRootEvictionDatabase } from './SQLiteRootEvictionDatabase.js'

/** Internal original-contract records. Every call holds the shared root transaction. */
export class RootEvictionContractRecords {
  constructor(
    private readonly database: SQLiteRootEvictionDatabase,
    private readonly requests: RootEvictionRequests
  ) {}

  private configured(): number {
    const capacity = this.database.configuration.coordination
    outputAssert(capacity, 'Root journal has no original-contract storage', 'unavailable')
    return capacity.contractBytes
  }
  private bound(contract: RootEvictionSelectedContract): void {
    const { root, chain } = this.database.configuration
    const manifest = contract.selection.manifest.body
    outputAssert(
      manifest.identity === root &&
        canonicalOutputJSON(manifest.chain) === canonicalOutputJSON(chain),
      'Root capability differs from this journal',
      'context-changed'
    )
  }
  restore(
    retained: RootEvictionRetainedRequest,
    selector: string,
    contracts: RootEvictionContracts
  ): RootEvictionCoordinatedRequest {
    this.configured()
    const row = this.database.get(
      `SELECT selector,bytes,
       CASE WHEN length(CAST(record AS BLOB))<=524288 THEN record END AS record
       FROM root_contracts WHERE request_digest=?`,
      retained.digest
    )
    outputAssert(row, 'Original root capability is unavailable', 'unavailable')
    outputAssert(
      row.selector === outputHex32(selector),
      'Use the retained root capability selector',
      'context-changed'
    )
    outputAssert(
      typeof row.record === 'string',
      'Retained root capability exceeds its bound',
      'unavailable'
    )
    const record = parseOutputJSON(row.record, { bytes: 524288 })
    outputAssert(
      canonicalOutputJSON(record, { bytes: 524288 }) === row.record &&
        rootBytes(row.record) === row.bytes,
      'Retained root capability accounting failed',
      'unavailable'
    )
    const contract = contracts.restore(record, selector)
    this.bound(contract)
    return { ...retained, contract }
  }

  /** Resolve local saved selection only; never ask current discovery to fill a gap. */
  recover(
    retained: RootEvictionRetainedRequest,
    contracts: RootEvictionContracts
  ): RootEvictionCoordinatedRequest {
    this.configured()
    const row = this.database.get(
      'SELECT selector FROM root_contracts WHERE request_digest=?',
      retained.digest
    )
    outputAssert(row, 'Original root capability is unavailable', 'unavailable')
    return this.restore(retained, outputHex32(row.selector), contracts)
  }

  private requestBytes(
    input: unknown,
    packet: unknown,
    contract: RootEvictionSelectedContract
  ): void {
    canonicalOutputJSON(packet, { bytes: contract.limits.maximumRequestBytes })
    // Only actual transport text can carry this fact; an object field cannot
    // assert its own received length. Check before retaining any new operation.
    if (typeof input === 'string')
      outputAssert(
        rootBytes(input) <= contract.limits.maximumRequestBytes,
        'Root request exceeds the selected received-byte limit',
        'limited'
      )
  }

  retain(
    input: unknown,
    requester: string,
    selection: { manifest: unknown; selector: string; futureClockSeconds: string },
    contracts: RootEvictionContracts,
    now: string
  ): RootEvictionCoordinatedRequest {
    const capacity = this.configured()
    const packet = parseOutputRootEvictionRequest(
      typeof input === 'string' ? parseOutputJSON(input, { bytes: 1048576 }) : input
    )
    verifyOutputRootEvictionRequest(packet, {
      root: packet.body.recipient,
      chain: packet.body.chain,
      requester
    })
    const previous = this.requests.get(requester, packet.body.requestId)
    if (previous) {
      outputAssert(
        previous.digest === outputPacketDigest('root-eviction-request', packet.body),
        'Root request ID conflicts with its retained body',
        'conflict'
      )
      const retained = this.restore(previous, selection.selector, contracts)
      this.requestBytes(input, packet, retained.contract)
      return retained
    }
    const { record, ...contract } = contracts.retain(selection.manifest, selection.selector, now)
    this.bound(contract)
    outputAssert(
      packet.body.targets.length <= contract.limits.maximumTargets,
      'Root request exceeds the selected target limit',
      'limited'
    )
    this.requestBytes(input, packet, contract)
    const text = canonicalOutputJSON(record, { bytes: 524288 })
    const bytes = rootBytes(text)
    const retainedBytes = this.database.get(
      'SELECT coalesce(sum(bytes),0) AS bytes FROM root_contracts'
    )!.bytes
    outputAssert(
      Number.isSafeInteger(retainedBytes) &&
        Number(retainedBytes) >= 0 &&
        Number(retainedBytes) + bytes <= capacity,
      'Root original-contract capacity is full',
      'limited'
    )
    const retained = this.requests.retain(
      packet,
      requester,
      {
        now,
        maximumLifetimeSeconds: contract.limits.maximumLifetimeSeconds,
        futureClockSeconds: selection.futureClockSeconds
      },
      contract.limits.maximumResponseBytes
    )
    this.database.run(
      'INSERT INTO root_contracts VALUES (?,?,?,?)',
      retained.digest,
      selection.selector,
      text,
      bytes
    )
    return { ...retained, contract }
  }
}
