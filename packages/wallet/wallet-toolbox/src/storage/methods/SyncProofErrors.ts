import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'

/** Portable shared error identity. A stale root needs current-chain
 * reconciliation; this exception does not grant replacement authority. */
export class StaleSyncProofError extends WERR_INVALID_PARAMETER {
  constructor() {
    super('provenTx', 'a server-verified proof. Merkle root is not active at the recorded height')
  }
}
