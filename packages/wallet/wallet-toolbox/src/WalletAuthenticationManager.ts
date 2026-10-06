import { CWIStyleWalletManager, UMPTokenInteractor } from './CWIStyleWalletManager'
import { PrivilegedKeyManager } from './sdk/PrivilegedKeyManager'
import {
  WalletInterface,
  Random,
  Beef,
  Transaction,
  RPuzzle,
  PrivateKey,
  PublicKey,
  CachedKeyDeriver,
  TelemetryConfig,
  completeBoundAction
} from '@bsv/sdk'
import { toArray, toBase64, toHex } from '@bsv/sdk/primitives/utils'
import { WABClient, WABOperationResponse } from './wab-client/WABClient'
import { WABClientError } from './wab-client/WABTransport'
import { validateWABOperationResponse } from './wab-client/WABResponseValidation'
import {
  AuthMethodInteractor,
  AuthPayload,
  CompleteAuthResponse
} from './wab-client/auth-method-interactors/AuthMethodInteractor'
import { ScriptTemplateBRC29 } from './utility/ScriptTemplateBRC29'
import { maxPossibleSatoshis } from './storage/methods/generateChange'
import { getActionOutputAuthorizations } from './utility/actionOutputAuthorizations'

const DEFAULT_AUTH_SESSION_TTL_MS = 10 * 60 * 1000
const MAX_AUTH_SESSION_TTL_MS = 60 * 60 * 1000
const AUTH_COMPONENT = 'wallet-toolbox.authentication-manager'
const AUTH_EVENT = 'wallet-toolbox.authentication.'
const EXISTING_USER = 'existing-user'
const NEW_USER = 'new-user'
const PENDING_REGISTRATION = 'pending'
const WAB_FAUCET_RECOVERY_BASKET = 'wab faucet recovery'
const WAB_FAUCET_RECOVERY_VERSION = 1
const MAX_WAB_FAUCET_RECOVERY_BEEF_BYTES = 16 * 1024 * 1024

interface WABFaucetRecoveryInstructions {
  version: number
  faucetOutpoint: string
  derivationPrefix: string
  derivationSuffix: string
  senderIdentityKey: string
}

function parseFaucetRecoveryInstructions(value: unknown): WABFaucetRecoveryInstructions | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (
    record.version !== WAB_FAUCET_RECOVERY_VERSION ||
    typeof record.faucetOutpoint !== 'string' ||
    !/^[0-9a-f]{64}\.(?:0|[1-9]\d*)$/i.test(record.faucetOutpoint) ||
    typeof record.derivationPrefix !== 'string' ||
    typeof record.derivationSuffix !== 'string' ||
    typeof record.senderIdentityKey !== 'string'
  ) {
    return undefined
  }
  try {
    const prefix = toArray(record.derivationPrefix, 'base64')
    const suffix = toArray(record.derivationSuffix, 'base64')
    if (
      prefix.length === 0 ||
      prefix.length > 64 ||
      suffix.length === 0 ||
      suffix.length > 64 ||
      toBase64(prefix) !== record.derivationPrefix ||
      toBase64(suffix) !== record.derivationSuffix ||
      PublicKey.fromString(record.senderIdentityKey).toString() !== record.senderIdentityKey
    ) {
      return undefined
    }
  } catch {
    return undefined
  }
  return record as unknown as WABFaucetRecoveryInstructions
}

function transactionInputOutpoint(transaction: Transaction, inputIndex: number): string | undefined {
  const input = transaction.inputs[inputIndex]
  if (input == null || !Number.isSafeInteger(input.sourceOutputIndex) || input.sourceOutputIndex < 0) return undefined
  const sourceTxid = input.sourceTXID ?? input.sourceTransaction?.id('hex')
  if (sourceTxid == null || !/^[0-9a-f]{64}$/i.test(sourceTxid)) return undefined
  return `${sourceTxid.toLowerCase()}.${input.sourceOutputIndex}`
}

