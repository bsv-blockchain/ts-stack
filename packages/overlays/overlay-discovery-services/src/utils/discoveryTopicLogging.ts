import { DiscoveryProtocol } from './isAdmissibleDiscoveryOutput.js'

interface DiscoveryTopicLogStyle {
  admitted: string
  consumed: string
  idle: string
  error: string
}

const discoveryTopicLogStyle: Record<DiscoveryProtocol, DiscoveryTopicLogStyle> = {
  SHIP: { admitted: '🛳️ Ahoy! Admitted', consumed: '🚢', idle: '⚓', error: '⛴️' },
  SLAP: { admitted: '👏 Admitted', consumed: '✋', idle: '😕', error: '🤚' }
}

const pluralize = (count: number, singular: string): string =>
  count === 1 ? singular : `${singular}s`

export function hasPreviousCoins(previousCoins: number[] | undefined): boolean {
  return previousCoins !== undefined && previousCoins.length > 0
}

/**
 * Emits the shared SHIP/SLAP admittance summary while preserving each
 * protocol's existing wording and emoji.
 */
export function logDiscoverySummary(
  protocol: DiscoveryProtocol,
  outputsToAdmit: number[],
  previousCoins: number[]
): void {
  const style = discoveryTopicLogStyle[protocol]
  if (outputsToAdmit.length > 0) {
    console.log(
      `${style.admitted} ${outputsToAdmit.length} ${protocol} ${pluralize(outputsToAdmit.length, 'output')}!`
    )
  }
  if (hasPreviousCoins(previousCoins)) {
    console.log(
      `${style.consumed} Consumed ${previousCoins.length} previous ${protocol} ${pluralize(previousCoins.length, 'coin')}!`
    )
  }
  if (outputsToAdmit.length === 0 && !hasPreviousCoins(previousCoins)) {
    console.warn(
      `${style.idle} No ${protocol} outputs admitted and no previous ${protocol} coins consumed.`
    )
  }
}

/**
 * Logs a parse failure only when nothing was admitted and no previous coin
 * was consumed, matching the prior per-protocol behavior.
 */
export function logDiscoveryIdentificationError(
  protocol: DiscoveryProtocol,
  outputsToAdmit: number[],
  previousCoins: number[],
  error: unknown
): void {
  if (outputsToAdmit.length === 0 && !hasPreviousCoins(previousCoins)) {
    console.error(
      `${discoveryTopicLogStyle[protocol].error} Error identifying admissible outputs:`,
      error
    )
  }
}
