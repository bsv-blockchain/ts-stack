import { PubKeyHex } from '@bsv/sdk'
import { Dispatch, SetStateAction } from 'react'

export interface DecryptedField {
  profilePhoto: string
  firstName?: string
  lastName?: string
  userName?: string
  email?: string
  phoneNumber?: string
}
export interface Certifier {
  publicKey: PubKeyHex
  icon: string
  name: string
}
export interface SigniaResult {
  certifier: Certifier
  decryptedFields: DecryptedField
  subject: string
  type: string
  signature: string
}

export interface AssetProps {
  identityKey: string
  themeMode?: 'light' | 'dark'
}

export interface AssetStore {
  identities: Asset[]
  fetchIdentities: (query: string, setIsLoading: Dispatch<SetStateAction<boolean>>) => Promise<void>
}

export interface Asset {
  name: string
  profilePhoto: string
  identityKey: string
  certifier: Certifier
  certificateType?: string
}