async function recoverWABFaucetPayment(
  wallet: WalletInterface,
  faucetOutpoint: string,
  adminOriginator: string,
  resumeNosend = true
): Promise<boolean> {
  const label = `wab faucet ${faucetOutpoint.slice(0, 64)}`
  const listed = await wallet.listOutputs(
    {
      basket: WAB_FAUCET_RECOVERY_BASKET,
      include: 'entire transactions',
      includeCustomInstructions: true,
      limit: 100
    },
    adminOriginator
  )
  if (!Array.isArray(listed.outputs)) throw new Error('Wallet returned invalid faucet recovery outputs.')
  const candidates = listed.outputs.flatMap(output => {
    const instructions = parseFaucetRecoveryInstructions(output.customInstructions)
    return instructions?.faucetOutpoint.toLowerCase() === faucetOutpoint ? [{ output, instructions }] : []
  })
  if (candidates.length > 1) throw new Error('Wallet returned ambiguous faucet recovery outputs.')
  if (candidates.length === 1) {
    if (
      !Array.isArray(listed.BEEF) ||
      listed.BEEF.length === 0 ||
      listed.BEEF.length > MAX_WAB_FAUCET_RECOVERY_BEEF_BYTES
    ) {
      throw new Error('Wallet omitted bounded faucet recovery transaction evidence.')
    }
    const { output, instructions } = candidates[0]
    const match = /^([0-9a-f]{64})\.(0|[1-9]\d*)$/i.exec(output.outpoint)
    if (match == null) throw new Error('Wallet returned an invalid faucet recovery outpoint.')
    const outputIndex = Number(match[2])
    if (!Number.isSafeInteger(outputIndex) || outputIndex > 0xffffffff) {
      throw new Error('Wallet returned an invalid faucet recovery output index.')
    }
    const beef = Beef.fromBinaryStrict(listed.BEEF)
    const transaction = beef.findTxid(match[1].toLowerCase())?.tx
    const transactionOutput = transaction?.outputs[outputIndex]
    if (
      transaction == null ||
      transactionOutput == null ||
      transactionOutput.satoshis !== output.satoshis ||
      transaction.inputs.filter((_, index) => transactionInputOutpoint(transaction, index) === faucetOutpoint)
        .length !== 1
    ) {
      throw new Error('Wallet returned unrelated faucet recovery transaction evidence.')
    }
    const result = await wallet.internalizeAction(
      {
        tx: beef.toBinaryAtomic(transaction.id('hex')),
        outputs: [
          {
            outputIndex,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: instructions.derivationPrefix,
              derivationSuffix: instructions.derivationSuffix,
              senderIdentityKey: instructions.senderIdentityKey
            }
          }
        ],
        description: 'Recover WAB faucet funding'
      },
      adminOriginator
    )
    if (result.accepted !== true) throw new Error('Wallet did not accept its recovered WAB faucet payment.')
    return true
  }

  const actions = await wallet.listActions(
    {
      labels: [label],
      includeLabels: true,
      includeInputs: true,
      includeOutputs: true,
      includeOutputLockingScripts: true,
      limit: 10
    },
    adminOriginator
  )
  if (!Array.isArray(actions.actions)) throw new Error('Wallet returned invalid faucet recovery actions.')
  const matchingActions = actions.actions.filter(action => action.labels?.includes(label))
  if (matchingActions.length === 0) return false
  if (matchingActions.length !== 1) throw new Error('Wallet returned ambiguous faucet recovery actions.')
  const action = matchingActions[0]
  const matchingInputs = action.inputs?.filter(input => input.sourceOutpoint.toLowerCase() === faucetOutpoint) ?? []
  const matchingOutputs =
    action.outputs?.filter(output => {
      const instructions = parseFaucetRecoveryInstructions(output.customInstructions)
      return instructions?.faucetOutpoint.toLowerCase() === faucetOutpoint
    }) ?? []
  if (matchingInputs.length !== 1 || matchingOutputs.length !== 1) {
    throw new Error('Wallet returned unrelated faucet recovery action evidence.')
  }
  if (
    (action.status === 'completed' || action.status === 'sending' || action.status === 'unproven') &&
    matchingOutputs[0].basket === 'default'
  ) {
    return true
  }
  if (action.status === 'nosend') {
    if (!resumeNosend) throw new Error('Prior WAB faucet action remained unsent after broadcast retry.')
    await wallet.createAction(
      {
        description: 'Resume WAB faucet broadcast',
        options: { sendWith: [action.txid], acceptDelayedBroadcast: false }
      },
      adminOriginator
    )
    return await recoverWABFaucetPayment(wallet, faucetOutpoint, adminOriginator, false)
  }
  throw new Error('Prior WAB faucet action requires reconciliation before retrying.')
}

export interface WalletAuthenticationManagerOptions {
  telemetry?: TelemetryConfig
  /** Maximum lifetime of a temporary WAB presentation key. Defaults to 10 minutes. */
  authSessionTtlMs?: number
}

