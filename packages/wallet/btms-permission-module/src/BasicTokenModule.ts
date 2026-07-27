import {
  Hash,
  LockingScript,
  PushDrop,
  Transaction,
  Utils,
  type CreateActionArgs,
  type CreateActionInput,
  type CreateActionOutput,
  type CreateActionResult,
  type CreateSignatureArgs,
  type ListActionsArgs,
  type ListOutputsArgs
} from '@bsv/sdk'
import { ISSUE_MARKER, type BTMS } from '@bsv/btms'
import type { PermissionsModule } from '@bsv/wallet-toolbox-client'
import {
  BTMS_FIELD,
  P_BASKET_PREFIX,
  type AuthorizedTransaction,
  type ParsedTokenInfo,
  type TokenSpendInfo
} from './types'

/**
 * BasicTokenModule - BTMS Permission Module
 *
 * SECURITY MODEL:
 * This module enforces permissions when spending BTMS tokens stored in
 * permissioned baskets (format: "p btms <assetId>"). It prevents unauthorized
 * token transfers by requiring explicit user approval for each transaction.
 *
 * THREAT MODEL:
 * - Malicious dApp attempts to spend tokens without user knowledge
 * - Malicious dApp gets approval for one transaction, attempts to sign different transaction
 * - Malicious dApp attempts to bypass authorization checks
 * - Malicious dApp attempts to steal tokens via preimage manipulation
 *
 * SECURITY BOUNDARIES:
 * 1. createAction: Extracts token details and prompts user for approval
 * 2. createSignature: Verifies session authorization + exact signing digest
 * 3. Session authorization: Time-limited (60s) to prevent replay attacks
 * 4. Digest verification: Ensures signed transaction matches approved transaction
 *
 * AUTHORIZATION FLOW:
 * 1. createAction → extract token info → prompt user → grant session auth
 * 2. createSignature → verify session auth → verify signing digest → allow signature
 *
 * ISSUANCE HANDLING:
 * Token issuance is auto-approved (no user prompt) because:
 * - Issuance creates new tokens (doesn't spend existing ones)
 * - It must be identified explicitly by ISSUE_MARKER or a btms_type_issue tag
 * - Unmarked actions and short signature payloads require user approval
 */
export class BasicTokenModule implements PermissionsModule {
  private readonly requestTokenAccess: (app: string, message: string) => Promise<boolean>
  private readonly btms?: Pick<BTMS, 'getAssetInfo'>

  /**
   * Session-based authorization tracking.
   *
   * SECURITY: Time-limited to prevent replay attacks. Each approval expires after 60s.
   * Key: originator (dApp identifier)
   * Value: timestamp of approval (milliseconds since epoch)
   */
  private readonly sessionAuthorizations: Map<string, number> = new Map()
  private readonly SESSION_TIMEOUT_MS = 60000 // 60 seconds
  private readonly DEFAULT_TOKEN_NAME = 'BTMS Token'

  /**
   * Authorized transaction data from createAction responses.
   *
   * SECURITY: Stores exact BIP-143 signing digests to verify
   * that createSignature is signing the exact transaction the user approved.
   * This prevents a malicious dApp from getting approval for one transaction
   * and then signing a different transaction.
   *
   * Key: originator (dApp identifier)
   * Value: authorized transaction details (reference, digests, timestamp)
   */
  private readonly authorizedTransactions: Map<string, AuthorizedTransaction> = new Map()

  /**
   * Creates a new BasicTokenModule instance.
   *
   * @param requestTokenAccess - Callback to prompt user for token spending approval.
   *   Should return true if user approves, false if denied.
   *   SECURITY: This callback MUST be implemented securely to prevent UI spoofing.
   * @param btms - Optional BTMS instance for enriching prompts with token metadata
   */
  constructor(
    requestTokenAccess: (app: string, message: string) => Promise<boolean>,
    btms?: Pick<BTMS, 'getAssetInfo'>
  ) {
    if (!requestTokenAccess || typeof requestTokenAccess !== 'function') {
      throw new Error('requestTokenAccess callback is required')
    }
    this.requestTokenAccess = requestTokenAccess
    this.btms = btms
  }

  /**
   * Clears sensitive in-memory authorization state when the host no longer needs the module.
   */
  dispose(): void {
    this.sessionAuthorizations.clear()
    this.authorizedTransactions.clear()
  }

  private clearAuthorization(originator: string): void {
    this.sessionAuthorizations.delete(originator)
    this.authorizedTransactions.delete(originator)
  }

