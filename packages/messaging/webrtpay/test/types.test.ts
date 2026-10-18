/**
 * PaymentToken interop with @bsv/sdk and PeerPay (@bsv/message-box-client), checked by the
 * compiler: `pnpm typecheck` fails when an assignment below stops compiling. The jest
 * run only confirms the file loads; ts-jest does not type-check.
 */
import { describe, expect, it } from '@jest/globals'
import type { CreateActionResult } from '@bsv/sdk'
import type {
  IncomingPayment as PeerPayIncomingPayment,
  PaymentToken as PeerPayToken
} from '@bsv/message-box-client'
import type { AuthenticatedPeer } from '../src/session/AuthenticatedPeer.js'
import type { DirectPayClient } from '../src/client/DirectPayClient.js'
import type { acceptDirectPayment } from '../src/payments/accept.js'
import type {
  AtomicBEEF,
  IncomingPayment,
  IncomingPaymentInput,
  PaymentToken,
  PaymentTokenInput,
  WalletLike
} from '../src/types.js'

/** Never called: each statement is a compile-time assignability check. */
export function compileTimeChecks(
  created: CreateActionResult,
  fromPeerPay: PeerPayToken,
  incomingFromPeerPay: PeerPayIncomingPayment,
  received: IncomingPayment,
  client: DirectPayClient,
  peer: AuthenticatedPeer,
  wallet: WalletLike,
  accept: typeof acceptDirectPayment
): void {
  // The sdk's AtomicBEEF (number[] | Uint8Array), as createAction returns it, is accepted.
  const transaction: PaymentTokenInput['transaction'] = created.tx!
  // PeerPay's types go into every input API...
  const token: PaymentTokenInput = fromPeerPay
  const incoming: IncomingPaymentInput = incomingFromPeerPay
  void client.sendPayment(peer, fromPeerPay)
  void accept(wallet, incomingFromPeerPay)
  // ...and what this package hands out goes into PeerPay's.
  const toPeerPay: PeerPayToken = received.token
  const incomingToPeerPay: PeerPayIncomingPayment = received
  // Outputs stay number arrays.
  const out: number[] = received.token.transaction
  const beef: AtomicBEEF = out
  // @ts-expect-error a received token's transaction is never a Uint8Array
  const notBytes: PaymentToken = { ...received.token, transaction: new Uint8Array(1) }
  void [transaction, token, incoming, toPeerPay, incomingToPeerPay, beef, notBytes]
}

describe('PaymentToken interop types', () => {
  it('is checked by the compiler (pnpm typecheck)', () => {
    expect(typeof compileTimeChecks).toBe('function')
  })
})