export class WABAccountContinuityError extends Error {
  readonly code = 'WERR_WAB_ACCOUNT_CONTINUITY'

  constructor(message: string = 'WAB and UMP accounts disagree; retry or recover.') {
    super(message)
    this.name = 'WABAccountContinuityError'
  }
}

interface WABAuthSession {
  presentationKey: string
  methodType: string
  expiresAt: number
  correlationId?: string
}

interface WABPhoneChangeSession {
  phoneNumber: string
  presentationKey: string
  changeToken?: string
  newKey?: number[]
  changeId?: number
  umpUpdated?: boolean
}

interface WABPhoneChangeAuthorization extends WABOperationResponse {
  changeToken?: string
  pendingPresentationKey?: string
  pendingPhoneChangeId?: number
}

interface WABPhoneChangeCommit extends WABOperationResponse {
  changeId?: number
}

interface PendingPhoneChange {
  presentationKey: string
  changeId: number
}

/**
 * WalletAuthenticationManager
 *
 * A wallet manager that integrates
 * with a WABClient for user authentication flows (e.g. Twilio phone).
 */
export class WalletAuthenticationManager extends CWIStyleWalletManager {
  private readonly wabClient: WABClient // instance of WABClient
  private authMethod?: AuthMethodInteractor // chosen AuthMethod interactor
  private authSession?: WABAuthSession
  private phoneChangeSession?: WABPhoneChangeSession
  private pendingRegistrationPresentationKey?: string
  private readonly authSessionTtlMs: number