  /**
   * Removes expired state during normal request processing without creating a background timer.
   */
  private cleanupExpiredAuthorizations(now = Date.now()): void {
    for (const [originator, timestamp] of this.sessionAuthorizations) {
      if (now - timestamp > this.SESSION_TIMEOUT_MS) {
        this.sessionAuthorizations.delete(originator)
      }
    }
    for (const [originator, transaction] of this.authorizedTransactions) {
      if (now - transaction.timestamp > this.SESSION_TIMEOUT_MS) {
        this.authorizedTransactions.delete(originator)
      }
    }
  }

  /**
   * Intercepts wallet method requests for P-basket/protocol operations.
   *
   * SECURITY: This is the main entry point for all permission checks.
   * All token spending operations MUST go through this method.
   *
   * @param req - Request object containing method, args, and originator
   * @returns Modified args (unchanged in this implementation)
   * @throws Error if authorization is denied
   */
  async onRequest(req: {
    method: string
    args: object
    originator: string
  }): Promise<{ args: object }> {
    const { method, args, originator } = req
    this.cleanupExpiredAuthorizations()

    // Input validation
    if (!method || typeof method !== 'string') {
      throw new Error('Invalid method')
    }
    if (!originator || typeof originator !== 'string') {
      throw new Error('Invalid originator')
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('Invalid args')
    }

    // Handle security-critical methods
    if (method === 'createAction') {
      await this.handleCreateAction(args as CreateActionArgs, originator)
    } else if (method === 'createSignature') {
      await this.handleCreateSignature(args as CreateSignatureArgs, originator)
    } else if (method === 'listActions') {
      await this.handleListActions(args as ListActionsArgs, originator)
    } else if (method === 'listOutputs') {
      await this.handleListOutputs(args as ListOutputsArgs, originator)
    }

    return { args }
  }

  /**
   * Transforms responses from the underlying wallet.
   * For createAction: Captures signable transaction data for security verification.
   */
  async onResponse(
    res: unknown,
    context: {
      method: string
      originator: string
    }
  ): Promise<unknown> {
    const { method, originator } = context
    this.cleanupExpiredAuthorizations()

    if (method === 'createAction') {
      await this.captureAuthorizedTransaction(res as CreateActionResult, originator)
    }

    return res
  }

  /**
   * Captures authorized transaction data from createAction response.
   *
   * SECURITY: This data is used to verify that createSignature calls are signing
   * the exact transaction the user approved. Prevents transaction substitution attacks.
   *
   * Captured data:
   * 1. reference - Transaction reference for matching
   * 2. authorizedDigests - SHA-256 hashes of every exact BIP-143 input preimage
   * 3. timestamp - For expiry checking
   *
   * @param result - createAction response
   * @param originator - dApp identifier
   */
  private async captureAuthorizedTransaction(
    result: CreateActionResult,
    originator: string
  ): Promise<void> {
    if (!result || typeof result !== 'object' || !result.signableTransaction) {
      this.clearAuthorization(originator)
      return
    }

    const { tx, reference } = result.signableTransaction
    if (!tx || !reference) {
      this.clearAuthorization(originator)
      return
    }

    try {
      const transaction = Transaction.fromAtomicBEEF(tx)
      this.authorizedTransactions.set(originator, {
        reference,
        authorizedDigests: this.computeAuthorizedDigests(transaction),
        timestamp: Date.now()
      })
    } catch {
      this.clearAuthorization(originator)
      throw new Error('Unable to bind BTMS authorization to the returned transaction')
    }
  }

  /**
   * Computes the exact signing digest that PushDrop passes to createSignature
   * for every input in a signable transaction.
   */
  private computeAuthorizedDigests(transaction: Transaction): Set<string> {
    if (!transaction || !Array.isArray(transaction.inputs)) {
      throw new Error('Invalid transaction for signing-digest computation')
    }

    const digests = new Set<string>()
    for (let inputIndex = 0; inputIndex < transaction.inputs.length; inputIndex++) {
      digests.add(Utils.toHex(Hash.sha256(transaction.preimage(inputIndex))))
    }
    return digests
  }

