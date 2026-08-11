import { AuthId } from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER, WERR_UTXO_REVIEW_INCONCLUSIVE } from '../../sdk/WERR_errors'
import {
  classifyOutputUtxo,
  mapWithConcurrency,
  type OutputUtxoClassification,
  UTXO_PROVIDER_MAX_CONCURRENCY
} from '../../services/classifyOutputUtxo'
import { verifyId } from '../../utility/utilityHelpers'
import { StorageProvider } from '../StorageProvider'
import { TableOutput } from '../schema/tables/TableOutput'

const MAX_AUDIT_PROVIDERS = 8
const MAX_PROVIDER_NAME_LENGTH = 128
export const UTXO_REVIEW_PROVIDER_TIMEOUT_MSECS = 5_000

export type UtxoReviewReleaseMode = 'none' | 'atomic' | 'conclusive'

export interface UtxoReviewClassification {
  output: TableOutput
  status: OutputUtxoClassification
}

export interface UtxoReviewDiagnostics {
  checked: number
  confirmedUnspent: number
  confirmedSpent: number
  unknown: number
  confirmedSpentSatoshis: number
  released: number
  releasedSatoshis: number
  providers: string[]
  providerCount: number
  providersTruncated: boolean
}

export interface ReviewUtxoOutputsResult {
  classifications: UtxoReviewClassification[]
  confirmedSpentOutputs: TableOutput[]
  unknownOutputs: TableOutput[]
  diagnostics: UtxoReviewDiagnostics
}

function diagnosticsFor(
  classifications: UtxoReviewClassification[],
  releasedOutputIds: Set<number>
): UtxoReviewDiagnostics {
  const allProviders = [
    ...new Set(classifications.map(result => result.status.provider.slice(0, MAX_PROVIDER_NAME_LENGTH)))
  ]
  const providers = allProviders.slice(0, MAX_AUDIT_PROVIDERS)
  const confirmedSpent = classifications.filter(result => result.status.verdict === 'spent')
  const released = confirmedSpent.filter(result => releasedOutputIds.has(result.output.outputId))
  return {
    checked: classifications.length,
    confirmedUnspent: classifications.filter(result => result.status.verdict === 'unspent').length,
    confirmedSpent: confirmedSpent.length,
    unknown: classifications.filter(result => result.status.verdict === 'unknown').length,
    confirmedSpentSatoshis: confirmedSpent.reduce((sum, result) => sum + result.output.satoshis, 0),
    released: released.length,
    releasedSatoshis: released.reduce((sum, result) => sum + result.output.satoshis, 0),
    providers,
    providerCount: allProviders.length,
    providersTruncated: allProviders.length > providers.length
  }
}

function auditDetails(
  diagnostics: UtxoReviewDiagnostics,
  userId: number | undefined,
  releaseMode: Exclude<UtxoReviewReleaseMode, 'none'>,
  reason: 'inconclusive-provider-result' | 'provider-confirmed-spent'
): string {
  return JSON.stringify({
    operation: 'specOpInvalidChange',
    reason,
    releaseMode,
    userId,
    ...diagnostics
  })
}

