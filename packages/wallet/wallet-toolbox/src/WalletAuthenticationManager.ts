import { CWIStyleWalletManager, UMPTokenInteractor } from './CWIStyleWalletManager'
import { PrivilegedKeyManager } from './sdk/PrivilegedKeyManager'
import {
  WalletInterface,
  Random,
  Utils,
  Transaction,
  RPuzzle,
  PrivateKey,
  BigNumber,
  TelemetryConfig
} from '@bsv/sdk'
import { WABClient } from './wab-client/WABClient'
import { WABClientError } from './wab-client/WABTransport'
import {
  AuthMethodInteractor,
  AuthPayload,
  CompleteAuthResponse
} from './wab-client/auth-method-interactors/AuthMethodInteractor'

const DEFAULT_AUTH_SESSION_TTL_MS = 10 * 60 * 1000
const MAX_AUTH_SESSION_TTL_MS = 60 * 60 * 1000

export interface WalletAuthenticationManagerOptions {
  telemetry?: TelemetryConfig
  /** Maximum lifetime of a temporary WAB presentation key. Defaults to 10 minutes. */
  authSessionTtlMs?: number
}

export class WABAccountContinuityError extends Error {
  readonly code = 'WERR_WAB_ACCOUNT_CONTINUITY'

  constructor (message: string = 'WAB and UMP account state did not agree. Retry or use account recovery.') {
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
  private readonly authSessionTtlMs: number

  constructor (
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
          const message = faucetResponse.message != null && faucetResponse.message.length > 0
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
            throw new Error('Faucet redemption did not return a signableTransaction')
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
    if (
      !Number.isInteger(authSessionTtlMs) ||
      authSessionTtlMs <= 0 ||
      authSessionTtlMs > MAX_AUTH_SESSION_TTL_MS
    ) {
      throw new TypeError(`authSessionTtlMs must be between 1 and ${MAX_AUTH_SESSION_TTL_MS}.`)
    }
    this.authSessionTtlMs = authSessionTtlMs
  }

  /**
   * Sets (or switches) the chosen AuthMethodInteractor at runtime,
   * in case the user changes their mind or picks a new method in the UI.
   */
  public setAuthMethod (method: AuthMethodInteractor): void {
    if (this.authMethod?.methodType !== method.methodType) this.cancelAuth()
    this.authMethod = method
  }

  /**
   * Initiate the WAB-based flow, e.g. sending an SMS code or starting an ID check,
   * using the chosen AuthMethodInteractor.
   */
  public async startAuth (payload: AuthPayload): Promise<void> {
    if (this.authMethod == null) {
      throw new Error('No AuthMethod selected in WalletAuthenticationManager')
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
      name: 'wallet-toolbox.authentication.wab-start.started',
      component: 'wallet-toolbox.authentication-manager',
      severity: 'debug',
      correlationId,
      attributes: { methodType: authMethod.methodType }
    })

    try {
      const startRes = await this.wabClient.startAuthMethod(
        authMethod,
        presentationKey,
        payload,
        correlationId
      )

      const startSucceeded: unknown = startRes.success
      if (startSucceeded !== true) {
        const message = startRes.message != null && startRes.message.length > 0
          ? startRes.message
          : 'Failed to start WAB auth method'
        throw new Error(message)
      }
      this.telemetry.capture({
        name: 'wallet-toolbox.authentication.wab-start.completed',
        component: 'wallet-toolbox.authentication-manager',
        severity: 'info',
        correlationId,
        attributes: { methodType: authMethod.methodType }
      })
    } catch (error) {
      this.cancelAuth()
      this.telemetry.capture({
        name: 'wallet-toolbox.authentication.wab-start.failed',
        component: 'wallet-toolbox.authentication-manager',
        severity: 'warn',
        correlationId,
        attributes: { methodType: authMethod.methodType },
        error: error instanceof WABClientError
          ? error
          : new Error('WAB authentication start failed.')
      })
      throw error
    }
  }

