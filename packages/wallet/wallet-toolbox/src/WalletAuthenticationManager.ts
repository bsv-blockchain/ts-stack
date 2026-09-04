import { CWIStyleWalletManager, UMPTokenInteractor } from './CWIStyleWalletManager'
import { PrivilegedKeyManager } from './sdk/PrivilegedKeyManager'
import { WalletInterface, Random, Utils, Transaction, RPuzzle, PrivateKey, BigNumber, TelemetryConfig } from '@bsv/sdk'
import { WABClient, WABOperationResponse } from './wab-client/WABClient'
import { WABClientError } from './wab-client/WABTransport'
import {
  AuthMethodInteractor,
  AuthPayload,
  CompleteAuthResponse
} from './wab-client/auth-method-interactors/AuthMethodInteractor'

const DEFAULT_AUTH_SESSION_TTL_MS = 10 * 60 * 1000
const MAX_AUTH_SESSION_TTL_MS = 60 * 60 * 1000
const AUTH_COMPONENT = 'wallet-toolbox.authentication-manager'
const AUTH_EVENT = 'wallet-toolbox.authentication.'
const EXISTING_USER = 'existing-user'
const NEW_USER = 'new-user'
const PENDING_REGISTRATION = 'pending'

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
        const faucetResponse = await this.wabClient.requestFaucet(Utils.toHex(presentationKey))
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
          const tx = Transaction.fromAtomicBEEF(paymentData.tx)
          const faucetRedeemTXCreationResult = await wallet.createAction(
            {
              inputBEEF: tx.toBEEF(),
              inputs: [
                {
                  outpoint: `${paymentData.txid}.0`,
                  unlockingScriptLength: 108,
                  inputDescription: 'Fund from faucet'
                }
              ],
              description: 'Fund wallet',
              options: {
                acceptDelayedBroadcast: false
              }
            },
            adminOriginator
          )

          if (faucetRedeemTXCreationResult.signableTransaction == null) {
            throw new Error('Faucet redemption was not signable.')
          }

          const faucetRedeemTX = Transaction.fromAtomicBEEF(faucetRedeemTXCreationResult.signableTransaction.tx)
          const faucetRedemptionPuzzle = new RPuzzle()
          const randomRedemptionPrivateKey = PrivateKey.fromRandom()
          const faucetRedeemUnlocker = faucetRedemptionPuzzle.unlock(
            new BigNumber(paymentData.k, 16),
            randomRedemptionPrivateKey
          )
          const faucetRedeemUnlockingScript = await faucetRedeemUnlocker.sign(faucetRedeemTX, 0)

          await wallet.signAction({
            reference: faucetRedeemTXCreationResult.signableTransaction.reference,
            spends: {
              0: {
                unlockingScript: faucetRedeemUnlockingScript.toHex()
              }
            }
          })
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

    if (
      wabAccountStatus === EXISTING_USER &&
      this.authenticationFlow !== EXISTING_USER &&
      registrationStatus !== PENDING_REGISTRATION
    ) {
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

    if (registrationStatus === PENDING_REGISTRATION) {
      this.pendingRegistrationPresentationKey = result.presentationKey
      if (this.authenticationFlow === EXISTING_USER) {
        await this.finalizePendingRegistration()
      }
    }

    const continuity =
      registrationStatus === PENDING_REGISTRATION && this.authenticationFlow === NEW_USER
        ? 'registration-resumed'
        : wabAccountStatus === this.authenticationFlow
          ? 'matched'
          : 'ump-existing'
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
      await this.providePresentationKey(Utils.toArray(result.presentationKey!, 'hex'), lookupOptions)
    } catch (error) {
      if (pending == null) throw error
      usePending = true
    }

    if (
      pending != null &&
      (usePending || (wabAccountStatus === EXISTING_USER && this.authenticationFlow !== EXISTING_USER))
    ) {
      await this.providePresentationKey(Utils.toArray(pending.presentationKey, 'hex'), lookupOptions)
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
    const currentPresentationKey = Utils.toHex(await this.getFactor('presentationKey'))
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
        session.newKey = Utils.toArray(authorization.pendingPresentationKey!, 'hex')
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
        newPresentationKey: Utils.toHex(session.newKey)
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
      newPresentationKey: Utils.toHex(session.newKey)
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

  private phoneChange<T>(phase: string, body: unknown): Promise<T> {
    return this.wabClient.transport.request<T>(`/auth/phone-change/${phase}`, {
      operation: 'phone-change',
      body
    })
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
    return Utils.toHex(randomBytes)
  }
}