  /**
   * Handles createAction requests that involve BTMS P-baskets.
   *
   * SECURITY: This is the primary authorization checkpoint. User approval here
   * grants session authorization for subsequent createSignature calls.
   *
   * ISSUANCE DETECTION: Token issuance is auto-approved because it creates new
   * tokens rather than spending existing ones. Detected by:
   * - ISSUE_MARKER in locking script
   * - btms_type_issue tag in outputs
   *
   * @param args - createAction arguments
   * @param originator - dApp identifier
   * @throws Error if user denies authorization
   */
  private async handleCreateAction(args: CreateActionArgs, originator: string): Promise<void> {
    // Input validation
    if (!args || typeof args !== 'object') {
      throw new Error('Invalid createAction args')
    }

    // Check if this is token issuance - auto-approve
    const isIssuance = this.isTokenIssuance(args)
    if (isIssuance) {
      this.grantSessionAuthorization(originator)
      return
    }

    // Extract token spend information for user prompt
    const spendInfo = this.extractTokenSpendInfo(args)
    const enrichedSpendInfo = await this.enrichSpendInfoWithMetadata(spendInfo, spendInfo.assetId)
    const actionClassification = this.classifyTokenAction(enrichedSpendInfo)

    if (actionClassification.isInvalidBurn) {
      throw new Error('Burn transactions must not send tokens to a recipient')
    }

    if (actionClassification.isBurn) {
      await this.promptForTokenBurn(originator, {
        ...enrichedSpendInfo,
        sendAmount: 0,
        totalInputAmount: actionClassification.burnAmount
      })
      return
    }

    if (enrichedSpendInfo.sendAmount > 0 || enrichedSpendInfo.totalInputAmount > 0) {
      await this.promptForTokenSpend(originator, enrichedSpendInfo)
      return
    }

    // Fallback to generic prompt if we can't parse token details
    await this.promptForGenericAuthorization(originator)
  }

  private async enrichSpendInfoWithMetadata(
    spendInfo: TokenSpendInfo,
    assetId?: string
  ): Promise<TokenSpendInfo> {
    if (!assetId) return spendInfo

    const meta = await this.getAssetMetadata(assetId)
    return {
      ...spendInfo,
      assetId,
      tokenName: meta?.name || spendInfo.tokenName,
      iconURL: meta?.iconURL || spendInfo.iconURL
    }
  }

  private classifyTokenAction(spendInfo: TokenSpendInfo): {
    burnAmount: number
    isBurn: boolean
    isInvalidBurn: boolean
  } {
    const inputAmountReliable = spendInfo.inputAmountSource === 'beef'
    const burnAmount = inputAmountReliable
      ? Math.max(
          0,
          spendInfo.totalInputAmount - spendInfo.outputChangeAmount - spendInfo.outputSendAmount
        )
      : 0
    const isInvalidBurn = burnAmount > 0 && spendInfo.outputSendAmount > 0
    const isBurn = inputAmountReliable && burnAmount > 0 && spendInfo.outputSendAmount === 0

    return {
      burnAmount,
      isBurn,
      isInvalidBurn
    }
  }

  /**
   * Extracts comprehensive token spend information from createAction args.
   *
   * Parses ALL output locking scripts to get token data, and extracts
   * recipient info from the action description.
   */
  private extractTokenSpendInfo(args: CreateActionArgs): TokenSpendInfo {
    if (!args || typeof args !== 'object') {
      throw new Error('Invalid args for extractTokenSpendInfo')
    }

    const inputResult = this.parseInputAmounts(args)
    const outputResult = this.parseOutputAmounts(args, inputResult.assetId)

    const assetId = outputResult.assetId || inputResult.assetId
    const assetIdMismatch =
      inputResult.assetIdMismatch ||
      outputResult.assetIdMismatch ||
      (inputResult.assetId && outputResult.assetId && inputResult.assetId !== outputResult.assetId)

    if (assetIdMismatch) {
      throw new Error('Asset swap support coming soon')
    }

    let { totalInputAmount, inputAmountSource } = inputResult
    let sendAmount = outputResult.hasTokenOutputs ? outputResult.outputSendAmount : 0
    const changeAmount = outputResult.hasTokenOutputs ? outputResult.outputChangeAmount : 0

    // If we have token outputs, derive total input amount from them
    if (sendAmount + changeAmount > 0 && totalInputAmount === 0) {
      totalInputAmount = sendAmount + changeAmount
      inputAmountSource = 'derived'
    }

    // If we still couldn't determine send amount, try calculating from inputs
    if (sendAmount === 0 && totalInputAmount > 0) {
      sendAmount = totalInputAmount - changeAmount
    }

    return {
      sendAmount,
      totalInputAmount,
      changeAmount,
      outputSendAmount: outputResult.outputSendAmount,
      outputChangeAmount: outputResult.outputChangeAmount,
      hasTokenOutputs: outputResult.hasTokenOutputs,
      inputAmountSource,
      tokenName: outputResult.tokenName || inputResult.tokenName,
      assetId: assetId || '',
      recipient: undefined,
      iconURL: outputResult.iconURL || inputResult.iconURL,
      actionDescription: args.description || 'Token transaction'
    }
  }