  constructor(
    ...[
      adminOriginator,
      walletBuilder,
      interactor,
      recoveryKeySaver,
      passwordRetriever,
      wabClient,
      authMethod,
      stateSnapshot,
      options = {}
    ]: [
      adminOriginator: string,
      walletBuilder: (primaryKey: number[], privilegedKeyManager: PrivilegedKeyManager) => Promise<WalletInterface>,
      interactor: UMPTokenInteractor | undefined,
      recoveryKeySaver: (key: number[]) => Promise<true>,
      passwordRetriever: (
        reason: string,
        test: (passwordCandidate: string) => boolean | Promise<boolean>
      ) => Promise<string>,
      wabClient: WABClient,
      authMethod?: AuthMethodInteractor,
      stateSnapshot?: number[],
      options?: WalletAuthenticationManagerOptions
    ]
  ) {
    super(
      adminOriginator,
      walletBuilder,
      interactor,
      recoveryKeySaver,
      passwordRetriever,
      // Here, we provide a custom new wallet funder that uses the Secret Server
      async (presentationKey: number[], wallet: WalletInterface, adminOriginator: string) => {
        const faucetResponse = await this.wabClient.requestFaucet(toHex(presentationKey))
        const paymentData = faucetResponse.paymentData
        const faucetSucceeded: unknown = faucetResponse.success

        if (faucetSucceeded !== true || paymentData == null) {
          const message =
            faucetResponse.message != null && faucetResponse.message.length > 0
              ? faucetResponse.message
              : 'Missing paymentData from WAB'
          throw new Error(`Faucet request failed: ${message}`)
        }

        if (
          paymentData.k == null ||
          paymentData.k.length === 0 ||
          paymentData.tx == null ||
          paymentData.tx.length === 0 ||
          paymentData.txid == null ||
          paymentData.txid.length === 0
        ) {
          throw new Error('Faucet response missing required fields: k, tx, or txid')
        }

        try {
          if (!/^[0-9a-f]{64}$/i.test(paymentData.txid)) {
            throw new Error('Faucet transaction ID is invalid.')
          }
          if (!/^[0-9a-f]{1,64}$/i.test(paymentData.k)) {
            throw new Error('Faucet R-puzzle scalar is invalid.')
          }
          const faucetK = new PrivateKey(paymentData.k, 16, 'be', 'error')
          if (faucetK.isZero()) {
            throw new Error('Faucet R-puzzle scalar is invalid.')
          }
          const tx = Transaction.fromAtomicBEEF(paymentData.tx)
          const txid = tx.id('hex')
          if (txid !== paymentData.txid.toLowerCase()) {
            throw new Error('Faucet transaction ID does not match its transaction data.')
          }
          const faucetOutput = tx.outputs[0]
          if (faucetOutput == null) {
            throw new Error('Faucet transaction output 0 is missing.')
          }
          const faucetSatoshis = faucetOutput.satoshis
          if (
            typeof faucetSatoshis !== 'number' ||
            !Number.isSafeInteger(faucetSatoshis) ||
            faucetSatoshis <= 0 ||
            faucetSatoshis > 21e14
          ) {
            throw new Error('Faucet transaction output 0 has an invalid amount.')
          }
          let rValue = faucetK.toPublicKey().getX().toArray()
          if (rValue[0] > 127) rValue = [0, ...rValue]
          const faucetRedemptionPuzzle = new RPuzzle()
          if (faucetOutput.lockingScript.toHex() !== faucetRedemptionPuzzle.lock(rValue).toHex()) {
            throw new Error('Faucet transaction output 0 does not match its R-puzzle scalar.')
          }
          const randomRedemptionPrivateKey = PrivateKey.fromRandom()
          const faucetRedeemUnlocker = faucetRedemptionPuzzle.unlock(faucetK, randomRedemptionPrivateKey)
          const outpoint = `${txid}.0`
          if (paymentData.outputIndex !== undefined && paymentData.outputIndex !== 0) {
            throw new Error('Faucet response output index does not match output 0.')
          }
          if (paymentData.amount !== undefined && paymentData.amount !== faucetSatoshis) {
            throw new Error('Faucet response amount does not match output 0.')
          }
          if (await recoverWABFaucetPayment(wallet, outpoint, adminOriginator)) return

          const identityResult = await wallet.getPublicKey({ identityKey: true }, adminOriginator)
          const identityKey = PublicKey.fromString(identityResult.publicKey).toString()
          const paymentSender = PrivateKey.fromRandom()
          const derivationPrefix = toBase64(Random(16))
          const derivationSuffix = toBase64(Random(16))
          const paymentTemplate = new ScriptTemplateBRC29({
            derivationPrefix,
            derivationSuffix,
            keyDeriver: new CachedKeyDeriver(paymentSender)
          })
          const paymentLock = paymentTemplate.lock(paymentSender.toString(), identityKey).toHex()
          const recoveryInstructions = JSON.stringify({
            version: 1,
            faucetOutpoint: outpoint,
            derivationPrefix,
            derivationSuffix,
            senderIdentityKey: paymentSender.toPublicKey().toString()
          })
          const signed = await completeBoundAction(
            wallet,
            {
              inputBEEF: tx.toBEEF(),
              inputs: [
                {
                  outpoint,
                  unlockingScriptLength: 108,
                  inputDescription: 'Fund from faucet'
                }
              ],
              outputs: [
                {
                  lockingScript: paymentLock,
                  satoshis: maxPossibleSatoshis,
                  outputDescription: 'Receive WAB faucet funds',
                  basket: 'wab faucet recovery',
                  customInstructions: recoveryInstructions
                }
              ],
              labels: [`wab faucet ${txid}`],
              description: 'Fund wallet',
              options: {
                acceptDelayedBroadcast: false,
                noSend: true,
                randomizeOutputs: false
              }
            },
            {
              ...(completeBoundAction.outputAuthorizationVersion === 1
                ? { authorizeAdditionalOutputs: getActionOutputAuthorizations }
                : {}),
              inputSigners: {
                [outpoint]: async (transaction, inputIndex) => await faucetRedeemUnlocker.sign(transaction, inputIndex)
              },
              outputSatoshisRanges: {
                0: {
                  minimumSatoshis: 1,
                  maximumSatoshis: faucetSatoshis
                }
              }
            },
            adminOriginator
          )
          const matches = signed.outputs.flatMap((output, outputIndex) => {
            const outputSatoshis = output.satoshis
            return output.lockingScript.toHex() === paymentLock &&
              typeof outputSatoshis === 'number' &&
              outputSatoshis >= 1 &&
              outputSatoshis <= faucetSatoshis
              ? [outputIndex]
              : []
          })
          if (matches.length !== 1) {
            throw new Error('Faucet redemption omitted or duplicated its wallet-owned output.')
          }
          const redemptionTxid = signed.id('hex')
          await wallet.createAction(
            {
              description: 'Broadcast WAB faucet funding',
              options: { sendWith: [redemptionTxid], acceptDelayedBroadcast: false }
            },
            adminOriginator
          )
          const internalized = await wallet.internalizeAction(
            {
              tx: signed.toAtomicBEEF(),
              outputs: [
                {
                  outputIndex: matches[0],
                  protocol: 'wallet payment',
                  paymentRemittance: {
                    derivationPrefix,
                    derivationSuffix,
                    senderIdentityKey: paymentSender.toPublicKey().toString()
                  }
                }
              ],
              description: 'Receive WAB faucet funding'
            },
            adminOriginator
          )
          if (internalized.accepted !== true) {
            throw new Error('Wallet did not accept its WAB faucet payment.')
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`Faucet redemption failed: ${message}`)
        }
      },
      stateSnapshot,
      undefined,
      options.telemetry
    )

    this.wabClient = wabClient
    this.authMethod = authMethod
    const authSessionTtlMs = options.authSessionTtlMs ?? DEFAULT_AUTH_SESSION_TTL_MS
    if (!Number.isInteger(authSessionTtlMs) || authSessionTtlMs <= 0 || authSessionTtlMs > MAX_AUTH_SESSION_TTL_MS) {
      throw new TypeError(`authSessionTtlMs must be between 1 and ${MAX_AUTH_SESSION_TTL_MS}.`)
    }
    this.authSessionTtlMs = authSessionTtlMs
  }

