/**
 * Given a previous authorised amount (satoshis) work out the next tier
 * ($5 → $10 → $20 → $50).  Return either satoshis or USD.
 */
export const determineUpgradeAmount = (
  previousAmountInSats: number,
  usdPerBsv: number,
  returnType: 'sats' | 'usd' = 'sats'
): number => {
  const tierInSatoshis = (usd: number) => Math.round((usd * 1e8) / usdPerBsv)
  const nextUsd = [5, 10, 20].find(tier => previousAmountInSats < tierInSatoshis(tier)) ?? 50

  return returnType === 'usd' ? nextUsd : tierInSatoshis(nextUsd)
}