  /**
   * Parses input BEEF to extract token amounts and asset metadata from inputs.
   */
  private parseInputAmounts(args: CreateActionArgs): {
    assetId: string
    tokenName: string
    iconURL: string | undefined
    totalInputAmount: number
    inputAmountSource: TokenSpendInfo['inputAmountSource']
    assetIdMismatch: boolean
  } {
    let assetId = ''
    let tokenName = this.DEFAULT_TOKEN_NAME
    let iconURL: string | undefined
    let beefInputAmount = 0
    let assetIdMismatch = false

    if (!args.inputBEEF || !Array.isArray(args.inputs)) {
      return {
        assetId,
        tokenName,
        iconURL,
        totalInputAmount: 0,
        inputAmountSource: 'none',
        assetIdMismatch
      }
    }

    for (const input of args.inputs) {
      const parsed = this.resolveTokenForInput(input, args.inputBEEF as number[])
      if (!parsed) continue
      if (!assetId) {
        assetId = parsed.assetId
      } else if (parsed.assetId !== assetId) {
        assetIdMismatch = true
        continue
      }
      beefInputAmount += parsed.amount
      ;({ tokenName, iconURL } = this.applyMetadata(parsed, tokenName, iconURL))
    }

    const inputAmountSource: TokenSpendInfo['inputAmountSource'] =
      beefInputAmount > 0 ? 'beef' : 'none'
    return {
      assetId,
      tokenName,
      iconURL,
      totalInputAmount: beefInputAmount,
      inputAmountSource,
      assetIdMismatch
    }
  }

  /**
   * Resolves a BTMS token from a single input via BEEF lookup.
   * Returns null if the input is invalid, malformed, or an issuance marker.
   */
  private resolveTokenForInput(
    input: CreateActionInput,
    inputBEEF: number[]
  ): ParsedTokenInfo | null {
    if (!input?.outpoint || typeof input.outpoint !== 'string') return null
    const [txid, voutStr] = input.outpoint.split('.')
    const outputIndex = Number(voutStr)
    if (!txid || !Number.isFinite(outputIndex) || outputIndex < 0) return null
    try {
      const tx = Transaction.fromBEEF(inputBEEF, txid)
      const scriptHex = tx.outputs?.[outputIndex]?.lockingScript?.toHex?.()
      if (!scriptHex) return null
      const parsed = this.parseTokenLockingScript(scriptHex)
      if (!parsed || parsed.assetId === ISSUE_MARKER) return null
      return parsed
    } catch {
      return null
    }
  }

  /**
   * Parses outputs to extract token send/change amounts and asset metadata.
   */
  private parseOutputAmounts(
    args: CreateActionArgs,
    knownAssetId: string
  ): {
    assetId: string
    tokenName: string
    iconURL: string | undefined
    outputSendAmount: number
    outputChangeAmount: number
    hasTokenOutputs: boolean
    assetIdMismatch: boolean
  } {
    let assetId = knownAssetId
    let tokenName = this.DEFAULT_TOKEN_NAME
    let iconURL: string | undefined
    let outputSendAmount = 0
    let outputChangeAmount = 0
    let hasTokenOutputs = false
    let assetIdMismatch = false

    if (!Array.isArray(args.outputs)) {
      return {
        assetId,
        tokenName,
        iconURL,
        outputSendAmount,
        outputChangeAmount,
        hasTokenOutputs,
        assetIdMismatch
      }
    }

    for (const output of args.outputs) {
      const parsed = this.resolveTokenForOutput(output)
      if (!parsed) continue
      if (!assetId) {
        assetId = parsed.assetId
      } else if (parsed.assetId !== assetId) {
        assetIdMismatch = true
        continue
      }
      hasTokenOutputs = true
      ;({ tokenName, iconURL } = this.applyMetadata(parsed, tokenName, iconURL))
      if (
        output.basket &&
        typeof output.basket === 'string' &&
        output.basket.startsWith(P_BASKET_PREFIX)
      ) {
        outputChangeAmount += parsed.amount
      } else {
        outputSendAmount += parsed.amount
      }
    }

    return {
      assetId,
      tokenName,
      iconURL,
      outputSendAmount,
      outputChangeAmount,
      hasTokenOutputs,
      assetIdMismatch
    }
  }

  /**
   * Resolves a BTMS token from a single output locking script.
   * Returns null if the output is invalid or an issuance marker.
   */
  private resolveTokenForOutput(output: CreateActionOutput): ParsedTokenInfo | null {
    if (!output?.lockingScript || typeof output.lockingScript !== 'string') return null
    const parsed = this.parseTokenLockingScript(output.lockingScript)
    if (!parsed || parsed.assetId === ISSUE_MARKER) return null
    return parsed
  }

