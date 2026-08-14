import { AdmittanceInstructions } from '@bsv/sdk'

export interface TopicAdmittanceContext {
  /** Validate protocol shape without creating provisional external state. */
  dryRun?: boolean
}

/**
 * Defines a Topic Manager interface that can be implemented for specific use-cases
 */
export interface TopicManager {
  /**
   * Returns instructions that denote which outputs from the provided transaction to admit into the topic, and which previous coins should be retained.
   * Accepts the transaction in BEEF format and an array of those input indices which spend previously-admitted outputs from the same topic.
   * The transaction's BEEF structure will always contain the transactions associated with previous coins for reference (if any), regardless of whether the current transaction was directly proven.
   */
  identifyAdmissibleOutputs: (
    beef: number[],
    previousCoins: number[],
    offChainValues?: number[],
    mode?: 'historical-tx' | 'current-tx' | 'historical-tx-no-spv',
    context?: TopicAdmittanceContext
  ) => Promise<AdmittanceInstructions>

  /**
   * Releases provisional state created while identifying admissible outputs
   * when a current transaction cannot be broadcast. Implementations that keep
   * validation read-only do not need this hook.
   */
  abortAdmissibleOutputs?: (beef: number[], outputsToAbort: number[]) => Promise<void> | void

  /**
   * Identifies and returns the inputs needed to anchor any topical outputs from this transaction to their associated previous history.
   * @throws - if there are no potentially valid topical outputs in this transaction
   */
  identifyNeededInputs?: (
    beef: number[],
    offChainValues?: number[]
  ) => Promise<Array<{ txid: string; outputIndex: number }>>

  /**
   * Returns a Markdown-formatted documentation string for the topic manager.
   */
  getDocumentation: () => Promise<string>

  /**
   * Returns a metadata object that can be used to identify the topic manager.
   */
  getMetaData: () => Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }>
}
