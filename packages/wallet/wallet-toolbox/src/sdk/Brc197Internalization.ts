import { P2PKH, PrivateKey, PublicKey, type InternalizeActionArgs, type InternalizeOutput } from '@bsv/sdk'
import { validateInternalizeActionArgs, type ValidInternalizeActionArgs } from '@bsv/sdk/wallet/validationHelpers'
import { WERR_INVALID_PARAMETER } from './WERR_errors'

/** Explicit local capability. This is not an extension of the ordinary BRC-100 wire method. */
export const BRC197_INTERNALIZATION_PROFILE = 'brc197-fixed-child-v1' as const
export const BRC197_DERIVATION_PREFIX = 'brc197' as const
export const BRC197_DERIVATION_SUFFIX = 'authority' as const
export const BRC197_COUNTERPARTY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' as const

export interface Brc197InternalizeActionArgs extends InternalizeActionArgs {
  profile: typeof BRC197_INTERNALIZATION_PROFILE
  recipientIdentityKey: string
}
export interface Brc197InternalizationCapabilities {
  profile: typeof BRC197_INTERNALIZATION_PROFILE
  recipientIdentityKey: string
  childPublicKey: string
}

function validateRecipientIdentity(value: unknown): string {
  try {
    if (typeof value !== 'string' || !/^(02|03)[0-9a-f]{64}$/.test(value)) throw new Error('encoding')
    const key = PublicKey.fromString(value)
    if (key.isInfinity() || !key.validate() || key.toString() !== value) throw new Error('point')
    return key.toString()
  } catch {
    throw new WERR_INVALID_PARAMETER('recipientIdentityKey', 'a canonical compressed secp256k1 public key')
  }
}

/** Public derivation; no identity or child private scalar crosses this interface. */
export function brc197ChildPublicKey(recipientIdentityKey: string): string {
  const root = PublicKey.fromString(validateRecipientIdentity(recipientIdentityKey))
  const child = root.deriveChild(new PrivateKey(1), '2-3241645161d8-brc197 authority')
  if (child.isInfinity() || child.getX().eq(root.getX())) {
    throw new WERR_INVALID_PARAMETER('recipientIdentityKey', 'a nondegenerate BRC-197 child')
  }
  return child.toString()
}

/** Own all ordinary validated arguments and then restore the independently checked
 * literal fixed invoice fields. Base64 placeholders are validation scaffolding only:
 * they never enter a key derivation, signer, storage record or remittance. The ordinary
 * validator and ordinary internalizeAction method remain unchanged. */
export function validateBrc197InternalizeActionArgs(args: Brc197InternalizeActionArgs): ValidInternalizeActionArgs {
  if (args == null || typeof args !== 'object' || args.profile !== BRC197_INTERNALIZATION_PROFILE) {
    throw new WERR_INVALID_PARAMETER('profile', BRC197_INTERNALIZATION_PROFILE)
  }
  validateRecipientIdentity(args.recipientIdentityKey)
  if (!Array.isArray(args.outputs)) throw new WERR_INVALID_PARAMETER('outputs', 'an array')
  const indices = new Set<number>()
  const outputs: InternalizeOutput[] = args.outputs.map(output => {
    const remittance = output?.paymentRemittance
    if (
      output?.protocol !== 'wallet payment' ||
      output.insertionRemittance !== undefined ||
      remittance?.derivationPrefix !== BRC197_DERIVATION_PREFIX ||
      remittance.derivationSuffix !== BRC197_DERIVATION_SUFFIX ||
      remittance.senderIdentityKey !== BRC197_COUNTERPARTY ||
      indices.has(output.outputIndex)
    ) {
      throw new WERR_INVALID_PARAMETER('outputs', 'unique BRC-197 fixed-child wallet payments')
    }
    indices.add(output.outputIndex)
    return { ...output, paymentRemittance: { ...remittance, derivationPrefix: 'AA==', derivationSuffix: 'AA==' } }
  })
  const validated = validateInternalizeActionArgs({ ...args, outputs })
  return {
    ...validated,
    tx: Array.from(validated.tx),
    outputs: validated.outputs.map(output => ({
      ...output,
      paymentRemittance: {
        derivationPrefix: BRC197_DERIVATION_PREFIX,
        derivationSuffix: BRC197_DERIVATION_SUFFIX,
        senderIdentityKey: BRC197_COUNTERPARTY
      }
    }))
  }
}

/** Repeated at the signer and storage boundaries before any ownership write. */
export function assertBrc197Recipient(args: Brc197InternalizeActionArgs, identityKey: string): void {
  if (args.recipientIdentityKey !== identityKey) {
    throw new WERR_INVALID_PARAMETER('recipientIdentityKey', 'the authenticated wallet identity')
  }
}
export function brc197ExpectedLockingScript(recipientIdentityKey: string): string {
  return new P2PKH().lock(PublicKey.fromString(brc197ChildPublicKey(recipientIdentityKey)).toAddress()).toHex()
}

/** Retain original profile and recipient beside freshly owned ordinary argument bytes. */
export function ownBrc197InternalizeActionArgs(args: Brc197InternalizeActionArgs): Brc197InternalizeActionArgs {
  const validated = validateBrc197InternalizeActionArgs(args)
  const recipientIdentityKey = validateRecipientIdentity(args.recipientIdentityKey)
  return { ...validated, profile: BRC197_INTERNALIZATION_PROFILE, recipientIdentityKey }
}