  /**
   * Returns updated tokenName and iconURL from parsed metadata, keeping existing values if metadata is absent.
   */
  private applyMetadata(
    parsed: ParsedTokenInfo,
    tokenName: string,
    iconURL: string | undefined
  ): { tokenName: string; iconURL: string | undefined } {
    return {
      tokenName:
        parsed.metadata?.name && typeof parsed.metadata.name === 'string'
          ? parsed.metadata.name
          : tokenName,
      iconURL:
        parsed.metadata?.iconURL && typeof parsed.metadata.iconURL === 'string'
          ? parsed.metadata.iconURL
          : iconURL
    }
  }

  /**
   * Prompts user for token spend authorization with detailed information.
   *
   * SECURITY: The prompt data is JSON-encoded to prevent injection attacks.
   * The host wallet is responsible for safely rendering this data.
   *
   * @param originator - dApp identifier
   * @param spendInfo - Parsed token spend information
   * @throws Error if user denies authorization
   */
  private async promptForTokenSpend(originator: string, spendInfo: TokenSpendInfo): Promise<void> {
    // Input validation
    if (!originator || typeof originator !== 'string') {
      throw new Error('Invalid originator')
    }
    if (!spendInfo || typeof spendInfo !== 'object') {
      throw new Error('Invalid spendInfo')
    }

    // Build structured prompt data (JSON-encoded for safety)
    const promptData = {
      type: 'btms_spend',
      sendAmount: spendInfo.sendAmount,
      tokenName: spendInfo.tokenName,
      assetId: spendInfo.assetId,
      recipient: spendInfo.recipient,
      iconURL: spendInfo.iconURL,
      changeAmount: spendInfo.changeAmount,
      totalInputAmount: spendInfo.totalInputAmount
    }

    const message = JSON.stringify(promptData)
    const approved = await this.requestTokenAccess(originator, message)

    if (!approved) {
      throw new Error('User denied permission to spend tokens')
    }

    this.grantSessionAuthorization(originator)
  }

  /**
   * Prompts user for token burn authorization (burns all inputs with no token outputs).
   */
  private async promptForTokenBurn(originator: string, spendInfo: TokenSpendInfo): Promise<void> {
    // Input validation
    if (!originator || typeof originator !== 'string') {
      throw new Error('Invalid originator')
    }
    if (!spendInfo || typeof spendInfo !== 'object') {
      throw new Error('Invalid spendInfo')
    }

    const promptData = {
      type: 'btms_burn',
      burnAmount: spendInfo.totalInputAmount,
      tokenName: spendInfo.tokenName,
      assetId: spendInfo.assetId,
      iconURL: spendInfo.iconURL,
      burnAll: spendInfo.changeAmount === 0
    }

    const message = JSON.stringify(promptData)
    const approved = await this.requestTokenAccess(originator, message)

    if (!approved) {
      throw new Error('User denied permission to burn tokens')
    }

    this.grantSessionAuthorization(originator)
  }

  /**
   * Prompts user for generic authorization when token details cannot be parsed.
   *
   * SECURITY: Fallback prompt when we can't extract detailed token information.
   * Still requires explicit user approval.
   *
   * @param originator - dApp identifier
   * @throws Error if user denies authorization
   */
  private async promptForGenericAuthorization(originator: string): Promise<void> {
    if (!originator || typeof originator !== 'string') {
      throw new Error('Invalid originator')
    }

    const message = `Spend BTMS tokens\n\nApp: ${originator}`
    const approved = await this.requestTokenAccess(originator, message)

    if (!approved) {
      throw new Error('User denied permission to spend BTMS tokens')
    }

    this.grantSessionAuthorization(originator)
  }

  /**
   * Handles createSignature requests for BTMS token spending.
   *
   * SECURITY: This is the second checkpoint. It verifies that:
   * 1. Session authorization exists (granted by createAction approval)
   * 2. The signing digest matches the authorized transaction
   *
   * ISSUANCE HANDLING:
   * Token issuance is auto-approved only when it is identified explicitly:
   * - Session auth from createAction (if ISSUE_MARKER or btms_type_issue tag detected)
   * - Full-preimage parsing (checks for ISSUE_MARKER in scriptCode)
   * - Short or unmarked payloads require approval
   *
   * @param args - createSignature arguments
   * @param originator - dApp identifier
   * @throws Error if authorization is denied or verification fails
   */
  private async handleCreateSignature(
    args: CreateSignatureArgs,
    originator: string
  ): Promise<void> {
    // Input validation
    if (!args || typeof args !== 'object') {
      throw new Error('Invalid createSignature args')
    }
    if (!originator || typeof originator !== 'string') {
      throw new Error('Invalid originator')
    }

    const hasTransactionBinding = this.authorizedTransactions.has(originator)

    // An access/session grant is not sufficient for an unbound signature request.
    // Prompt (or prove issuance) for every such request and consume that one-shot grant.
    if (!hasTransactionBinding) {
      await this.authorizeOrGrantIssuance(args, originator)
      this.sessionAuthorizations.delete(originator)
      return
    }

    if (!this.hasSessionAuthorization(originator)) {
      await this.promptForGenericAuthorization(originator)
    }

    // Verify the signature request matches the exact authorized transaction.
    this.verifyAuthorizedTransaction(args, originator)
  }

