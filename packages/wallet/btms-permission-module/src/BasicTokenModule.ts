import { CreateActionArgs, CreateActionResult, CreateSignatureArgs, Hash, ListActionsArgs, LockingScript, PushDrop, Transaction, Utils } from '@bsv/sdk'
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
  private sessionAuthorizations: Map<string, number> = new Map()
  private readonly SESSION_TIMEOUT_MS = 60000 // 60 seconds

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
  private authorizedTransactions: Map<string, AuthorizedTransaction> = new Map()

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
      const authorizedOutpoints = new Set<string>()
      if (Array.isArray(transaction.inputs)) {
        for (const input of transaction.inputs) {
          if (!input || typeof input !== 'object') continue

          const txid = input.sourceTXID || input.sourceTransaction?.id('hex')
          if (txid && typeof txid === 'string') {
            const vout = input.sourceOutputIndex
            if (typeof vout === 'number' && vout >= 0) {
              const outpoint = `${txid}.${vout}`
              authorizedOutpoints.add(outpoint)
            }
          }
        }
      }

      // Store the authorized transaction data
      this.authorizedTransactions.set(originator, {
        reference,
        hashOutputs,
        authorizedOutpoints,
        timestamp: Date.now()
      })
    } catch (error) {
      // Don't throw - we'll fall back to session-based auth
    }
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
        outputBytes.push(0xfd)
        outputBytes.push(scriptLen & 0xff)
        outputBytes.push((scriptLen >> 8) & 0xff)
      } else {
        outputBytes.push(0xfe)
        outputBytes.push(scriptLen & 0xff)
        outputBytes.push((scriptLen >> 8) & 0xff)
        outputBytes.push((scriptLen >> 16) & 0xff)
        outputBytes.push((scriptLen >> 24) & 0xff)
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
    let sendAmount = 0
    let changeAmount = 0
    let totalInputAmount = 0
    let outputSendAmount = 0
    let outputChangeAmount = 0
    let hasTokenOutputs = false
    let inputAmountSource: TokenSpendInfo['inputAmountSource'] = 'none'
    let inputAssetId: string | undefined
    let outputAssetId: string | undefined
    let assetIdMismatch = false
    let tokenName = 'BTMS Token'
    let assetId = ''
    let iconURL: string | undefined
    let recipient: string | undefined

    // Input validation
    if (!args || typeof args !== 'object') {
      throw new Error('Invalid args for extractTokenSpendInfo')
    }

    // Parse inputs using inputBEEF to get total input amount (if available)
    let beefInputAmount = 0
    if (args.inputBEEF && Array.isArray(args.inputs)) {
      for (const input of args.inputs) {
        if (!input?.outpoint || typeof input.outpoint !== 'string') continue
        const [txid, voutStr] = input.outpoint.split('.')
        const outputIndex = Number(voutStr)
        if (!txid || !Number.isFinite(outputIndex) || outputIndex < 0) continue

        try {
          const tx = Transaction.fromBEEF(args.inputBEEF as number[], txid)
          const lockingScript = tx.outputs?.[outputIndex]?.lockingScript
          const scriptHex = lockingScript?.toHex?.()
          if (!scriptHex) continue

          const parsed = this.parseTokenLockingScript(scriptHex)
          if (!parsed || parsed.assetId === ISSUE_MARKER) continue

          if (!inputAssetId) {
            inputAssetId = parsed.assetId
          } else if (parsed.assetId !== inputAssetId) {
            assetIdMismatch = true
            continue
          }

          if (!assetId) {
            assetId = parsed.assetId
          } else if (parsed.assetId !== assetId) {
            assetIdMismatch = true
            continue
          }

          beefInputAmount += parsed.amount

          if (parsed.metadata?.name && typeof parsed.metadata.name === 'string') {
            tokenName = parsed.metadata.name
          }
          if (parsed.metadata?.iconURL && typeof parsed.metadata.iconURL === 'string') {
            iconURL = parsed.metadata.iconURL
          }
        } catch {
          // Ignore malformed input BEEF
        }
      }
    }

    if (beefInputAmount > 0) {
      totalInputAmount = beefInputAmount
      inputAmountSource = 'beef'
    }

    // Parse ALL output locking scripts to extract token metadata
    if (Array.isArray(args.outputs)) {
      for (const output of args.outputs) {
        if (output?.lockingScript && typeof output.lockingScript === 'string') {
          const parsed = this.parseTokenLockingScript(output.lockingScript)
          if (parsed) {
            if (parsed.assetId === ISSUE_MARKER) {
              continue
            }
            // Get asset ID from first valid token
            if (!outputAssetId) {
              outputAssetId = parsed.assetId
            } else if (parsed.assetId !== outputAssetId) {
              assetIdMismatch = true
              continue
            }

            if (!assetId) {
              assetId = parsed.assetId
            } else if (parsed.assetId !== assetId) {
              assetIdMismatch = true
              continue
            }

            hasTokenOutputs = true
            if (parsed.metadata?.name && typeof parsed.metadata.name === 'string') {
              tokenName = parsed.metadata.name
            }
            if (parsed.metadata?.iconURL && typeof parsed.metadata.iconURL === 'string') {
              iconURL = parsed.metadata.iconURL
            }

            // Determine if this is a change output or send output
            // Basket presence indicates change (returning to self)
            if (output.basket && typeof output.basket === 'string' && output.basket.startsWith(P_BASKET_PREFIX)) {
              outputChangeAmount += parsed.amount
            } else {
              outputSendAmount += parsed.amount
            }
          }
        }
      }
    }

    if (hasTokenOutputs) {
      sendAmount = outputSendAmount
      changeAmount = outputChangeAmount
    }

    if (assetIdMismatch || (inputAssetId && outputAssetId && inputAssetId !== outputAssetId)) {
      throw new Error('Asset swap support coming soon')
    }

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
      outputSendAmount,
      outputChangeAmount,
      hasTokenOutputs,
      inputAmountSource,
      tokenName,
      assetId,
      recipient,
      iconURL,
      actionDescription: args.description || 'Token transaction'
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

    // Check if we have session authorization from createAction
    if (this.hasSessionAuthorization(originator)) {
      // Session auth exists - proceed to verification
    } else {
      // No session auth - check if this is token issuance

      // Method 1: Parse BIP-143 preimage for ISSUE_MARKER
      if (args.data && args.data.length >= 157) {
        if (this.isIssuanceFromPreimage(args.data)) {
          this.grantSessionAuthorization(originator)
          return
        }
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

    // Verify the signature request matches the authorized transaction
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
      const txid = Utils.toHex(txidBytes.reverse())
      const voutBytes = data.slice(outpointStart + 32, outpointStart + 36)
      const vout = voutBytes[0] | (voutBytes[1] << 8) | (voutBytes[2] << 16) | (voutBytes[3] << 24)
      const outpoint = `${txid}.${vout}`

      // SECURITY: Verify the outpoint is in our authorized list
      if (!authorizedTx.authorizedOutpoints.has(outpoint)) {
        throw new Error(`Unauthorized outpoint: ${outpoint}. This transaction was not approved.`)
      }

      // Parse scriptCode length to find hashOutputs position
      const scriptCodeLenStart = outpointStart + 36

      if (data.length < scriptCodeLenStart + 1) {
        throw new Error('Preimage too short to parse scriptCode length')
      }

      let scriptCodeLen: number
      let scriptCodeDataStart: number

      const firstByte = data[scriptCodeLenStart]
      if (firstByte < 0xfd) {
        scriptCodeLen = firstByte
        scriptCodeDataStart = scriptCodeLenStart + 1
      } else if (firstByte === 0xfd) {
        if (data.length < scriptCodeLenStart + 3) {
          throw new Error('Preimage too short for varint')
        }
        scriptCodeLen = data[scriptCodeLenStart + 1] | (data[scriptCodeLenStart + 2] << 8)
        scriptCodeDataStart = scriptCodeLenStart + 3
      } else if (firstByte === 0xfe) {
        if (data.length < scriptCodeLenStart + 5) {
          throw new Error('Preimage too short for varint')
        }
        scriptCodeLen = data[scriptCodeLenStart + 1] | (data[scriptCodeLenStart + 2] << 8) |
          (data[scriptCodeLenStart + 3] << 16) | (data[scriptCodeLenStart + 4] << 24)
        scriptCodeDataStart = scriptCodeLenStart + 5
      } else {
        // 0xff varint not expected for script lengths
        return
      }

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
      // Skip to scriptCode position
      let offset = 4 + 32 + 32 + 36 // version + hashPrevouts + hashSequence + outpoint

      if (offset >= preimage.length) {
        return false
      }

      // Parse varint scriptCode length
      const firstByte = preimage[offset]
      let scriptLength: number

      if (firstByte < 0xfd) {
        scriptLength = firstByte
        offset += 1
      } else if (firstByte === 0xfd) {
        if (offset + 3 > preimage.length) return false
        scriptLength = preimage[offset + 1] | (preimage[offset + 2] << 8)
        offset += 3
      } else if (firstByte === 0xfe) {
        if (offset + 5 > preimage.length) return false
        scriptLength = preimage[offset + 1] | (preimage[offset + 2] << 8) |
          (preimage[offset + 3] << 16) | (preimage[offset + 4] << 24)
        offset += 5
      } else {
        return false // 0xff not expected
      }

      // Validate scriptLength
      if (scriptLength < 0 || scriptLength > 10000 || offset + scriptLength > preimage.length) {
        return false
      }

      // Extract and decode scriptCode
      const scriptBytes = preimage.slice(offset, offset + scriptLength)
      const lockingScript = LockingScript.fromBinary(scriptBytes)
      const decoded = PushDrop.decode(lockingScript)

      // Check for ISSUE_MARKER in first field
      if (decoded.fields.length >= 1) {
        const assetId = Utils.toUTF8(decoded.fields[BTMS_FIELD.ASSET_ID])
        return assetId === ISSUE_MARKER
      }
    } catch (e) {
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
          const match = label.match(/^p btms assetId (.+)$/)
          if (match && match[1]) {
            assetId = match[1]
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
      const match = args.basket.match(/^p btms(?:\s+(.+))?$/)
      if (match && match[1]) {
        assetId = match[1]
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
      if (!output || typeof output !== 'object') {
        continue
      }

      // Check for btms_type_issue tag
      if (Array.isArray(output.tags) && output.tags.includes('btms_type_issue')) {
        return true
      }

      // Check locking script for ISSUE_MARKER
      if (output.lockingScript && typeof output.lockingScript === 'string') {
        try {
          const lockingScript = LockingScript.fromHex(output.lockingScript)
          const decoded = PushDrop.decode(lockingScript)

          if (decoded.fields.length >= 1) {
            const assetId = Utils.toUTF8(decoded.fields[BTMS_FIELD.ASSET_ID])
            if (assetId === ISSUE_MARKER) {
              return true
            }
          }
        } catch (e) {
          // Not a valid PushDrop script, continue checking
        }
      }
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
      if (isNaN(amount) || amount <= 0 || !Number.isFinite(amount)) {
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
        } catch (e) {
          // Field 2 might be a signature, not metadata - that's fine
        }
      }

      return { assetId, amount, metadata }
    } catch (e) {
      // Parsing failed - not a valid BTMS token
      return null
    }
  }

}
