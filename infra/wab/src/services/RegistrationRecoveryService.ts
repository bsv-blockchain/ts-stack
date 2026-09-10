import { Hash, LookupResolver, Utils, type LookupNetworkPreset } from '@bsv/sdk'
import { OverlayUMPTokenInteractor, type UMPTokenInteractor } from '@bsv/wallet-toolbox'
import { parsePublicWalletChain } from '../config/network'
import type { User } from '../types'
import { UserService } from './UserService'

type RegistrationUMPInteractor = Pick<UMPTokenInteractor, 'findByPresentationKeyHash'>

function lookupNetworkPreset(): LookupNetworkPreset {
  switch (parsePublicWalletChain(process.env.BSV_NETWORK)) {
    case 'main':
      return 'mainnet'
    case 'test':
      return 'testnet'
    case 'ttn':
      return 'teratestnet'
  }
}

function defaultUMPInteractor(): RegistrationUMPInteractor {
  const resolver = new LookupResolver({ networkPreset: lookupNetworkPreset() })
  // The standalone CommonJS build exposes the same SDK class through two
  // conditional declaration paths, whose private fields make TypeScript treat
  // them as nominally distinct even though Node resolves one runtime class.
  const toolboxResolver = resolver as unknown as ConstructorParameters<
    typeof OverlayUMPTokenInteractor
  >[0]
  return new OverlayUMPTokenInteractor(toolboxResolver)
}

export class RegistrationRecoveryError extends Error {
  constructor(
    message: string,
    public readonly status: 409 | 503
  ) {
    super(message)
    this.name = 'RegistrationRecoveryError'
  }
}

/** Reopens legacy-stranded registrations only after verified UMP absence. */
export class RegistrationRecoveryService {
  constructor(private readonly umpTokens: RegistrationUMPInteractor) {}

  async reopenIfUMPAbsent(user: Pick<User, 'id' | 'presentationKey'>): Promise<void> {
    const presentationKey = Utils.toArray(user.presentationKey, 'hex')
    const presentationHash = Hash.sha256(presentationKey)

    let token
    try {
      token = await this.umpTokens.findByPresentationKeyHash(presentationHash)
    } catch {
      throw new RegistrationRecoveryError(
        'Verified UMP lookup was indeterminate; registration was not reopened.',
        503
      )
    }
    if (token != null) {
      throw new RegistrationRecoveryError(
        'A published UMP token exists; registration was not reopened.',
        409
      )
    }

    await UserService.reopenRegistration(user.id)
  }
}

export const registrationRecoveryService = new RegistrationRecoveryService(defaultUMPInteractor())
