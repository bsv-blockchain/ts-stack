import { Utils } from '@bsv/sdk'
import type { WalletServices } from '../sdk/WalletServices.interfaces'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../sdk/WERR_errors'
import type { TableOutput } from '../storage/schema/tables/TableOutput'

export type OutputUtxoVerdict = 'unspent' | 'spent' | 'unknown'

export interface OutputUtxoClassification {
  verdict: OutputUtxoVerdict
  provider: string
  error?: unknown
}

type UtxoServices = Pick<WalletServices, 'getUtxoStatus' | 'hashOutputScript'>

export const UTXO_PROVIDER_MAX_CONCURRENCY = 4

export async function mapWithConcurrency<T, R>(
  values: T[],
  maxConcurrency: number,
  worker: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = Array.from<R>({ length: values.length })
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(maxConcurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++
      results[index] = await worker(values[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Classify an output without ever converting provider absence or failure into
 * positive spent evidence. This helper deliberately catches provider throws so
 * batch callers can finish classifying every candidate before deciding whether
 * a destructive operation is safe.
 */
export async function classifyOutputUtxo(
  services: UtxoServices,
  output: TableOutput
): Promise<OutputUtxoClassification> {
  if (output.lockingScript == null || output.lockingScript.length === 0) {
    return {
      verdict: 'unknown',
      provider: '<no-locking-script>',
      error: new WERR_INVALID_PARAMETER('output.lockingScript', 'validated by storage provider validateOutputScript.')
    }
  }
  if (
    typeof output.txid !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(output.txid) ||
    !Number.isSafeInteger(output.vout) ||
    output.vout < 0
  ) {
    return {
      verdict: 'unknown',
      provider: '<invalid-outpoint>',
      error: new WERR_INVALID_PARAMETER('output outpoint', 'a 32-byte transaction ID and non-negative vout')
    }
  }

  try {
    const hash = services.hashOutputScript(Utils.toHex(output.lockingScript))
    const result = await services.getUtxoStatus(hash, undefined, `${output.txid}.${output.vout}`)
    const provider = typeof result?.name === 'string' && result.name.length > 0
      ? result.name
      : '<invalid-provider-result>'
    if (
      result?.status !== 'success' ||
      typeof result.isUtxo !== 'boolean' ||
      provider === '<invalid-provider-result>'
    ) {
      return {
        verdict: 'unknown',
        provider,
        error: result?.error
      }
    }
    return {
      verdict: result.isUtxo ? 'unspent' : 'spent',
      provider
    }
  } catch (error: unknown) {
    return {
      verdict: 'unknown',
      provider: '<provider-error>',
      error
    }
  }
}

/**
 * Convert an internal tri-state classification to the historical boolean
 * contract only when a provider supplied a conclusive answer.
 */
export function requireConclusiveUtxo(classification: OutputUtxoClassification): boolean {
  if (classification.verdict === 'unspent') return true
  if (classification.verdict === 'spent') return false
  if (classification.error instanceof Error) throw classification.error
  throw new WERR_INVALID_OPERATION(`UTXO provider ${classification.provider} did not return a conclusive result.`)
}
