/** Private wallet capability material. Store durably; never send to telemetry. */
export interface PendingUMPUpdate {
  version: 1
  operationId: string
  rootIdentityKey: string
  previousSnapshot: number[]
  proposedToken: number[]
  activeProfileId: number[]
  stage: 'prepared' | 'submitting' | 'signed' | 'published'
  transaction?: number[]
  outpoint?: string
}

/** Optional, awaited host persistence. Existing callers retain their storage contract. */
export interface WalletStatePersistence {
  saveSnapshot(snapshot: number[]): Promise<void>
  savePendingUpdate(checkpoint: PendingUMPUpdate | null): Promise<void>
}

export interface UMPActionCheckpoint {
  operationId: string
  onStarting?(): Promise<void>
  onCompleted(transaction: number[], outpoint: string): Promise<void>
}

/** A local failure can follow a successful financial update. Reconcile before retrying. */
export class WalletStateTransitionError extends Error {
  readonly code = 'WERR_WALLET_STATE_PENDING'
  constructor(
    readonly stage: PendingUMPUpdate['stage'] | 'persistence',
    cause: unknown
  ) {
    super(
      stage === 'persistence'
        ? 'The wallet changed, but its device state still needs to be saved. Retry saving before closing the wallet.'
        : 'The wallet update needs reconciliation before another update can start.',
      { cause }
    )
    this.name = 'WalletStateTransitionError'
  }
}

export function validatePendingUMPUpdate(value: unknown): asserts value is PendingUMPUpdate {
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid pending wallet update.')
  const item = value as Partial<PendingUMPUpdate>
  const bytes = (input: unknown, limit: number): input is number[] =>
    Array.isArray(input) &&
    input.length > 0 &&
    input.length <= limit &&
    input.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  if (
    item.version !== 1 ||
    typeof item.operationId !== 'string' ||
    !/^[0-9a-f]{32}$/.test(item.operationId) ||
    typeof item.rootIdentityKey !== 'string' ||
    !/^(02|03)[0-9a-f]{64}$/.test(item.rootIdentityKey) ||
    !bytes(item.previousSnapshot, 16 * 1024 * 1024) ||
    !bytes(item.proposedToken, 16 * 1024 * 1024) ||
    !bytes(item.activeProfileId, 16) ||
    item.activeProfileId.length !== 16 ||
    !['prepared', 'submitting', 'signed', 'published'].includes(item.stage ?? '') ||
    ((item.stage === 'signed' || item.stage === 'published') &&
      (!bytes(item.transaction, 16 * 1024 * 1024) ||
        typeof item.outpoint !== 'string' ||
        !/^[0-9a-f]{64}\.(0|[1-9][0-9]*)$/.test(item.outpoint))) ||
    ((item.stage === 'prepared' || item.stage === 'submitting') &&
      (item.transaction !== undefined || item.outpoint !== undefined))
  ) {
    throw new Error('Invalid pending wallet update.')
  }
}

/** A verified account update removed the selected profile. Hosts must ask for an explicit selection. */
export class WalletProfileUnavailableError extends Error {
  readonly code = 'WERR_WALLET_PROFILE_UNAVAILABLE'
  constructor() {
    super('The selected wallet profile is absent from the current account. Choose a profile explicitly.')
    this.name = 'WalletProfileUnavailableError'
  }
}