  /**
   * Grants session authorization for issuance requests, or prompts the user otherwise.
   */
  private async authorizeOrGrantIssuance(
    args: CreateSignatureArgs,
    originator: string
  ): Promise<void> {
    // Method 1: Parse BIP-143 preimage for ISSUE_MARKER
    if (args.data && args.data.length >= 157 && this.isIssuanceFromPreimage(args.data)) {
      this.grantSessionAuthorization(originator)
      return
    }

    // Unmarked or short payloads cannot prove issuance and therefore require approval.
    await this.promptForGenericAuthorization(originator)
  }

  /**
   * Verifies the signing digest/data against the stored authorized transaction (if any).
   */
  private verifyAuthorizedTransaction(args: CreateSignatureArgs, originator: string): void {
    const authorizedTx = this.authorizedTransactions.get(originator)
    if (!authorizedTx) {
      throw new Error('No approved transaction is available for this signature request')
    }

    // Check if authorization has expired
    const elapsed = Date.now() - authorizedTx.timestamp
    if (elapsed > this.SESSION_TIMEOUT_MS) {
      this.sessionAuthorizations.delete(originator)
      this.authorizedTransactions.delete(originator)
      throw new Error('Transaction authorization has expired. Please try again.')
    }

    if (!Array.isArray(args.data)) {
      throw new TypeError('Signature request is missing data')
    }

    let digest: number[]
    if (args.data.length === 32) {
      // PushDrop supplies SHA-256(preimage) to the wallet signer.
      digest = args.data
    } else if (args.data.length >= 157) {
      // Retain compatibility with callers that supply the full BIP-143 preimage.
      digest = Hash.sha256(args.data)
    } else {
      throw new Error('Signature data is neither a 32-byte digest nor a full BIP-143 preimage')
    }

    if (!authorizedTx.authorizedDigests.has(Utils.toHex(digest))) {
      throw new Error('Signature request does not match the approved transaction')
    }
  }

  /**
   * Reads a Bitcoin varint from a byte array at a given offset.
   * Returns { value, nextOffset } on success, or null if unsupported (0xff) or truncated.
   * When throwOnTruncated is true, throws instead of returning null for truncated varints.
   */
  private readVarint(
    data: number[],
    offset: number,
    throwOnTruncated = false
  ): { value: number; nextOffset: number } | null {
    const firstByte = data[offset]
    if (firstByte === undefined) {
      return this.handleTruncatedVarint(throwOnTruncated)
    }
    if (firstByte < 0xfd) {
      return { value: firstByte, nextOffset: offset + 1 }
    }
    if (firstByte === 0xfd) {
      if (data.length < offset + 3) {
        return this.handleTruncatedVarint(throwOnTruncated)
      }
      return { value: data[offset + 1] | (data[offset + 2] << 8), nextOffset: offset + 3 }
    }
    if (firstByte === 0xfe) {
      if (data.length < offset + 5) {
        return this.handleTruncatedVarint(throwOnTruncated)
      }
      return {
        value:
          (data[offset + 1] |
            (data[offset + 2] << 8) |
            (data[offset + 3] << 16) |
            (data[offset + 4] << 24)) >>>
          0,
        nextOffset: offset + 5
      }
    }
    return null // 0xff not expected for script lengths
  }

  private handleTruncatedVarint(throwOnTruncated: boolean): null {
    if (throwOnTruncated) {
      throw new Error('Preimage too short for varint')
    }
    return null
  }

  /**
   * Grants session authorization for an originator.
   *
   * SECURITY: Session authorization is time-limited (60s) to prevent replay attacks.
   * After expiry, user must re-approve the transaction.
   *
   * @param originator - dApp identifier
   */
  private grantSessionAuthorization(originator: string): void {
    if (!originator || typeof originator !== 'string') {
      throw new Error('Invalid originator for session authorization')
    }
    const now = Date.now()
    this.cleanupExpiredAuthorizations(now)
    this.sessionAuthorizations.set(originator, now)
  }