  /**
   * Sets (or switches) the chosen AuthMethodInteractor at runtime,
   * in case the user changes their mind or picks a new method in the UI.
   */
  public setAuthMethod(method: AuthMethodInteractor): void {
    if (this.authMethod?.methodType !== method.methodType) this.cancelAuth()
    this.authMethod = method
  }

  /**
   * Initiate the WAB-based flow, e.g. sending an SMS code or starting an ID check,
   * using the chosen AuthMethodInteractor.
   */
  public async startAuth(payload: AuthPayload): Promise<void> {
    if (this.authMethod == null) {
      throw new Error('No WAB authentication method selected.')
    }
    const authMethod = this.authMethod
    if (this.authenticated) throw new Error('User is already authenticated')
    this.cancelAuth()
    this.pendingRegistrationPresentationKey = undefined

    const presentationKey = this.generateTemporaryPresentationKey()
    const correlationId = this.telemetry.enabled === true ? this.telemetry.createCorrelationId() : undefined
    this.authSession = {
      presentationKey,
      methodType: authMethod.methodType,
      expiresAt: Date.now() + this.authSessionTtlMs,
      ...(correlationId !== undefined ? { correlationId } : {})
    }
    this.telemetry.capture({
      name: `${AUTH_EVENT}wab-start.started`,
      component: AUTH_COMPONENT,
      severity: 'debug',
      correlationId,
      attributes: { methodType: authMethod.methodType }
    })

    try {
      const startRes = await this.wabClient.startAuthMethod(authMethod, presentationKey, payload, correlationId)

      const startSucceeded: unknown = startRes.success
      if (startSucceeded !== true) {
        const message =
          startRes.message != null && startRes.message.length > 0 ? startRes.message : 'Failed to start WAB auth method'
        throw new Error(message)
      }
      this.telemetry.capture({
        name: `${AUTH_EVENT}wab-start.completed`,
        component: AUTH_COMPONENT,
        severity: 'info',
        correlationId,
        attributes: { methodType: authMethod.methodType }
      })
    } catch (error) {
      this.cancelAuth()
      this.telemetry.capture({
        name: `${AUTH_EVENT}wab-start.failed`,
        component: AUTH_COMPONENT,
        severity: 'warn',
        correlationId,
        attributes: { methodType: authMethod.methodType },
        error: error instanceof WABClientError ? error : new Error('WAB authentication start failed.')
      })
      throw error
    }
  }

