import { MasterCertificate, ProveCertificateResult, Validation } from '@bsv/sdk'
import { Wallet } from '../../Wallet'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { AuthId } from '../../sdk/WalletStorage.interfaces'

export async function proveCertificate(
  wallet: Wallet,
  auth: AuthId,
  vargs: Validation.ValidProveCertificateArgs
): Promise<ProveCertificateResult> {
  const lcargs: Validation.ValidListCertificatesArgs = {
    partial: {
      type: vargs.type,
      serialNumber: vargs.serialNumber,
      certifier: vargs.certifier,
      subject: vargs.subject,
      revocationOutpoint: vargs.revocationOutpoint,
      signature: vargs.signature
    },
    certifiers: [],
    types: [],
    limit: 2,
    offset: 0,
    privileged: false
  }

  const lcr = await wallet.storage.listCertificates(lcargs)
  if (lcr.certificates.length != 1) throw new WERR_INVALID_PARAMETER('args', `a unique certificate match`)
  const storageCert = lcr.certificates[0]
  const keyringForVerifier = await MasterCertificate.createKeyringForVerifier(
    wallet,
    storageCert.certifier,
    vargs.verifier,
    storageCert.fields,
    vargs.fieldsToReveal,
    storageCert.keyring!,
    storageCert.serialNumber,
    vargs.privileged,
    vargs.privilegedReason
  )

  return { keyringForVerifier }
}
