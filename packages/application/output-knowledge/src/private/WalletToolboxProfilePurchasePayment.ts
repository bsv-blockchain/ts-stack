import {
  canonicalOutputJSON,
  outputAssert,
  type OutputSignedPurchaseTerms,
  type Transaction
} from '@bsv/sdk'
import {
  RevenueListingProfile,
  REVENUE_LISTING_ACTIVATION_PROGRAM_SHA256,
  REVENUE_LISTING_ACTIVE_PROGRAM_SHA256,
  type RevenueListingProfileDescriptor
} from '@bsv/sdk/script/templates/RevenueListingProfile'
import { RevenueListingProfileSpend } from '@bsv/sdk/script/templates/RevenueListingProfileSpend'
import { RevenueListingProfileLineageVerifier } from '../revenue-listing/RevenueListingProfileLineageVerifier.js'
import {
  parseRevenueListingProfileLineagePackage,
  type RevenueListingProfileLineagePackage
} from '../revenue-listing/ProfileLineagePackage.js'
import { parseVerificationContext } from '../validation.js'
import {
  WalletToolboxPurchasePaymentCore,
  type WalletToolboxPurchasePaymentCoreOptions,
  type PurchaseWalletSpend
} from './WalletToolboxPurchasePaymentCore.js'
export interface WalletToolboxProfilePurchasePaymentOptions extends WalletToolboxPurchasePaymentCoreOptions {
  family: RevenueListingProfile
}
/** Explicit current immutable two-stage noSend purchase adapter. Independently
 * verifies reserve-stage genesis, activation and active history before new wallet
 * allocation; rechecks the same verified chain view and exclusive height expiry
 * at every financial boundary. Finalized original recovery remains read-only and
 * does not turn historical purchase evidence into a fresh offer. */
export class WalletToolboxProfilePurchasePayment extends WalletToolboxPurchasePaymentCore<RevenueListingProfileDescriptor> {
  constructor(ports: WalletToolboxProfilePurchasePaymentOptions) {
    super(
      ports,
      Object.freeze({
        format: 'private-purchase-wallet/2' as const,
        script: Object.freeze({
          activation: REVENUE_LISTING_ACTIVATION_PROGRAM_SHA256,
          active: REVENUE_LISTING_ACTIVE_PROGRAM_SHA256
        }),
        parse: parseRevenueListingProfileLineagePackage,
        verifier: () => {
          const verifier = new RevenueListingProfileLineageVerifier(ports.family, ports.chains)
          return {
            verify: async (
              lineage: RevenueListingProfileLineagePackage,
              context: ReturnType<typeof parseVerificationContext>,
              signal: AbortSignal
            ) => {
              const result = await verifier.verify(lineage, context, signal)
              if (result.status === 'verified')
                outputAssert(
                  result.stage === 'active',
                  'Purchase requires a verified active listing',
                  'context-changed'
                )
              return result
            }
          }
        },
        eligible: (
          lineage: RevenueListingProfileLineagePackage,
          context: ReturnType<typeof parseVerificationContext>
        ) => {
          const current = parseVerificationContext(structuredClone(ports.context()))
          outputAssert(
            canonicalOutputJSON(current.view) === canonicalOutputJSON(context.view) &&
              current.id === context.id &&
              current.generation === context.generation &&
              current.policyDigest === context.policyDigest &&
              canonicalOutputJSON(current.partition) === canonicalOutputJSON(context.partition),
            'Verified purchase chain context changed',
            'context-changed'
          )
          outputAssert(
            BigInt(current.view.tipHeight) < BigInt(lineage.descriptor.expiryHeight),
            'Listing purchase height expired',
            'expired'
          )
        },
        spend: (
          lineage: RevenueListingProfileLineagePackage,
          predecessor: Transaction,
          terms: OutputSignedPurchaseTerms
        ): PurchaseWalletSpend => {
          const spend = new RevenueListingProfileSpend(
            ports.family,
            lineage.descriptor,
            [{ rawTransaction: predecessor.toHex(), outputIndex: lineage.target.outputIndex }],
            {
              operation: 'purchase',
              acquisitionId: terms.body.acquisitionId,
              requestDigest: terms.body.requestDigest,
              recipient: terms.body.recipient
            }
          )
          return {
            plan: () => {
              const plan = spend.plan()
              return { inputs: [plan.input], outputs: plan.outputs }
            },
            estimateUnlockingLength: () => spend.estimateUnlockingLength(),
            prepare: transaction => {
              const prepared = spend.prepare(transaction)
              return {
                signingRequests: () => prepared.signingRequests(),
                complete: () => prepared.complete({}),
                assertFinalLayout: transaction => prepared.assertFinalLayout(transaction)
              }
            }
          }
        }
      })
    )
  }
}