  /**
   * Completes the WAB-based flow, retrieving the final presentationKey from WAB if successful.
   */
  public async completeAuth(payload: AuthPayload): Promise<void> {
    if (this.authMethod == null || this.authSession == null) {
      throw new Error('Start WAB authentication first.')
    }
    const authMethod = this.authMethod
    if (this.authSession.methodType !== authMethod.methodType) {
      this.cancelAuth()
      throw new Error('WAB authentication method changed; restart.')
    }
    if (Date.now() >= this.authSession.expiresAt) {
      this.cancelAuth()
      throw new Error('WAB authentication expired; restart.')
    }

    const session = this.authSession
    const result = await this.wabClient.completeAuthMethod(
      authMethod,
      session.presentationKey,
      payload,
      session.correlationId
    )

    const authSucceeded: unknown = result.success
    if (authSucceeded !== true || result.presentationKey == null || result.presentationKey.length === 0) {
      this.telemetry.capture({
        name: `${AUTH_EVENT}wab-complete.rejected`,
        component: AUTH_COMPONENT,
        severity: 'warn',
        correlationId: session.correlationId,
        attributes: { methodType: session.methodType }
      })
      const message =
        result.message != null && result.message.length > 0 ? result.message : 'Failed to complete WAB auth'
      throw new Error(message)
    }
    if (!/^[0-9a-fA-F]{64}$/.test(result.presentationKey)) {
      this.cancelAuth()
      throw new WABAccountContinuityError('WAB returned an invalid presentation key.')
    }

    this.cancelAuth()
    const wabAccountStatus = this.inferAccountStatus(result, session.presentationKey)
    const registrationStatus = this.readRegistrationStatus(result)
    try {
      await this.provideWABPresentationKey(result, wabAccountStatus)
    } catch (error) {
      this.telemetry.capture({
        name: `${AUTH_EVENT}ump-continuity.failed`,
        component: AUTH_COMPONENT,
        severity: 'warn',
        correlationId: session.correlationId,
        attributes: {
          methodType: session.methodType,
          wabAccountStatus
        },
        error
      })
      throw error
    }

    this.assertAccountContinuity(wabAccountStatus, registrationStatus, session)
    await this.reconcilePendingRegistration(result, registrationStatus)
    const continuity = this.describeContinuity(wabAccountStatus, registrationStatus)
    this.telemetry.capture({
      name: `${AUTH_EVENT}completed`,
      component: AUTH_COMPONENT,
      severity: continuity === 'matched' ? 'info' : 'warn',
      correlationId: session.correlationId,
      attributes: {
        methodType: session.methodType,
        wabAccountStatus,
        umpAccountStatus: this.authenticationFlow,
        continuity
      }
    })
  }

  public cancelAuth(): void {
    this.authSession = undefined
  }

  /**
   * Publishes a new UMP token before committing WAB's registration state.
   * Finalization is deliberately best-effort: if its response is lost, the
   * next verified login finds the UMP token and repairs WAB idempotently.
   */
  public override async providePassword(password: string): Promise<void> {
    const shouldFinalize = this.pendingRegistrationPresentationKey != null && this.authenticationFlow === NEW_USER
    await super.providePassword(password)
    if (shouldFinalize) await this.finalizePendingRegistration()
  }

  private readRegistrationStatus(result: CompleteAuthResponse): 'pending' | 'active' {
    const status: unknown = result.registrationStatus
    if (status === undefined) return 'active'
    if (status !== 'pending' && status !== 'active') {
      throw new WABAccountContinuityError('WAB returned an invalid registration status.')
    }
    return status
  }

  private assertAccountContinuity(
    wabAccountStatus: 'new-user' | 'existing-user',
    registrationStatus: 'pending' | 'active',
    session: WABAuthSession
  ): void {
    const mismatch = wabAccountStatus === EXISTING_USER && this.authenticationFlow !== EXISTING_USER
    if (!mismatch || registrationStatus === PENDING_REGISTRATION) return

    super.destroy()
    const error = new WABAccountContinuityError()
    this.telemetry.capture({
      name: `${AUTH_EVENT}account-continuity.mismatch`,
      component: AUTH_COMPONENT,
      severity: 'error',
      correlationId: session.correlationId,
      attributes: {
        methodType: session.methodType,
        wabAccountStatus,
        umpAccountStatus: NEW_USER
      },
      error
    })
    throw error
  }

  private async reconcilePendingRegistration(
    result: CompleteAuthResponse,
    registrationStatus: 'pending' | 'active'
  ): Promise<void> {
    if (registrationStatus !== PENDING_REGISTRATION) return
    this.pendingRegistrationPresentationKey = result.presentationKey
    if (this.authenticationFlow === EXISTING_USER) await this.finalizePendingRegistration()
  }

  private describeContinuity(
    wabAccountStatus: 'new-user' | 'existing-user',
    registrationStatus: 'pending' | 'active'
  ): 'registration-resumed' | 'matched' | 'ump-existing' {
    if (registrationStatus === PENDING_REGISTRATION && this.authenticationFlow === NEW_USER) {
      return 'registration-resumed'
    }
    if (wabAccountStatus === this.authenticationFlow) return 'matched'
    return 'ump-existing'
  }

  private async finalizePendingRegistration(): Promise<void> {
    const presentationKey = this.pendingRegistrationPresentationKey
    if (presentationKey == null) return
    try {
      const result = await this.wabClient.finalizeRegistration(presentationKey)
      if (result.success !== true || result.registrationStatus !== 'active') {
        throw new Error(result.message || 'WAB registration finalization was not acknowledged.')
      }
      this.pendingRegistrationPresentationKey = undefined
      this.telemetry.capture({
        name: `${AUTH_EVENT}registration-finalize.completed`,
        component: AUTH_COMPONENT,
        severity: 'info'
      })
    } catch (error) {
      this.telemetry.capture({
        name: `${AUTH_EVENT}registration-finalize.deferred`,
        component: AUTH_COMPONENT,
        severity: 'warn',
        error: new Error('WAB registration finalization was deferred.', { cause: error })
      })
    }
  }

