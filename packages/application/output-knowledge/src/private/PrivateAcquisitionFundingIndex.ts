import {
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputHex32,
  outputPacketDigest,
  outputU32,
  parseOutputChain,
  type OutputJSONObject,
  type OutputWalletFundingOperation
} from '@bsv/sdk'
import type { PrivateServiceDomain } from './PrivateServiceDomain.js'
import type {
  ProtectedLedgerChange,
  ProtectedLedgerGuard,
  ProtectedLedgerRecord
} from './ProtectedLedgerCodec.js'
import {
  parsePrivateAcquisitionProgress,
  type PrivateAcquisitionProgress
} from './PrivateAcquisitionProgress.js'

const SLOT_BYTES = 8192
interface FundingSlot {
  format: 'private-acquisition-funding-slot/1'
  acquisitionId: string
  requestDigest: string
  assignment: { operationId: string; funding: OutputWalletFundingOperation['funding'] } | null
}

/**
 * Native bounded seller/chain-wide funding uniqueness. Each quote reserves its
 * permanent slot before promising service. Assignment never needs another slot.
 * The bounded scan must share one revision with the atomic owner commit. A
 * competing commit invalidates it; no process mutex or cached absence suffices.
 * All acquisition services for this seller/chain must share this physical domain.
 */
export class PrivateAcquisitionFundingIndex {
  constructor(private readonly domain: PrivateServiceDomain) {}

  private address(acquisitionId: string) {
    return this.domain.identity.address('funding-fence', {
      purpose: 'private-acquisition-funding-slot',
      acquisitionId: outputHex32(acquisitionId)
    })
  }

  private state(input: PrivateAcquisitionProgress) {
    const state = parsePrivateAcquisitionProgress(input)
    outputAssert(
      state.challenge.seller === this.domain.scope.seller &&
        canonicalOutputJSON(state.chain) === canonicalOutputJSON(this.domain.scope.chain),
      'Acquisition funding namespace differs',
      'context-changed'
    )
    return state
  }

  /** Include this change in the same atomic quote/material/prefix reservation. */
  reserveQuote(input: PrivateAcquisitionProgress): ProtectedLedgerChange {
    const state = this.state(input)
    outputAssert(
      state.phase === 'quoted' && state.candidate === null,
      'Funding capacity must be reserved before issuing a quote'
    )
    return {
      ...this.address(state.challenge.acquisitionId),
      expectedRevision: null,
      reservedBytes: SLOT_BYTES,
      reservedUpdates: 1,
      value: {
        format: 'private-acquisition-funding-slot/1',
        acquisitionId: state.challenge.acquisitionId,
        requestDigest: state.challenge.requestDigest,
        assignment: null
      }
    }
  }

  private parse(row: ProtectedLedgerRecord): FundingSlot {
    const value = row.value
    closedOutputObject(value, ['format', 'acquisitionId', 'requestDigest', 'assignment'])
    outputAssert(
      value.format === 'private-acquisition-funding-slot/1',
      'Unknown retained funding fence cannot establish uniqueness',
      'unavailable'
    )
    const acquisitionId = outputHex32(value.acquisitionId),
      requestDigest = outputHex32(value.requestDigest)
    const address = this.address(acquisitionId)
    outputAssert(
      row.kind === address.kind && row.key === address.key && row.reservedBytes === SLOT_BYTES,
      'Retained funding fence binding differs',
      'unavailable'
    )
    outputAssert(
      row.reservedUpdates === (value.assignment === null ? 1 : 0),
      'Funding slot completion capacity differs',
      'unavailable'
    )
    const result: FundingSlot = {
      format: value.format,
      acquisitionId,
      requestDigest,
      assignment: null
    }
    if (value.assignment !== null) {
      closedOutputObject(value.assignment, ['operationId', 'funding'])
      closedOutputObject(value.assignment.funding, ['chain', 'txid', 'outputIndex'])
      const funding = {
        chain: parseOutputChain(value.assignment.funding.chain),
        txid: outputHex32(value.assignment.funding.txid),
        outputIndex: outputU32(value.assignment.funding.outputIndex)
      }
      outputAssert(
        canonicalOutputJSON(funding.chain) === canonicalOutputJSON(this.domain.scope.chain) &&
          value.assignment.operationId ===
            outputPacketDigest('wallet-funding', {
              seller: this.domain.scope.seller,
              acquisitionId,
              funding
            }),
        'Retained funding assignment differs',
        'unavailable'
      )
      result.assignment = { operationId: outputHex32(value.assignment.operationId), funding }
    }
    return result
  }

  /**
   * The owner commits this change plus the exact funding-pending state/operation
   * using expectedRevision. Recheck current authority in that atomic commit.
   * Null means this same slot already holds the exact assignment, never absence.
   */
  assign(
    input: PrivateAcquisitionProgress,
    expectedRevision: string,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): ProtectedLedgerChange | null {
    const state = this.state(input)
    outputAssert(
      state.phase === 'funding-pending' && state.funding !== null,
      'Funding assignment requires a verified reserved operation'
    )
    const operation = state.funding.operation
    let after: string | null = null,
      count = 0,
      own: { row: ProtectedLedgerRecord; slot: FundingSlot } | undefined
    do {
      const page = this.domain.ledger.enumerate('funding-fence', after, 64, clock, guard)
      outputAssert(
        page.revision === expectedRevision,
        'Funding namespace changed during scan',
        'conflict'
      )
      count += page.entries.length
      outputAssert(count <= 4096, 'Funding namespace exceeds native domain capacity', 'limited')
      if (page.entries.length) {
        const retained = this.domain.ledger.read(
          page.entries.map(({ kind, key }) => ({ kind, key })),
          clock,
          guard
        )
        outputAssert(
          retained.revision === expectedRevision,
          'Funding namespace changed during read',
          'conflict'
        )
        for (const row of retained.records) {
          outputAssert(row !== undefined, 'Reserved funding slot is unavailable', 'unavailable')
          const slot = this.parse(row)
          if (slot.acquisitionId === state.challenge.acquisitionId) {
            outputAssert(
              own === undefined && slot.requestDigest === state.challenge.requestDigest,
              'Acquisition funding slot changed request',
              'unavailable'
            )
            own = { row, slot }
          } else {
            outputAssert(
              slot.assignment === null ||
                canonicalOutputJSON(slot.assignment.funding) !==
                  canonicalOutputJSON(operation.funding),
              'Funding output already belongs to another acquisition',
              'conflict'
            )
          }
        }
      }
      after = page.next
    } while (after !== null)
    outputAssert(own !== undefined, 'Acquisition funding capacity was not reserved', 'unavailable')
    const assignment = { operationId: operation.id, funding: operation.funding }
    if (own.slot.assignment !== null) {
      outputAssert(
        canonicalOutputJSON(own.slot.assignment) === canonicalOutputJSON(assignment),
        'Acquisition already reserved different funding',
        'conflict'
      )
      return null
    }
    return {
      kind: own.row.kind,
      key: own.row.key,
      expectedRevision: own.row.revision,
      reservedBytes: SLOT_BYTES,
      reservedUpdates: Math.max(0, own.row.reservedUpdates - 1),
      value: { ...own.slot, assignment } as unknown as OutputJSONObject
    }
  }
}