  /**
   * Checks if an originator has valid session authorization.
   *
   * SECURITY: Automatically expires and removes stale authorizations.
   *
   * @param originator - dApp identifier
   * @returns true if valid session authorization exists
   */
  private hasSessionAuthorization(originator: string): boolean {
    if (!originator || typeof originator !== 'string') {
      return false
    }

    const timestamp = this.sessionAuthorizations.get(originator)
    if (!timestamp || typeof timestamp !== 'number') {
      return false
    }

    const elapsed = Date.now() - timestamp
    if (elapsed > this.SESSION_TIMEOUT_MS) {
      // Auto-cleanup expired authorization
      this.sessionAuthorizations.delete(originator)
      this.authorizedTransactions.delete(originator)
      return false
    }

    return true
  }

  /**
   * Checks if a signature request is for token issuance by examining the BIP-143 preimage.
   *
   * ISSUANCE DETECTION: Parses the scriptCode from the preimage and checks for ISSUE_MARKER.
   * This is needed because during issuance, createAction doesn't have P-basket outputs
   * (basket is added later via internalizeAction), so handleCreateAction isn't triggered.
   *
   * @param preimage - BIP-143 preimage data
   * @returns true if this is a token issuance signature
   */
  private isIssuanceFromPreimage(preimage: number[]): boolean {
    if (!Array.isArray(preimage) || preimage.length < 157) {
      return false
    }

    try {
      // Skip to scriptCode position: version(4) + hashPrevouts(32) + hashSequence(32) + outpoint(36)
      const scriptCodeLenOffset = 4 + 32 + 32 + 36

      if (scriptCodeLenOffset >= preimage.length) return false

      // Parse varint scriptCode length
      const varint = this.readVarint(preimage, scriptCodeLenOffset)
      if (varint === null) return false // 0xff not expected

      const { value: scriptLength, nextOffset: scriptDataOffset } = varint

      // Validate scriptLength
      if (scriptLength > 10000 || scriptDataOffset + scriptLength > preimage.length) {
        return false
      }

      // Extract and decode scriptCode
      const scriptBytes = preimage.slice(scriptDataOffset, scriptDataOffset + scriptLength)
      const lockingScript = LockingScript.fromBinary(scriptBytes)
      const decoded = PushDrop.decode(lockingScript)

      if (decoded.fields.length >= 1) {
        const assetId = Utils.toUTF8(decoded.fields[BTMS_FIELD.ASSET_ID])
        return assetId === ISSUE_MARKER
      }
    } catch {
      // Not a valid PushDrop script or parsing failed
      return false
    }

    return false
  }

  /**
   * Handles listActions requests that query BTMS token labels.
   *
   * Prompts the user when an app tries to list token transactions.
   * This provides transparency about which apps are accessing token history.
   *
   * @param args - listActions arguments
   * @param originator - dApp identifier
   * @throws Error if user denies authorization
   */
  private async handleListActions(args: ListActionsArgs, originator: string): Promise<void> {
    // Extract asset ID from labels if present
    let assetId: string | undefined

    if (args.labels && Array.isArray(args.labels)) {
      for (const label of args.labels) {
        if (typeof label === 'string') {
          // Parse p-label format: "p btms assetId <assetId>"
          const labelPrefix = 'p btms assetId '
          const parsedAssetId = label.startsWith(labelPrefix)
            ? label.slice(labelPrefix.length).trim()
            : ''
          if (parsedAssetId) {
            assetId = parsedAssetId
            break
          }
        }
      }
    }

    await this.promptForBTMSAccess(originator, assetId)
  }

  /**
   * Handles listOutputs requests that query BTMS token baskets.
   *
   * Prompts the user when an app tries to list token balances/UTXOs.
   * This provides transparency about which apps are accessing token data.
   *
   * @param args - listOutputs arguments
   * @param originator - dApp identifier
   * @throws Error if user denies authorization
   */
  private async handleListOutputs(args: ListOutputsArgs, originator: string): Promise<void> {
    // Extract asset ID from basket if present
    let assetId: string | undefined

    if (args.basket && typeof args.basket === 'string') {
      // Parse p-basket format: "p btms" or with asset ID
      const basketPrefix = 'p btms'
      if (args.basket === basketPrefix) {
        assetId = undefined
      } else if (args.basket.startsWith(`${basketPrefix} `)) {
        const parsedAssetId = args.basket.slice(basketPrefix.length).trim()
        assetId = parsedAssetId || undefined
      }
    }

    await this.promptForBTMSAccess(originator, assetId)
  }

  /**
   * Prompts user once per session for BTMS token access (listActions/listOutputs).
   */
  private async promptForBTMSAccess(originator: string, assetId?: string): Promise<void> {
    if (this.hasSessionAuthorization(originator)) return

    const promptData = {
      type: 'btms_access',
      action: 'access BTMS tokens',
      assetId
    }

    const message = JSON.stringify(promptData)
    const approved = await this.requestTokenAccess(originator, message)

    if (!approved) {
      throw new Error('User denied permission to access BTMS tokens')
    }

    this.grantSessionAuthorization(originator)
  }

