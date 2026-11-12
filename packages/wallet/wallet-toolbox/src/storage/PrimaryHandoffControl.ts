import type { AuthId } from '../sdk/WalletStorage.interfaces'

/** Comparison/control metadata only. These values never carry a SQL writer,
 * source actor, primary grant or financial acknowledgement across a wire. */
export interface PrimaryHandoffSource {
  storageIdentityKey: string
  epoch: string
}
export interface PrimaryHandoffPlan {
  version: 1
  operationId: string
  targetStorageIdentityKey: string
  sources: readonly PrimaryHandoffSource[]
}
export interface PrimaryHandoffStatus {
  version: 1
  operationId: string
  localStorageIdentityKey: string
  targetStorageIdentityKey: string
  side: 'source' | 'target' | 'backup'
  phase: 'prepared' | 'retired' | 'activated' | 'complete' | 'cancelled'
  localEpoch: string
  sourceEpoch?: string
  plan?: PrimaryHandoffPlan
}
/** Local cancellation CODE, never serialized as permission or plan DATA. */
export interface PrimaryHandoffControlOptions {
  signal?: AbortSignal
}

/** Authenticated durable control. Activation independently verifies actual
 * final financial receipts inside its own physical destination writer. No
 * supplied plan/status grants a writer or constitutes a financial ACK. */
export interface PrimaryHandoffControl {
  status: (auth: AuthId) => Promise<PrimaryHandoffStatus | undefined>
  prepareSource: (auth: AuthId, operationId: string, targetStorageIdentityKey: string) => Promise<PrimaryHandoffSource>
  prepareTarget: (auth: AuthId, plan: PrimaryHandoffPlan) => Promise<PrimaryHandoffStatus>
  retireSource: (auth: AuthId, plan: PrimaryHandoffPlan) => Promise<PrimaryHandoffStatus>
  activateTarget: (auth: AuthId, plan: PrimaryHandoffPlan) => Promise<PrimaryHandoffStatus>
  /** Permits target-to-backup DATA only; never reactivates the retired source. */
  completeSource: (auth: AuthId, plan: PrimaryHandoffPlan) => Promise<PrimaryHandoffStatus>
  completeTarget: (auth: AuthId, plan: PrimaryHandoffPlan) => Promise<PrimaryHandoffStatus>
  /** Explicit selection propagation to an already inactive backup. It may
   * never retire an unaccounted writable root or activate a local primary. */
  followTarget: (auth: AuthId, plan: PrimaryHandoffPlan) => Promise<PrimaryHandoffStatus>
  /** Only prepared intents may cancel. A parked target stays inactive. */
  cancel: (auth: AuthId, operationId: string) => Promise<PrimaryHandoffStatus>
}