  private readPendingPhoneChange(result: CompleteAuthResponse): PendingPhoneChange | undefined {
    const presentationKey = result.pendingPresentationKey
    const changeId = result.pendingPhoneChangeId
    if (presentationKey === undefined && changeId === undefined) return undefined
    if (!/^[0-9a-fA-F]{64}$/.test(presentationKey ?? '') || !Number.isSafeInteger(changeId) || changeId! <= 0) {
      throw new WABAccountContinuityError('WAB returned invalid pending phone-change data.')
    }
    return { presentationKey: presentationKey!, changeId: changeId! }
  }

  private async provideWABPresentationKey(result: CompleteAuthResponse, wabAccountStatus: string): Promise<void> {
    const umpTokenOutpoint =
      typeof result.umpTokenOutpoint === 'string' ? (result.umpTokenOutpoint as `${string}.${number}`) : undefined
    const lookupOptions = umpTokenOutpoint == null ? undefined : { pinnedOutpoint: umpTokenOutpoint }
    const pending = this.readPendingPhoneChange(result)
    let usePending = false
    try {
      await this.providePresentationKey(toArray(result.presentationKey!, 'hex'), lookupOptions)
    } catch (error) {
      if (pending == null) throw error
      usePending = true
    }

    if (
      pending != null &&
      (usePending || (wabAccountStatus === EXISTING_USER && this.authenticationFlow !== EXISTING_USER))
    ) {
      await this.providePresentationKey(toArray(pending.presentationKey, 'hex'), lookupOptions)
      if (this.authenticationFlow === EXISTING_USER) {
        await this.finalizePendingPhoneChange(result.presentationKey!, pending)
      }
    }
  }

  private async finalizePendingPhoneChange(currentPresentationKey: string, pending: PendingPhoneChange): Promise<void> {
    const finalized = await this.phoneChange<WABPhoneChangeCommit>('finalize', {
      changeId: pending.changeId,
      presentationKey: currentPresentationKey,
      newPresentationKey: pending.presentationKey
    })
    if (finalized.success !== true || finalized.changeId !== pending.changeId) {
      throw new WABAccountContinuityError(finalized.message || 'WAB could not finalize the pending phone change.')
    }
  }

  /**
   * Starts OTP verification for a replacement phone number. The same number
   * is valid and intentionally produces a fresh presentation key/hash.
   */
  public async startPhoneNumberChange(phoneNumber: string): Promise<void> {
    if (!this.authenticated) throw new Error('Not authenticated')
    const normalizedPhone = phoneNumber.trim()
    const currentPresentationKey = toHex(await this.getFactor('presentationKey'))
    const response = await this.phoneChange<WABOperationResponse>('start', {
      presentationKey: currentPresentationKey,
      phoneNumber: normalizedPhone
    })
    if (response.success !== true) throw new Error(response.message || 'Phone change failed')
    this.phoneChangeSession = {
      phoneNumber: normalizedPhone,
      presentationKey: currentPresentationKey
    }
  }

