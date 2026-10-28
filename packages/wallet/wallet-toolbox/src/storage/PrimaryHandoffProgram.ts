import type { AuthId } from '../sdk/WalletStorage.interfaces'
import type { PrimaryHandoffControl, PrimaryHandoffPlan, PrimaryHandoffStatus } from './PrimaryHandoffControl'
import { canonicalPrimaryHandoffPlan } from './PrimaryHandoffPlan'
import { WERR_INVALID_OPERATION } from '../sdk/WERR_errors'
export interface PrimaryHandoffParticipant {
  readonly storageIdentityKey: string
  readonly activeStorage: string
  readonly auth: AuthId
  readonly control: PrimaryHandoffControl
}
export interface PrimaryHandoffProgram {
  readonly participants: readonly PrimaryHandoffParticipant[]
  readonly targetStorageIdentityKey: string
  readonly newOperationId: () => string
  /** Queue/lifecycle scheduling only; this supplies no SQL or financial grant. */
  readonly arm: (plan: PrimaryHandoffPlan) => Promise<void>
  /** Actual provider-owned copy, including physical cleanup before return. The
   * target activation independently checks its real completed database ACKs. */
  readonly copy: (source: PrimaryHandoffParticipant, target: PrimaryHandoffParticipant) => Promise<void>
}
function invalid(message = 'Pending primary handoff needs forward recovery with the same managed participants'): never {
  throw new WERR_INVALID_OPERATION(message)
}
function pending(value: PrimaryHandoffStatus | undefined): boolean {
  return value !== undefined && ['prepared', 'retired', 'activated'].includes(value.phase)
}
/** Orchestrates AUTHENTICATED provider controls and actual provider copies. No
 * serialized status/plan can construct a provider, source actor or database
 * permission. Lost replies recover from the real participant status methods;
 * an uncertain retirement is never reversed automatically. */
export async function runPrimaryHandoffProgram(input: PrimaryHandoffProgram): Promise<void> {
  const participants = [...input.participants].map(value => ({
    ...value,
    auth: { identityKey: value.auth.identityKey, userId: value.auth.userId }
  }))
  if (
    participants.length < 2 ||
    participants.length > 9 ||
    new Set(participants.map(value => value.storageIdentityKey)).size !== participants.length ||
    new Set(participants.map(value => value.auth.identityKey)).size !== 1
  )
    invalid()
  const target = participants.find(value => value.storageIdentityKey === input.targetStorageIdentityKey)
  if (target === undefined) invalid()
  const states = new Map<string, PrimaryHandoffStatus | undefined>()
  for (const participant of participants)
    states.set(participant.storageIdentityKey, await participant.control.status(participant.auth))
  const open = [...states.values()].filter((value): value is PrimaryHandoffStatus => pending(value))
  if (
    open.some(value => value.targetStorageIdentityKey !== target.storageIdentityKey) ||
    new Set(open.map(value => value.operationId)).size > 1
  )
    invalid()
  const savedPlans = open.flatMap(value => (value.plan === undefined ? [] : [value.plan]))
  if (new Set(savedPlans.map(value => JSON.stringify(value))).size > 1) invalid()
  let plan: PrimaryHandoffPlan
  if (savedPlans.length) plan = canonicalPrimaryHandoffPlan(savedPlans[0])
  else {
    const operationId = open[0]?.operationId ?? input.newOperationId()
    const candidates = participants.filter(
      value =>
        value !== target &&
        (value.activeStorage === value.storageIdentityKey || pending(states.get(value.storageIdentityKey)))
    )
    if (candidates.length === 0) invalid('No actual primary source is available to reconcile')
    const sources = []
    for (const source of candidates)
      sources.push(await source.control.prepareSource(source.auth, operationId, target.storageIdentityKey))
    plan = canonicalPrimaryHandoffPlan({
      version: 1,
      operationId,
      targetStorageIdentityKey: target.storageIdentityKey,
      sources
    })
  }
  const sources = plan.sources.map(value => {
    const participant = participants.find(candidate => candidate.storageIdentityKey === value.storageIdentityKey)
    if (participant === undefined) return invalid()
    return participant
  })
  // Prepare target before any source retirement. Parking it invalidates existing
  // target writers while preserving its own current wallet rows for the merge.
  const preparedTarget = await target.control.prepareTarget(target.auth, plan)
  // Reconcile the large body while genuine source wallet writes may continue.
  // Retirement then leaves only the bounded final delta under the inactive
  // cutover. A warm copy never qualifies activation: its source epoch is older.
  if (preparedTarget.phase === 'prepared') for (const source of sources) await input.copy(source, target)
  await input.arm(plan)
  const current = await target.control.status(target.auth)
  if (current === undefined || current.operationId !== plan.operationId) invalid()
  if (current.phase !== 'activated' && current.phase !== 'complete') {
    if (current.phase !== 'prepared') invalid()
    for (const source of sources) await source.control.retireSource(source.auth, plan)
    for (const source of sources) await input.copy(source, target)
    await target.control.activateTarget(target.auth, plan)
  }
  // This only permits inactive backup DATA. No source is reactivated, and these
  // commands do not manufacture a financial acknowledgement of propagation.
  for (const source of sources) await source.control.completeSource(source.auth, plan)
  for (const backup of participants) {
    if (backup === target) continue
    if (!sources.includes(backup)) await backup.control.followTarget(backup.auth, plan)
    await input.copy(target, backup)
  }
  await target.control.completeTarget(target.auth, plan)
  for (const participant of participants) {
    const status = await participant.control.status(participant.auth)
    if (
      status === undefined ||
      status.operationId !== plan.operationId ||
      status.targetStorageIdentityKey !== target.storageIdentityKey ||
      status.phase !== 'complete'
    )
      invalid()
  }
}
