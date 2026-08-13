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

type WABPhoneChangeSession = [phoneNumber: string, presentationKey: string, changeToken?: string, newKey?: number[]]

interface WABPhoneChangeAuthorization extends WABOperationResponse {
  changeToken?: string
}

interface WABPhoneChangeCommit extends WABOperationResponse {
  changeId?: number
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
    try {
      const umpTokenOutpoint =
        typeof result.umpTokenOutpoint === 'string' ? (result.umpTokenOutpoint as `${string}.${number}`) : undefined
      await this.providePresentationKey(
        Utils.toArray(result.presentationKey, 'hex'),
        umpTokenOutpoint == null ? undefined : { pinnedOutpoint: umpTokenOutpoint }
      )
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

    if (wabAccountStatus === EXISTING_USER && this.authenticationFlow !== EXISTING_USER) {
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

    const continuity = wabAccountStatus === this.authenticationFlow ? 'matched' : 'ump-existing'
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
    this.phoneChangeSession = [normalizedPhone, currentPresentationKey]
  }

  /**
   * Completes phone verification, rolls the on-chain UMP presentation key by
   * spending the current token, and only then commits the WAB association.
   * A failed final WAB request can be retried with the same OTP while this
   * manager remains alive; the UMP update is not repeated.
   */
  public async completePhoneNumberChange(otp: string): Promise<{ changeId: number }> {
    const session = this.phoneChangeSession
    if (session == null) throw new Error('No phone change')

    if (session[2] == null) {
      const authorization = await this.phoneChange<WABPhoneChangeAuthorization>('complete', {
        presentationKey: session[1],
        phoneNumber: session[0],
        otp: otp.trim()
      })
      if (
        authorization.success !== true ||
        typeof authorization.changeToken !== 'string' ||
        authorization.changeToken.length === 0
      ) {
        throw new Error(authorization.message || 'Phone change failed')
      }
      session[2] = authorization.changeToken
    }

    if (session[3] == null) {
      const newKey = Random(32)
      await this.changePresentationKey(newKey)
      session[3] = newKey
    }

    const committed = await this.phoneChange<WABPhoneChangeCommit>('commit', {
      changeToken: session[2],
      presentationKey: session[1],
      newPresentationKey: Utils.toHex(session[3])
    })
    if (committed.success !== true || !Number.isSafeInteger(committed.changeId) || committed.changeId! <= 0) {
      throw new Error(committed.message || 'Phone change failed')
    }
    this.phoneChangeSession = undefined
    return { changeId: committed.changeId as number }
  }

  public cancelPhoneNumberChange(): void {
    this.phoneChangeSession = undefined
  }

  public override destroy(): void {
    this.cancelAuth()
    this.cancelPhoneNumberChange()
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