  /**
   * Completes phone verification and stages the WAB association before
   * publishing the UMP key rotation. WAB retains both the current and pending
   * presentation keys until finalization, so either side of an interrupted
   * transition remains recoverable on the next verified login.
   */
  public async completePhoneNumberChange(otp: string): Promise<{ changeId: number }> {
    const session = this.phoneChangeSession
    if (session == null) throw new Error('No phone change')

    if (session.changeToken == null) {
      const authorization = await this.phoneChange<WABPhoneChangeAuthorization>('complete', {
        presentationKey: session.presentationKey,
        phoneNumber: session.phoneNumber,
        otp: otp.trim()
      })
      if (authorization.success !== true) {
        throw new Error(authorization.message || 'Phone change failed')
      }
      const resumable =
        /^[0-9a-fA-F]{64}$/.test(authorization.pendingPresentationKey ?? '') &&
        Number.isSafeInteger(authorization.pendingPhoneChangeId) &&
        authorization.pendingPhoneChangeId! > 0
      if (resumable) {
        session.newKey = toArray(authorization.pendingPresentationKey!, 'hex')
        session.changeId = authorization.pendingPhoneChangeId
      } else if (typeof authorization.changeToken === 'string' && authorization.changeToken.length > 0) {
        session.changeToken = authorization.changeToken
      } else {
        throw new Error(authorization.message || 'Phone change failed')
      }
    }

    session.newKey ??= Random(32)
    if (session.changeId == null) {
      const committed = await this.phoneChange<WABPhoneChangeCommit>('commit', {
        changeToken: session.changeToken,
        presentationKey: session.presentationKey,
        newPresentationKey: toHex(session.newKey)
      })
      if (committed.success !== true || !Number.isSafeInteger(committed.changeId) || committed.changeId! <= 0) {
        throw new Error(committed.message || 'Phone change failed')
      }
      session.changeId = committed.changeId as number
    }
    const changeId = session.changeId

    if (session.umpUpdated !== true) {
      await this.changePresentationKey(session.newKey)
      session.umpUpdated = true
    }

    const finalized = await this.phoneChange<WABPhoneChangeCommit>('finalize', {
      changeId,
      presentationKey: session.presentationKey,
      newPresentationKey: toHex(session.newKey)
    })
    if (finalized.success !== true || finalized.changeId !== changeId) {
      throw new Error(finalized.message || 'Phone change failed')
    }
    this.phoneChangeSession = undefined
    return { changeId }
  }

  public cancelPhoneNumberChange(): void {
    this.phoneChangeSession = undefined
  }

  public override destroy(): void {
    this.cancelAuth()
    this.cancelPhoneNumberChange()
    this.pendingRegistrationPresentationKey = undefined
    super.destroy()
  }

  private async phoneChange<T extends WABOperationResponse>(phase: string, body: unknown): Promise<T> {
    const response = await this.wabClient.transport.request<unknown>(`/auth/phone-change/${phase}`, {
      operation: 'phone-change',
      body
    })
    return validateWABOperationResponse(response, `phone-change-${phase}`) as T
  }

  private inferAccountStatus(
    result: CompleteAuthResponse,
    temporaryPresentationKey: string
  ): 'new-user' | 'existing-user' {
    if (result.presentationKey == null) {
      throw new WABAccountContinuityError('WAB did not return a presentation key.')
    }
    const keyMatchesTemporary = this.constantTimeHexEqual(result.presentationKey, temporaryPresentationKey)
    const rawAccountStatus: unknown = result.accountStatus
    if (rawAccountStatus !== undefined && rawAccountStatus !== NEW_USER && rawAccountStatus !== EXISTING_USER) {
      throw new WABAccountContinuityError('WAB returned an invalid account status.')
    }
    const rawExistingUser: unknown = result.existingUser
    if (rawExistingUser !== undefined && typeof rawExistingUser !== 'boolean') {
      throw new WABAccountContinuityError('WAB returned invalid existing-user data.')
    }
    if (
      rawAccountStatus !== undefined &&
      rawExistingUser !== undefined &&
      (rawAccountStatus === EXISTING_USER) !== rawExistingUser
    ) {
      throw new WABAccountContinuityError('WAB returned conflicting account status.')
    }
    let compatibilityStatus: 'existing-user' | 'new-user' | undefined
    if (typeof rawExistingUser === 'boolean') {
      compatibilityStatus = rawExistingUser ? EXISTING_USER : NEW_USER
    }
    const explicitStatus = rawAccountStatus ?? compatibilityStatus

    if (
      (explicitStatus === NEW_USER && !keyMatchesTemporary) ||
      (explicitStatus === EXISTING_USER && keyMatchesTemporary)
    ) {
      throw new WABAccountContinuityError('WAB returned conflicting account status.')
    }
    return explicitStatus ?? (keyMatchesTemporary ? NEW_USER : EXISTING_USER)
  }

  private constantTimeHexEqual(left: string, right: string): boolean {
    if (left.length !== right.length) return false
    const normalizedLeft = left.toLowerCase()
    const normalizedRight = right.toLowerCase()
    let difference = 0
    for (let i = 0; i < normalizedLeft.length; i++) {
      difference |= normalizedLeft.codePointAt(i)! ^ normalizedRight.codePointAt(i)!
    }
    return difference === 0
  }

  private generateTemporaryPresentationKey(): string {
    // For the 'startAuth' call, we can generate a random 32 bytes → 64 hex chars.
    const randomBytes = Random(32) // array of length 32
    return toHex(randomBytes)
  }
}
