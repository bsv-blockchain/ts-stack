import { CWIStyleWalletManager, UMPTokenInteractor, OverlayUMPTokenInteractor } from './CWIStyleWalletManager'
import { PrivilegedKeyManager } from './sdk/PrivilegedKeyManager'
import { WalletInterface, Random, Utils, Transaction, RPuzzle, PrivateKey, BigNumber } from '@bsv/sdk'
import { WABClient } from './wab-client/WABClient'
import { AuthMethodInteractor } from './wab-client/auth-method-interactors/AuthMethodInteractor'

/**
 * WalletAuthenticationManager
 *
 * A wallet manager that integrates
 * with a WABClient for user authentication flows (e.g. Twilio phone).
 */
export class WalletAuthenticationManager extends CWIStyleWalletManager {
  private readonly wabClient: WABClient // instance of WABClient
  private authMethod?: AuthMethodInteractor // chosen AuthMethod interactor
  private tempPresentationKey?: string // for temporary persistence between auth steps

  constructor (
    adminOriginator: string,
    walletBuilder: (primaryKey: number[], privilegedKeyManager: PrivilegedKeyManager) => Promise<WalletInterface>,
    interactor: UMPTokenInteractor = new OverlayUMPTokenInteractor(),
    recoveryKeySaver: (key: number[]) => Promise<true>,
    passwordRetriever: (
      reason: string,
      test: (passwordCandidate: string) => boolean | Promise<boolean>
    ) => Promise<string>,
    wabClient: WABClient,
    authMethod?: AuthMethodInteractor,
    stateSnapshot?: number[]
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
        const paymentData = faucetResponse?.paymentData

        if (!faucetResponse?.success || !paymentData) {
          throw new Error(`Faucet request failed: ${faucetResponse?.message || 'Missing paymentData from WAB'}`)
        }

        if (!paymentData.k || !paymentData.tx || !paymentData.txid) {
          throw new Error('Faucet response missing required fields: k, tx, or txid')
        }

        try {
          const tx = Transaction.fromAtomicBEEF(paymentData.tx as number[])
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
      stateSnapshot
    )

    this.wabClient = wabClient
    this.authMethod = authMethod
  }

  /**
   * Sets (or switches) the chosen AuthMethodInteractor at runtime,
   * in case the user changes their mind or picks a new method in the UI.
   */
  public setAuthMethod (method: AuthMethodInteractor) {
    this.authMethod = method
  }

  /**
   * Initiate the WAB-based flow, e.g. sending an SMS code or starting an ID check,
   * using the chosen AuthMethodInteractor.
   */
  public async startAuth (payload: any): Promise<void> {
    if (this.authMethod == null) {
      throw new Error('No AuthMethod selected in WalletAuthenticationManager')
    }
    this.tempPresentationKey = this.generateTemporaryPresentationKey()

    // For example, if this.authMethod is Twilio, `payload` might contain { phoneNumber: "+1..." }
    const startRes = await this.wabClient.startAuthMethod(
      this.authMethod,
      // The user might not have a presentationKey yet, so we generate one locally to pass to the server.
      // If it’s an existing user on the WAB side, the WAB will give us the stored key later.
      // But we do need some placeholder key for the 'startAuth' call:
      this.tempPresentationKey,
      payload
    )

    if (!startRes.success) {
      throw new Error(startRes.message || 'Failed to start WAB auth method')
    }
  }

  /**
   * Completes the WAB-based flow, retrieving the final presentationKey from WAB if successful.
   */
  public async completeAuth (payload: any): Promise<void> {
    if ((this.authMethod == null) || !this.tempPresentationKey) {
      throw new Error('No AuthMethod selected in WalletAuthenticationManager or startAuth has yet to be called.')
    }

    // Unser the temp presentation key early (for security)
    const tempKey = this.tempPresentationKey
    this.tempPresentationKey = undefined

    const result = await this.wabClient.completeAuthMethod(this.authMethod, tempKey, payload)

    if (!result.success || !result.presentationKey) {
      throw new Error(result.message || 'Failed to complete WAB auth')
    }

    // We now have the final 256-bit key in hex from the WAB
    const presentationKeyHex = result.presentationKey
    const presentationKeyBytes = Utils.toArray(presentationKeyHex, 'hex')

    // Provide this presentation key to the underlying CWI logic:
    // This sets 'this.presentationKey' and determines if it's a new or existing user
    // based on whether a UMP token exists on chain.  We'll do "presentation-key-and-password"
    // for new user flows, for example, or user might choose "presentation-key-and-recovery-key" if we wanted.
    // Either way, WAB has now done its job and we are off to base-layer CWI logic at this point!
    await this.providePresentationKey(presentationKeyBytes)
  }

  private generateTemporaryPresentationKey (): string {
    // For the 'startAuth' call, we can generate a random 32 bytes → 64 hex chars.
    const randomBytes = Random(32) // array of length 32
    return Utils.toHex(randomBytes)
  }
}
