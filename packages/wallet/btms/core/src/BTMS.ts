/**
 * BTMS - Basic Token Management System
 * 
 * Main class for managing BTMS tokens. Provides high-level methods for:
 * - Issuing new tokens
 * - Sending tokens to recipients
 * - Receiving tokens from others
 * - Querying token balances and assets
 * 
 */

import {
  WalletClient,
  Transaction,
  Beef,
  Utils,
  TopicBroadcaster,
  LookupResolver,
  LockingScript,
  CreateActionArgs,
  CreateActionOutput,
  ListOutputsResult,
  ListOutputsArgs,
  ListActionsResult,
  TXIDHexString,
  HexString,
  PubKeyHex,
  OutpointString,
  LabelStringUnder300Bytes,
  OutputTagStringUnder300Bytes,
  PositiveIntegerOrZero,
  Random,
  WalletInterface,
  CommsLayer,
  AtomicBEEF
} from '@bsv/sdk'

import { BTMSToken } from './BTMSToken.js'
import { parseCustomInstructions, decodeOutputAmount, decodeInputAmount } from './utils.js'
import type {
  BTMSConfig,
  BTMSAsset,
  BTMSAssetMetadata,
  BTMSTokenOutput,
  IssueResult,
  SendResult,
  AcceptResult,
  RefundResult,
  TokenForRecipient,
  IncomingToken,
  OwnershipProof,
  ProvenToken,
  ProveOwnershipResult,
  VerifyOwnershipResult,
  SelectionOptions,
  SelectionResult,
  ChangeStrategyOptions,
  ChangeContext,
  ChangeOutput,
  BurnResult,
  BTMSTransaction,
  GetTransactionsResult,
} from './types.js'
import {
  BTMS_TOPIC,
  BTMS_LOOKUP_SERVICE,
  BTMS_PROTOCOL_ID,
  BTMS_BASKET,
  BTMS_LABEL_PREFIX,
  BTMS_MESSAGE_BOX,
  DEFAULT_TOKEN_SATOSHIS,
  ISSUE_MARKER
} from './constants.js'

/**
 * BTMS - Basic Token Management System
 * 
 * @example
 * ```typescript
 * // Create a BTMS instance
 * const btms = new BTMS()
 * 
 * // Issue new tokens
 * const result = await btms.issue(1000, { name: 'GOLD', description: 'A test token' })
 * console.log('Asset ID:', result.assetId)
 * 
 * // Check balance
 * const balance = await btms.getBalance(result.assetId)
 * console.log('Balance:', balance)
 * 
 * // Send tokens
 * await btms.send(result.assetId, recipientPubKey, 100)
 * 
 * // List all assets
 * const assets = await btms.listAssets()
 * ```
 */
export class BTMS {
  private wallet: WalletInterface
  private networkPreset: 'local' | 'mainnet' | 'testnet'
  private comms?: CommsLayer
  private tokenTemplate: BTMSToken
  private cachedIdentityKey?: PubKeyHex
  private originator?: string
  private static readonly LIST_OUTPUTS_PAGE_SIZE = 1000
  private static readonly MAX_LIST_OUTPUTS_PAGES = 1000
  private static readonly BROADCAST_MAX_ATTEMPTS = 3

  constructor(config: BTMSConfig = {}) {
    // Apply defaults
    this.wallet = (config.wallet ?? new WalletClient('auto'))
    this.networkPreset = config.networkPreset ?? 'mainnet'
    this.comms = config.comms

    this.tokenTemplate = new BTMSToken(
      this.wallet,
      BTMS_PROTOCOL_ID,
      this.originator
    )
  }

  /**
   * Set the originator for wallet calls.
   * This is passed through to all wallet operations.
   */
  setOriginator(originator: string): void {
    this.originator = originator
    // Recreate token template with new originator
    this.tokenTemplate = new BTMSToken(
      this.wallet,
      BTMS_PROTOCOL_ID,
      this.originator
    )
  }

  // ---------------------------------------------------------------------------
  // Token Issuance
  // ---------------------------------------------------------------------------

