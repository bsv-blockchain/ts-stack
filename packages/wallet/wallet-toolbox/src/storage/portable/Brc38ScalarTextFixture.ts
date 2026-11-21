import type { BRC38WalletData } from './index'
import type { Brc38StageTable } from './Brc38SemanticStage'

/** Finite independent original-contract oracle. This deliberately does not
 * obtain coordinates or expected bytes from the production TEXT whitelist. */
export function withBrc38ScalarTextFixture(data: BRC38WalletData): readonly Readonly<{
  table: Brc38StageTable
  field: string
  value: string
}>[] {
  const coordinates: readonly (readonly [Brc38StageTable, string])[] = [
    ['transactions', 'description'],
    ['transactions', 'noSendExpiryReclaimDerivationPrefix'],
    ['transactions', 'noSendExpiryReclaimDerivationSuffix'],
    ['outputs', 'outputDescription'],
    ['outputs', 'spendingDescription'],
    ['outputs', 'customInstructions'],
    ['outputs', 'derivationPrefix'],
    ['outputs', 'derivationSuffix'],
    ['outputs', 'type'],
    ['outputs', 'purpose'],
    ['commissions', 'keyOffset'],
    ['certificates', 'subject'],
    ['certificates', 'revocationOutpoint'],
    ['certificates', 'signature'],
    ['certificates', 'verifier'],
    ['certificateFields', 'fieldValue'],
    ['certificateFields', 'masterKey']
  ]
  return Object.freeze(
    coordinates.map(([table, field], index) => {
      const value =
        field === 'masterKey'
          ? ''
          : '\ufeff' +
            index +
            ' quote" slash\\ control\u0000\n雪😀' +
            (field === 'description' ? 'ab雪😀"\\\n'.repeat(9000) : '')
      data.tables[table][0][field] = value
      return Object.freeze({ table, field, value })
    })
  )
}
