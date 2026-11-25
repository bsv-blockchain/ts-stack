/**
 * Given a previous authorised amount (satoshis) work out the next tier
 * ($5 → $10 → $20 → $50).  Return either satoshis or USD.
 */
export const determineUpgradeAmount = (
  previousAmountInSats: number,
  usdPerBsv: number,
  returnType: 'sats' | 'usd' = 'sats'
): number => {
  const previousUsd = previousAmountInSats * (usdPerBsv / 1e8)

  const nextUsd = [5, 10, 20].find(tier => previousUsd < tier) ?? 50

  return returnType === 'usd' ? nextUsd : Math.round((nextUsd * 1e8) / usdPerBsv)
}