  /**
   * Issue new BTMS tokens.
   * 
   * Creates a new token with the specified amount and optional metadata.
   * The token will be stored in basket 'p btms <assetId>' where assetId is
   * the canonical txid.0 format determined after transaction creation.
   * 
   * @param amount - Number of tokens to issue (positive integer)
   * @param metadata - Optional metadata including name, description, iconURL, etc.
   * @returns Issue result with txid and assetId
   * 
   * @example
   * ```typescript
   * const result = await btms.issue(1000000, {
   *   name: 'GOLD',
   *   description: 'Represents 1 gram of gold',
   *   iconURL: 'https://example.com/gold.png' // or a UHRP url
   * })
   * console.log('Asset ID:', result.assetId) // e.g., 'abc123...def.0'
   * ```
   */
  async issue(amount: number, metadata?: BTMSAssetMetadata): Promise<IssueResult> {
    try {
      // Generate random derivation keys for privacy
      const derivationPrefix = Utils.toBase64(Random(32))
      const derivationSuffix = Utils.toBase64(Random(32))
      const keyID = `${derivationPrefix} ${derivationSuffix}`

      // Create the issuance locking script
      const lockingScript = await this.tokenTemplate.createIssuance(amount, keyID, metadata)
      const lockingScriptHex = lockingScript.toHex()

      const tokenName = metadata?.name ?? 'tokens'

      const monthLabel = this.getMonthLabel()
      const timestampLabel = this.getTimestampLabel()
      const monthTag = this.getMonthTag()
      const timestampTag = this.getTimestampTag()
      const counterparty = await this.getIdentityKey()

      // Build the action WITHOUT a basket - we'll internalize after to use the real assetId
      const args: CreateActionArgs = {
        description: `Issue ${amount} ${tokenName}`,
        labels: [
          `${BTMS_LABEL_PREFIX}type issue` as LabelStringUnder300Bytes,
          `${BTMS_LABEL_PREFIX}direction incoming` as LabelStringUnder300Bytes,
          timestampLabel,
          monthLabel,
          `${BTMS_LABEL_PREFIX}counterparty ${counterparty}` as LabelStringUnder300Bytes
        ],
        outputs: [
          {
            satoshis: DEFAULT_TOKEN_SATOSHIS,
            lockingScript: lockingScriptHex,
            customInstructions: JSON.stringify({
              derivationPrefix,
              derivationSuffix
            }),
            outputDescription: `Issue ${amount} ${tokenName}`,
            tags: [
              'btms_type_issue',
              'btms_direction_incoming',
              timestampTag,
              monthTag,
              `btms_counterparty_${counterparty}`
            ] as OutputTagStringUnder300Bytes[]
          }
        ],
        options: {
          acceptDelayedBroadcast: false,
          randomizeOutputs: false
        }
      }

      // Create the action (no basket yet)
      const createResult = await this.wallet.createAction(args)

      if (!createResult.tx || !createResult.txid) {
        throw new Error('Transaction creation failed - no tx returned')
      }

      // Get the txid to compute the canonical assetId
      const assetId = BTMSToken.computeAssetId(createResult.txid, 0)

      // Now internalize the action into the BTMS basket
      await this.wallet.internalizeAction({
        tx: createResult.tx,
        labels: [
          `${BTMS_LABEL_PREFIX}type issue` as LabelStringUnder300Bytes,
          `${BTMS_LABEL_PREFIX}direction incoming` as LabelStringUnder300Bytes,
          timestampLabel,
          monthLabel,
          `${BTMS_LABEL_PREFIX}assetId ${assetId}` as LabelStringUnder300Bytes,
          `${BTMS_LABEL_PREFIX}counterparty ${counterparty}` as LabelStringUnder300Bytes
        ],
        outputs: [{
          outputIndex: 0 as PositiveIntegerOrZero,
          protocol: 'basket insertion',
          insertionRemittance: {
            basket: BTMS_BASKET,
            customInstructions: JSON.stringify({
              derivationPrefix,
              derivationSuffix
            }),
            tags: [
              'btms_type_issue',
              'btms_direction_incoming',
              timestampTag,
              monthTag,
              `btms_assetid_${assetId}`,
              `btms_counterparty_${counterparty}`
            ] as OutputTagStringUnder300Bytes[]
          }
        }],
        description: `Issue ${amount} ${tokenName}`
      })

      // Broadcast to overlay
      await this.broadcastWithRetry(
        Transaction.fromAtomicBEEF(createResult.tx),
        `issuance ${createResult.txid}`
      )

      return {
        success: true,
        txid: createResult.txid,
        assetId,
        outputIndex: 0,
        amount
      }
    } catch (error) {
      return {
        success: false,
        txid: '' as TXIDHexString,
        assetId: '',
        outputIndex: 0,
        amount,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Token Transfers
  // ---------------------------------------------------------------------------

  /**
   * Send tokens to a recipient.
   * 
   * Selects UTXOs to cover the amount, creates transfer outputs,
   * and broadcasts the transaction. If a messenger is configured,
   * also sends the token data to the recipient.
   * 
   * @param assetId - The asset to send
   * @param recipient - Recipient's identity public key
   * @param amount - Amount to send
   * @param options - Optional send options including change strategy
   * @returns Send result with transaction details
   */
  async send(
    assetId: string,
    recipient: PubKeyHex,
    amount: number,
    options: { changeStrategy?: ChangeStrategyOptions } = {}
  ): Promise<SendResult> {
    try {
      // Validate inputs
      if (!BTMSToken.isValidAssetId(assetId)) {
        throw new Error(`Invalid assetId: ${assetId}`)
      }
      if (amount < 1 || !Number.isInteger(amount)) {
        throw new Error('Amount must be a positive integer')
      }

      // Fetch spendable UTXOs for this asset
      const { tokens: utxos } = await this.getSpendableTokens(assetId)

      if (utxos.length === 0) {
        throw new Error(`No spendable tokens found for asset ${assetId}`)
      }

      // Select and verify UTXOs on the overlay
      const { selected, totalInput, inputBeef } = await this.selectAndVerifyUTXOs(utxos, amount)

      if (totalInput < amount) {
        throw new Error(`Insufficient balance on overlay. Have ${totalInput}, need ${amount}`)
      }

      // Get metadata from first selected UTXO (must be consistent)
      const metadata = selected[0].token.metadata

      // Ensure metadata is consistent across all selected UTXOs
      const metadataJson = JSON.stringify(metadata ?? null)
      for (const utxo of selected) {
        const utxoMetadataJson = JSON.stringify(utxo.token.metadata ?? null)
        if (utxoMetadataJson !== metadataJson) {
          throw new Error('Metadata mismatch across selected tokens')
        }
      }

      // Build outputs
      const outputs: CreateActionOutput[] = []
      const monthLabel = this.getMonthLabel()
      const timestampLabel = this.getTimestampLabel()
      const monthTag = this.getMonthTag()
      const timestampTag = this.getTimestampTag()

      // Generate random derivation for recipient output
      const transferDerivationPrefix = Utils.toBase64(Random(32))
      const recipientDerivationSuffix = Utils.toBase64(Random(32))
      const recipientKeyID = `${transferDerivationPrefix} ${recipientDerivationSuffix}`

      // Recipient output
      const recipientScript = await this.tokenTemplate.createTransfer(
        assetId,
        amount,
        recipientKeyID,
        recipient,
        metadata,
        false
      )
      const recipientScriptHex = recipientScript.toHex() as HexString

      outputs.push({
        satoshis: DEFAULT_TOKEN_SATOSHIS,
        lockingScript: recipientScriptHex,
        customInstructions: JSON.stringify({
          derivationPrefix: transferDerivationPrefix,
          derivationSuffix: recipientDerivationSuffix
        }),
        outputDescription: `Send ${amount} tokens`,
        tags: [
          'btms_type_send',
          'btms_direction_outgoing',
          timestampTag,
          monthTag,
          `btms_assetid_${assetId}`,
          `btms_counterparty_${recipient}`
        ] as OutputTagStringUnder300Bytes[]
      })

      // Change outputs (if needed)
      const changeAmount = totalInput - amount
      if (changeAmount > 0) {
        // Compute change outputs using the specified strategy
        const changeContext: ChangeContext = {
          changeAmount,
          paymentAmount: amount,
          totalInput,
          assetId
        }
        const changeOutputs = BTMS.computeChangeOutputs(changeContext, options.changeStrategy)

        // Create each change output
        for (const changeOutput of changeOutputs) {
          const changeDerivationSuffix = Utils.toBase64(Random(32))
          const changeKeyID = `${transferDerivationPrefix} ${changeDerivationSuffix}`

          const changeScript = await this.tokenTemplate.createTransfer(
            assetId,
            changeOutput.amount,
            changeKeyID,
            'self',
            metadata
          )

          outputs.push({
            satoshis: DEFAULT_TOKEN_SATOSHIS,
            lockingScript: changeScript.toHex(),
            customInstructions: JSON.stringify({
              derivationPrefix: transferDerivationPrefix,
              derivationSuffix: changeDerivationSuffix
            }),
            basket: BTMS_BASKET,
            outputDescription: `Change: ${changeOutput.amount} tokens`,
            tags: [
              'btms_type_change',
              'btms_direction_incoming',
              timestampTag,
              monthTag,
              `btms_assetid_${assetId}`
            ] as OutputTagStringUnder300Bytes[]
          })
        }
      }

      // Build inputs
      const inputs = selected.map(u => ({
        outpoint: u.outpoint as OutpointString,
        unlockingScriptLength: 74,
        inputDescription: `Spend ${u.token.amount} tokens`
      }))

      const completeInputBeef = inputBeef instanceof Beef
        ? await this.ensureCompleteInputBeef(
          selected.map(u => ({ txid: u.txid, outputIndex: u.outputIndex })),
          inputBeef,
          assetId
        )
        : inputBeef

      // Create the action with BEEF from overlay
      const createArgs: CreateActionArgs = {
        description: `Send ${amount} tokens to ${recipient.slice(0, 8)}...`,
        labels: [
          `${BTMS_LABEL_PREFIX}type send` as LabelStringUnder300Bytes,
          `${BTMS_LABEL_PREFIX}direction outgoing` as LabelStringUnder300Bytes,
          timestampLabel,
          monthLabel,
          `${BTMS_LABEL_PREFIX}assetId ${assetId}` as LabelStringUnder300Bytes,
          `${BTMS_LABEL_PREFIX}counterparty ${recipient}` as LabelStringUnder300Bytes
        ],
        inputBEEF: completeInputBeef.toBinary(),
        inputs,
        outputs,
        options: {
          acceptDelayedBroadcast: false,
          randomizeOutputs: false
        }
      }

      const { signableTransaction } = await this.wallet.createAction(createArgs)

      if (!signableTransaction) {
        throw new Error('Failed to create signable transaction')
      }

      const spends = await this.buildSpendsForInputs(selected, signableTransaction.tx)
      const { tx: signedTx, txid } = await this.signAndBroadcast(signableTransaction.reference, spends)

      // Build token data for recipient
      const tokenForRecipient: TokenForRecipient = {
        txid,
        outputIndex: 0,
        lockingScript: recipientScriptHex,
        amount,
        satoshis: DEFAULT_TOKEN_SATOSHIS,
        beef: signedTx,
        customInstructions: JSON.stringify({
          derivationPrefix: transferDerivationPrefix,
          derivationSuffix: recipientDerivationSuffix
        }),
        assetId,
        metadata
      }

      // Send to recipient via comms layer (if configured and not sending to self)
      if (this.comms) {
        await this.comms.sendMessage({
          recipient,
          messageBox: BTMS_MESSAGE_BOX,
          body: JSON.stringify(tokenForRecipient)
        })
      }

      return {
        success: true,
        txid,
        tokenForRecipient,
        changeAmount: changeAmount > 0 ? changeAmount : undefined
      }
    } catch (error) {
      return {
        success: false,
        txid: '' as TXIDHexString,
        tokenForRecipient: {} as TokenForRecipient,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Burning Tokens
  // ---------------------------------------------------------------------------

  /**
   * Burn (destroy) tokens permanently.
   * 
   * This operation spends token UTXOs without creating corresponding outputs,
   * effectively destroying the tokens. This is useful when tokens represent
   * claims on physical assets that have been redeemed (e.g., trading gold
   * tokens for physical gold).
   * 
   * @param assetId - The asset to burn
   * @param amount - Amount to burn (if undefined, burns entire balance)
   * @param options - Optional change strategy for remaining balance
   * @returns Burn result with transaction details
   * 
   * @example
   * ```typescript
   * // Burn 50 tokens
   * const result = await btms.burn('abc123.0', 50)
   * 
   * // Burn entire balance
   * const result = await btms.burn('abc123.0')
   * ```
   */
  async burn(
    assetId: string,
    amount?: number,
    options: { changeStrategy?: ChangeStrategyOptions } = {}
  ): Promise<BurnResult> {
    try {
      // Validate inputs
      if (!BTMSToken.isValidAssetId(assetId)) {
        throw new Error(`Invalid assetId: ${assetId}`)
      }
      if (amount !== undefined && (amount < 1 || !Number.isInteger(amount))) {
        throw new Error('Amount must be a positive integer')
      }

      // Fetch spendable UTXOs for this asset
      const { tokens: utxos } = await this.getSpendableTokens(assetId)

      if (utxos.length === 0) {
        throw new Error(`No spendable tokens found for asset ${assetId}`)
      }

      // Calculate total available
      const totalAvailable = utxos.reduce((sum, u) => sum + u.token.amount, 0)

      // Determine amount to burn
      const amountToBurn = amount ?? totalAvailable

      if (amountToBurn > totalAvailable) {
        throw new Error(`Insufficient balance. Have ${totalAvailable}, trying to burn ${amountToBurn}`)
      }

      // Select UTXOs to cover the amount to burn
      const { selected, totalInput, inputBeef } = await this.selectAndVerifyUTXOs(utxos, amountToBurn)

      // Get metadata from first selected UTXO (for change output if needed)
      const metadata = selected[0].token.metadata

      // Build outputs (only change if partial burn)
      const outputs: CreateActionOutput[] = []
      const changeAmount = totalInput - amountToBurn
      const monthLabel = this.getMonthLabel()
      const timestampLabel = this.getTimestampLabel()
      const monthTag = this.getMonthTag()
      const timestampTag = this.getTimestampTag()
      const counterparty = await this.getIdentityKey()

      if (changeAmount > 0) {
        // Partial burn - return change to self using the specified strategy
        const changeDerivationPrefix = Utils.toBase64(Random(32))

        const changeContext: ChangeContext = {
          changeAmount,
          paymentAmount: amountToBurn,
          totalInput,
          assetId
        }
        const changeOutputs = BTMS.computeChangeOutputs(changeContext, options.changeStrategy)

        for (const changeOutput of changeOutputs) {
          const changeDerivationSuffix = Utils.toBase64(Random(32))
          const changeKeyID = `${changeDerivationPrefix} ${changeDerivationSuffix}`

          const changeScript = await this.tokenTemplate.createTransfer(
            assetId,
            changeOutput.amount,
            changeKeyID,
            'self',
            metadata
          )

          outputs.push({
            satoshis: DEFAULT_TOKEN_SATOSHIS,
            lockingScript: changeScript.toHex(),
            customInstructions: JSON.stringify({
              derivationPrefix: changeDerivationPrefix,
              derivationSuffix: changeDerivationSuffix
            }),
            basket: BTMS_BASKET,
            outputDescription: `Change after burning: ${changeOutput.amount} tokens`,
            tags: [
              'btms_type_change',
              'btms_direction_incoming',
              timestampTag,
              monthTag,
              `btms_assetid_${assetId}`
            ] as OutputTagStringUnder300Bytes[]
          })
        }
      }

      // Build inputs - note: inputDescription should reflect what's happening to the tokens
      // The actual burn amount is amountToBurn, change goes back to user
      const inputs = selected.map((u, i) => ({
        outpoint: u.outpoint as OutpointString,
        unlockingScriptLength: 74,
        inputDescription: i === 0
          ? `Burn ${amountToBurn} tokens (from UTXO with ${u.token.amount})`
          : `Input ${u.token.amount} tokens for burn`
      }))

      const completeInputBeef = inputBeef instanceof Beef
        ? await this.ensureCompleteInputBeef(
          selected.map(u => ({ txid: u.txid, outputIndex: u.outputIndex })),
          inputBeef,
          assetId
        )
        : inputBeef

      // Create the action
      const createArgs: CreateActionArgs = {
        description: `Burn ${amountToBurn} tokens of ${assetId.slice(0, 8)}...`,
        labels: [
          `${BTMS_LABEL_PREFIX}type burn` as LabelStringUnder300Bytes,
          `${BTMS_LABEL_PREFIX}direction incoming` as LabelStringUnder300Bytes,
          timestampLabel,
          monthLabel,
          `${BTMS_LABEL_PREFIX}assetId ${assetId}` as LabelStringUnder300Bytes,
          `${BTMS_LABEL_PREFIX}counterparty ${counterparty}` as LabelStringUnder300Bytes
        ],
        inputBEEF: completeInputBeef.toBinary(),
        inputs,
        outputs,
        options: {
          acceptDelayedBroadcast: false,
          randomizeOutputs: false
        }
      }

      const { signableTransaction } = await this.wallet.createAction(createArgs)

      if (!signableTransaction) {
        throw new Error('Failed to create signable transaction')
      }

      const spends = await this.buildSpendsForInputs(selected, signableTransaction.tx)

      try {
        const { txid } = await this.signAndBroadcast(signableTransaction.reference, spends)

        return {
          success: true,
          txid,
          assetId,
          amountBurned: amountToBurn
        }
      } catch (broadcastError: any) {
        // When burning all tokens (no outputs), overlay won't admit/retain anything
        // This is expected behavior and should be treated as success
        const errorMsg = broadcastError?.message || ''
        const isBurnAll = changeAmount === 0 // No change outputs means burning everything
        const isOverlayRejection = errorMsg.includes('No host acknowledged') ||
          errorMsg.includes('not in admitted outputs')

        if (isBurnAll && isOverlayRejection) {
          // Sign the transaction to get the txid even though broadcast failed
          const signResult = await this.wallet.signAction({
            reference: signableTransaction.reference,
            spends
          })

          if (!signResult.tx) {
            throw new Error('Failed to sign transaction')
          }

          const txData = Array.isArray(signResult.tx) ? signResult.tx : Utils.toArray(signResult.tx)
          const finalTx = Transaction.fromAtomicBEEF(txData)
          const txid = finalTx.id('hex') as TXIDHexString

          return {
            success: true,
            txid,
            assetId,
            amountBurned: amountToBurn
          }
        }

        // For other broadcast errors, throw them
        throw broadcastError
      }
    } catch (error) {
      return {
        success: false,
        txid: '' as TXIDHexString,
        assetId,
        amountBurned: 0,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Receiving Tokens
  // ---------------------------------------------------------------------------

  /**
   * List incoming token payments (requires comms layer).
   * 
   * @param assetId - Optional filter by asset ID
   * @returns List of incoming payments
   */
  async listIncoming(assetId?: string): Promise<IncomingToken[]> {
    if (!this.comms) {
      return []
    }

    const messages = await this.comms.listMessages({
      messageBox: BTMS_MESSAGE_BOX
    })

    const payments: IncomingToken[] = []
    for (const msg of messages) {
      try {
        const payment = JSON.parse(msg.body) as IncomingToken
        payment.messageId = msg.messageId
        payment.sender = msg.sender

        // Filter by assetId if provided
        if (!assetId || payment.assetId === assetId) {
          payments.push(payment)
        }
      } catch {
        // Skip invalid messages
      }
    }

    return payments
  }

  /**
   * Accept an incoming token.
   * 
   * Verifies the token on the overlay, internalizes it into the wallet,
   * and acknowledges receipt via the messenger.
   * 
   * @param token - The incoming token to accept
   * @returns Accept result
   */
  async accept(token: IncomingToken): Promise<AcceptResult> {
    try {
      // Decode and validate the token
      const decoded = BTMSToken.decode(token.lockingScript)
      if (!decoded.valid) {
        throw new Error(`Invalid token: ${decoded.error}`)
      }

      // Verify the token exists on the overlay
      const { found: isOnOverlay } = await this.lookupTokenOnOverlay(token.txid, token.outputIndex)

      // Re-broadcast if token is not on overlay
      if (!isOnOverlay && token.beef) {
        const tx = Transaction.fromBEEF(token.beef)
        try {
          await this.broadcastWithRetry(tx, `accept rebroadcast ${token.txid}`)
        } catch {
          throw new Error('Token not found on overlay and broadcast failed!')
        }
      }

      // We must verify we can unlock this token in the future!
      // Parse customInstructions to get key derivation parameters
      const { keyID } = parseCustomInstructions(
        token.customInstructions,
        token.txid,
        token.outputIndex
      )

      // Derive the public key we would use to unlock this token
      const { publicKey: derivedPubKey } = await this.wallet.getPublicKey({
        protocolID: BTMS_PROTOCOL_ID,
        keyID,
        counterparty: token.sender,
        forSelf: true
      })

      // Compare with the locking public key embedded in the script
      if (decoded.lockingPublicKey !== derivedPubKey) {
        throw new Error(
          `Key derivation mismatch: expected ${decoded.lockingPublicKey}, derived ${derivedPubKey}. ` +
          `Cannot unlock this token with the provided customInstructions.`
        )
      }

      // Internalize the token into the wallet
      // Augment customInstructions with senderIdentityKey so we can unlock later
      const originalInstructions = JSON.parse(token.customInstructions)
      const augmentedInstructions = JSON.stringify({
        ...originalInstructions,
        senderIdentityKey: token.sender
      })
      const monthLabel = this.getMonthLabel()
      const timestampLabel = this.getTimestampLabel()
      const monthTag = this.getMonthTag()
      const timestampTag = this.getTimestampTag()

      await this.wallet.internalizeAction({
        tx: token.beef,
        labels: [
          `${BTMS_LABEL_PREFIX}type receive` as LabelStringUnder300Bytes,
          `${BTMS_LABEL_PREFIX}direction incoming` as LabelStringUnder300Bytes,
          timestampLabel,
          monthLabel,
          `${BTMS_LABEL_PREFIX}assetId ${token.assetId}` as LabelStringUnder300Bytes,
          `${BTMS_LABEL_PREFIX}counterparty ${token.sender}` as LabelStringUnder300Bytes
        ],
        outputs: [
          {
            outputIndex: token.outputIndex as PositiveIntegerOrZero,
            protocol: 'basket insertion',
            insertionRemittance: {
              basket: BTMS_BASKET,
              customInstructions: augmentedInstructions,
              tags: [
                'btms_type_receive',
                'btms_direction_incoming',
                timestampTag,
                monthTag,
                `btms_assetid_${token.assetId}`,
                `btms_counterparty_${token.sender}`
              ] as OutputTagStringUnder300Bytes[]
            }
          }
        ],
        description: `Receive ${token.amount} tokens`,
        seekPermission: true
      })

      // Acknowledge receipt via comms layer
      if (this.comms && token.messageId) {
        await this.comms.acknowledgeMessage({
          messageIds: [token.messageId]
        })
      }

      return {
        success: true,
        assetId: token.assetId,
        amount: token.amount
      }
    } catch (error) {
      return {
        success: false,
        assetId: token.assetId,
        amount: token.amount,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Refund an incoming token back to the sender without internalizing it.
   *
   * Verifies the token, spends it, and sends a new token of equal value
   * back to the original sender. The original incoming message is acknowledged
   * so it disappears from the receiver's incoming list.
   *
   * @param token - The incoming token to refund
   * @returns Refund result
   */
  async refundIncoming(token: IncomingToken): Promise<RefundResult> {
    try {
      if (!this.comms) {
        throw new Error('Comms layer is required to refund incoming tokens')
      }

      // Decode and validate the token
      const decoded = BTMSToken.decode(token.lockingScript)
      if (!decoded.valid) {
        throw new Error(`Invalid token: ${decoded.error}`)
      }

      // Verify the token exists on the overlay (fetch BEEF if possible)
      const overlayLookup = await this.lookupTokenOnOverlay(
        token.txid,
        token.outputIndex,
        true
      )

      // Re-broadcast if token is not on overlay
      if (!overlayLookup.found && token.beef) {
        const tx = Transaction.fromBEEF(token.beef)
        try {
          await this.broadcastWithRetry(tx, `refund rebroadcast ${token.txid}`)
        } catch {
          throw new Error('Token not found on overlay and broadcast failed!')
        }
      }

      const inputBeef = overlayLookup.beef
        ?? (token.beef ? Beef.fromBinary(Utils.toArray(token.beef)) : undefined)

      if (!inputBeef) {
        throw new Error('Missing BEEF data required to refund token')
      }

      const completeInputBeef = inputBeef instanceof Beef
        ? await this.ensureCompleteInputBeef(
          [{ txid: token.txid, outputIndex: token.outputIndex }],
          inputBeef
        )
        : inputBeef

      // Validate ability to unlock this token
      const { keyID } = parseCustomInstructions(
        token.customInstructions,
        token.txid,
        token.outputIndex
      )

      const { publicKey: derivedPubKey } = await this.wallet.getPublicKey({
        protocolID: BTMS_PROTOCOL_ID,
        keyID,
        counterparty: token.sender,
        forSelf: true
      })

      if (decoded.lockingPublicKey !== derivedPubKey) {
        throw new Error(
          `Key derivation mismatch: expected ${decoded.lockingPublicKey}, derived ${derivedPubKey}. ` +
          `Cannot unlock this token with the provided customInstructions.`
        )
      }

      const monthLabel = this.getMonthLabel()
      const timestampLabel = this.getTimestampLabel()
      const monthTag = this.getMonthTag()
      const timestampTag = this.getTimestampTag()

      // Create a new transfer back to the sender
      const refundDerivationPrefix = Utils.toBase64(Random(32))
      const refundDerivationSuffix = Utils.toBase64(Random(32))
      const refundKeyID = `${refundDerivationPrefix} ${refundDerivationSuffix}`

      const refundScript = await this.tokenTemplate.createTransfer(
        token.assetId,
        token.amount,
        refundKeyID,
        token.sender,
        decoded.metadata,
        false
      )

      const outputs: CreateActionOutput[] = [
        {
          satoshis: DEFAULT_TOKEN_SATOSHIS,
          lockingScript: refundScript.toHex(),
          customInstructions: JSON.stringify({
            derivationPrefix: refundDerivationPrefix,
            derivationSuffix: refundDerivationSuffix
          }),
          outputDescription: `Refund ${token.amount} tokens`,
          tags: [
            'btms_type_send',
            'btms_direction_outgoing',
            timestampTag,
            monthTag,
            `btms_assetid_${token.assetId}`,
            `btms_counterparty_${token.sender}`
          ] as OutputTagStringUnder300Bytes[]
        }
      ]

      const inputs = [
        {
          outpoint: `${token.txid}.${token.outputIndex}` as OutpointString,
          unlockingScriptLength: 74,
          inputDescription: `Refund ${token.amount} tokens`
        }
      ]

      const createArgs: CreateActionArgs = {
        description: `Refund ${token.amount} tokens to ${token.sender.slice(0, 8)}...`,
        labels: [
          `${BTMS_LABEL_PREFIX}type send` as LabelStringUnder300Bytes,
          `${BTMS_LABEL_PREFIX}direction outgoing` as LabelStringUnder300Bytes,
          timestampLabel,
          monthLabel,
          `${BTMS_LABEL_PREFIX}assetId ${token.assetId}` as LabelStringUnder300Bytes,
          `${BTMS_LABEL_PREFIX}counterparty ${token.sender}` as LabelStringUnder300Bytes
        ],
        inputBEEF: completeInputBeef.toBinary(),
        inputs,
        outputs,
        options: {
          acceptDelayedBroadcast: false,
          randomizeOutputs: false
        }
      }

      const { signableTransaction } = await this.wallet.createAction(createArgs)

      if (!signableTransaction) {
        throw new Error('Failed to create signable transaction')
      }

      const originalInstructions = JSON.parse(token.customInstructions)
      const refundInstructions = JSON.stringify({
        ...originalInstructions,
        senderIdentityKey: token.sender
      })

      const selectedUtxo: BTMSTokenOutput = {
        outpoint: `${token.txid}.${token.outputIndex}`,
        txid: token.txid,
        outputIndex: token.outputIndex,
        satoshis: token.satoshis,
        lockingScript: token.lockingScript,
        customInstructions: refundInstructions,
        token: decoded,
        spendable: true,
        beef: token.beef
      }

      const spends = await this.buildSpendsForInputs([selectedUtxo], signableTransaction.tx)
      const { tx: signedTx, txid } = await this.signAndBroadcast(signableTransaction.reference, spends)

      const tokenForRecipient: TokenForRecipient = {
        txid,
        outputIndex: 0,
        lockingScript: refundScript.toHex() as HexString,
        amount: token.amount,
        satoshis: DEFAULT_TOKEN_SATOSHIS,
        beef: signedTx,
        customInstructions: JSON.stringify({
          derivationPrefix: refundDerivationPrefix,
          derivationSuffix: refundDerivationSuffix
        }),
        assetId: token.assetId,
        metadata: decoded.metadata
      }

      await this.comms.sendMessage({
        recipient: token.sender,
        messageBox: BTMS_MESSAGE_BOX,
        body: JSON.stringify(tokenForRecipient)
      })

      if (token.messageId) {
        await this.comms.acknowledgeMessage({
          messageIds: [token.messageId]
        })
      }

      return {
        success: true,
        txid,
        assetId: token.assetId,
        amount: token.amount
      }
    } catch (error) {
      return {
        success: false,
        txid: '' as TXIDHexString,
        assetId: token.assetId,
        amount: token.amount,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Balance and Asset Queries
  // ---------------------------------------------------------------------------

  /**
   * Get the balance of a specific asset.
   * 
   * @param assetId - The asset to check
   * @returns Total spendable balance
   */
  async getBalance(assetId: string): Promise<number> {
    const { tokens: utxos } = await this.getSpendableTokens(assetId)
    return utxos.reduce((sum, u) => sum + u.token.amount, 0)
  }

  /**
   * Get info for a specific asset by ID using a targeted tag-based query.
   * Uses the assetId label to efficiently find outputs for this asset.
   * 
   * @param assetId - The asset ID to look up
   * @returns Asset info with name and metadata, or null if not found
   */
  async getAssetInfo(assetId: string): Promise<{ name?: string; metadata?: BTMSAssetMetadata } | null> {
    if (!BTMSToken.isValidAssetId(assetId)) return null
    return await this.lookupAssetMetadataOnOverlay(assetId)
  }

  /**
   * Lookup asset metadata from the overlay using assetId and BEEF.
   */
  private async lookupAssetMetadataOnOverlay(
    assetId: string
  ): Promise<{ name?: string; metadata?: BTMSAssetMetadata } | null> {
    try {
      const lookup = new LookupResolver({ networkPreset: this.networkPreset })
      const result = await lookup.query({
        service: BTMS_LOOKUP_SERVICE,
        query: { assetId, limit: 1 }
      })

      if (result.type !== 'output-list' || result.outputs.length === 0) {
        return null
      }

      const output = result.outputs[0] as { context: any; outputIndex: number; beef?: number[] }
      if (!output.beef) return null
      const tx = Transaction.fromBEEF(output.beef)
      const lockingScript = tx.outputs[output.outputIndex]?.lockingScript
      if (!lockingScript) return null

      const decoded = BTMSToken.decode(lockingScript)
      if (!decoded.valid) return null

      const resolvedAssetId = decoded.assetId === ISSUE_MARKER
        ? `${tx.id('hex')}.${output.outputIndex}`
        : decoded.assetId

      if (resolvedAssetId !== assetId) {
        return null
      }

      if (decoded.metadata) {
        const meta = typeof decoded.metadata === 'string'
          ? JSON.parse(decoded.metadata)
          : decoded.metadata
        return { name: meta?.name, metadata: meta }
      }
      return { name: undefined, metadata: undefined }
    } catch {
      return null
    }
  }

  /**
   * List all assets owned by this wallet.
   * 
   * @returns List of assets with balances
   */
  async listAssets(): Promise<BTMSAsset[]> {
    const assetIds = new Set<string>()

    // Discover assets efficiently using single basket query with tag filtering
    // This is much faster than scanning thousands of transactions
    // We also calculate balances and extract metadata in one pass to avoid redundant queries
    const assetBalances = new Map<string, { balance: number; metadata?: BTMSAssetMetadata }>()

    try {
      // Query all owned BTMS tokens (issue, change, received) from single basket.
      const pages = await this.listOutputsPaged({
        basket: BTMS_BASKET,
        tags: ['btms_type_issue', 'btms_type_change', 'btms_type_receive'],
        tagQueryMode: 'any',
        include: 'locking scripts'
      })

      // Decode each output to discover unique assets AND calculate balances in one pass
      for (const page of pages) {
        for (const output of page.outputs) {
          if (!output.spendable) continue
          if (output.satoshis !== DEFAULT_TOKEN_SATOSHIS) continue

          const decoded = BTMSToken.decode(output.lockingScript || '')
          if (!decoded.valid) continue

          // For transfer outputs, use the assetId from the token
          // For issuance outputs, compute from outpoint
          let assetId: string
          if (decoded.assetId === ISSUE_MARKER) {
            const [txid, outputIndexStr] = output.outpoint.split('.')
            assetId = BTMSToken.computeAssetId(txid, Number(outputIndexStr))
          } else {
            assetId = decoded.assetId
          }

          if (BTMSToken.isValidAssetId(assetId)) {
            assetIds.add(assetId)

            // Accumulate balance for this asset
            const current = assetBalances.get(assetId) || { balance: 0 }
            current.balance += decoded.amount

            // Store metadata from first output (if not already stored)
            if (!current.metadata && decoded.metadata) {
              try {
                current.metadata = typeof decoded.metadata === 'string'
                  ? JSON.parse(decoded.metadata)
                  : decoded.metadata
              } catch {
                // Invalid metadata, skip
              }
            }

            assetBalances.set(assetId, current)
          }
        }
      }
    } catch (error) {
      console.warn(`[BTMS] listAssets failed to read wallet outputs: ${error instanceof Error ? error.message : String(error)}`)
    }

    // Get all incoming payments once (used for both discovery and per-asset checks)
    const allIncoming: IncomingToken[] = []
    if (this.comms) {
      try {
        const messages = await this.comms.listMessages({
          messageBox: BTMS_MESSAGE_BOX
        })
        for (const msg of messages) {
          try {
            const payment = JSON.parse(msg.body) as IncomingToken
            payment.messageId = msg.messageId
            payment.sender = msg.sender
            allIncoming.push(payment)
            // Also add to discovered assets
            if (BTMSToken.isValidAssetId(payment.assetId)) {
              assetIds.add(payment.assetId)
            }
          } catch {
            // Skip invalid messages
          }
        }
      } catch {
        // Ignore comms errors
        console.warn('[BTMS] listAssets failed to read incoming comms messages')
      }
    }

    // Build asset list with balances (already calculated from initial query)
    const assets: BTMSAsset[] = []

    for (const assetId of assetIds) {
      const assetData = assetBalances.get(assetId)
      const balance = assetData?.balance || 0
      const metadata = assetData?.metadata

      // Check for pending incoming (filter from already-fetched list)
      const incomingForAsset = allIncoming.filter(p => p.assetId === assetId)
      const hasPendingIncoming = incomingForAsset.length > 0

      // Only include assets with balance or pending incoming
      if (balance > 0 || hasPendingIncoming) {
        assets.push({
          assetId,
          name: metadata?.name,
          balance,
          metadata,
          hasPendingIncoming
        })
      }
    }

    return assets
  }

  /**
   * Get transaction history for an asset.
   * 
   * @param assetId - The asset to query
   * @param limit - Maximum number of transactions to return
   * @param offset - Number of transactions to skip (for pagination)
   * @returns Transaction history with pagination info
   */
  async getTransactions(
    assetId: string,
    limit = 50,
    offset = 0
  ): Promise<GetTransactionsResult> {
    // Query wallet actions filtered by assetId label, including outputs and inputs to get token amounts
    const result: ListActionsResult = await this.wallet.listActions({
      labels: [
        `${BTMS_LABEL_PREFIX}assetId ${assetId}` as LabelStringUnder300Bytes
      ],
      labelQueryMode: 'all',
      includeLabels: true,
      includeOutputs: true,
      includeInputs: true,
      includeInputSourceLockingScripts: true,
      includeOutputLockingScripts: true,
      limit,
      offset
    })

    const transactions: BTMSTransaction[] = []

    for (const action of result.actions) {
      // Parse labels to determine transaction type and direction
      const labels = action.labels || []
      const labelPayloads = labels.map(label =>
        label.startsWith(BTMS_LABEL_PREFIX)
          ? label.slice(BTMS_LABEL_PREFIX.length)
          : label
      )
      let type: 'issue' | 'send' | 'receive' | 'burn' = 'send'
      let direction: 'incoming' | 'outgoing' = 'outgoing'
      let counterparty: PubKeyHex | undefined

      // Extract type from labels
      if (labelPayloads.some(l => l.includes('type issue'))) {
        type = 'issue'
      } else if (labelPayloads.some(l => l.includes('type send'))) {
        type = 'send'
      } else if (labelPayloads.some(l => l.includes('type receive'))) {
        type = 'receive'
      } else if (labelPayloads.some(l => l.includes('type burn'))) {
        type = 'burn'
      }

      direction = (type === 'send' || type === 'burn') ? 'outgoing' : 'incoming'

      // Extract counterparty from labels
      const counterpartyLabel = labelPayloads.find(l => l.startsWith('counterparty '))
      if (counterpartyLabel) {
        counterparty = counterpartyLabel.replace('counterparty ', '') as PubKeyHex
      }

      const timestampLabel = labelPayloads.find(l => l.startsWith('timestamp '))
      const timestamp = timestampLabel
        ? Number(timestampLabel.replace('timestamp ', ''))
        : undefined

      // Extract amount from actual token outputs
      let amount = 0

      if (type === 'issue' && action.outputs) {
        for (const output of action.outputs) {
          if (!output.tags?.includes('btms_type_issue')) continue
          const outputAmount = decodeOutputAmount(output, action.txid, assetId)
          if (outputAmount !== null) amount += outputAmount
        }
      } else if (type === 'receive' && action.outputs) {
        for (const output of action.outputs) {
          if (!output.tags?.includes('btms_type_receive')) continue
          const outputAmount = decodeOutputAmount(output, action.txid, assetId)
          if (outputAmount !== null) amount += outputAmount
        }
      } else if (type === 'send') {
        const sendOutputs = action.outputs?.filter(output => output.tags?.includes('btms_type_send')) ?? []
        let decodedSendOutputs = 0

        // Count all btms_type_send outputs (these are sent to counterparty, no basket)
        // btms_type_change outputs are change and have basket, so they're not included here
        for (const output of sendOutputs) {
          const outputAmount = decodeOutputAmount(output, action.txid, assetId)
          if (outputAmount !== null) {
            amount += outputAmount
            decodedSendOutputs += 1
          }
        }

        // Fallback to input minus change if send amounts couldn't be decoded.
        if (decodedSendOutputs === 0) {
          let inputAmount = 0
          if (action.inputs) {
            for (const input of action.inputs) {
              const inputAmountValue = decodeInputAmount(input, assetId)
              if (inputAmountValue !== null) inputAmount += inputAmountValue
            }
          }

          let changeAmount = 0
          if (action.outputs) {
            for (const output of action.outputs) {
              if (!output.tags?.includes('btms_type_change')) continue
              const outputAmount = decodeOutputAmount(output, action.txid, assetId)
              if (outputAmount !== null) changeAmount += outputAmount
            }
          }
          amount = inputAmount - changeAmount
        }
      } else if (type === 'burn') {
        let inputAmount = 0
        if (action.inputs) {
          for (const input of action.inputs) {
            const inputAmountValue = decodeInputAmount(input, assetId)
            if (inputAmountValue !== null) inputAmount += inputAmountValue
          }
        }

        let changeAmount = 0
        if (action.outputs) {
          for (const output of action.outputs) {
            if (!output.tags?.includes('btms_type_change')) continue
            const outputAmount = decodeOutputAmount(output, action.txid, assetId)
            if (outputAmount !== null) changeAmount += outputAmount
          }
        }

        amount = inputAmount - changeAmount
      }

      // Make outgoing amounts negative for display
      if (direction === 'outgoing') {
        amount = -amount
      }

      transactions.push({
        txid: action.txid as TXIDHexString,
        type,
        direction,
        amount,
        assetId,
        counterparty,
        description: action.description,
        status: action.status === 'completed' ? 'completed' : 'pending',
        timestamp: Number.isFinite(timestamp) ? timestamp : undefined
      })
    }

    return {
      transactions,
      total: result.totalActions || transactions.length
    }
  }

  /**
   * Get all spendable token UTXOs for an asset.
   * 
   * @param assetId - The asset to query
   * @param includeBeef - Whether to include full transaction data (for spending)
   * @returns List of spendable token outputs and optional BEEF
   */
  async getSpendableTokens(
    assetId: string,
    includeBeef = false
  ): Promise<{ tokens: BTMSTokenOutput[], beef?: Beef }> {
    const pages = await this.listOutputsPaged({
      basket: BTMS_BASKET,
      tags: ['btms_type_issue', 'btms_type_change', 'btms_type_receive'],
      tagQueryMode: 'any',
      include: includeBeef ? 'entire transactions' : 'locking scripts',
      includeTags: true,
      includeCustomInstructions: true
    })

    const tokens: BTMSTokenOutput[] = []
    const mergedBeef = includeBeef ? new Beef() : undefined

    for (const page of pages) {
      if (includeBeef && page.BEEF) {
        mergedBeef?.mergeBeef(page.BEEF)
      }

      for (const output of page.outputs) {
        try {
          if (!output.spendable) continue
          if (output.satoshis !== DEFAULT_TOKEN_SATOSHIS) continue

          const [txid, outputIndexStr] = output.outpoint.split('.')
          const outputIndex = Number(outputIndexStr)
          const canonicalAssetId = BTMSToken.computeAssetId(txid, outputIndex)

          let scriptHex: LockingScript | HexString | undefined
          if (includeBeef) {
            // When includeBeef is true, lockingScript is not returned - get it from the transaction
            if (!page.BEEF) {
              continue
            }
            const tx = Transaction.fromBEEF(page.BEEF, txid)
            scriptHex = tx.outputs[Number(outputIndexStr)].lockingScript
          } else {
            // When includeBeef is false, use the returned lockingScript
            scriptHex = output.lockingScript
          }

          if (!scriptHex) {
            continue
          }

          const decoded = BTMSToken.decode(scriptHex)
          if (!decoded.valid) continue

          // For issuance outputs, bind them to their canonical txid.vout asset.
          // For transfer outputs, require direct asset ID match.
          if (decoded.assetId === ISSUE_MARKER) {
            if (canonicalAssetId !== assetId) continue
          } else if (decoded.assetId !== assetId) {
            continue
          }

          tokens.push({
            outpoint: output.outpoint,
            txid: txid as TXIDHexString,
            outputIndex,
            satoshis: output.satoshis,
            lockingScript: scriptHex as HexString,
            customInstructions: output.customInstructions,
            token: decoded,
            spendable: true,
            // Per-output BEEF comes from page BEEF
            beef: includeBeef && page.BEEF ? page.BEEF : undefined
          })
        } catch {
          // Skip corrupted token data
          continue
        }
      }
    }

    return { tokens, beef: mergedBeef }
  }

  /**
   * Find outputs in the BTMS basket that cannot be decoded as valid tokens.
   * Useful for cleaning up corrupted or non-overlay outputs.
   */
  async findBadOutputs(): Promise<Array<{ outpoint: string; reason: string }>> {
    const pages = await this.listOutputsPaged({
      basket: BTMS_BASKET,
      tags: ['btms_type_issue', 'btms_type_change', 'btms_type_receive'],
      tagQueryMode: 'any',
      include: 'locking scripts'
    })

    const badOutputs: Array<{ outpoint: string; reason: string }> = []

    for (const page of pages) {
      for (const output of page.outputs) {
        if (!output.spendable) continue

        if (output.satoshis !== DEFAULT_TOKEN_SATOSHIS) {
          badOutputs.push({ outpoint: output.outpoint, reason: 'Unexpected satoshi value' })
          continue
        }

        if (!output.lockingScript) {
          badOutputs.push({ outpoint: output.outpoint, reason: 'Missing locking script' })
          continue
        }

        try {
          const decoded = BTMSToken.decode(output.lockingScript)
          if (!decoded.valid) {
            badOutputs.push({ outpoint: output.outpoint, reason: decoded.error || 'Invalid token encoding' })
            continue
          }
        } catch (error) {
          badOutputs.push({
            outpoint: output.outpoint,
            reason: error instanceof Error ? error.message : 'Failed to decode token'
          })
        }
      }
    }

    return badOutputs
  }

  /**
   * Relinquish corrupted outputs from the BTMS basket using wallet.relinquishOutput.
   * Returns which outpoints were relinquished and which failed.
   */
  async relinquishBadOutputs(): Promise<{
    relinquished: string[]
    failed: Array<{ outpoint: string; error: string }>
  }> {
    const badOutputs = await this.findBadOutputs()
    const relinquished: string[] = []
    const failed: Array<{ outpoint: string; error: string }> = []

    for (const bad of badOutputs) {
      try {
        await this.wallet.relinquishOutput({
          basket: BTMS_BASKET,
          output: bad.outpoint
        })
        relinquished.push(bad.outpoint)
      } catch (error) {
        failed.push({
          outpoint: bad.outpoint,
          error: error instanceof Error ? error.message : 'Failed to relinquish output'
        })
      }
    }

    return { relinquished, failed }
  }

  // ---------------------------------------------------------------------------
  // Ownership Proof Methods
  // ---------------------------------------------------------------------------

  /**
   * Prove ownership of tokens to a verifier.
   * 
   * Creates a cryptographic proof that the caller owns the specified tokens
   * by revealing key linkage information that only the owner could produce.
   * 
   * @param assetId - The asset to prove ownership of
   * @param amount - The amount to prove (must have sufficient balance)
   * @param verifier - The verifier's identity public key
   * @returns Ownership proof that can be verified by the verifier
   * 
   * @example
   * ```typescript
   * const proof = await btms.proveOwnership('abc123.0', 100, verifierPubKey)
   * // Send proof to verifier for verification
   * ```
   */
  async proveOwnership(
    assetId: string,
    amount: number,
    verifier: PubKeyHex
  ): Promise<ProveOwnershipResult> {
    try {
      // Validate inputs
      if (!BTMSToken.isValidAssetId(assetId)) {
        throw new Error(`Invalid assetId: ${assetId}`)
      }
      if (amount < 1 || !Number.isInteger(amount)) {
        throw new Error('Amount must be a positive integer')
      }

      // Get prover's identity key
      const prover = await this.getIdentityKey()

      // Get spendable tokens for this asset
      const { tokens: utxos } = await this.getSpendableTokens(assetId)
      if (utxos.length === 0) {
        throw new Error(`No tokens found for asset ${assetId}`)
      }

      // Select tokens to cover the amount
      const { selected, totalInput } = BTMS.selectUTXOs(utxos, amount)
      if (totalInput < amount) {
        throw new Error(`Insufficient balance. Have ${totalInput}, need ${amount}`)
      }

      // Generate key linkage proofs for each selected token
      const provenTokens: ProvenToken[] = []

      for (const utxo of selected) {
        const { keyID } = parseCustomInstructions(
          utxo.customInstructions,
          utxo.txid,
          utxo.outputIndex
        )

        // Reveal specific key linkage for this token
        // The counterparty is 'self' for tokens we own (resolved to our own key)
        const linkageResult = await this.wallet.revealSpecificKeyLinkage({
          counterparty: prover, // Self-owned tokens use our own key as counterparty
          verifier,
          protocolID: BTMS_PROTOCOL_ID,
          keyID
        })

        provenTokens.push({
          output: {
            txid: utxo.txid,
            outputIndex: utxo.outputIndex,
            lockingScript: utxo.lockingScript,
            satoshis: utxo.satoshis
          },
          keyID,
          linkage: {
            prover: linkageResult.prover as PubKeyHex,
            verifier: linkageResult.verifier as PubKeyHex,
            counterparty: linkageResult.counterparty as PubKeyHex,
            encryptedLinkage: linkageResult.encryptedLinkage,
            encryptedLinkageProof: linkageResult.encryptedLinkageProof,
            proofType: linkageResult.proofType
          }
        })
      }

      const proof: OwnershipProof = {
        prover,
        verifier,
        tokens: provenTokens,
        amount,
        assetId
      }

      return {
        success: true,
        proof
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Verify an ownership proof from a prover.
   * 
   * Validates that:
   * 1. The key linkage is valid for each token
   * 2. The tokens exist on the overlay
   * 3. The total amount matches the claimed amount
   * 4. All tokens belong to the claimed prover
   * 
   * @param proof - The ownership proof to verify
   * @returns Verification result
   * 
   * @example
   * ```typescript
   * const result = await btms.verifyOwnership(proof)
   * if (result.valid) {
   *   console.log(`Verified ${result.amount} tokens owned by ${result.prover}`)
   * }
   * ```
   */
  async verifyOwnership(proof: OwnershipProof): Promise<VerifyOwnershipResult> {
    try {
      // Get verifier's identity key
      const verifierKey = await this.getIdentityKey()

      // Verify the proof is intended for us
      if (proof.verifier !== verifierKey) {
        throw new Error('Proof is not intended for this verifier')
      }

      let amountProven = 0

      // Verify each token in the proof
      const seenOutpoints = new Set<string>()
      for (const provenToken of proof.tokens) {
        const outpoint = `${provenToken.output.txid}.${provenToken.output.outputIndex}`
        if (seenOutpoints.has(outpoint)) {
          throw new Error(`Duplicate token outpoint in proof: ${outpoint}`)
        }
        seenOutpoints.add(outpoint)

        // Decode the token to get the amount
        const decoded = BTMSToken.decode(provenToken.output.lockingScript)
        if (!decoded.valid) {
          throw new Error('Invalid token in proof')
        }

        // Verify the token belongs to the claimed asset
        const tokenAssetId = decoded.assetId === ISSUE_MARKER
          ? BTMSToken.computeAssetId(provenToken.output.txid, provenToken.output.outputIndex)
          : decoded.assetId

        if (tokenAssetId !== proof.assetId) {
          throw new Error('Token asset ID does not match proof asset ID')
        }

        // Verify the linkage prover matches the proof prover
        if (provenToken.linkage.prover !== proof.prover) {
          throw new Error('Token linkage prover does not match proof prover')
        }

        // Verify the token exists on the overlay first
        const lookupResult = await this.lookupTokenOnOverlay(
          provenToken.output.txid,
          provenToken.output.outputIndex
        )
        if (!lookupResult.found) {
          throw new Error('Token not found on overlay')
        }

        // Decrypt the linkage to verify the prover owns the key
        // The verifier decrypts using their key and the prover as counterparty
        const { plaintext: linkage } = await this.wallet.decrypt({
          ciphertext: provenToken.linkage.encryptedLinkage,
          protocolID: [
            2,
            `specific linkage revelation ${BTMS_PROTOCOL_ID[0]} ${BTMS_PROTOCOL_ID[1]}`
          ],
          keyID: provenToken.keyID,
          counterparty: proof.prover
        })

        // The linkage should be a valid HMAC - if decryption succeeded,
        // it proves the prover has the corresponding private key
        if (!linkage || linkage.length === 0) {
          throw new Error('Invalid key linkage for token')
        }

        // Add to proven amount
        amountProven += decoded.amount
      }

      // Verify the total amount matches
      if (amountProven < proof.amount) {
        throw new Error(`Amount proven (${amountProven}) is less than claimed (${proof.amount})`)
      }

      return {
        valid: true,
        amount: amountProven,
        assetId: proof.assetId,
        prover: proof.prover
      }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Lookup a token on the overlay network.
   * 
   * @param txid - Transaction ID
   * @param outputIndex - Output index
   * @param includeBeef - Whether to return BEEF data
   * @returns Whether the token was found and optionally the BEEF
   */
  protected async lookupTokenOnOverlay(
    txid: TXIDHexString,
    outputIndex: number,
    includeBeef = false
  ): Promise<{ found: boolean; beef?: Beef }> {
    try {
      const lookup = new LookupResolver({ networkPreset: this.networkPreset })
      const result = await lookup.query({
        service: BTMS_LOOKUP_SERVICE,
        query: { txid, outputIndex }
      })

      // Check if we got a valid result
      if (result.type === 'output-list' && result.outputs.length > 0) {
        const beef = includeBeef ? Beef.fromBinary(result.outputs[0].beef) : undefined
        return { found: true, beef }
      }
      return { found: false }
    } catch {
      return { found: false }
    }
  }

  // ---------------------------------------------------------------------------
  // Utility Methods
  // ---------------------------------------------------------------------------

  /**
   * Get the wallet's identity public key (cached after first call).
   */
  async getIdentityKey(): Promise<PubKeyHex> {
    if (!this.cachedIdentityKey) {
      const { publicKey } = await this.wallet.getPublicKey({
        identityKey: true
      })
      this.cachedIdentityKey = publicKey as PubKeyHex
    }
    return this.cachedIdentityKey
  }

  private getMonthLabel(): LabelStringUnder300Bytes {
    const now = new Date()
    const year = now.getUTCFullYear()
    const month = String(now.getUTCMonth() + 1).padStart(2, '0')
    return `${BTMS_LABEL_PREFIX}month ${year}-${month}` as LabelStringUnder300Bytes
  }

  private getTimestampLabel(): LabelStringUnder300Bytes {
    return `${BTMS_LABEL_PREFIX}timestamp ${Date.now()}` as LabelStringUnder300Bytes
  }

  private getMonthTag(): OutputTagStringUnder300Bytes {
    const now = new Date()
    const year = now.getUTCFullYear()
    const month = String(now.getUTCMonth() + 1).padStart(2, '0')
    return `btms_month_${year}-${month}` as OutputTagStringUnder300Bytes
  }

  private getTimestampTag(): OutputTagStringUnder300Bytes {
    return `btms_timestamp_${Date.now()}` as OutputTagStringUnder300Bytes
  }

  private async buildSpendsForInputs(
    selected: BTMSTokenOutput[],
    unsignedTx: number[] | Uint8Array
  ): Promise<Record<number, { unlockingScript: string }>> {
    const txData = Array.isArray(unsignedTx) ? unsignedTx : Utils.toArray(unsignedTx)
    const txForSigning = Transaction.fromAtomicBEEF(txData)
    const spends: Record<number, { unlockingScript: string }> = {}
    for (let i = 0; i < selected.length; i++) {
      const utxo = selected[i]
      const { keyID, senderIdentityKey } = parseCustomInstructions(utxo.customInstructions, utxo.txid, utxo.outputIndex)
      const counterparty = senderIdentityKey ?? 'self'
      const unlocker = this.tokenTemplate.createUnlocker(counterparty, keyID)
      const unlockingScript = await unlocker.sign(txForSigning, i)
      spends[i] = { unlockingScript: unlockingScript.toHex() }
    }
    return spends
  }

  private async signAndBroadcast(
    reference: string,
    spends: Record<number, { unlockingScript: string }>
  ): Promise<{ tx: AtomicBEEF; txid: TXIDHexString }> {
    const signResult = await this.wallet.signAction({
      reference,
      spends
    })

    if (!signResult.tx) {
      throw new Error('Failed to sign transaction')
    }

    const txData = Array.isArray(signResult.tx) ? signResult.tx : Utils.toArray(signResult.tx)
    const finalTx = Transaction.fromAtomicBEEF(txData)
    const txid = finalTx.id('hex') as TXIDHexString

    await this.broadcastWithRetry(finalTx, `txid ${txid}`)

    return { tx: signResult.tx, txid }
  }

  private async broadcastWithRetry(
    tx: Transaction,
    context: string,
    maxAttempts = BTMS.BROADCAST_MAX_ATTEMPTS
  ): Promise<void> {
    let lastError = 'Unknown error'

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const broadcaster = new TopicBroadcaster([BTMS_TOPIC], {
          networkPreset: this.networkPreset
        })
        const broadcastResult = await broadcaster.broadcast(tx)

        if (broadcastResult.status === 'success') {
          return
        }

        lastError = (broadcastResult as any).description || `status: ${broadcastResult.status}`
        console.warn(`[BTMS] Broadcast attempt ${attempt}/${maxAttempts} failed for ${context}: ${lastError}`)
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        console.warn(`[BTMS] Broadcast attempt ${attempt}/${maxAttempts} threw for ${context}: ${lastError}`)
      }
    }

    throw new Error(`Broadcast failed after ${maxAttempts} attempts: ${lastError}`)
  }

  private async listOutputsPaged(args: ListOutputsArgs): Promise<ListOutputsResult[]> {
    const pages: ListOutputsResult[] = []
    const pageSize = BTMS.LIST_OUTPUTS_PAGE_SIZE
    let offset = 0

    for (let i = 0; i < BTMS.MAX_LIST_OUTPUTS_PAGES; i++) {
      const page = await this.wallet.listOutputs({
        ...args,
        limit: pageSize,
        offset
      })
      pages.push(page)

      const count = page.outputs.length
      if (count === 0 || count < pageSize) {
        return pages
      }
      offset += count
    }

    console.warn(`[BTMS] listOutputs pagination reached max pages (${BTMS.MAX_LIST_OUTPUTS_PAGES})`)
    return pages
  }

  /**
   * Ensure a createAction inputBEEF is complete and non-txid-only for required inputs.
   */
  private async ensureCompleteInputBeef(
    requiredInputs: Array<{ txid: TXIDHexString; outputIndex: number }>,
    baseBeef: Beef,
    assetIdForRecovery?: string
  ): Promise<Beef> {
    const merged = baseBeef.clone()

    const validate = (beef: Beef): { ok: true } | { ok: false; reason: string } => {
      const txidOnlyTxs = beef.txs.filter((tx: any) => tx?.isTxidOnly).map((tx: any) => tx.txid)
      if (txidOnlyTxs.length > 0) {
        return {
          ok: false,
          reason: `BEEF contains txid-only entries: ${txidOnlyTxs.slice(0, 3).join(', ')}`
        }
      }

      const beefBin = beef.toBinary()
      for (const input of requiredInputs) {
        const beefTx = beef.findTxid(input.txid)
        if (!beefTx || (beefTx as any).isTxidOnly) {
          return {
            ok: false,
            reason: `Missing complete transaction for input ${input.txid}.${input.outputIndex}`
          }
        }

        try {
          const tx = Transaction.fromBEEF(beefBin, input.txid)
          if (tx.outputs[input.outputIndex] === undefined) {
            return {
              ok: false,
              reason: `Missing referenced output ${input.txid}.${input.outputIndex}`
            }
          }
        } catch (error) {
          return {
            ok: false,
            reason: `Unresolvable ancestry for ${input.txid}.${input.outputIndex}: ${error instanceof Error ? error.message : 'unknown error'}`
          }
        }
      }

      return { ok: true }
    }

    let validation = validate(merged)
    if (validation.ok) {
      return merged
    }

    // Recovery path: merge wallet-provided BEEF for the same asset (when available).
    if (assetIdForRecovery && BTMSToken.isValidAssetId(assetIdForRecovery)) {
      const { beef: walletBeef } = await this.getSpendableTokens(assetIdForRecovery, true)
      if (walletBeef) {
        merged.mergeBeef(walletBeef)
      }
      validation = validate(merged)
      if (validation.ok) {
        return merged
      }
    }

    throw new Error(`Unable to build complete inputBEEF for createAction: ${validation.reason}`)
  }

  /**
   * Decode a token from a locking script.
   */
  decodeToken(lockingScript: string | LockingScript) {
    return BTMSToken.decode(lockingScript)
  }

  /**
   * Select and verify UTXOs on the overlay.
   * 
   * Selects UTXOs first using the specified strategy, then verifies only
   * the selected ones on the overlay. If any fail verification, retries
   * with remaining UTXOs.
   * 
   * @param utxos - Available UTXOs to select from
   * @param amount - Target amount to cover
   * @param options - Selection options including strategy
   * @returns Selected UTXOs, total input, and merged BEEF from overlay
   */
  async selectAndVerifyUTXOs(
    utxos: BTMSTokenOutput[],
    amount: number,
    options: SelectionOptions = {}
  ): Promise<{ selected: BTMSTokenOutput[]; totalInput: number; inputBeef: Beef }> {
    const inputBeef = new Beef()
    let remainingUtxos = [...utxos]

    while (remainingUtxos.length > 0) {
      // Select UTXOs using the specified strategy
      const { selected, totalInput } = BTMS.selectUTXOs(remainingUtxos, amount, options)

      if (selected.length === 0 || totalInput < amount) {
        // Not enough UTXOs available
        return { selected: [], totalInput: 0, inputBeef }
      }

      // Verify only the selected UTXOs on overlay
      type VerificationResult = { utxo: BTMSTokenOutput; found: boolean; beef?: Beef }
      const verificationPromises = selected.map(async (utxo): Promise<VerificationResult> => {
        const { found, beef } = await this.lookupTokenOnOverlay(utxo.txid, utxo.outputIndex, true)
        if (found) {
          return { utxo, found, beef }
        }
        return { utxo, found: false, beef: undefined }
      })

      const verificationResults = await Promise.all(verificationPromises)

      // Separate valid and invalid UTXOs
      let validResults = verificationResults.filter(r => r.found)
      let invalidUtxos = verificationResults.filter(r => !r.found).map(r => r.utxo)

      // Re-broadcast missing UTXOs only if we need to fetch BEEF
      if (invalidUtxos.length > 0) {
        const needsBeef = invalidUtxos.some(utxo => !utxo.beef)
        const assetId = selected[0]?.token.assetId
        const beefMap = needsBeef && assetId
          ? new Map((await this.getSpendableTokens(assetId, true)).tokens.map(utxo => [utxo.outpoint, utxo]))
          : new Map<string, BTMSTokenOutput>()
        const invalidWithBeef = invalidUtxos.map(utxo => beefMap.get(utxo.outpoint) ?? utxo)

        const rebroadcastResults: VerificationResult[] = await Promise.all(
          invalidWithBeef.map(async (utxo): Promise<VerificationResult> => {
            if (!utxo.beef) {
              return { utxo, found: false, beef: undefined }
            }

            try {
              const tx = Transaction.fromAtomicBEEF(Transaction.fromBEEF(utxo.beef, utxo.txid).toAtomicBEEF())
              const broadcaster = new TopicBroadcaster([BTMS_TOPIC], {
                networkPreset: this.networkPreset
              })
              const response = await broadcaster.broadcast(tx)
              if (response.status === 'success') {
                return {
                  utxo,
                  found: true,
                  beef: Beef.fromBinary(utxo.beef)
                }
              }
            } catch {
              // Fall through to mark as not found
            }

            return { utxo, found: false, beef: undefined }
          })
        )

        validResults = [...validResults, ...rebroadcastResults.filter(r => r.found)]
        invalidUtxos = rebroadcastResults.filter(r => !r.found).map(r => r.utxo)
      }

      // Merge BEEF from valid UTXOs
      for (const result of validResults) {
        if (result.beef) {
          inputBeef.mergeBeef(result.beef)
        }
      }

      // If all selected UTXOs are valid, we're done
      if (invalidUtxos.length === 0) {
        return {
          selected: validResults.map(r => r.utxo),
          totalInput,
          inputBeef
        }
      }

      // Some UTXOs failed verification - remove them and retry
      remainingUtxos = remainingUtxos.filter(
        u => !invalidUtxos.some(invalid => invalid.outpoint === u.outpoint)
      )
    }

    // Token supply exhausted
    return { selected: [], totalInput: 0, inputBeef }
  }

  // ---------------------------------------------------------------------------
  // Static Methods
  // ---------------------------------------------------------------------------

  /**
   * Select UTXOs to cover a target amount using a configurable strategy.
   * 
   * @param utxos - Available UTXOs to select from
   * @param amount - Target amount to cover
   * @param options - Selection options including strategy
   * @returns Selected UTXOs, total input amount, and excluded UTXOs
   */
  static selectUTXOs<T extends { token: { amount: number } }>(
    utxos: T[],
    amount: number,
    options: SelectionOptions = {}
  ): SelectionResult<T> {
    const {
      strategy = 'largest-first',
      fallbackStrategy = 'largest-first',
      maxInputs,
      minUtxoAmount = 0
    } = options

    // Filter by minimum amount
    const eligible = utxos.filter(u => u.token.amount >= minUtxoAmount)
    const excluded = utxos.filter(u => u.token.amount < minUtxoAmount)

    // Sort based on strategy
    let sorted: T[]
    switch (strategy) {
      case 'smallest-first':
        sorted = [...eligible].sort((a, b) => a.token.amount - b.token.amount)
        break
      case 'random':
        sorted = [...eligible].sort(() => Math.random() - 0.5)
        break
      case 'exact-match':
        // Try to find exact match first
        const exactMatch = eligible.find(u => u.token.amount === amount)
        if (exactMatch) {
          return { selected: [exactMatch], totalInput: amount, excluded }
        }
        // Fall back to configured strategy
        switch (fallbackStrategy) {
          case 'smallest-first':
            sorted = [...eligible].sort((a, b) => a.token.amount - b.token.amount)
            break
          case 'random':
            sorted = [...eligible].sort(() => Math.random() - 0.5)
            break
          case 'largest-first':
          default:
            sorted = [...eligible].sort((a, b) => b.token.amount - a.token.amount)
            break
        }
        break
      case 'largest-first':
      default:
        sorted = [...eligible].sort((a, b) => b.token.amount - a.token.amount)
        break
    }

    // Select UTXOs until we meet the target
    const selected: T[] = []
    let totalInput = 0

    for (const utxo of sorted) {
      if (totalInput >= amount) break
      if (maxInputs !== undefined && selected.length >= maxInputs) break
      selected.push(utxo)
      totalInput += utxo.token.amount
    }

    return { selected, totalInput, excluded }
  }

  /**
   * Compute change outputs using the specified strategy.
   * 
   * @param context - Change context with amounts and asset info
   * @param options - Change strategy options
   * @returns Array of change outputs to create
   */
  static computeChangeOutputs(
    context: ChangeContext,
    options: ChangeStrategyOptions = {}
  ): ChangeOutput[] {
    const { changeAmount } = context

    if (changeAmount <= 0) {
      return []
    }

    const {
      strategy = 'single',
      splitCount = 2,
      minOutputAmount = 1
    } = options

    // If a custom strategy object is provided, use it
    if (typeof strategy === 'object' && 'computeChange' in strategy) {
      return strategy.computeChange(context)
    }

    // Built-in strategies
    switch (strategy) {
      case 'split-equal':
        return BTMS.splitEqualChange(changeAmount, splitCount, minOutputAmount)

      case 'split-random':
        return BTMS.splitRandomChange(changeAmount, splitCount, minOutputAmount)

      case 'single':
      default:
        return [{ amount: changeAmount }]
    }
  }

  /**
   * Split change into equal amounts.
   */
  private static splitEqualChange(
    changeAmount: number,
    splitCount: number,
    minOutputAmount: number
  ): ChangeOutput[] {
    // Ensure we can create at least minOutputAmount per output
    const maxOutputs = Math.floor(changeAmount / minOutputAmount)
    const actualCount = Math.min(splitCount, maxOutputs)

    if (actualCount <= 1) {
      return [{ amount: changeAmount }]
    }

    const perOutput = Math.floor(changeAmount / actualCount)
    const remainder = changeAmount - (perOutput * actualCount)

    const outputs: ChangeOutput[] = []
    for (let i = 0; i < actualCount; i++) {
      // Add remainder to the last output
      const amount = i === actualCount - 1 ? perOutput + remainder : perOutput
      outputs.push({ amount })
    }

    return outputs
  }

  /**
   * Split change into random amounts using a logarithmic distribution.
   * Uses a Benford-inspired formula to favor smaller amounts, creating
   * more natural-looking output amounts for privacy.
   */
  private static splitRandomChange(
    changeAmount: number,
    splitCount: number,
    minOutputAmount: number
  ): ChangeOutput[] {
    // Ensure we can create at least minOutputAmount per output
    const maxOutputs = Math.floor(changeAmount / minOutputAmount)
    const actualCount = Math.min(splitCount, maxOutputs)

    if (actualCount <= 1) {
      return [{ amount: changeAmount }]
    }

    const outputs: ChangeOutput[] = []
    let remaining = changeAmount - (actualCount * minOutputAmount) // Reserve minimum for each

    // Distribute using Benford-like distribution
    for (let i = 0; i < actualCount - 1; i++) {
      const portion = BTMS.benfordNumber(0, remaining)
      outputs.push({ amount: minOutputAmount + portion })
      remaining -= portion
    }

    // Last output gets the remainder
    outputs.push({ amount: minOutputAmount + remaining })

    // Shuffle to avoid predictable ordering
    for (let i = outputs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
        ;[outputs[i], outputs[j]] = [outputs[j], outputs[i]]
    }

    return outputs
  }

  /**
   * Generate a logarithmically-distributed random number.
   * Uses a formula inspired by Benford's law to favor smaller values,
   * creating more natural-looking distributions.
   */
  private static benfordNumber(min: number, max: number): number {
    if (max <= min) return min
    const d = Math.floor(Math.random() * 9) + 1
    return Math.floor(min + ((max - min) * Math.log10(1 + 1 / d)) / Math.log10(10))
  }

}
