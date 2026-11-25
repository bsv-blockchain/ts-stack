import { DisplayableIdentity, WalletInterface, IdentityClientOptions, OriginatorDomainNameStringUnder250Bytes } from "@bsv/sdk"
import { Dispatch, SetStateAction } from "react"

export interface DecryptedField {
  profilePhoto: string
  firstName?: string
  lastName?: string
  userName?: string
  name?: string,
  email?: string
  phoneNumber?: string
}
export interface Certifier {
  publicKey: string
  icon: string
  name: string
}

export interface IdentityProps {
  identityKey: string
  themeMode?: "light" | "dark"
}

export interface IdentityStore {
  identities: DisplayableIdentity[]
  fetchIdentities: (
    query: string,
    setIsLoading: Dispatch<SetStateAction<boolean>>,
    wallet?: WalletInterface | undefined,
    options?: IdentityClientOptions | undefined,
    originator?: OriginatorDomainNameStringUnder250Bytes | undefined
  ) => Promise<void>
}

export const DEFAULT_IDENTITY: DisplayableIdentity = {
  name: 'Unknown Identity',
  avatarURL: '',
  identityKey: '',
  abbreviatedKey: '',
  badgeIconURL: '',
  badgeLabel: 'Not verified by anyone you trust.',
  badgeClickURL: 'https://projectbabbage.com/docs/unknown-identity'
}