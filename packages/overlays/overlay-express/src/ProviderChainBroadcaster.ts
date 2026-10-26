import {
  BroadcastFailure,
  Broadcaster,
  BroadcastResponse,
  Transaction
} from '@bsv/sdk'
import {
  assertBoundedString,
  assertHash,
  isRecord
} from './OutboundSecurity.js'

export interface NamedBroadcaster {
  name: string
  broadcaster: Broadcaster
}

const TERMINAL_CODES = new Set([
  '400',
  '460',
  '463',
  '464',
  'DOUBLE_SPEND_ATTEMPTED',
  'REJECTED',
  'INVALID',
  'MALFORMED',
  'MINED_IN_STALE_BLOCK'
])

function isTerminalBroadcastFailure (failure: BroadcastFailure): boolean {
  const code = failure.code.toUpperCase()
  const description = failure.description.toUpperCase()
  if (TERMINAL_CODES.has(code)) return true
  if (code.includes('ORPHAN') || description.includes('ORPHAN')) return true
  if (
    typeof failure.more === 'object' &&
    failure.more !== null &&
    'terminal' in failure.more &&
    failure.more.terminal === true
  ) {
    return true
  }
  return false
}

function validateProviderResponse(
  value: unknown,
  expectedTxid: string
): BroadcastResponse | BroadcastFailure {
  if (!isRecord(value) || (value.status !== 'success' && value.status !== 'error')) {
    throw new TypeError('Provider returned an invalid broadcast response')
  }
  if (value.status === 'success') {
    assertHash(value.txid, 'Provider success txid')
    if (value.txid.toLowerCase() !== expectedTxid.toLowerCase()) {
      throw new TypeError('Provider success txid does not match the submitted transaction')
    }
    assertBoundedString(value.message, 'Provider success message', 4096)
    return value as unknown as BroadcastResponse
  }
  assertBoundedString(value.code, 'Provider failure code', 256, false)
  assertBoundedString(value.description, 'Provider failure description', 4096)
  if (value.txid !== undefined) assertHash(value.txid, 'Provider failure txid')
  return value as unknown as BroadcastFailure
}

/**
 * Tries transaction propagation providers in priority order.
 *
 * Transient provider failures fall through to the next provider. Terminal
 * validation states, including double spends, stop immediately so a conflicting
 * transaction is not retried against a second propagation surface.
 */
export class ProviderChainBroadcaster implements Broadcaster {
  constructor (private readonly providers: NamedBroadcaster[]) {
    if (providers.length === 0) {
      throw new TypeError('ProviderChainBroadcaster requires at least one provider')
    }
    const names = new Set<string>()
    for (const provider of providers) {
      assertBoundedString(provider.name, 'Provider name', 128, false)
      if (names.has(provider.name)) throw new TypeError('Provider names must be unique')
      names.add(provider.name)
    }
  }

  async broadcast (tx: Transaction): Promise<BroadcastResponse | BroadcastFailure> {
    const failures: Array<{ provider: string, failure: BroadcastFailure }> = []
    let lastFailure: { provider: string, failure: BroadcastFailure } | undefined
    const expectedTxid = tx.id('hex')

    for (const provider of this.providers) {
      let response: BroadcastResponse | BroadcastFailure
      try {
        response = validateProviderResponse(
          await provider.broadcaster.broadcast(tx),
          expectedTxid
        )
      } catch (error: unknown) {
        response = {
          status: 'error',
          code: '500',
          description: error instanceof Error ? error.message : 'Internal Server Error',
          more: { provider: provider.name, terminal: false }
        }
      }

      if (response.status === 'success') {
        return {
          ...response,
          message: `[${provider.name}] ${response.message}`
        }
      }

      lastFailure = { provider: provider.name, failure: response }
      failures.push(lastFailure)
      if (isTerminalBroadcastFailure(response)) {
        return annotateFailure(response, provider.name, failures)
      }
    }

    if (lastFailure === undefined) {
      throw new Error('ProviderChainBroadcaster exhausted no providers')
    }
    return annotateFailure(lastFailure.failure, lastFailure.provider, failures)
  }
}

function annotateFailure (
  failure: BroadcastFailure,
  provider: string,
  failures: Array<{ provider: string, failure: BroadcastFailure }>
): BroadcastFailure {
  return {
    ...failure,
    more: {
      ...(typeof failure.more === 'object' && failure.more !== null ? failure.more : {}),
      provider,
      providerFailures: failures.map(item => ({
        provider: item.provider,
        code: item.failure.code,
        description: item.failure.description,
        txid: item.failure.txid,
        more: item.failure.more
      }))
    }
  }
}