  /**
   * Completes the WAB-based flow, retrieving the final presentationKey from WAB if successful.
   */
  public async completeAuth (payload: AuthPayload): Promise<void> {
    if (this.authMethod == null || this.authSession == null) {
      throw new Error('No AuthMethod selected in WalletAuthenticationManager or startAuth has yet to be called.')
    }
    const authMethod = this.authMethod
    if (this.authSession.methodType !== authMethod.methodType) {
      this.cancelAuth()
      throw new Error('The selected authentication method changed. Start authentication again.')
    }
    if (Date.now() >= this.authSession.expiresAt) {
      this.cancelAuth()
      throw new Error('The WAB authentication session expired. Start authentication again.')
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
        name: 'wallet-toolbox.authentication.wab-complete.rejected',
        component: 'wallet-toolbox.authentication-manager',
        severity: 'warn',
        correlationId: session.correlationId,
        attributes: { methodType: session.methodType }
      })
      const message = result.message != null && result.message.length > 0
        ? result.message
        : 'Failed to complete WAB auth'
      throw new Error(message)
    }
    if (!/^[0-9a-fA-F]{64}$/.test(result.presentationKey)) {
      this.cancelAuth()
      throw new WABAccountContinuityError('WAB returned an invalid presentation key.')
    }

    this.cancelAuth()
    const wabAccountStatus = this.inferAccountStatus(result, session.presentationKey)
    try {
      await this.providePresentationKey(Utils.toArray(result.presentationKey, 'hex'))
    } catch (error) {
      this.telemetry.capture({
        name: 'wallet-toolbox.authentication.ump-continuity.failed',
        component: 'wallet-toolbox.authentication-manager',
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

    if (wabAccountStatus === 'existing-user' && this.authenticationFlow !== 'existing-user') {
      super.destroy()
      const error = new WABAccountContinuityError()
      this.telemetry.capture({
        name: 'wallet-toolbox.authentication.account-continuity.mismatch',
        component: 'wallet-toolbox.authentication-manager',
        severity: 'error',
        correlationId: session.correlationId,
        attributes: {
          methodType: session.methodType,
          wabAccountStatus,
          umpAccountStatus: 'new-user'
        },
        error
      })
      throw error
    }

    const continuity = wabAccountStatus === this.authenticationFlow ? 'matched' : 'ump-existing'
    this.telemetry.capture({
      name: 'wallet-toolbox.authentication.completed',
      component: 'wallet-toolbox.authentication-manager',
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

  public cancelAuth (): void {
    this.authSession = undefined
  }

  public override destroy (): void {
    this.cancelAuth()
    super.destroy()
  }

  private inferAccountStatus (
    result: CompleteAuthResponse,
    temporaryPresentationKey: string
  ): 'new-user' | 'existing-user' {
    if (result.presentationKey == null) {
      throw new WABAccountContinuityError('WAB did not return a presentation key.')
    }
    const keyMatchesTemporary = this.constantTimeHexEqual(
      result.presentationKey,
      temporaryPresentationKey
    )
    const rawAccountStatus: unknown = result.accountStatus
    if (
      rawAccountStatus !== undefined &&
      rawAccountStatus !== 'new-user' &&
      rawAccountStatus !== 'existing-user'
    ) {
      throw new WABAccountContinuityError('WAB returned an invalid account-continuity status.')
    }
    const rawExistingUser: unknown = result.existingUser
    if (rawExistingUser !== undefined && typeof rawExistingUser !== 'boolean') {
      throw new WABAccountContinuityError('WAB returned an invalid existing-user status.')
    }
    if (
      rawAccountStatus !== undefined &&
      rawExistingUser !== undefined &&
      (rawAccountStatus === 'existing-user') !== rawExistingUser
    ) {
      throw new WABAccountContinuityError('WAB returned contradictory account-continuity statuses.')
    }
    let compatibilityStatus: 'existing-user' | 'new-user' | undefined
    if (typeof rawExistingUser === 'boolean') {
      compatibilityStatus = rawExistingUser ? 'existing-user' : 'new-user'
    }
    const explicitStatus = rawAccountStatus ?? compatibilityStatus

    if (
      (explicitStatus === 'new-user' && !keyMatchesTemporary) ||
      (explicitStatus === 'existing-user' && keyMatchesTemporary)
    ) {
      throw new WABAccountContinuityError('WAB returned contradictory account-continuity data.')
    }
    return explicitStatus ?? (keyMatchesTemporary ? 'new-user' : 'existing-user')
  }

  private constantTimeHexEqual (left: string, right: string): boolean {
    if (left.length !== right.length) return false
    const normalizedLeft = left.toLowerCase()
    const normalizedRight = right.toLowerCase()
    let difference = 0
    for (let i = 0; i < normalizedLeft.length; i++) {
      difference |= normalizedLeft.codePointAt(i)! ^ normalizedRight.codePointAt(i)!
    }
    return difference === 0
  }

  private generateTemporaryPresentationKey (): string {
    // For the 'startAuth' call, we can generate a random 32 bytes → 64 hex chars.
    const randomBytes = Random(32) // array of length 32
    return Utils.toHex(randomBytes)
  }
}