  /**
   * Fetches metadata for a specific asset using btms.getAssetInfo.
   *
   * @param assetId - The asset ID to look up
   * @returns Token metadata or null if not found
   */
  private async getAssetMetadata(
    assetId: string
  ): Promise<{ name?: string; iconURL?: string } | null> {
    if (!this.btms) return null
    try {
      const info = await this.btms.getAssetInfo(assetId)
      if (info) {
        return {
          name: info.name,
          iconURL: info.metadata?.iconURL
        }
      }
    } catch {
      // Ignore errors
    }
    return null
  }

  /**
   * Checks if the createAction is for token issuance.
   *
   * ISSUANCE DETECTION: Token issuance is detected by:
   * 1. Output tags containing 'btms_type_issue'
   * 2. Locking script contains ISSUE_MARKER in assetId field
   *
   * @param args - createAction arguments
   * @returns true if this is a token issuance operation
   */
  private isTokenIssuance(args: CreateActionArgs): boolean {
    if (!args || !Array.isArray(args.outputs)) {
      return false
    }

    for (const output of args.outputs) {
      if (!output || typeof output !== 'object') continue
      if (this.outputIndicatesIssuance(output)) return true
    }

    return false
  }

  /**
   * Checks whether a single output indicates token issuance via tag or locking script.
   */
  private outputIndicatesIssuance(output: { tags?: unknown; lockingScript?: unknown }): boolean {
    // Check for btms_type_issue tag
    if (Array.isArray(output.tags) && output.tags.includes('btms_type_issue')) {
      return true
    }

    // Check locking script for ISSUE_MARKER
    if (!output.lockingScript || typeof output.lockingScript !== 'string') return false

    try {
      const lockingScript = LockingScript.fromHex(output.lockingScript)
      const decoded = PushDrop.decode(lockingScript)
      if (decoded.fields.length >= 1) {
        const assetId = Utils.toUTF8(decoded.fields[BTMS_FIELD.ASSET_ID])
        return assetId === ISSUE_MARKER
      }
    } catch {
      // Not a valid PushDrop script
    }
    return false
  }

  /**
   * Parses a BTMS token locking script to extract token information.
   *
   * BTMS TOKEN STRUCTURE:
   * - Field 0: assetId (or "ISSUE" for issuance)
   * - Field 1: amount (as string)
   * - Field 2: metadata (optional JSON string)
   * - Field 3: signature (present in signed PushDrop scripts)
   *
   * @param lockingScriptHex - Hex-encoded locking script
   * @returns Parsed token info or null if parsing fails
   */
  private parseTokenLockingScript(lockingScriptHex: string): ParsedTokenInfo | null {
    if (!lockingScriptHex || typeof lockingScriptHex !== 'string') {
      return null
    }

    try {
      const lockingScript = LockingScript.fromHex(lockingScriptHex)
      const decoded = PushDrop.decode(lockingScript)

      // BTMS tokens have 2-4 fields depending on metadata and signature presence
      if (decoded.fields.length < 2 || decoded.fields.length > 4) {
        return null
      }

      // Extract assetId and amount
      const assetId = Utils.toUTF8(decoded.fields[BTMS_FIELD.ASSET_ID])
      const amountStr = Utils.toUTF8(decoded.fields[BTMS_FIELD.AMOUNT])
      const amount = Number(amountStr)

      // Validate amount
      if (!/^[1-9]\d*$/.test(amountStr) || !Number.isSafeInteger(amount)) {
        return null
      }

      // Validate assetId
      if (!assetId || typeof assetId !== 'string') {
        return null
      }

      // Try to parse metadata from field 2 if it exists
      let metadata: ParsedTokenInfo['metadata']
      if (decoded.fields.length >= 3) {
        try {
          const potentialMetadata = Utils.toUTF8(decoded.fields[BTMS_FIELD.METADATA])
          // Only parse if it looks like JSON (starts with {)
          if (
            potentialMetadata &&
            typeof potentialMetadata === 'string' &&
            potentialMetadata.startsWith('{')
          ) {
            const parsed = JSON.parse(potentialMetadata)
            // Validate metadata is an object
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              metadata = parsed
            }
          }
        } catch {
          // Field 2 might be a signature, not metadata - that's fine
        }
      }

      return { assetId, amount, metadata }
    } catch {
      // Parsing failed - not a valid BTMS token
      return null
    }
  }
}
