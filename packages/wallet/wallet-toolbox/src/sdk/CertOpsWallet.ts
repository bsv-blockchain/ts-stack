import {
  GetPublicKeyArgs,
  GetPublicKeyResult,
  OriginatorDomainNameStringUnder250Bytes,
  WalletDecryptArgs,
  WalletDecryptResult,
  WalletEncryptArgs,
  WalletEncryptResult
} from '@bsv/sdk'

export interface CertOpsWallet {
  getPublicKey(
    args: GetPublicKeyArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<GetPublicKeyResult>
  encrypt(args: WalletEncryptArgs, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<WalletEncryptResult>
  decrypt(args: WalletDecryptArgs, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<WalletDecryptResult>
}
