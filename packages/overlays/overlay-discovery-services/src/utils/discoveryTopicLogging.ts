import { DiscoveryProtocol } from './isAdmissibleDiscoveryOutput.js'

interface DiscoveryTopicLogStyle {
  /** Leading text for the admittance line, including emoji and any greeting. */
  admitted: string
  consumed: string
  idle: string
  error: string
}

const discoveryTopicLogStyle: Record<DiscoveryProtocol, DiscoveryTopicLogStyle> = {
  SHIP: { admitted: '🛳️ Ahoy! Admitted', consumed: '🚢', idle: '⚓', error: '⛴️' },
  SLAP: { admitted: '👏 Admitted', consumed: '✋', idle: '😕', error: '🤚' }
}

export function hasPreviousCoins(previousCoins: number[] | undefined): boolean {
  return previousCoins !== undefined && previousCoins.length > 0
}

/**
 * Emits the shared SHIP/SLAP admittance summary, preserving each protocol's
 * original wording and emoji.
 */
export function logDiscoverySummary(
  protocol: DiscoveryProtocol,
  outputsToAdmit: number[],
  previousCoins: number[]
): void {
  const style = discoveryTopicLogStyle[protocol]
  if (outputsToAdmit.length > 0) {
    console.log(
      `${style.admitted} ${outputsToAdmit.length} ${protocol} ${outputsToAdmit.length === 1 ? 'output' : 'outputs'}!`
    )
  }
  if (hasPreviousCoins(previousCoins)) {
    console.log(
      `${style.consumed} Consumed ${previousCoins.length} previous ${protocol} ${previousCoins.length === 1 ? 'coin' : 'coins'}!`
    )
  }
  if (outputsToAdmit.length === 0 && !hasPreviousCoins(previousCoins)) {
    console.warn(
      `${style.idle} No ${protocol} outputs admitted and no previous ${protocol} coins consumed.`
    )
  }
}

/**
 * Logs a parse/identification failure only when nothing was admitted and no
 * previous coins were consumed, matching the prior per-protocol behavior.
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