async function classifyCandidates(
  storage: StorageProvider,
  outputs: TableOutput[]
): Promise<UtxoReviewClassification[]> {
  const services = storage.getServices()
  const candidates = outputs.filter(output => output.basketId != null)
  return await mapWithConcurrency(candidates, UTXO_PROVIDER_MAX_CONCURRENCY, async output => {
    try {
      await storage.validateOutputScript(output)
    } catch (error: unknown) {
      return {
        output,
        status: {
          verdict: 'unknown' as const,
          provider: '<script-validation-error>',
          error
        }
      }
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    const providerCall = classifyOutputUtxo(services, output)
    const timedClassification = new Promise<OutputUtxoClassification>(resolve => {
      timeout = setTimeout(
        () =>
          resolve({
            verdict: 'unknown',
            provider: '<review-timeout>',
            error: new Error(`UTXO classification exceeded ${UTXO_REVIEW_PROVIDER_TIMEOUT_MSECS}ms`)
          }),
        UTXO_REVIEW_PROVIDER_TIMEOUT_MSECS
      )
    })
    try {
      return {
        output,
        status: await Promise.race([providerCall, timedClassification])
      }
    } finally {
      if (timeout != null) clearTimeout(timeout)
      void providerCall.catch(() => undefined)
    }
  })
}

async function releaseConfirmedSpent(
  storage: StorageProvider,
  auth: AuthId,
  classifications: UtxoReviewClassification[],
  releaseMode: Exclude<UtxoReviewReleaseMode, 'none'>
): Promise<Set<number>> {
  const confirmedSpent = classifications.filter(result => result.status.verdict === 'spent')
  const releasedOutputIds = new Set<number>()
  await storage.transaction(async trx => {
    for (const { output } of confirmedSpent) {
      const current = await storage.findOutputById(output.outputId, trx, true)
      if (current == null || current.userId !== auth.userId) {
        throw new WERR_INVALID_PARAMETER('outputId', `owned by user ${auth.userId}`)
      }
      if (current.spendable !== true || current.spentBy != null) {
        throw new WERR_INVALID_OPERATION(
          `Output ${output.outputId} changed state during UTXO review; no outputs were changed.`
        )
      }
      const updated = await storage.updateOutput(verifyId(output.outputId), { spendable: false }, trx)
      if (updated !== 1) {
        throw new WERR_INVALID_PARAMETER('outputId', `updated exactly once: ${output.outputId}`)
      }
      releasedOutputIds.add(output.outputId)
    }
    const now = new Date()
    const diagnostics = diagnosticsFor(classifications, releasedOutputIds)
    await storage.insertMonitorEvent(
      {
        created_at: now,
        updated_at: now,
        id: 0,
        event: releaseMode === 'atomic' ? 'InvalidChangeRelease' : 'InvalidChangeConclusiveRelease',
        details: auditDetails(diagnostics, auth.userId, releaseMode, 'provider-confirmed-spent')
      },
      trx
    )
  })
  return releasedOutputIds
}

/**
 * Classify a bounded set of wallet outputs without treating provider failure as
 * proof that an output was spent. Read-only reviews always return their
 * conclusive and unknown partitions. Atomic release requires every verdict to
 * be conclusive; the operator-only conclusive mode releases the positively
 * spent subset while retaining and reporting unknowns.
 */
export async function reviewUtxoOutputs(
  storage: StorageProvider,
  auth: AuthId,
  outputs: TableOutput[],
  releaseMode: UtxoReviewReleaseMode = 'none'
): Promise<ReviewUtxoOutputsResult> {
  const classifications = await classifyCandidates(storage, outputs)
  const confirmedSpentOutputs = classifications
    .filter(result => result.status.verdict === 'spent')
    .map(result => result.output)
  const unknownOutputs = classifications
    .filter(result => result.status.verdict === 'unknown')
    .map(result => result.output)

  if (releaseMode === 'atomic' && unknownOutputs.length > 0) {
    const diagnostics = diagnosticsFor(classifications, new Set())
    const now = new Date()
    await storage.insertMonitorEvent({
      created_at: now,
      updated_at: now,
      id: 0,
      event: 'InvalidChangeReleaseBlocked',
      details: auditDetails(diagnostics, auth.userId, releaseMode, 'inconclusive-provider-result')
    })
    throw new WERR_UTXO_REVIEW_INCONCLUSIVE(diagnostics.checked, diagnostics.confirmedSpent, diagnostics.unknown)
  }

  const releasedOutputIds =
    releaseMode === 'none'
      ? new Set<number>()
      : await releaseConfirmedSpent(storage, auth, classifications, releaseMode)
  for (const output of confirmedSpentOutputs) {
    if (releasedOutputIds.has(output.outputId)) output.spendable = false
  }

  return {
    classifications,
    confirmedSpentOutputs,
    unknownOutputs,
    diagnostics: diagnosticsFor(classifications, releasedOutputIds)
  }
}
