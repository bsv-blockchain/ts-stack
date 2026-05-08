import { CreateActionArgs, CreateActionInput, CreateActionOutput, CreateActionResult, CreateSignatureArgs, Hash, ListActionsArgs, LockingScript, PushDrop, Transaction, Utils } from '@bsv/sdk'
import { PermissionsModule } from '@bsv/wallet-toolbox-client'
import { BTMS, ISSUE_MARKER } from '@bsv/btms'
import { AuthorizedTransaction, TokenSpendInfo, P_BASKET_PREFIX, BTMS_FIELD, ParsedTokenInfo } from './types'

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
 * 2. createSignature: Verifies session authorization + preimage integrity
 * 3. Session authorization: Time-limited (60s) to prevent replay attacks
 * 4. Preimage verification: Ensures signed transaction matches approved transaction
 * 
 * AUTHORIZATION FLOW:
 * 1. createAction → extract token info → prompt user → grant session auth
 * 2. createSignature → verify session auth → verify preimage → allow signature
 * 
 * ISSUANCE HANDLING:
 * Token issuance is auto-approved (no user prompt) because:
 * - Issuance creates new tokens (doesn't spend existing ones)
 * - Detected by ISSUE_MARKER in locking script or btms_issue tag
 * - Short signatures (<157 bytes) are assumed to be issuance
 */
export class BasicTokenModule implements PermissionsModule {
  private readonly requestTokenAccess: (app: string, message: string) => Promise<boolean>
  private readonly btms: BTMS

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
   * SECURITY: Stores cryptographic commitments (hashOutputs, outpoints) to verify
   * that createSignature is signing the exact transaction the user approved.
   * This prevents a malicious dApp from getting approval for one transaction
   * and then signing a different transaction.
   * 
   * Key: originator (dApp identifier)
   * Value: authorized transaction details (reference, hashOutputs, outpoints, timestamp)
   */
  private readonly authorizedTransactions: Map<string, AuthorizedTransaction> = new Map()

  /**
   * Creates a new BasicTokenModule instance.
   * 
   * @param requestTokenAccess - Callback to prompt user for token spending approval.
   *   Should return true if user approves, false if denied.
   *   SECURITY: This callback MUST be implemented securely to prevent UI spoofing.
   * @param btms - BTMS instance for fetching token metadata via getAssetInfo
   */
  constructor(
    requestTokenAccess: (app: string, message: string) => Promise<boolean>,
    btms: BTMS
  ) {
    if (!requestTokenAccess || typeof requestTokenAccess !== 'function') {
      throw new Error('requestTokenAccess callback is required')
    }
    this.requestTokenAccess = requestTokenAccess
    this.btms = btms

    // Start periodic cleanup of expired sessions
    this.startSessionCleanup()
  }

  /**
   * Periodic cleanup of expired session authorizations.
   * Runs every 30 seconds to prevent memory leaks.
   */
  private startSessionCleanup(): void {
    setInterval(() => {
      const now = Date.now()
      for (const [originator, timestamp] of this.sessionAuthorizations.entries()) {
        if (now - timestamp > this.SESSION_TIMEOUT_MS) {
          this.sessionAuthorizations.delete(originator)
        }
      }
      for (const [originator, tx] of this.authorizedTransactions.entries()) {
        if (now - tx.timestamp > this.SESSION_TIMEOUT_MS) {
          this.authorizedTransactions.delete(originator)
        }
      }
    }, 30000) // Every 30 seconds
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

    // Input validation
    if (!method || typeof method !== 'string') {
      throw new Error('Invalid method')
    }
    if (!originator || typeof originator !== 'string') {
      throw new Error('Invalid originator')
    }
    if (!args || typeof args !== 'object') {
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
      await this.handleListOutputs(args, originator)
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
   * 2. hashOutputs - BIP-143 hash of all outputs (prevents output modification)
   * 3. authorizedOutpoints - Whitelist of inputs that can be signed (prevents input substitution)
   * 4. timestamp - For expiry checking
   *
   * @param result - createAction response
   * @param originator - dApp identifier
   */
  private async captureAuthorizedTransaction(
    result: CreateActionResult,
    originator: string
  ): Promise<void> {
    if (!result || typeof result !== 'object' || !result.signableTransaction) {
      return
    }

    try {
      const { tx, reference } = result.signableTransaction

      if (!tx || !reference) {
        return
      }

      const transaction = Transaction.fromAtomicBEEF(tx)

      // Compute hashOutputs (BIP-143 style) from the transaction outputs
      const hashOutputs = this.computeHashOutputs(transaction)

      // Collect all input outpoints as authorized
      const authorizedOutpoints = this.collectAuthorizedOutpoints(transaction)

      // Store the authorized transaction data
      this.authorizedTransactions.set(originator, {
        reference,
        hashOutputs,
        authorizedOutpoints,
        timestamp: Date.now()
      })
    } catch (_captureError) {
      // Don't throw - we'll fall back to session-based auth
    }
  }

  /**
   * Collects authorized outpoints from all inputs of a transaction.
   */
  private collectAuthorizedOutpoints(transaction: Transaction): Set<string> {
    const authorizedOutpoints = new Set<string>()
    if (!Array.isArray(transaction.inputs)) return authorizedOutpoints

    for (const input of transaction.inputs) {
      if (!input || typeof input !== 'object') continue
      const txid = input.sourceTXID || input.sourceTransaction?.id('hex')
      if (!txid || typeof txid !== 'string') continue
      const vout = input.sourceOutputIndex
      if (typeof vout === 'number' && vout >= 0) {
        authorizedOutpoints.add(`${txid}.${vout}`)
      }
    }
    return authorizedOutpoints
  }

  /**
   * Computes BIP-143 hashOutputs from a transaction.
   * 
   * SECURITY: This hash commits to all transaction outputs. Any modification
   * to outputs (amounts, recipients, scripts) will change this hash.
   * 
   * @param tx - Transaction to compute hashOutputs for
   * @returns Hex-encoded double-SHA256 hash of all outputs
   */
  private computeHashOutputs(tx: Transaction): string {
    if (!tx || typeof tx !== 'object' || !Array.isArray(tx.outputs)) {
      throw new Error('Invalid transaction for hashOutputs computation')
    }
    // Serialize all outputs: satoshis (8 bytes LE) + scriptLen (varint) + script
    const outputBytes: number[] = []

    for (const output of tx.outputs) {
      // Satoshis as 8-byte little-endian
      const satoshis = output.satoshis ?? 0
      for (let i = 0; i < 8; i++) {
        outputBytes.push(Number((BigInt(satoshis) >> BigInt(i * 8)) & BigInt(0xff)))
      }

      // Script length as varint + script bytes
      const scriptBytes = output.lockingScript?.toBinary() ?? []
      const scriptLen = scriptBytes.length
      if (scriptLen < 0xfd) {
        outputBytes.push(scriptLen)
      } else if (scriptLen <= 0xffff) {
        outputBytes.push(0xfd, scriptLen & 0xff, (scriptLen >> 8) & 0xff)
      } else {
        outputBytes.push(0xfe, scriptLen & 0xff, (scriptLen >> 8) & 0xff, (scriptLen >> 16) & 0xff, (scriptLen >> 24) & 0xff)
      }
      outputBytes.push(...scriptBytes)
    }

    // Double SHA-256
    const hash = Hash.hash256(outputBytes)
    return Utils.toHex(hash)
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
   * - btms_issue tag in outputs
   * - No inputs (issuance doesn't spend existing UTXOs)
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

    // No inputs = likely issuance (creating new tokens)
    if (!args.inputs || args.inputs.length === 0) {
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
      return { assetId, tokenName, iconURL, totalInputAmount: 0, inputAmountSource: 'none', assetIdMismatch }
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
      beefInputAmount += parsed.amount;
      ({ tokenName, iconURL } = this.applyMetadata(parsed, tokenName, iconURL))
    }

    const inputAmountSource: TokenSpendInfo['inputAmountSource'] = beefInputAmount > 0 ? 'beef' : 'none'
    return { assetId, tokenName, iconURL, totalInputAmount: beefInputAmount, inputAmountSource, assetIdMismatch }
  }

  /**
   * Resolves a BTMS token from a single input via BEEF lookup.
   * Returns null if the input is invalid, malformed, or an issuance marker.
   */
  private resolveTokenForInput(input: CreateActionInput, inputBEEF: number[]): ParsedTokenInfo | null {
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
    } catch (_parseError) {
      // BEEF or script parsing failed — cannot identify token
      return null
    }
  }

  /**
   * Parses outputs to extract token send/change amounts and asset metadata.
   */
  private parseOutputAmounts(args: CreateActionArgs, knownAssetId: string): {
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
      return { assetId, tokenName, iconURL, outputSendAmount, outputChangeAmount, hasTokenOutputs, assetIdMismatch }
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
      hasTokenOutputs = true;
      ({ tokenName, iconURL } = this.applyMetadata(parsed, tokenName, iconURL))
      if (output.basket && typeof output.basket === 'string' && output.basket.startsWith(P_BASKET_PREFIX)) {
        outputChangeAmount += parsed.amount
      } else {
        outputSendAmount += parsed.amount
      }
    }

    return { assetId, tokenName, iconURL, outputSendAmount, outputChangeAmount, hasTokenOutputs, assetIdMismatch }
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
      tokenName: (parsed.metadata?.name && typeof parsed.metadata.name === 'string')
        ? parsed.metadata.name
        : tokenName,
      iconURL: (parsed.metadata?.iconURL && typeof parsed.metadata.iconURL === 'string')
        ? parsed.metadata.iconURL
        : iconURL
    }
  }

  /**
   * Prompts user for token spend authorization with detailed information.
   * 
   * SECURITY: The prompt data is JSON-encoded to prevent injection attacks.
   * The UI component (TokenAccessPrompt) is responsible for safely rendering this data.
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
   * 2. The preimage matches the authorized transaction (prevents transaction substitution)
   * 
   * ISSUANCE HANDLING:
   * Token issuance is auto-approved via multiple detection methods:
   * - Session auth from createAction (if ISSUE_MARKER or btms_issue tag detected)
   * - Preimage parsing (checks for ISSUE_MARKER in scriptCode)
   * - Short signatures (<157 bytes, not full BIP-143 preimages)
   * 
   * @param args - createSignature arguments
   * @param originator - dApp identifier
   * @throws Error if authorization is denied or verification fails
   */
  private async handleCreateSignature(args: CreateSignatureArgs, originator: string): Promise<void> {
    // Input validation
    if (!args || typeof args !== 'object') {
      throw new Error('Invalid createSignature args')
    }
    if (!originator || typeof originator !== 'string') {
      throw new Error('Invalid originator')
    }

    // Ensure session authorization exists (grant it if this is issuance; prompt otherwise)
    if (!this.hasSessionAuthorization(originator)) {
      await this.authorizeOrGrantIssuance(args, originator)
    }

    // Verify the signature request matches the authorized transaction
    this.verifyAuthorizedTransaction(args, originator)
  }

  /**
   * Grants session authorization for issuance requests, or prompts the user otherwise.
   */
  private async authorizeOrGrantIssuance(args: CreateSignatureArgs, originator: string): Promise<void> {
    // Method 1: Parse BIP-143 preimage for ISSUE_MARKER
    if (args.data && args.data.length >= 157 && this.isIssuanceFromPreimage(args.data)) {
      this.grantSessionAuthorization(originator)
      return
    }

    // Method 2: Short signatures (not full BIP-143 preimages) are assumed to be issuance
    // This handles PushDrop signatures that don't include full transaction context
    if (args.data && args.data.length > 0 && args.data.length < 157) {
      this.grantSessionAuthorization(originator)
      return
    }

    // No authorization and not issuance - require user approval
    await this.promptForGenericAuthorization(originator)
  }

  /**
   * Verifies the preimage/data against the stored authorized transaction (if any).
   */
  private verifyAuthorizedTransaction(args: CreateSignatureArgs, originator: string): void {
    const authorizedTx = this.authorizedTransactions.get(originator)
    if (!authorizedTx) {
      // No transaction data captured - allow based on session auth alone
      return
    }

    // Check if authorization has expired
    const elapsed = Date.now() - authorizedTx.timestamp
    if (elapsed > this.SESSION_TIMEOUT_MS) {
      this.sessionAuthorizations.delete(originator)
      this.authorizedTransactions.delete(originator)
      throw new Error('Transaction authorization has expired. Please try again.')
    }

    // Verify the preimage matches the authorized transaction
    if (args.data && args.data.length >= 157) {
      this.verifyPreimage(args.data, authorizedTx, originator)
    }
  }

  /**
   * Verifies that a BIP-143 preimage matches the authorized transaction.
   * 
   * SECURITY: This prevents a malicious dApp from:
   * 1. Getting approval for one transaction
   * 2. Signing a different transaction with different outputs or inputs
   * 
   * BIP-143 preimage structure:
   * - Version: 4 bytes
   * - hashPrevouts: 32 bytes
   * - hashSequence: 32 bytes
   * - Outpoint (txid + vout): 36 bytes
   * - scriptCode: variable (varint length + script)
   * - Value: 8 bytes
   * - Sequence: 4 bytes
   * - hashOutputs: 32 bytes
   * - Locktime: 4 bytes
   * - Sighash type: 4 bytes
   * 
   * Verification checks:
   * 1. Outpoint being signed is in our authorized list
   * 2. hashOutputs matches what we computed from createAction
   * 
   * @param data - BIP-143 preimage bytes
   * @param authorizedTx - Authorized transaction data from createAction
   * @param _originator - dApp identifier (unused, for future logging)
   * @throws Error if verification fails
   */
  private verifyPreimage(data: number[], authorizedTx: AuthorizedTransaction, _originator: string): void {
    // Input validation
    if (!Array.isArray(data) || data.length < 157) {
      // Too short to be a valid BIP-143 preimage - skip verification
      return
    }
    if (!authorizedTx || typeof authorizedTx !== 'object') {
      throw new Error('Invalid authorized transaction data')
    }

    try {
      // Extract outpoint (bytes 68-103: 32-byte txid reversed + 4-byte vout)
      const outpointStart = 4 + 32 + 32 // After version, hashPrevouts, hashSequence

      if (data.length < outpointStart + 36) {
        throw new Error('Preimage too short to extract outpoint')
      }

      const txidBytes = data.slice(outpointStart, outpointStart + 32)
      // Reverse the txid bytes (Bitcoin uses little-endian)
      txidBytes.reverse()
      const txid = Utils.toHex(txidBytes)
      const voutBytes = data.slice(outpointStart + 32, outpointStart + 36)
      const vout = voutBytes[0] | (voutBytes[1] << 8) | (voutBytes[2] << 16) | (voutBytes[3] << 24)
      const outpoint = `${txid}.${vout}`

      // SECURITY: Verify the outpoint is in our authorized list
      if (!authorizedTx.authorizedOutpoints.has(outpoint)) {
        throw new Error(`Unauthorized outpoint: ${outpoint}. This transaction was not approved.`)
      }

      // Parse scriptCode varint to find hashOutputs position
      const scriptCodeLenStart = outpointStart + 36
      if (data.length < scriptCodeLenStart + 1) {
        throw new Error('Preimage too short to parse scriptCode length')
      }

      const varint = this.readVarint(data, scriptCodeLenStart, true)
      if (varint === null) {
        // 0xff varint not expected for script lengths
        return
      }
      const { value: scriptCodeLen, nextOffset: scriptCodeDataStart } = varint

      // Validate scriptCode length is reasonable (prevent DoS)
      if (scriptCodeLen < 0 || scriptCodeLen > 10000) {
        throw new Error('Invalid scriptCode length in preimage')
      }

      // hashOutputs starts after scriptCode + value(8) + sequence(4)
      const hashOutputsStart = scriptCodeDataStart + scriptCodeLen + 8 + 4

      if (hashOutputsStart + 32 > data.length) {
        throw new Error('Preimage too short to extract hashOutputs')
      }

      const hashOutputsBytes = data.slice(hashOutputsStart, hashOutputsStart + 32)
      const preimageHashOutputs = Utils.toHex(hashOutputsBytes)

      // SECURITY: Verify hashOutputs matches what user approved
      if (preimageHashOutputs !== authorizedTx.hashOutputs) {
        throw new Error('Transaction outputs do not match approved transaction. Possible attack detected.')
      }
    } catch (error) {
      // Re-throw security-critical errors
      if (error instanceof Error &&
        (error.message.includes('Unauthorized') ||
          error.message.includes('do not match') ||
          error.message.includes('attack'))) {
        throw error
      }
      // For parsing errors, fall back to session auth (don't block legitimate transactions)
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
    if (firstByte < 0xfd) {
      return { value: firstByte, nextOffset: offset + 1 }
    }
    if (firstByte === 0xfd) {
      if (data.length < offset + 3) {
        if (throwOnTruncated) throw new Error('Preimage too short for varint')
        return null
      }
      return { value: data[offset + 1] | (data[offset + 2] << 8), nextOffset: offset + 3 }
    }
    if (firstByte === 0xfe) {
      if (data.length < offset + 5) {
        if (throwOnTruncated) throw new Error('Preimage too short for varint')
        return null
      }
      return {
        value: data[offset + 1] | (data[offset + 2] << 8) | (data[offset + 3] << 16) | (data[offset + 4] << 24),
        nextOffset: offset + 5
      }
    }
    return null // 0xff not expected for script lengths
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
    this.sessionAuthorizations.set(originator, Date.now())
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
      if (scriptLength < 0 || scriptLength > 10000 || scriptDataOffset + scriptLength > preimage.length) {
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
    } catch (_notPushDrop) {
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
          const parsedAssetId = label.startsWith(labelPrefix) ? label.slice(labelPrefix.length).trim() : ''
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
  private async handleListOutputs(args: any, originator: string): Promise<void> {
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
  private async getAssetMetadata(assetId: string): Promise<{ name?: string; iconURL?: string } | null> {
    try {
      const info = await this.btms.getAssetInfo(assetId)
      if (info) {
        return {
          name: info.name,
          iconURL: info.metadata?.iconURL
        }
      }
    } catch (_lookupError) {
      // Asset info lookup failed — return null
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
    } catch (_notPushDropScript) {
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
      if (Number.isNaN(amount) || amount <= 0 || !Number.isFinite(amount)) {
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
          if (potentialMetadata && typeof potentialMetadata === 'string' && potentialMetadata.startsWith('{')) {
            const parsed = JSON.parse(potentialMetadata)
            // Validate metadata is an object
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              metadata = parsed
            }
          }
        } catch (_notJsonMetadata) {
          // Field 2 might be a signature, not metadata - that's fine
        }
      }

      return { assetId, amount, metadata }
    } catch (_parseFailure) {
      // Parsing failed - not a valid BTMS token
      return null
    }
  }

}
