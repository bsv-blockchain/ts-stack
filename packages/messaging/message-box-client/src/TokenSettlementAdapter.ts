/**
 * TokenSettlementAdapter — the pluggable seam that lets PeerTokenClient move
 * tokens over MessageBox without knowing any token standard's wire format.
 *
 * It mirrors the shape of `Brc29RemittanceModule` (buildSettlement /
 * acceptSettlement) that PeerPayClient uses for satoshi payments, but the
 * artifact additionally carries the token `protocol`, `assetId`, and `amount`
 * so the receiving side can route to the right adapter. One adapter exists per
 * standard (classic STAS, DSTAS, BSV-21).
 */
import { AtomicBEEF, Base64String, PubKeyHex, WalletInterface } from '@bsv/sdk'

/** A token UTXO the sender controls and wishes to transfer. */
export interface TokenSourceRef {
  txid: string
  outputIndex: number
  lockingScriptHex: string
  satoshis: number
  protocol: string
  assetId: string
  /** BRC-42 receive-key id under which the sender holds this UTXO. */
  brc42KeyId?: string
  /** Standard-specific extras (e.g. BSV-21 tokenId/dec/sym) tolerated by adapters. */
  [key: string]: unknown
}

/** The transferable result produced by an adapter; travels in the message body. */
export interface TokenSettlementArtifact {
  customInstructions: { derivationPrefix: Base64String, derivationSuffix: Base64String }
  transaction: AtomicBEEF
  protocol: string
  assetId: string
  /** Token units as a string (bigint-safe); for classic STAS this equals satoshis. */
  amount: string
  outputIndex: number
}

export interface AdapterLogger {
  log: (...args: any[]) => void
  warn: (...args: any[]) => void
  error: (...args: any[]) => void
}

export interface TokenAdapterContext {
  wallet: WalletInterface
  originator?: string
  logger?: AdapterLogger
}

export interface BuildTokenSettlementArgs {
  recipient: PubKeyHex
  source: TokenSourceRef
  amount: string
}

export interface AcceptTokenSettlementArgs {
  sender: PubKeyHex
  settlement: TokenSettlementArtifact
}

export interface Termination { code: string, message: string }

export type TokenBuildResult =
  | { action: 'settle', artifact: TokenSettlementArtifact }
  | { action: 'terminate', termination: Termination }

export type TokenAcceptResult =
  | { action: 'accept', receiptData?: { internalizeResult?: unknown } }
  | { action: 'terminate', termination: Termination }

export interface TokenSettlementAdapter {
  /** Discriminator matched against TokenSourceRef.protocol / TokenToken.protocol. */
  readonly protocol: string
  buildTokenSettlement: (args: BuildTokenSettlementArgs, ctx: TokenAdapterContext) => Promise<TokenBuildResult>
  acceptTokenSettlement: (args: AcceptTokenSettlementArgs, ctx: TokenAdapterContext) => Promise<TokenAcceptResult>
}
