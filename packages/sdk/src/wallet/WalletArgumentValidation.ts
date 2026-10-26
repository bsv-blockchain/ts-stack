import { CallType } from './substrates/WalletWireCalls.js'
import { AcquireCertificateArgs } from './Wallet.interfaces.js'
import { WERR_INVALID_PARAMETER } from './WERR_INVALID_PARAMETER.js'
import {
  validateAbortActionArgs,
  validateAcquireDirectCertificateArgs,
  validateAcquireIssuanceCertificateArgs,
  validateCreateActionArgs,
  validateCreateHmacArgs,
  validateCreateSignatureArgs,
  validateDiscoverByAttributesArgs,
  validateDiscoverByIdentityKeyArgs,
  validateGetHeaderArgs,
  validateGetPublicKeyArgs,
  validateInternalizeActionArgs,
  validateListActionsArgs,
  validateListCertificatesArgs,
  validateListOutputsArgs,
  validateNoArgs,
  validateProveCertificateArgs,
  validateRelinquishCertificateArgs,
  validateRelinquishOutputArgs,
  validateRevealCounterpartyKeyLinkageArgs,
  validateRevealSpecificKeyLinkageArgs,
  validateSignActionArgs,
  validateVerifyHmacArgs,
  validateVerifySignatureArgs,
  validateWalletDecryptArgs,
  validateWalletEncryptArgs
} from './validationHelpers.js'

/**
 * Runtime validation for every BRC-100 request before it crosses a wallet
 * transport or reaches a wallet implementation.
 */
export function validateWalletArgs(call: CallType, args: unknown): void {
  switch (call) {
    case 'createAction':
      validateCreateActionArgs(args as never)
      return
    case 'signAction':
      validateSignActionArgs(args as never)
      return
    case 'abortAction':
      validateAbortActionArgs(args as never)
      return
    case 'listActions':
      validateListActionsArgs(args as never)
      return
    case 'internalizeAction':
      validateInternalizeActionArgs(args as never)
      return
    case 'listOutputs':
      validateListOutputsArgs(args as never)
      return
    case 'relinquishOutput':
      validateRelinquishOutputArgs(args as never)
      return
    case 'getPublicKey':
      validateGetPublicKeyArgs(args as never)
      return
    case 'revealCounterpartyKeyLinkage':
      validateRevealCounterpartyKeyLinkageArgs(args as never)
      return
    case 'revealSpecificKeyLinkage':
      validateRevealSpecificKeyLinkageArgs(args as never)
      return
    case 'encrypt':
      validateWalletEncryptArgs(args as never)
      return
    case 'decrypt':
      validateWalletDecryptArgs(args as never)
      return
    case 'createHmac':
      validateCreateHmacArgs(args as never)
      return
    case 'verifyHmac':
      validateVerifyHmacArgs(args as never)
      return
    case 'createSignature':
      validateCreateSignatureArgs(args as never)
      return
    case 'verifySignature':
      validateVerifySignatureArgs(args as never)
      return
    case 'acquireCertificate': {
      const certificateArgs = args as AcquireCertificateArgs
      if (certificateArgs?.acquisitionProtocol === 'direct') {
        validateAcquireDirectCertificateArgs(certificateArgs)
      } else if (certificateArgs?.acquisitionProtocol === 'issuance') {
        validateAcquireIssuanceCertificateArgs(certificateArgs)
      } else {
        throw new WERR_INVALID_PARAMETER('acquisitionProtocol', 'direct or issuance')
      }
      return
    }
    case 'listCertificates':
      validateListCertificatesArgs(args as never)
      return
    case 'proveCertificate':
      validateProveCertificateArgs(args as never)
      return
    case 'relinquishCertificate':
      validateRelinquishCertificateArgs(args as never)
      return
    case 'discoverByIdentityKey':
      validateDiscoverByIdentityKeyArgs(args as never)
      return
    case 'discoverByAttributes':
      validateDiscoverByAttributesArgs(args as never)
      return
    case 'getHeaderForHeight':
      validateGetHeaderArgs(args as never)
      return
    case 'isAuthenticated':
    case 'waitForAuthentication':
    case 'getHeight':
    case 'getNetwork':
    case 'getVersion':
      validateNoArgs(args as object)
  }
}
